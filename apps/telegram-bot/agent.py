import json
import logging
import asyncio
import re
from openai import OpenAI
from config import (
    FREELLM_BASE_URL, FREELLM_API_KEY,
    AGENT_MODEL, AGENT_FALLBACK_MODEL, MAX_TOOL_CALLS, MULTI_AGENT_ENABLED,
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

AGENT_SYSTEM_PROMPT = """You are FreeLLM Agent — an advanced AI coding assistant inspired by Opencode, Claude Code, ChatGPT, DeepSeek, and Mistral.

## 🧠 Core Principles
- **Chain of Thought**: Before each response, think step-by-step internally. Plan before acting.
- **Multi-step reasoning**: Break complex tasks into smaller steps. Verify each step before continuing.
- **Self-reflection**: After completing a task, review your work for errors and improvements.

## ⚠️ SECURITY — NEVER DO THESE (deadly serious)
- **NO system-level commands**: sudo, su, chown, passwd, poweroff, reboot, shutdown, kill, killall, pkill, init, mkfs, dd, format, >|
- **NO write outside workspace**: You can only read/write files inside the workspace directory.
- **NO accessing other users' files**: You work with ONE user's files at a time.
- **NO deleting essential files**: Do not delete the bot's own code (`/app/` directory) or system files.
- **NO installing/uninstalling system packages**: Use `bash` only for development commands (build, test, git, lint, run code).
- **NO mining, exploits, malware**: Do not generate cryptocurrency miners, exploits, viruses, or any malicious code.
- **NO privilege escalation**: Do not attempt to gain root access or modify system permissions.

## ✅ SAFE operations — these are fine
- Create/edit/read files in workspace → use `write`, `read`, `edit`
- Search code → use `grep`, `glob`
- Run development commands → use `bash` (git, python, npm, pip, go, cargo, ls, cat, mkdir, etc.)
- Test Python code safely → use `sandbox`
- Search the web for info → use `research`
- Create multi-file projects → use `scaffold`
- Analyze images → use `vision`
- Fetch web pages → use `web_fetch`

## 🔧 Tool Usage Guidelines
- **sandbox**: Always test Python code before delivering it. Write code, test it with sandbox, fix errors, then deliver.
- **research**: Use for any question requiring up-to-date information (APIs, libraries, docs, news).
- **scaffold**: For multi-file projects (web apps, libraries, full-stack). Creates proper file structure.
- **bash**: Use for git, npm, python scripts, compilation, testing.
- **vision**: For images, screenshots, diagrams uploaded by user.

## 💬 Conversation Style
- Respond in Russian unless the user writes in another language
- Be concise but thorough
- For code tasks: explain what you did, show the code, note any tradeoffs
- For research: cite sources, summarize findings
- For multi-step: keep the user updated on progress

## 📋 Context & Memory
- History contains `[Загружен файл: имя]`, `[Создан файл: имя]` entries
- User may reference files from earlier in conversation
- Previous conversation context is available via RAG memory

## How to handle requests
- User says "прочитай" / "read" / "скажи что там":
  1. Find the most recent file mentioned in history
  2. Call `read` on it
  3. Summarize in Russian
- User asks for code → write + test + deliver
- Multi-file projects → use `scaffold` to create organized project structure
- When fully done → call `task_done` with summary and list of changed files"""


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


async def run_agent(messages: list, on_status: callable = None, cancel_event: asyncio.Event = None) -> str:
    user_text = messages[-1]["content"] if messages else ""
    is_casual = bool(CASUAL_PATTERNS.match(user_text.strip()))
    needs_tools = _needs_tools(user_text)

    if cancel_event and cancel_event.is_set():
        return "⏹ Задача отменена."

    from guardrails import check_input, check_output, sanitize_output
    guard = check_input(user_text)
    if guard["blocked"]:
        return "\n".join(guard["warnings"])

    from rag_memory import rag
    rag.add_messages(messages)
    memory_context = rag.build_context(user_text)

    if is_casual and not needs_tools:
        sys_msg = {"role": "system", "content": "You are a helpful AI assistant. Respond conversationally."}
        try:
            resp = await _call_llm([sys_msg] + messages)
            text = resp.choices[0].message.content or ""
            messages.append({"role": "assistant", "content": text})
            return text
        except Exception as e:
            return f"❌ {e}"

    ctx_note = ""
    if memory_context:
        ctx_note = f"\n\nRelevant context from previous conversations:\n{memory_context}"

    sys_msg = {"role": "system", "content": AGENT_SYSTEM_PROMPT + ctx_note}
    full_messages = [sys_msg] + messages
    tool_calls_count = 0
    tried_fallback = False
    no_tool_retries = 0

    while tool_calls_count < MAX_TOOL_CALLS:
        if cancel_event and cancel_event.is_set():
            return "⏹ Задача отменена."

        if on_status:
            await on_status(f"🔄 Шаг {tool_calls_count + 1}: анализ...")

        from tools import TOOL_DEFINITIONS

        try:
            resp = await _call_llm(full_messages, TOOL_DEFINITIONS, "auto")
        except asyncio.CancelledError:
            return "⏹ Задача отменена."
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
            if needs_tools and no_tool_retries < 2:
                no_tool_retries += 1
                if on_status:
                    await on_status(f"🤔 Напоминаю использовать инструменты (попытка {no_tool_retries + 1})...")
                full_messages.append({
                    "role": "system",
                    "content": "The user's request requires tools. You MUST use appropriate tools to accomplish it. Don't just talk — do."
                })
                continue
            final = msg.content or "✅ Готово."
            full_messages.append({"role": "assistant", "content": final})
            messages[:] = [m for m in full_messages if m.get("role") != "system"]
            final = sanitize_output(final)
            rag.add(f"[Assistant] {final}", {"role": "assistant"})
            return final

        no_tool_retries = 0

        for tc in msg.tool_calls:
            if cancel_event and cancel_event.is_set():
                return "⏹ Задача отменена."
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
                result = sanitize_output(result)
                rag.add(f"[Done] {summary}", {"role": "system"})
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

            if tool_calls_count >= MAX_TOOL_CALLS:
                break

    final = "⚠️ Достигнут лимит шагов."
    full_messages.append({"role": "assistant", "content": final})
    messages[:] = [m for m in full_messages if m.get("role") != "system"]
    return final
