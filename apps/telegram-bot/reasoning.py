import json
import re
import logging
import asyncio
from openai import OpenAI

from config import FREELLM_BASE_URL, FREELLM_API_KEY, AGENT_MODEL

logger = logging.getLogger(__name__)
_client = OpenAI(base_url=FREELLM_BASE_URL, api_key=FREELLM_API_KEY)

REASONING_PROMPT = """You are a methodical reasoning engine. Your task is to create a detailed plan.

Given the user's request, think step by step:

1. **Analyze the request**: What exactly does the user want? What are the key requirements?
2. **Identify what you know vs what you need to find out**: Do you need to search the web? Read files? Write code?
3. **Create a step-by-step plan**: Each step should specify which tool to use and why.

Available tools: read, write, edit, glob, grep, bash, web_fetch, vision, sandbox, research, scaffold

Return a JSON object:
```json
{
  "analysis": "what the user needs",
  "steps": [
    {"step": 1, "tool": "tool_name", "description": "what to do", "expected_outcome": "what result to expect"}
  ],
  "needs_web_search": true/false,
  "risks": ["potential issues"]
}
```
"""

REFLECTION_PROMPT = """Review the completed work critically:
1. Does the result fully satisfy the original request?
2. Are there any bugs, logical errors, or edge cases?
3. Is the code clean and well-structured?
4. What would you improve?

Respond in JSON:
```json
{"score": 1-10, "issues": [...], "suggestions": [...], "ready": true/false}
```
"""


async def reason(user_request: str, context: str = "") -> dict:
    messages = [{"role": "system", "content": REASONING_PROMPT}]
    if context:
        messages.append({"role": "user", "content": f"Контекст:\n{context}\n\nЗапрос:\n{user_request}"})
    else:
        messages.append({"role": "user", "content": user_request})

    loop = asyncio.get_event_loop()
    try:
        resp = await loop.run_in_executor(
            None,
            lambda: _client.chat.completions.create(
                model=AGENT_MODEL,
                messages=messages,
                timeout=60,
            ),
        )
        text = resp.choices[0].message.content or ""
        return _parse_json(text) or {
            "analysis": user_request,
            "steps": [{"step": 1, "tool": "auto", "description": "Execute the request"}],
            "needs_web_search": False,
            "risks": [],
        }
    except Exception as e:
        logger.warning(f"Reasoning failed: {e}")
        return {
            "analysis": user_request,
            "steps": [{"step": 1, "tool": "auto", "description": "Execute the request"}],
            "needs_web_search": False,
            "risks": [str(e)],
        }


async def reflect(task: str, result: str) -> dict:
    messages = [
        {"role": "system", "content": REFLECTION_PROMPT},
        {"role": "user", "content": f"Task: {task}\n\nResult:\n{result}"},
    ]
    loop = asyncio.get_event_loop()
    try:
        resp = await loop.run_in_executor(
            None,
            lambda: _client.chat.completions.create(
                model=AGENT_MODEL,
                messages=messages,
                timeout=30,
            ),
        )
        text = resp.choices[0].message.content or ""
        return _parse_json(text) or {"score": 5, "issues": ["Could not parse reflection"], "suggestions": [], "ready": True}
    except Exception as e:
        return {"score": 5, "issues": [str(e)], "suggestions": [], "ready": True}


def _parse_json(text: str) -> dict | None:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\n?|```$", "", text, flags=re.MULTILINE).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None
