import logging
from collections import defaultdict

from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters

from config import TELEGRAM_BOT_TOKEN, MAX_HISTORY
from orchestrator import simple_answer, orchestrate, is_complex
from file_handler import is_file_request, generate_file_content, extract_filename, get_extension, EXTENSION_MAP


logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

user_history: dict[int, list] = defaultdict(list)


def _get_history(uid: int) -> list:
    return user_history[uid]


def _add_history(uid: int, role: str, content: str):
    history = user_history[uid]
    history.append({"role": role, "content": content})
    if len(history) > MAX_HISTORY * 2:
        user_history[uid] = history[-MAX_HISTORY * 2 :]


async def start(update: Update, _ctx):
    await update.message.reply_text(
        "🤖 *FreeLLM Telegram Bot*\n\n"
        "Я — шлюз к 8+ бесплатным LLM провайдерам.\n\n"
        "• Простые вопросы — быстрый ответ через free-fast\n"
        "• Сложные вопросы — параллельный опрос нескольких AI\n"
        "• Файлы — отправлю как документ\n\n"
        "Команды:\n"
        "/help — подробнее\n"
        "/reset — сбросить историю\n"
        "/status — статус моделей",
        parse_mode="Markdown",
    )


async def help_cmd(update: Update, _ctx):
    await update.message.reply_text(
        "*Команды:*\n"
        "/start — приветствие\n"
        "/help — эта справка\n"
        "/reset — очистить историю диалога\n"
        "/status — проверить доступность FreeLLM\n\n"
        "*Примеры запросов:*\n"
        "• \"Привет\" — простой вопрос → free-fast\n"
        "• \"Сравни архитектуры микросервисов и монолита\" — сложный → несколько AI\n"
        "• \"Напиши файл main.py с веб-сервером\" — создаст и пришлёт файл\n"
        "• \"Создай docker-compose.yml для PostgreSQL и Redis\" — файл с кодом",
        parse_mode="Markdown",
    )


async def reset(update: Update, _ctx):
    uid = update.effective_user.id
    user_history[uid] = []
    await update.message.reply_text("🗑 История диалога очищена.")


async def status(update: Update, _ctx):
    from openai import OpenAI
    from config import FREELLM_BASE_URL, FREELLM_API_KEY
    client = OpenAI(base_url=FREELLM_BASE_URL, api_key=FREELLM_API_KEY)
    try:
        models = client.models.list()
        names = [m.id for m in models if not m.id.startswith("free-")]
        await update.message.reply_text(
            f"✅ FreeLLM доступен\n"
            f"Моделей: {len(names)}\n"
            f"Провайдеры: Groq, Gemini, Mistral, Cerebras, NVIDIA, Cloudflare, GitHub"
        )
    except Exception as e:
        await update.message.reply_text(f"❌ FreeLLM недоступен: {e}")


async def handle_message(update: Update, _ctx):
    uid = update.effective_user.id
    text = update.message.text

    if not text:
        return

    await update.message.chat.send_action("typing")

    _add_history(uid, "user", text)
    messages = _get_history(uid)

    # File request
    if is_file_request(text):
        content = await generate_file_content(messages)
        if content:
            fname = extract_filename(text) or "output.txt"
            ext = get_extension(fname)
            lang = EXTENSION_MAP.get(ext, "")
            caption = f"📄 `{fname}`" + (f" ({lang})" if lang else "")
            await update.message.reply_document(
                document=content.encode("utf-8"),
                filename=fname,
                caption=caption,
                parse_mode="Markdown",
            )
            _add_history(uid, "assistant", f"[Файл: {fname}]")
        else:
            await update.message.reply_text("❌ Не удалось сгенерировать файл.")
        return

    # Complex question
    if is_complex(text):
        await update.message.reply_text("🔄 Анализирую сложный вопрос — опрашиваю несколько AI моделей...")
        answer = await orchestrate(messages)
    else:
        answer = await simple_answer(messages)

    if answer:
        await update.message.reply_text(answer)
        _add_history(uid, "assistant", answer)
    else:
        await update.message.reply_text("❌ Ошибка получения ответа. Попробуйте позже.")


def main():
    if not TELEGRAM_BOT_TOKEN:
        logger.error("TELEGRAM_BOT_TOKEN не задан!")
        return

    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", help_cmd))
    app.add_handler(CommandHandler("reset", reset))
    app.add_handler(CommandHandler("status", status))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    logger.info("Бот запущен...")
    app.run_polling()


if __name__ == "__main__":
    main()
