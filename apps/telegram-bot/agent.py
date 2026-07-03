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
You have tools available: `read`, `write`, `edit`, `glob`, `grep`, `bash`, `web_fetch`, `task_done`.

**You MUST use these tools to accomplish tasks. Never just talk.**

## How you work
1. User gives a task — you IMMEDIATELY call a tool
2. Get the result, decide next step
3. When done, call `task_done`

## Examples
- User: "напиши main.py" → you call `write` with the code
- User: "пофикси баги" → you call `grep`/`read` → `edit`
- User: "покажи структуру" → you call `glob`
- User: "запусти тесты" → you call `bash`

## CRITICAL INSTRUCTION
DO NOT respond with text explaining what you plan to do.
DO respond by CALLING THE APPROPRIATE TOOL immediately.
You have function calling available. USE IT."""


NO_TOOL_REMINDER = (
    "You responded with text instead of using a tool. "
    "This is a coding agent — you MUST call a tool to complete the task. "
    "If the user asked to create a file, call `write`. "
    "If they asked to read code, call `read`. "
    "Do NOT explain. Call a tool NOW."
)


async def _call_llm(
    messages: list,
    tools: list | None = None,
    tool_choice: str = "auto",
    model: str | None = None,
):
    loop = asyncio.get_event_loop()
    kwargs = dict(
        model=model or AGENT_MODEL,
        messages=messages,
        timeout=120,
    )
    if tools:
        kwargs["tools"] = tools
        kwargs["tool_choice"] = tool_choice
    return await loop.run_in_executor(None, lambda: _client.chat.completions.create(**kwargs))


async def run_agent(messages: list, on_status: callable = None) -> str:
    sys_msg = {"role": "system", "content": AGENT_SYSTEM_PROMPT}
    full_messages = [sys_msg] + messages

    tool_calls_count = 0
    tried_fallback = False
    no_tool_retries = 0

    while tool_calls_count < MAX_TOOL_CALLS:
        if on_status:
            await on_status(f"🔄 Шаг {tool_calls_count + 1}: анализ...")

        from tools import TOOL_DEFINITIONS

        try:
            resp = await _call_llm(full_messages, TOOL_DEFINITIONS, "auto")
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
                    "content": f"Previous model failed. Now using {AGENT_FALLBACK_MODEL}. Continue.",
                })
                continue

            return f"❌ Ошибка AI: {err}"

        msg = resp.choices[0].message

        # Model didn't use tools — retry with reminder
        if not msg.tool_calls:
            no_tool_retries += 1
            content_preview = (msg.content or "")[:80]
            logger.warning(f"No tools used (attempt {no_tool_retries}): {content_preview}")

            if no_tool_retries >= 2:
                # Force with a different model
                if not tried_fallback:
                    tried_fallback = True
                    logger.info(f"No tool use after retries, fallback to {AGENT_FALLBACK_MODEL}")
                    if on_status:
                        await on_status(f"🔄 fallback на {AGENT_FALLBACK_MODEL}...")
                    full_messages.append({
                        "role": "system",
                        "content": NO_TOOL_REMINDER,
                    })
                    full_messages.append({
                        "role": "system",
                        "content": f"Switch to {AGENT_FALLBACK_MODEL} now. Call a tool immediately.",
                    })
                    continue
                else:
                    # Give up and return whatever was said
                    final = msg.content or "⚠️ Бот не смог использовать инструменты."
                    full_messages.append({"role": "assistant", "content": final})
                    messages[:] = [m for m in full_messages if m.get("role") != "system"]
                    return final

            # Remind model to use tools
            full_messages.append({"role": "assistant", "content": msg.content or ""})
            full_messages.append({"role": "user", "content": NO_TOOL_REMINDER})
            continue

        # Model IS using tools
        no_tool_retries = 0

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
                "role": "assistant", "content": None, "tool_calls": [tc],
            })
            full_messages.append({
                "role": "tool", "tool_call_id": tc.id,
                "content": json.dumps(result, ensure_ascii=False),
            })

    final = "⚠️ Достигнут лимит шагов."
    full_messages.append({"role": "assistant", "content": final})
    messages[:] = [m for m in full_messages if m.get("role") != "system"]
    return final
