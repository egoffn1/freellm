import json
import logging
import asyncio
from openai import OpenAI

from config import FREELLM_BASE_URL, FREELLM_API_KEY, AGENT_MODEL, AGENT_FALLBACK_MODEL, MAX_TOOL_CALLS

logger = logging.getLogger(__name__)
_client = OpenAI(base_url=FREELLM_BASE_URL, api_key=FREELLM_API_KEY)

MANAGER_PROMPT = """You are a Manager Agent. Your job:
1. Analyze the user request
2. Break it into sub-tasks
3. Delegate to specialists via tools
4. Review results and decide next steps

Available specialists:
- `researcher`: Searches web, reads docs, gathers facts
- `coder`: Writes code, creates files, edits code
- `critic`: Reviews work for bugs and improvements

For each sub-task, call the appropriate tool. After all sub-tasks complete, synthesize a final answer.
"""

RESEARCHER_PROMPT = """You are a Research Agent. Your job:
- Search the web for relevant information
- Read documentation and gather facts
- Verify claims with multiple sources
- Return structured findings with citations
Use `web_fetch` to get information from URLs.
"""

CODER_PROMPT = """You are a Code Agent. Your job:
- Write clean, idiomatic code
- Create project files with proper structure
- Debug and fix issues
- Use `read`, `write`, `edit`, `glob`, `grep`, `bash` tools
- Use `sandbox` to test Python code before delivering
"""

CRITIC_PROMPT = """You are a Critic Agent. Your job:
- Review code and text for errors
- Check for edge cases, security issues, performance problems
- Suggest concrete improvements
- Verify the solution matches the original requirements
Be thorough and honest. If something is wrong, say so.
"""


async def _call_llm(messages: list, tools: list = None, tool_choice: str = "auto", model: str = None):
    loop = asyncio.get_event_loop()
    kwargs = dict(model=model or AGENT_MODEL, messages=messages, timeout=120)
    if tools:
        kwargs["tools"] = tools
        kwargs["tool_choice"] = tool_choice
    try:
        return await loop.run_in_executor(None, lambda: _client.chat.completions.create(**kwargs))
    except Exception as e:
        logger.error(f"Agent call failed: {e}")
        if model != AGENT_FALLBACK_MODEL:
            kwargs["model"] = AGENT_FALLBACK_MODEL
            return await loop.run_in_executor(None, lambda: _client.chat.completions.create(**kwargs))
        raise


async def run_specialist(role: str, prompt: str, context: str, tools: list) -> str:
    system_prompts = {
        "manager": MANAGER_PROMPT,
        "researcher": RESEARCHER_PROMPT,
        "coder": CODER_PROMPT,
        "critic": CRITIC_PROMPT,
    }
    system = system_prompts.get(role, MANAGER_PROMPT)
    msgs = [
        {"role": "system", "content": system},
        {"role": "user", "content": f"Context:\n{context[:3000]}\n\nTask:\n{prompt}"},
    ]
    resp = await _call_llm(msgs, tools)
    return resp.choices[0].message.content or ""


async def orchestrate(user_request: str, context: str, tools: list, on_status=None) -> str:
    if on_status:
        await on_status("🧠 Анализирую задачу (Manager)...")

    manager_result = await run_specialist("manager", user_request, context, tools)

    research_needed = "researcher" in manager_result.lower() or "search" in manager_result.lower()
    code_needed = "coder" in manager_result.lower() or "code" in manager_result.lower() or "write" in manager_result.lower() or "create" in manager_result.lower()

    research_output = ""
    coder_output = ""

    if research_needed:
        if on_status:
            await on_status("🔍 Исследую (Researcher)...")
        research_output = await run_specialist("researcher", manager_result, context, tools)

    if code_needed:
        if on_status:
            await on_status("👨‍💻 Пишу код (Coder)...")
        coder_output = await run_specialist("coder", manager_result, context + "\n\n" + research_output, tools)

    combined_context = f"Original request: {user_request}\n\nPlan: {manager_result}"
    if research_output:
        combined_context += f"\n\nResearch: {research_output}"
    if coder_output:
        combined_context += f"\n\nCode: {coder_output}"

    if on_status:
        await on_status("🔎 Проверяю результат (Critic)...")

    critic_output = await run_specialist("critic", combined_context, "", tools)
    combined_context += f"\n\nReview: {critic_output}"

    if on_status:
        await on_status("📋 Собираю ответ...")

    final_msgs = [
        {"role": "system", "content": "You are a helpful assistant. Synthesize the final response from all agents."},
        {"role": "user", "content": f"Synthesize a final answer for the user.\n\nFull context:\n{combined_context}"},
    ]
    final_resp = await _call_llm(final_msgs)
    return final_resp.choices[0].message.content or ""
