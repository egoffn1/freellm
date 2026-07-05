import os
import json
import asyncio
import signal
import logging
from collections import defaultdict
from pathlib import Path

from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters

from config import TELEGRAM_BOT_TOKEN, FREELLM_BASE_URL, WORKSPACE_DIR, MAX_HISTORY, MULTI_AGENT_ENABLED, RAG_ENABLED, GUARDRAILS_ENABLED, SANDBOX_ENABLED
from agent import run_agent
from tools import get_and_clear_created_files
from server import start_web_server
from cleanup import run_cleanup_loop
from emoji import premium


async def reply(msg, text: str, **kw):
    kw["parse_mode"] = "HTML"
    kw.pop("markdown", None)
    from emoji import md_to_html
    return await msg.reply_text(md_to_html(text), **kw)


async def edit(msg, text: str, **kw):
    kw["parse_mode"] = "HTML"
    from emoji import md_to_html
    return await msg.edit_text(md_to_html(text), **kw)


logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

user_history: dict[int, list] = defaultdict(list)
running_tasks: dict[int, asyncio.Task] = {}
cancel_events: dict[int, asyncio.Event] = {}
HISTORY_DIR = Path(WORKSPACE_DIR) / ".histories"


def _load_histories():
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    for f in HISTORY_DIR.iterdir():
        if f.suffix == ".json":
            try:
                uid = int(f.stem)
                data = json.loads(f.read_text())
                user_history[uid] = data[-MAX_HISTORY * 2:]
            except Exception as e:
                logger.warning(f"Failed to load history {f.name}: {e}")
    logger.info(f"Loaded {len(user_history)} user histories")


def _save_history(uid: int, messages: list):
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    path = HISTORY_DIR / f"{uid}.json"
    try:
        path.write_text(json.dumps(messages[-MAX_HISTORY * 2:], ensure_ascii=False))
    except Exception as e:
        logger.warning(f"Failed to save history for {uid}: {e}")


async def start(update: Update, _ctx):
    features = []
    if MULTI_AGENT_ENABLED:
        features.append("🧠 Мульти-агент (Manager → Researcher → Coder → Critic)")
    if RAG_ENABLED:
        features.append("📀 RAG-память (контекст на всю историю)")
    if GUARDRAILS_ENABLED:
        features.append("🛡 Защита от инъекций и утечек")
    if SANDBOX_ENABLED:
        features.append("🔒 Sandbox для безопасного выполнения кода")
    features.append("🔍 Веб-поиск и исследование")
    features.append("📦 Артефакты (multi-file проекты)")
    features.append("👁 Анализ изображений (Vision)")

    await reply(update.message,
        "🤖 *FreeLLM Agent Bot* — AI-ассистент как Opencode / Claude / ChatGPT\n\n"
        f"**Фишки:**\n" + "\n".join(f"• {f}" for f in features) + "\n\n"
        "**Как работать:**\n"
        "1. 📤 Пришлите файл — бот сохранит его в workspace\n"
        "2. 📋 Напишите задачу — бот сделает\n"
        "3. 📦 `/clone` репозиторий и работайте с ним\n\n"
        "**Примеры:**\n"
        "• `напиши main.py с веб-сервером`\n"
        "• `создай проект калькулятора` (multi-file)\n"
        "• `пофикси баги` (после загрузки файла)\n"
        "• `/clone https://github.com/user/repo`\n\n"
        "Команды:\n"
        "/help — подробнее\n"
        "/clone <url> — клонировать репозиторий\n"
        "/clean — удалить старые файлы (>3 дней)\n"
        "/reset — сбросить историю\n"
        "/stop — остановить задачу\n"
        "/status — статус и фишки",
    )


async def help_cmd(update: Update, _ctx):
    await reply(update.message,
        "*Команды:*\n"
        "/start — приветствие\n"
        "/help — эта справка\n"
        "/clone <url> — клонировать репозиторий\n"
        "/clean — удалить файлы старше 3 дней\n"
        "/reset — очистить историю\n"
        "/status — проверить FreeLLM\n\n"
        "*Как использовать:*\n"
        "• Пришлите файл → бот сохранит и сможет с ним работать\n"
        "• Напишите задачу → бот сделает\n"
        "• `/clone` проект → работайте как с локальным\n\n"
        "*Примеры:*\n"
        "• \"найди ошибки\" (после загрузки файла)\n"
        "• \"создай REST API на FastAPI\"\n"
        "• \"отформатируй проект\"\n"
        "• \"сравни OpenCode и Claude Code\"",
    )


async def clone(update: Update, _ctx):
    url = update.message.text.replace("/clone", "").strip()
    if not url:
        await reply(update.message,
            "Укажите URL репозитория:\n`/clone https://github.com/user/repo`",
        )
        return

    msg = await reply(update.message, f"📦 Клонирую `{url}`...")
    try:
        proc = await asyncio.create_subprocess_shell(
            f"git clone --depth 1 {url}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=WORKSPACE_DIR,
        )
        stdout, stderr = await proc.communicate(timeout=120)

        if proc.returncode == 0:
            # find cloned dir name
            lines = stdout.decode()
            import re
            m = re.search(r"'(.*?)'", stderr.decode() + stdout.decode())
            dirname = m.group(1) if m else url.rstrip("/").split("/")[-1].replace(".git", "")
            await edit(msg,
                f"✅ Репозиторий склонирован в `{dirname}`\n"
                f"Теперь напишите задачу для работы с этим проектом.",
            )
        else:
            err = stderr.decode()[:500]
            await edit(msg, f"❌ Ошибка клонирования:\n`{err}`")
    except Exception as e:
        await edit(msg, f"❌ Ошибка: {e}")


async def clean(update: Update, _ctx):
    from cleanup import _cleanup_once
    msg = await reply(update.message, "🧹 Чищу старые файлы...")
    await _cleanup_once()
    await edit(msg, "✅ Старые файлы удалены.")


async def reset(update: Update, _ctx):
    uid = update.effective_user.id
    user_history[uid] = []
    await reply(update.message, "🗑 История диалога очищена.")


async def status(update: Update, _ctx):
    from openai import OpenAI
    from config import AGENT_MODEL, AGENT_FALLBACK_MODEL

    client = OpenAI(base_url=FREELLM_BASE_URL, api_key="unused")
    try:
        models = client.models.list()
        names = [m.id for m in models if not m.id.startswith("free-")]
        import shutil
        has_git = shutil.which("git") is not None

        status_lines = [
            "✅ *FreeLLM:* доступен",
            f"📊 *Моделей:* {len(names)}",
            f"🧠 *Модель:* `{AGENT_MODEL}`",
            f"🔄 *Fallback:* `{AGENT_FALLBACK_MODEL}`",
            "",
            "⚙️ *Фишки:*",
        ]
        features = [
            ("Мульти-агент", MULTI_AGENT_ENABLED),
            ("RAG-память", RAG_ENABLED),
            ("Guardrails", GUARDRAILS_ENABLED),
            ("Sandbox", SANDBOX_ENABLED),
            ("Git", has_git),
            ("Веб-поиск", True),
            ("Артефакты", True),
            ("Vision", True),
        ]
        for name, enabled in features:
            icon = "✅" if enabled else "❌"
            status_lines.append(f"{icon} {name}")

        await reply(update.message, "\n".join(status_lines))
    except Exception as e:
        await reply(update.message, f"❌ FreeLLM недоступен: {e}")


async def projects_cmd(update: Update, _ctx):
    from artifacts import list_projects, get_project, build_project_summary
    projects = list_projects()
    if not projects:
        await reply(update.message, "📦 Нет созданных проектов. Попросите бота создать multi-file проект.")
        return
    parts = ["📦 *Проекты:*\n"]
    for name in projects[-5:]:
        proj = get_project(name)
        if proj:
            parts.append(f"• `{name}` — {len(proj.get('files', []))} файлов")
    await reply(update.message, "\n".join(parts))


async def history_cmd(update: Update, _ctx):
    uid = update.effective_user.id
    msgs = user_history.get(uid, [])
    await reply(update.message,
        f"📋 История диалога: {len(msgs)} сообщений\n"
        f"Максимум: {MAX_HISTORY * 2}\n"
        f"Первое: {msgs[0]['content'][:50] if msgs else '—'}"
    )


async def handle_file(update: Update, ctx):
    uid = update.effective_user.id
    msg = update.message

    file = msg.document or (msg.photo[-1] if msg.photo else None)
    if not file:
        return

    status = await reply(msg, "📥 Скачиваю файл...")

    try:
        tg_file = await ctx.bot.get_file(file.file_id)
        fname = getattr(file, "file_name", None) or f"file_{file.file_id[:8]}"

        # Ensure unique name for photos without extension
        if msg.photo and "." not in fname:
            fname += ".jpg"

        dest = Path(WORKSPACE_DIR) / fname
        dest.parent.mkdir(parents=True, exist_ok=True)

        await tg_file.download_to_drive(dest)
        rel = str(dest.relative_to(Path(WORKSPACE_DIR).resolve()))

        from tools import CREATED_FILES
        CREATED_FILES.add(rel)

        messages = user_history[uid]

        # photos → auto-analyze with vision
        if msg.photo:
            ext = Path(fname).suffix.lower()
            image_exts = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}
            if ext in image_exts:
                caption = (msg.caption or "").strip()
                prompt = caption if caption else "Опиши подробно что на этом изображении"

                await edit(status, "🔍 Анализирую изображение..." if not caption else f"🔍 {caption}")

                from tools import tool_vision
                result = await tool_vision(rel, prompt)
                analysis = result.get("analysis", "") or result.get("error", "не удалось")

                messages.append({"role": "user", "content": f"[Загружено изображение: {rel}]" + (f" — {caption}" if caption else "")})
                messages.append({"role": "assistant", "content": analysis})

                _save_history(uid, messages)
                await edit(status,
                    f"👁 {analysis[:4000]}",
                )
                return
        else:
            messages.append({"role": "user", "content": f"[Загружен файл: {rel}]"})
            await edit(status,
                f"✅ Файл сохранён: `{rel}`\n"
                f"Теперь напишите, что с ним сделать.",
            )
    except Exception as e:
        await edit(status, f"❌ Ошибка: {e}")


async def stop_cmd(update: Update, _ctx):
    uid = update.effective_user.id
    if uid in running_tasks and not running_tasks[uid].done():
        if uid in cancel_events:
            cancel_events[uid].set()
        running_tasks[uid].cancel()
        await reply(update.message, "⏹ Задача остановлена.")
        logger.info(f"User {uid} cancelled their task")
    else:
        await reply(update.message, "🤷 Нет активной задачи для остановки.")


async def handle_message(update: Update, _ctx):
    uid = update.effective_user.id
    text = update.message.text

    if not text:
        return

    # Cancel any existing task for this user
    if uid in running_tasks and not running_tasks[uid].done():
        if uid in cancel_events:
            cancel_events[uid].set()
        running_tasks[uid].cancel()
        await asyncio.sleep(0.3)

    await update.message.chat.send_action("typing")

    messages = user_history[uid]

    max_len = MAX_HISTORY * 2
    if len(messages) > max_len:
        messages[:] = messages[-max_len:]

    messages.append({"role": "user", "content": text})

    status_msg = await reply(update.message, "🤔 Анализирую задачу...")
    log_msg = await reply(update.message, "📋 Лог:\n")

    cancel_events[uid] = asyncio.Event()

    async def on_status(text: str):
        try:
            await edit(status_msg, text)
        except Exception:
            try:
                nonlocal status_msg
                status_msg = await reply(update.message, text)
            except Exception:
                pass

    async def log_action(text: str):
        try:
            await edit(log_msg, f"📋 Лог:\n{text[:3500]}")
        except Exception:
            try:
                nonlocal log_msg
                log_msg = await reply(update.message, f"📋 Лог:\n{text[:3500]}")
            except Exception:
                pass

    get_and_clear_created_files()

    task = asyncio.create_task(
        run_agent(messages, on_status=on_status, cancel_event=cancel_events[uid])
    )
    running_tasks[uid] = task

    try:
        answer = await task
    except asyncio.CancelledError:
        answer = "⏹ Задача отменена."
    finally:
        if uid in running_tasks and running_tasks[uid] is task:
            del running_tasks[uid]
        if uid in cancel_events:
            del cancel_events[uid]

    try:
        await log_msg.delete()
    except Exception:
        pass

    files = get_and_clear_created_files()

    if not files and "```" in answer:
        import re
        from tools import CREATED_FILES
        blocks = re.findall(r"```(\w+)?\n(.*?)```", answer, re.DOTALL)
        extract_dir = Path(WORKSPACE_DIR)
        extract_dir.mkdir(parents=True, exist_ok=True)
        for i, (lang, code) in enumerate(blocks):
            code = code.strip()
            if not code:
                continue
            name = f"bot_{i+1}.{lang or 'py'}" if lang else f"file_{i+1}.txt"
            (extract_dir / name).write_text(code, encoding="utf-8")
            CREATED_FILES.add(name)
            files.append(name)
        answer = re.sub(r"```\w*\n.*?```", "", answer, flags=re.DOTALL)
        answer = re.sub(r"\n{3,}", "\n\n", answer).strip()
    if files:
        for fname in files:
            messages.append({"role": "system", "content": f"[Создан файл: {fname}]"})
        try:
            await status_msg.delete()
        except Exception:
            pass
        for fname in files:
            fpath = Path(WORKSPACE_DIR) / fname
            if fpath.is_file():
                with open(fpath, "rb") as f:
                    await update.message.reply_document(
                        document=f,
                        filename=fname,
                    )
        if answer.strip():
            await reply(update.message, answer)
    elif len(answer) > 4000:
        try:
            await status_msg.delete()
        except Exception:
            pass
        for i in range(0, len(answer), 4000):
            await reply(update.message, answer[i : i + 4000])
    else:
        try:
            await edit(status_msg, answer)
        except Exception:
            await reply(update.message, answer)

    _save_history(uid, messages)


async def main():
    if not TELEGRAM_BOT_TOKEN:
        logger.error("TELEGRAM_BOT_TOKEN не задан!")
        return

    from config import AGENT_MODEL
    logger.info(f"FreeLLM: {FREELLM_BASE_URL} | Модель: {AGENT_MODEL} | Workspace: {WORKSPACE_DIR}")

    from openai import OpenAI
    try:
        OpenAI(base_url=FREELLM_BASE_URL, api_key="unused").models.list()
        logger.info("FreeLLM OK")
    except Exception as e:
        logger.warning(f"FreeLLM недоступен: {e}")

    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", help_cmd))
    app.add_handler(CommandHandler("clone", clone))
    app.add_handler(CommandHandler("reset", reset))
    app.add_handler(CommandHandler("clean", clean))
    app.add_handler(CommandHandler("status", status))
    app.add_handler(CommandHandler("history", history_cmd))
    app.add_handler(CommandHandler("projects", projects_cmd))
    app.add_handler(CommandHandler("stop", stop_cmd))
    app.add_handler(MessageHandler(filters.Document.ALL | filters.PHOTO, handle_file))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    _load_histories()
    await app.initialize()
    await app.start()

    # Удаляем вебхук, если был установлен ранее — иначе polling не работает
    try:
        await app.bot.delete_webhook(drop_pending_updates=True)
    except Exception as e:
        logger.warning(f"delete_webhook error: {e}")

    # Небольшая пауза, чтобы старый инстанс точно завершился
    await asyncio.sleep(2)

    await app.updater.start_polling(
        allowed_updates=Update.ALL_TYPES,
        poll_interval=1.0,
        timeout=30,
        bootstrap_retries=-1,
    )
    logger.info("🤖 Бот запущен")

    shutdown_event = asyncio.Event()

    async def _shutdown():
        shutdown_event.set()

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, lambda: asyncio.ensure_future(_shutdown()))
        except NotImplementedError:
            pass

    await asyncio.gather(
        start_web_server(shutdown_event),
        run_cleanup_loop(shutdown_event),
    )

    logger.info("Остановка...")
    await app.updater.stop()
    await app.stop()
    await app.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
