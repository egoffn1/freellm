import os
import asyncio
import signal
import logging
from collections import defaultdict
from pathlib import Path

from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters

from config import TELEGRAM_BOT_TOKEN, FREELLM_BASE_URL, WORKSPACE_DIR, MAX_HISTORY
from agent import run_agent
from tools import get_and_clear_created_files
from server import start_web_server


logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

user_history: dict[int, list] = defaultdict(list)


async def start(update: Update, _ctx):
    await update.message.reply_text(
        "🤖 *FreeLLM Agent Bot*\n\n"
        "AI-агент для работы с кодом, как Opencode или Claude Code.\n\n"
        "**Как работать:**\n"
        "1. 📤 Пришлите файл — бот сохранит его в workspace\n"
        "2. 📋 Напишите задачу — бот сам прочитает, изменит, создаст\n"
        "3. 📦 `/clone` репозиторий и работайте с ним\n\n"
        "**Примеры:**\n"
        "• `напиши main.py с веб-сервером`\n"
        "• `пофикси баги` (после загрузки файла)\n"
        "• `создай докерфайл`\n"
        "• `/clone https://github.com/user/repo`\n\n"
        "Команды:\n"
        "/help — подробнее\n"
        "/clone <url> — клонировать репозиторий\n"
        "/reset — сбросить историю\n"
        "/status — статус",
        parse_mode="Markdown",
    )


async def help_cmd(update: Update, _ctx):
    await update.message.reply_text(
        "*Команды:*\n"
        "/start — приветствие\n"
        "/help — эта справка\n"
        "/clone <url> — клонировать Git-репозиторий\n"
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
        parse_mode="Markdown",
    )


async def clone(update: Update, _ctx):
    url = update.message.text.replace("/clone", "").strip()
    if not url:
        await update.message.reply_text(
            "Укажите URL репозитория:\n`/clone https://github.com/user/repo`",
            parse_mode="Markdown",
        )
        return

    msg = await update.message.reply_text(f"📦 Клонирую `{url}`...")
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
            await msg.edit_text(
                f"✅ Репозиторий склонирован в `{dirname}`\n"
                f"Теперь напишите задачу для работы с этим проектом.",
                parse_mode="Markdown",
            )
        else:
            err = stderr.decode()[:500]
            await msg.edit_text(f"❌ Ошибка клонирования:\n`{err}`", parse_mode="Markdown")
    except Exception as e:
        await msg.edit_text(f"❌ Ошибка: {e}")


async def reset(update: Update, _ctx):
    uid = update.effective_user.id
    user_history[uid] = []
    await update.message.reply_text("🗑 История диалога очищена.")


async def status(update: Update, _ctx):
    from openai import OpenAI
    from config import AGENT_MODEL

    client = OpenAI(base_url=FREELLM_BASE_URL, api_key="unused")
    try:
        models = client.models.list()
        names = [m.id for m in models if not m.id.startswith("free-")]
        import shutil
        has_git = shutil.which("git") is not None
        await update.message.reply_text(
            f"✅ FreeLLM: доступен\n"
            f"Модель: `{AGENT_MODEL}`\n"
            f"Моделей всего: {len(names)}\n"
            f"Git: {'✅' if has_git else '❌'}",
            parse_mode="Markdown",
        )
    except Exception as e:
        await update.message.reply_text(f"❌ FreeLLM недоступен: {e}")


async def handle_file(update: Update, ctx):
    uid = update.effective_user.id
    msg = update.message

    file = msg.document or (msg.photo[-1] if msg.photo else None)
    if not file:
        return

    status = await msg.reply_text("📥 Скачиваю файл...")

    try:
        tg_file = await ctx.bot.get_file(file.file_id)
        fname = getattr(file, "file_name", None) or f"file_{file.file_id[:8]}"

        dest = Path(WORKSPACE_DIR) / fname
        dest.parent.mkdir(parents=True, exist_ok=True)

        await tg_file.download_to_drive(dest)
        rel = str(dest.relative_to(Path(WORKSPACE_DIR).resolve()))

        from tools import CREATED_FILES
        CREATED_FILES.add(rel)

        await status.edit_text(
            f"✅ Файл сохранён: `{rel}`\n"
            f"Теперь напишите, что с ним сделать.",
            parse_mode="Markdown",
        )
    except Exception as e:
        await status.edit_text(f"❌ Ошибка: {e}")


async def handle_message(update: Update, _ctx):
    uid = update.effective_user.id
    text = update.message.text

    if not text:
        return

    await update.message.chat.send_action("typing")

    messages = user_history[uid]

    max_len = MAX_HISTORY * 2
    if len(messages) > max_len:
        messages[:] = messages[-max_len:]

    messages.append({"role": "user", "content": text})

    status_msg = await update.message.reply_text("🤔 Анализирую задачу...")

    async def on_status(text: str):
        try:
            await status_msg.edit_text(text, parse_mode="Markdown")
        except Exception:
            pass

    answer = await run_agent(messages, on_status=on_status)

    files = get_and_clear_created_files()
    if files:
        await status_msg.delete()
        for fname in files:
            fpath = Path(WORKSPACE_DIR) / fname
            if fpath.is_file():
                with open(fpath, "rb") as f:
                    await update.message.reply_document(
                        document=f,
                        filename=fname,
                    )
        if answer.strip():
            await update.message.reply_text(answer)
    elif len(answer) > 4000:
        await status_msg.delete()
        for i in range(0, len(answer), 4000):
            await update.message.reply_text(answer[i : i + 4000])
    else:
        try:
            await status_msg.edit_text(answer)
        except Exception:
            await update.message.reply_text(answer)


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
    app.add_handler(CommandHandler("status", status))
    app.add_handler(MessageHandler(filters.Document.ALL | filters.PHOTO, handle_file))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    await app.initialize()
    await app.start()
    await app.updater.start_polling(allowed_updates=Update.ALL_TYPES)
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

    await start_web_server(shutdown_event)

    logger.info("Остановка...")
    await app.updater.stop()
    await app.stop()
    await app.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
