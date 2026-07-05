import json
import logging
import asyncio
import re
from openai import OpenAI
from config import (
    FREELLM_BASE_URL, FREELLM_API_KEY,
    AGENT_MODEL, AGENT_FALLBACK_MODEL, MAX_TOOL_CALLS, MULTI_AGENT_ENABLED,
    WORKSPACE_DIR, LLM_CALL_TIMEOUT,
)

logger = logging.getLogger(__name__)
_client = OpenAI(base_url=FREELLM_BASE_URL, api_key=FREELLM_API_KEY)

CASUAL_PATTERNS = re.compile(
    r"^(привет|здравствуй|хай|хелло|пока|до свидания|спасибо|благодарю|"
    r"как дела|что делаешь|кто ты|расскажи о себе|help|hi|hello|bye|"
    r"как тебя зовут|ты кто|thanks|thank you|good morning|good evening|"
    r"алоо|ало|ты тут|ау|есть кто)",
    re.IGNORECASE,
)

NEEDS_TOOLS = re.compile(
    r"(напиш|создай|сгенер|сделай|пофикс|исправ|отредакт|измен|"
    r"прочитай|покажи|найди|напиши|запуст|скомпил|установ|"
    r"склон|задепло|отформат|проверь|протест|"
    r"рефактор|оптимиз|добав|удал|переимен|убер|встав|"
    r"read|write|edit|create|generate|fix|refactor|run|test|"
    r"clone|deploy|build|compile|install|format|lint|check|"
    r"file|файл|код|code|баг|bug|функци|function|class|"
    r"\w+\.\w+)|(?:\.\w+\s)",
    re.IGNORECASE,
)

AGENT_SYSTEM_PROMPT = """You are FreeLLM Agent — an AI coding assistant.

## 🧠 Core Principles
- Think step-by-step internally before acting.
- Break complex tasks into smaller steps. Verify each step.

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
- Host a file as public webpage → use `host_file`
- IMPORTANT: When you create HTML/CSS/JS files for a website, you MUST call `host_file` for the main HTML file to provide the user a working URL. If you don't, the user can't see the result.

## 🔧 Tool Usage Guidelines
- **sandbox**: Always test Python code before delivering it. Write code, test it with sandbox, fix errors, then deliver.
- **research**: Use for any question requiring up-to-date information (APIs, libraries, docs, news).
- **scaffold**: For multi-file projects (web apps, libraries, full-stack). Creates proper file structure.
- **bash**: Use for git, npm, python scripts, compilation, testing.
- **vision**: For images, screenshots, diagrams uploaded by user.

## 💬 Personality
- Mirror the user's tone and style. If they write formally, match it. If they're casual/swear, match that.
- Keep responses short unless asked to elaborate.
- For code tasks: explain what you did, show the code, note any tradeoffs.
- For research: cite sources, summarize findings.
- For multi-step: keep the user updated on progress.

## 📋 Context & Memory
- History contains `[Загружен файл: имя]`, `[Создан файл: имя]` entries
- User may reference files from earlier in conversation
- Previous conversation context is available via RAG memory

## CRITICAL RULES
- When user asks to write/create code, you MUST call the `write` tool. Do NOT just describe what the code would look like.
- Use ONLY the filename, never full paths like `/home/user/file.py`. Just `main.py` is enough.
- When `write` returns an error, do NOT say the file was created. Report the error or try a different approach.
- Only call `task_done` when you have actually completed the work using tools.

## How to handle requests
- User says "прочитай" / "read" / "скажи что там":
  1. Find the most recent file mentioned in history
  2. Call `read` on it
  3. Summarize in Russian
- User asks for code → use `write` tool, test with `sandbox`, then call `task_done`
- Multi-file projects → use `scaffold` to create organized project structure
- When fully done → call `task_done` with summary and list of changed files"""


def _is_html(text: str) -> bool:
    text_stripped = text.strip()[:200].lower()
    return text_stripped.startswith("<!doctype") or text_stripped.startswith("<html")


async def _ensure_html_hosted(result: str) -> str:
    from tools import CREATED_FILES, tool_host_file, current_user_id, _get_user_workspace
    uid = current_user_id.get()
    user_files = CREATED_FILES.get(uid, set())
    html_files = [f for f in user_files if f.endswith(".html")]
    if not html_files:
        return result
    has_hosted = set()
    urls = []
    for f in sorted(html_files):
        if f in has_hosted:
            continue
        has_hosted.add(f)
        try:
            r = await tool_host_file(filename=f)
            if "url" in r:
                urls.append(r["url"])
        except Exception:
            pass
    if uid in CREATED_FILES:
        CREATED_FILES[uid].difference_update(has_hosted)
    if urls:
        result += "\n\n🌐 Ссылки:\n" + "\n".join(f"• {u}" for u in urls)
    return result


async def _call_llm(
    messages: list,
    tools: list | None = None,
    tool_choice: str = "auto",
    model: str | None = None,
):
    loop = asyncio.get_event_loop()
    kwargs = dict(model=model or AGENT_MODEL, messages=messages, timeout=LLM_CALL_TIMEOUT)
    if tools:
        kwargs["tools"] = tools
        kwargs["tool_choice"] = tool_choice
    return await asyncio.wait_for(
        loop.run_in_executor(None, lambda: _client.chat.completions.create(**kwargs)),
        timeout=LLM_CALL_TIMEOUT + 5,
    )


def _needs_tools(text: str) -> bool:
    return bool(NEEDS_TOOLS.search(text))


async def run_agent(messages: list, on_status: callable = None, on_log: callable = None, cancel_event: asyncio.Event = None) -> str:
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
        if on_log:
            await on_log("💬 Ответ на приветствие")
        sys_msg = {"role": "system", "content": "You are a helpful AI assistant. Respond conversationally."}
        try:
            resp = await _call_llm([sys_msg] + messages)
            text = resp.choices[0].message.content or ""
            messages.append({"role": "assistant", "content": text})
            return text
        except Exception as e:
            err = str(e)
            if _is_html(err):
                err = err[:200] + "... (HTML ответ от API)"
            return f"❌ {err}"

    # Deep reasoning step — create a plan before acting
    plan = None
    if needs_tools and len(user_text) > 20:
        if on_log:
            await on_log("🧠 Запуск глубокого размышления (Reasoning)...")
        if on_status:
            await on_status("🧠 Анализирую и составляю план...")
        from reasoning import reason
        ctx_parts = []
        for m in messages[-6:]:
            ctx_parts.append(f"{m['role']}: {m['content'][:300]}")
        try:
            plan = await reason(user_text, "\n".join(ctx_parts), cancel_event)
        except asyncio.CancelledError:
            return "⏹ Задача отменена."
        except Exception as e:
            logger.warning(f"Reasoning error: {e}")
            plan = None
        if plan and plan.get("steps"):
            steps_str = "\n".join(f"  • {s['step']}. [{s['tool']}] {s['description'][:80]}" for s in plan["steps"])
            if on_log:
                await on_log(f"📋 План:\n{steps_str}")
            plan_summary = "\n".join(f"  {s['step']}. [{s['tool']}] {s['description'][:100]}" for s in plan["steps"])
            if on_status:
                await on_status(f"📋 План:\n{plan_summary[:200]}...")
            if plan.get("needs_web_search"):
                if on_log:
                    await on_log("🔍 Запланирован веб-поиск")
                if on_status:
                    await on_status("🔍 Потребуется веб-поиск — выполняю исследование...")

    ctx_note = ""
    if memory_context:
        ctx_note = f"\n\nRelevant context from previous conversations:\n{memory_context}"
    if plan and plan.get("steps"):
        plan_str = json.dumps(plan, ensure_ascii=False, indent=2)
        ctx_note += f"\n\n## Reasoning Plan\nFollow this plan:\n{plan_str}"

    sys_msg = {"role": "system", "content": AGENT_SYSTEM_PROMPT + ctx_note}
    full_messages = [sys_msg] + messages
    tool_calls_count = 0
    tried_fallback = False
    no_tool_retries = 0

    if on_status:
        await on_status("🤔 Выполняю...")
    if on_log:
        await on_log("🚀 Запуск агента...")

    while tool_calls_count < MAX_TOOL_CALLS:
        if cancel_event and cancel_event.is_set():
            return "⏹ Задача отменена."

        if on_log:
            await on_log(f"🔄 Шаг {tool_calls_count + 1}: обращение к LLM...")

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
                if on_log:
                    await on_log(f"🔄 Модель {AGENT_MODEL} не ответила, переключение на {AGENT_FALLBACK_MODEL}")
                if on_status:
                    await on_status(f"🔄 fallback на {AGENT_FALLBACK_MODEL}...")
                full_messages.append({
                    "role": "system",
                    "content": f"Previous model failed. Now using {AGENT_FALLBACK_MODEL}. Continue.",
                })
                continue
            err = str(e)
            if _is_html(err):
                err = err[:200] + "... (HTML ответ от API)"
            return f"❌ Ошибка AI: {err}"

        if not resp or not resp.choices:
            continue

        msg = resp.choices[0].message
        if not msg:
            continue

        if not msg.tool_calls:
            if needs_tools and no_tool_retries < 2:
                no_tool_retries += 1
                if on_log:
                    await on_log(f"🤔 Модель не использует инструменты, напоминаю (попытка {no_tool_retries + 1})")
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
            final = await _ensure_html_hosted(final)
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

            if on_log:
                args_str = json.dumps(fn_args, ensure_ascii=False)[:120]
                await on_log(f"🛠 Шаг {tool_calls_count}: `{fn_name}`\n{args_str}")

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
                result = await _ensure_html_hosted(result)
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
    final = await _ensure_html_hosted(final)
    return final
