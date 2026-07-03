import json
import logging
import asyncio
from openai import OpenAI
from config import (
    FREELLM_BASE_URL, FREELLM_API_KEY,
    AGENT_MODEL, AGENT_FALLBACK_MODEL, MAX_TOOL_CALLS,
)


logger = logging.getLogger(__name__)
_client = OpenAI(base_url=FREELLM_BASE_URL, api_key=FREELLM_API_KEY)


AGENT_SYSTEM_PROMPT = """You are an AI coding assistant called FreeLLM Agent. You act exactly like Claude Code or Opencode.

## CORE RULE — YOU MUST USE TOOLS
You have tools available. You MUST use them to accomplish tasks. NEVER just talk — ALWAYS use a tool.

## How you work
1. User gives you a task
2. You decide which tool to use and call it
3. You get the result and decide what to do next
4. When the task is fully done, call `task_done`

## Workspace
- All files are in the workspace directory
- Use `read`, `write`, `edit`, `glob`, `grep` to work with files
- Use `bash` to run commands (build, test, git, etc.)
- Use `web_fetch` to look up docs or information
- File paths are relative to workspace root

## Examples of what to do
- "improve this file" → `read` the file → `write` the improved version
- "find all bugs" → `grep` for patterns → `read` relevant files → `edit` fixes
- "create a web server" → `write` the files → `bash` to test
- "show project structure" → `glob` to list files

## CRITICAL
- NEVER respond with just text when you could use a tool
- If the user asks about code: read it first
- If the user asks to improve/create: write/edit files
- Think step by step. Call one tool at a time.
- When fully done, call `task_done` with a summary and list of changed files."""


async def _call_llm(messages: list, tools: list | None, tool_choice: str = "auto") -> tuple:
    loop = asyncio.get_event_loop()
    kwargs = dict(model=AGENT_MODEL, messages=messages, timeout=120)
    if tools:
        kwargs["tools"] = tools
        kwargs["tool_choice"] = tool_choice
    return await loop.run_in_executor(
        None,
        lambda: _client.chat.completions.create(**kwargs),
    )


async def run_agent(
    messages: list,
    on_status: callable = None,
) -> str:
    sys_msg = {"role": "system", "content": AGENT_SYSTEM_PROMPT}
    full_messages = [sys_msg] + messages

    tool_calls_count = 0
    tried_fallback = False

    while tool_calls_count < MAX_TOOL_CALLS:
        if on_status:
            await on_status(f"🔄 Шаг {tool_calls_count + 1}: анализ...")

        from tools import TOOL_DEFINITIONS

        try:
            # First call: force tool use so model can't just talk
            choice = "required" if tool_calls_count == 0 else "auto"
            resp = await _call_llm(full_messages, TOOL_DEFINITIONS, choice)
        except Exception as e:
            err = str(e)
            logger.error(f"AI call failed: {err}", exc_info=True)

            if not tried_fallback:
                tried_fallback = True
                logger.info(f"Fallback to {AGENT_FALLBACK_MODEL}")
                if on_status:
                    await on_status(f"🔄 fallback на {AGENT_FALLBACK_MODEL}...")
                full_messages.append({
                    "role": "system",
                    "content": f"Previous model failed. Now using {AGENT_FALLBACK_MODEL}. Continue the task.",
                })
                continue

            return f"❌ Ошибка AI: {err}"

        msg = resp.choices[0].message

        if not msg.tool_calls:
            content = msg.content or ""
            # If model didn't use tools and we forced it, something is wrong
            logger.warning(f"Model returned text without tool calls: {content[:100]}")
            full_messages.append({"role": "assistant", "content": content})
            messages[:] = [m for m in full_messages if m.get("role") != "system"]
            return content

        for tc in msg.tool_calls:
            tool_calls_count += 1
            fn_name = tc.function.name
            try:
                fn_args = json.loads(tc.function.arguments)
            except json.JSONDecodeError:
                fn_args = {}

            if on_status:
                args_str = json.dumps(fn_args, ensure_ascii=False)[:80]
                await on_status(f"🛠 Шаг {tool_calls_count}: `{fn_name}` {args_str}...")

            if fn_name == "task_done":
                summary = fn_args.get("summary", "")
                files = fn_args.get("files", [])
                result = summary
                if files:
                    result += "\n\n📁 Файлы:\n" + "\n".join(f"• `{f}`" for f in files)
                full_messages.append({"role": "assistant", "content": result})
                messages[:] = [m for m in full_messages if m.get("role") != "system"]
                return result

            from tools import TOOL_NAME_MAP
            tool_fn = TOOL_NAME_MAP.get(fn_name)
            if not tool_fn:
                result = {"error": f"Unknown tool: {fn_name}"}
            else:
                result = await tool_fn(**fn_args)

            full_messages.append({
                "role": "assistant",
                "content": None,
                "tool_calls": [tc],
            })
            full_messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": json.dumps(result, ensure_ascii=False),
            })

    final = "⚠️ Достигнут лимит шагов. Задача не завершена."
    full_messages.append({"role": "assistant", "content": final})
    messages[:] = [m for m in full_messages if m.get("role") != "system"]
    return final
