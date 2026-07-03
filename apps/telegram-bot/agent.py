import json
import logging
import asyncio
import re
from openai import OpenAI
from config import (
    FREELLM_BASE_URL, FREELLM_API_KEY,
    AGENT_MODEL, AGENT_FALLBACK_MODEL, MAX_TOOL_CALLS,
)


logger = logging.getLogger(__name__)
_client = OpenAI(base_url=FREELLM_BASE_URL, api_key=FREELLM_API_KEY)

CASUAL_PATTERNS = re.compile(
    r"^(привет|здравствуй|хай|хелло|пока|до свидания|спасибо|благодарю|"
    r"как дела|что делаешь|кто ты|расскажи о себе|help|hi|hello|bye|"
    r"как тебя зовут|ты кто|thanks|thank you|good morning|good evening)",
    re.IGNORECASE,
)

NEEDS_TOOLS = re.compile(
    r"(напиш|создай|сгенер|сделай|пофикс|исправ|отредакт|измен|"
    r"прочитай|покажи|найди|напиши|запуст|скомпил|установ|"
    r"склон|задепло|отформат|проверь|протест|"
    r"рефактор|оптимиз|добав|удал|переимен|"
    r"read|write|edit|create|generate|fix|refactor|run|test|"
    r"clone|deploy|build|compile|install|format|lint|check|"
    r"file|файл|код|code|баг|bug|функци|function|class|"
    r"\w+\.\w+)|(?:\.\w+\s)",
    re.IGNORECASE,
)

AGENT_SYSTEM_PROMPT = """You are FreeLLM Agent — an AI coding assistant like Claude Code.

## When to use tools
- User asks to create/edit/read files → use `write`, `read`, `edit`
- User asks "прочитай" or "read" → use `read` on the file from context
- User asks to search code → use `grep`, `glob`
- User asks to run commands → use `bash`
- User uploads an image and asks about it → use `vision`
- User asks about a URL → use `web_fetch`
- Task complete → call `task_done` with summary of what was done

## Conversation history has context about uploaded/created files
Look at the history — it contains `[Загружен файл: имя]` and `[Создан файл: имя]` entries.
Use these to know what files exist and what the user is referring to.

## When user says "прочитай" / "read" / "скажи что там"
1. Find the most recent file mentioned in history
2. Call `read` on it
3. Summarize the contents in Russian

## When to just talk
- Greetings, casual questions, general knowledge → respond normally
- No tools needed for simple conversation

## How you work
1. Think what the user needs
2. If it needs a tool → call it immediately
3. If it's just conversation → respond naturally
4. When a multi-step task is done → call `task_done`"""


async def _call_llm(
    messages: list,
    tools: list | None = None,
    tool_choice: str = "auto",
    model: str | None = None,
):
    loop = asyncio.get_event_loop()
    kwargs = dict(model=model or AGENT_MODEL, messages=messages, timeout=120)
    if tools:
        kwargs["tools"] = tools
        kwargs["tool_choice"] = tool_choice
    return await loop.run_in_executor(None, lambda: _client.chat.completions.create(**kwargs))


def _needs_tools(text: str) -> bool:
    return bool(NEEDS_TOOLS.search(text))


async def run_agent(messages: list, on_status: callable = None) -> str:
    user_text = messages[-1]["content"] if messages else ""
    is_casual = bool(CASUAL_PATTERNS.match(user_text.strip()))
    needs_tools = _needs_tools(user_text)

    # Pure casual chat — skip tools entirely
    if is_casual and not needs_tools:
        sys_msg = {"role": "system", "content": "You are a helpful AI assistant. Respond conversationally."}
        try:
            resp = await _call_llm([sys_msg] + messages)
            text = resp.choices[0].message.content or ""
            messages.append({"role": "assistant", "content": text})
            return text
        except Exception as e:
            return f"❌ {e}"

    # Needs tools — full agent mode
    sys_msg = {"role": "system", "content": AGENT_SYSTEM_PROMPT}
    full_messages = [sys_msg] + messages
    tool_calls_count = 0
    tried_fallback = False

    while tool_calls_count < MAX_TOOL_CALLS:
        if on_status:
            await on_status(f"🔄 Шаг {tool_calls_count + 1}: анализ...")

        from tools import TOOL_DEFINITIONS

        try:
            resp = await _call_llm(full_messages, TOOL_DEFINITIONS, "auto")
        except Exception as e:
            logger.error(f"AI call failed: {e}", exc_info=True)
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
            return f"❌ Ошибка AI: {e}"

        msg = resp.choices[0].message

        if not msg.tool_calls:
            final = msg.content or "✅ Готово."
            full_messages.append({"role": "assistant", "content": final})
            messages[:] = [m for m in full_messages if m.get("role") != "system"]
            return final

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

            full_messages.append({"role": "assistant", "content": None, "tool_calls": [tc]})
            full_messages.append({
                "role": "tool", "tool_call_id": tc.id,
                "content": json.dumps(result, ensure_ascii=False),
            })

    final = "⚠️ Достигнут лимит шагов."
    full_messages.append({"role": "assistant", "content": final})
    messages[:] = [m for m in full_messages if m.get("role") != "system"]
    return final
