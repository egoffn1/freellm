import asyncio
import signal
import logging
from collections import defaultdict

from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters

from config import TELEGRAM_BOT_TOKEN, FREELLM_BASE_URL, MAX_HISTORY
from agent import run_agent
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
        "**Возможности:**\n"
        "• 📖 Читать и анализировать код\n"
        "• ✏️ Создавать и редактировать файлы\n"
        "• 🔍 Искать по коду (glob, grep)\n"
        "• 🖥 Запускать команды в терминале\n"
        "• 🌐 Загружать веб-страницы\n"
        "• 📋 Планировать и выполнять многошаговые задачи\n\n"
        "Команды:\n"
        "/help — подробнее\n"
        "/reset — сбросить историю\n"
        "/status — статус моделей",
        parse_mode="Markdown",
    )


async def help_cmd(update: Update, _ctx):
    await update.message.reply_text(
        "*FreeLLM Agent Bot — справка*\n\n"
        "Просто напишите задачу — бот сам решит, какие инструменты использовать.\n\n"
        "*Примеры:*\n"
        "• \"Покажи структуру проекта\" → glob + read\n"
        "• \"Найди все обработчики ошибок\" → grep\n"
        "• \"Создай REST API на FastAPI\" → write + bash\n"
        "• \"Пофикси баг в функции calculate\" → read + edit\n"
        "• \"Запусти тесты и покажи результаты\" → bash\n"
        "• \"Сравни OpenCode и Claude Code\" → web_fetch + анализ\n\n"
        "Команды:\n"
        "/start — приветствие\n"
        "/help — эта справка\n"
        "/reset — очистить историю\n"
        "/status — проверить FreeLLM",
        parse_mode="Markdown",
    )


async def reset(update: Update, _ctx):
    uid = update.effective_user.id
    user_history[uid] = []
    await update.message.reply_text("🗑 История диалога очищена.")


async def status(update: Update, _ctx):
    from openai import OpenAI
    client = OpenAI(base_url=FREELLM_BASE_URL, api_key="unused")
    try:
        models = client.models.list()
        names = [m.id for m in models if not m.id.startswith("free-")]
        await update.message.reply_text(
            f"✅ FreeLLM доступен\n"
            f"Моделей: {len(names)}"
        )
    except Exception as e:
        await update.message.reply_text(f"❌ FreeLLM недоступен: {e}")


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

    if len(answer) > 4000:
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

    logger.info(f"FreeLLM: {FREELLM_BASE_URL}")

    try:
        from openai import OpenAI
        OpenAI(base_url=FREELLM_BASE_URL, api_key="unused").models.list()
        logger.info("FreeLLM OK")
    except Exception as e:
        logger.warning(f"FreeLLM недоступен: {e}")

    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", help_cmd))
    app.add_handler(CommandHandler("reset", reset))
    app.add_handler(CommandHandler("status", status))
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
