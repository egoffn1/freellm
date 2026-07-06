import os
import json
import asyncio
import signal
import logging
import time
from collections import defaultdict
from pathlib import Path

from telegram import Update, InlineKeyboardMarkup, ReplyKeyboardMarkup, KeyboardButton
from telegram.ext import Application, CommandHandler, MessageHandler, filters, CallbackQueryHandler

from config import (
    TELEGRAM_BOT_TOKEN, FREELLM_BASE_URL, WORKSPACE_DIR, MAX_HISTORY,
    MULTI_AGENT_ENABLED, RAG_ENABLED, GUARDRAILS_ENABLED, SANDBOX_ENABLED,
    RATE_LIMIT_PER_MINUTE, MAX_CONCURRENT_TASKS, AGENT_TIMEOUT_SECONDS,
    MAX_CONTEXT_SIZE_CHARS, MAX_HISTORY_LOAD_FILES, MAX_FILE_SIZE_MB,
)
from agent import run_agent
from tools import get_and_clear_created_files, current_user_id
from server import start_web_server
from cleanup import run_cleanup_loop
from firebase_db import init_firebase
from prompt_loader import init_prompts
from emoji import premium, premium_btn


logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024

user_history: dict[int, list] = defaultdict(list)
running_tasks: dict[int, asyncio.Task] = {}
cancel_events: dict[int, asyncio.Event] = {}
stop_requests: set[int] = set()           # per-user stop request (after /stop)
stop_all_requests: set[int] = set()       # per-user stop request (after /stop_all, blocks ALL task starts)
user_rate_limits: dict[int, list[float]] = defaultdict(list)
task_semaphore = asyncio.Semaphore(MAX_CONCURRENT_TASKS)
HISTORY_DIR = Path(WORKSPACE_DIR) / ".histories"


async def reply(msg, text: str, **kw):
    kw["parse_mode"] = "HTML"
    kw.pop("markdown", None)
    from emoji import md_to_html
    return await msg.reply_text(md_to_html(text), **kw)


async def reply_with_kb(msg, text: str, reply_markup=None, **kw):
    kw["parse_mode"] = "HTML"
    kw.pop("markdown", None)
    from emoji import md_to_html
    return await msg.reply_text(md_to_html(text), reply_markup=reply_markup, **kw)


async def edit(msg, text: str, **kw):
    kw["parse_mode"] = "HTML"
    from emoji import md_to_html
    from telegram.error import BadRequest
    try:
        return await msg.edit_text(md_to_html(text), **kw)
    except BadRequest as e:
        if "message is not modified" in str(e).lower():
            return
        raise


def main_keyboard():
    buttons = [
        [KeyboardButton("🌐 Создать сайт"), KeyboardButton("🔍 Поиск")],
        [KeyboardButton("📁 Мои файлы"), KeyboardButton("⚙️ Настройки")],
        [KeyboardButton("🛑 Стоп"), KeyboardButton("📋 Статус")],
    ]
    return ReplyKeyboardMarkup(buttons, resize_keyboard=True)


def _load_histories():
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    loaded = 0
    for f in HISTORY_DIR.iterdir():
        if f.suffix == ".json":
            if loaded >= MAX_HISTORY_LOAD_FILES:
                logger.warning(f"Hit max history load limit ({MAX_HISTORY_LOAD_FILES})")
                break
            try:
                if f.stat().st_size > 1024 * 1024:
                    logger.warning(f"History file too large, skipping: {f.name}")
                    f.unlink(missing_ok=True)
                    continue
                uid = int(f.stem)
                data = json.loads(f.read_text())
                for m in data:
                    if m.get("content") is None:
                        m["content"] = ""
                user_history[uid] = data[-MAX_HISTORY * 2:]
                loaded += 1
            except Exception as e:
                logger.warning(f"Failed to load history {f.name}: {e}")
    logger.info(f"Loaded {loaded} user histories")


def _save_history(uid: int, messages: list):
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    path = HISTORY_DIR / f"{uid}.json"
    out = []
    for m in messages[-MAX_HISTORY * 2:]:
        m = dict(m)
        if m.get("content") is None:
            m["content"] = ""
        out.append(m)
    try:
        path.write_text(json.dumps(out, ensure_ascii=False))
    except Exception as e:
        logger.warning(f"Failed to save history for {uid}: {e}")


def _trim_history_by_size(messages: list, max_chars: int = MAX_CONTEXT_SIZE_CHARS) -> list:
    total = sum(len(m.get("content") or "") for m in messages)
    while total > max_chars and len(messages) > 2:
        removed = messages.pop(0)
        total -= len(removed.get("content") or "")
    return messages


def _rate_limit(uid: int) -> bool:
    now = time.time()
    window = 60.0
    limits = user_rate_limits[uid]
    limits[:] = [t for t in limits if now - t < window]
    if len(limits) >= RATE_LIMIT_PER_MINUTE:
        return False
    limits.append(now)
    return True


def inline_task_actions() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [
            premium_btn("🔄 Повторить", callback_data="retry"),
            premium_btn("🛑 Стоп", callback_data="stop"),
        ],
        [
            premium_btn("📋 Статус", callback_data="status"),
            premium_btn("🗑 Сброс", callback_data="reset"),
        ],
    ])


async def handle_callback(update: Update, _ctx):
    query = update.callback_query
    await query.answer()
    data = query.data
    uid = update.effective_user.id

    cmd_map = {
        "stop": "/stop",
        "reset": "/reset",
        "status": "/status",
        "clean": "/clean",
        "retry": None,
    }

    if data == "retry":
        messages = user_history.get(uid, [])
        last_user = None
        for m in reversed(messages):
            if m["role"] == "user":
                last_user = m["content"]
                break
        if last_user:
            from emoji import md_to_html
            status_msg = await query.message.reply_text(md_to_html("🤔 Повторяю..."), parse_mode="HTML")
            await _execute_agent_task(
                update.effective_user, uid, messages, status_msg,
                cancel_events, running_tasks, user_history, task_semaphore, user_rate_limits,
            )
        return

    if data.startswith("settings_"):
        await _handle_settings_callback(query, uid, data)
        return

    cmd = cmd_map.get(data)
    if cmd:
        handler_map = {
            "/stop": stop_cmd,
            "/reset": reset,
            "/status": status,
            "/clean": clean,
        }
        handler = handler_map.get(cmd)
        if handler:
            fake_update = update
            fake_update.message = query.message
            await handler(fake_update, _ctx)


async def _handle_settings_callback(query, uid: int, data: str):
    from firebase_db import get_user_settings, save_user_settings
    from emoji import md_to_html
    settings = get_user_settings(uid)

    if data == "settings_lang":
        new_lang = "en" if settings.get("language") == "ru" else "ru"
        save_user_settings(uid, {"language": new_lang})
        emoji = "🇬🇧 English" if new_lang == "en" else "🇷🇺 Русский"
        await query.edit_message_text(md_to_html(f"✅ Язык изменён на {emoji}"))

    elif data == "settings_model":
        models = ["", "groq/llama-3.3-70b-versatile", "github/openai/gpt-4o-mini", "groq/qwen-qwq-32b", "groq/qwen-2.5-coder-32b"]
        current = settings.get("model", "")
        idx = (models.index(current) + 1) % len(models) if current in models else 1
        new_model = models[idx]
        save_user_settings(uid, {"model": new_model})
        label = new_model if new_model else "по умолчанию"
        await query.edit_message_text(md_to_html(f"✅ Модель: {label}"))

    elif data == "settings_notif":
        new_val = not settings.get("notifications", True)
        save_user_settings(uid, {"notifications": new_val})
        await query.edit_message_text(md_to_html(f"✅ Уведомления: {'вкл' if new_val else 'выкл'}"))

    elif data == "settings_integrations":
        from firebase_db import list_integrations, get_integration
        services = list_integrations(uid)
        lines = ["🔗 **Подключенные сервисы**\n"]
        if services:
            for s in services:
                lines.append(f"• **{s}** — ✅")
        else:
            lines.append("Нет подключенных сервисов.")
        lines.append("\nДоступно: Gmail, GitHub (скоро), Discord (скоро)")
        await query.edit_message_text(md_to_html("\n".join(lines)), parse_mode="HTML")

    elif data == "settings_close":
        await query.message.delete()


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
        "🤖 *ТНИИ* — AI-ассистент как Opencode / Claude / ChatGPT\n\n"
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
        "/clone &lt;url&gt; — клонировать репозиторий\n"
        "/clean — удалить старые файлы (&gt;3 дней)\n"
        "/reset — сбросить историю\n"
        "/stop — остановить задачу\n"
        "/settings — настройки пользователя\n"
        "/integrations — подключенные сервисы\n"
        "/status — статус и фишки",
        reply_markup=main_keyboard(),
    )


async def help_cmd(update: Update, _ctx):
    await reply(update.message,
        "*Команды:*\n"
        "/start — приветствие\n"
        "/help — эта справка\n"
        "/clone <url> — клонировать репозиторий\n"
        "/clean — удалить файлы старше 3 дней\n"
        "/reset — очистить историю\n"
        "/status — проверить ТНИИ\n\n"
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

    uid = update.effective_user.id
    user_ws = Path(WORKSPACE_DIR) / str(uid)
    user_ws.mkdir(parents=True, exist_ok=True)

    msg = await reply(update.message, f"📦 Клонирую `{url}`...")
    try:
        proc = await asyncio.create_subprocess_shell(
            f"git clone --depth 1 --single-branch {url}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(user_ws),
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)
        except asyncio.TimeoutError:
            proc.kill()
            await edit(msg, "❌ Таймаут клонирования (60s).")
            return

        if proc.returncode == 0:
            import re
            text = stderr.decode() + stdout.decode()
            m = re.search(r"'(.*?)'", text)
            dirname = m.group(1) if m else url.rstrip("/").split("/")[-1].replace(".git", "")
            full_path = user_ws / dirname
            if not full_path.exists():
                for p in user_ws.iterdir():
                    if p.is_dir() and p.name not in (".git", "__pycache__"):
                        dirname = p.name
                        break
            messages = user_history.get(uid, [])
            messages.append({"role": "system", "content": f"[Репозиторий склонирован в папку: {dirname}]"})
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
    from config import AGENT_MODEL, AGENT_CODE_MODEL, AGENT_FALLBACK_MODEL

    client = OpenAI(base_url=FREELLM_BASE_URL, api_key="unused")
    try:
        models = client.models.list()
        names = [m.id for m in models if not m.id.startswith("free-")]
        import shutil
        has_git = shutil.which("git") is not None

        status_lines = [
            "✅ *ТНИИ:* доступен",
            f"📊 *Моделей:* {len(names)}",
            f"🧠 *Модель:* `{AGENT_MODEL}`",
            f"💻 *Код-модель:* `{AGENT_CODE_MODEL}`",
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
        await reply(update.message, f"❌ ТНИИ недоступен: {e}")


async def projects_cmd(update: Update, _ctx):
    uid = update.effective_user.id
    from artifacts import list_projects, get_project, build_project_summary
    projects = list_projects(uid)
    if not projects:
        await reply(update.message, "📦 Нет созданных проектов. Попросите бота создать multi-file проект.")
        return
    parts = ["📦 *Проекты:*\n"]
    for name in projects[-5:]:
        proj = get_project(name, uid)
        if proj:
            parts.append(f"• `{name}` — {len(proj.get('files', []))} файлов")
    await reply(update.message, "\n".join(parts))


async def history_cmd(update: Update, _ctx):
    uid = update.effective_user.id
    msgs = user_history.get(uid, [])
    total_size = sum(len(m.get("content", "")) for m in msgs)
    await reply(update.message,
        f"📋 История диалога: {len(msgs)} сообщений\n"
        f"Максимум: {MAX_HISTORY * 2}\n"
        f"Размер: {total_size} / {MAX_CONTEXT_SIZE_CHARS} chars\n"
        f"Первое: {msgs[0]['content'][:50] if msgs else '—'}"
    )


async def handle_file(update: Update, ctx):
    uid = update.effective_user.id
    msg = update.message
    current_user_id.set(uid)

    file = msg.document or (msg.photo[-1] if msg.photo else None)
    if not file:
        return

    if file.file_size and file.file_size > MAX_FILE_SIZE_BYTES:
        await reply(msg, f"❌ Файл слишком большой (макс. {MAX_FILE_SIZE_MB}MB)")
        return

    status = await reply(msg, "📥 Скачиваю файл...")

    try:
        tg_file = await ctx.bot.get_file(file.file_id)
        fname = getattr(file, "file_name", None) or f"file_{file.file_id[:8]}"

        if msg.photo and "." not in fname:
            fname += ".jpg"

        user_dir = Path(WORKSPACE_DIR) / str(uid)
        dest = user_dir / fname
        dest.parent.mkdir(parents=True, exist_ok=True)

        await tg_file.download_to_drive(dest)
        rel = str(dest.relative_to(user_dir))

        from tools import CREATED_FILES
        CREATED_FILES.setdefault(uid, set()).add(rel)

        messages = user_history[uid]

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
                if caption:
                    await edit(status, f"👁 Анализ готов. Выполняю: {caption}")
                    await _execute_agent_task(update, uid, messages, status, cancel_events, running_tasks, user_history, task_semaphore, user_rate_limits)
                return
        caption = (msg.caption or "").strip()
        messages.append({"role": "user", "content": f"[Загружен файл: {rel}]" + (f" — {caption}" if caption else "")})
        if caption:
            await edit(status, f"📥 Файл `{rel}` сохранён, выполняю: {caption[:100]}...")
            await _execute_agent_task(update, uid, messages, status, cancel_events, running_tasks, user_history, task_semaphore, user_rate_limits)
        else:
            await edit(status, f"✅ Файл сохранён: `{rel}`")
    except Exception as e:
        await edit(status, f"❌ Ошибка: {e}")


async def _execute_agent_task(
    update: Update,
    uid: int,
    messages: list,
    status_msg,
    cancel_events: dict,
    running_tasks: dict,
    user_history: dict,
    task_semaphore: asyncio.Semaphore,
    user_rate_limits: dict,
):
    if not _rate_limit(uid):
        await reply(update.message, "⏳ Слишком много запросов. Подождите минуту.")
        return

    if uid in stop_requests:
        stop_requests.discard(uid)
        await edit(status_msg, "⏹ Задача остановлена.")
        return

    if uid in stop_all_requests:
        await edit(status_msg, "⏹ Все задачи остановлены.")
        return

    if uid in running_tasks and not running_tasks[uid].done():
        if uid in cancel_events:
            cancel_events[uid].set()
        running_tasks[uid].cancel()
        await asyncio.sleep(0.3)

    await update.message.chat.send_action("typing")

    max_len = MAX_HISTORY * 2
    if len(messages) > max_len:
        messages[:] = messages[-max_len:]

    messages = _trim_history_by_size(messages, MAX_CONTEXT_SIZE_CHARS)

    cancel_event = cancel_events[uid] = asyncio.Event()

    log_lines = []
    status_text = "🤔 Выполняю..."

    async def on_status(text: str):
        nonlocal status_msg, status_text
        status_text = text
        try:
            await edit(status_msg, text)
        except Exception:
            try:
                status_msg = await reply(update.message, text)
            except Exception:
                pass

    async def on_log(text: str):
        nonlocal status_msg, status_text
        log_lines.append(text)
        visible = "\n".join(log_lines[-8:])
        try:
            await edit(status_msg, f"{status_text}\n\n📋 **Лог действий:**\n{visible[:3500]}")
        except Exception:
            try:
                status_msg = await reply(update.message, f"🤔 Выполняю...\n\n📋 **Лог действий:**\n{visible[:3500]}")
            except Exception:
                pass

    get_and_clear_created_files(uid)
    current_user_id.set(uid)

    async def run_with_timeout():
        async with task_semaphore:
            return await asyncio.wait_for(
                run_agent(messages, on_status=on_status, on_log=on_log, cancel_event=cancel_event, user_id=uid),
                timeout=AGENT_TIMEOUT_SECONDS,
            )

    task = asyncio.create_task(run_with_timeout())
    running_tasks[uid] = task

    try:
        answer = await task
    except asyncio.CancelledError:
        answer = "⏹ Задача отменена."
    except asyncio.TimeoutError:
        answer = f"⏱ Таймаут ({AGENT_TIMEOUT_SECONDS}с). Попробуйте разбить задачу на части."
    except Exception as e:
        logger.error(f"Task crashed: {e}", exc_info=True)
        answer = f"❌ Ошибка выполнения: {e}"
    finally:
        if uid in running_tasks and running_tasks[uid] is task:
            del running_tasks[uid]
        if uid in cancel_events and cancel_events[uid] is cancel_event:
            del cancel_events[uid]
        if uid in running_tasks and running_tasks.get(uid) is not task:
            logger.info(f"Task for {uid} was replaced — orphaned task ended")
        if uid in cancel_events and cancel_events.get(uid) is not cancel_event:
            cancel_events[uid].set()

    files = get_and_clear_created_files(uid)
    if files:
        for fname in files:
            messages.append({"role": "system", "content": f"[Создан файл: {fname}]"})
        try:
            await status_msg.delete()
        except Exception:
            pass
        for fname in files:
            fpath = Path(WORKSPACE_DIR) / str(uid) / fname
            if fpath.is_file():
                with open(fpath, "rb") as f:
                    await update.message.reply_document(
                        document=f,
                        filename=fname,
                    )
        kb = inline_task_actions()
        if answer.strip():
            await reply_with_kb(update.message, answer, reply_markup=kb)
        else:
            await reply_with_kb(update.message, "✅ Готово.", reply_markup=kb)
    elif len(answer) > 4000:
        try:
            await status_msg.delete()
        except Exception:
            pass
        parts = [answer[i : i + 4000] for i in range(0, len(answer), 4000)]
        for i, part in enumerate(parts):
            kb = inline_task_actions() if i == len(parts) - 1 else None
            await reply_with_kb(update.message, part, reply_markup=kb)
    else:
        kb = inline_task_actions()
        try:
            await edit(status_msg, answer)
            await status_msg.edit_reply_markup(reply_markup=kb)
        except Exception:
            await reply_with_kb(update.message, answer, reply_markup=kb)

    _save_history(uid, messages)


async def stop_cmd(update: Update, _ctx):
    uid = update.effective_user.id
    stop_requests.add(uid)

    for ev_uid, ev in list(cancel_events.items()):
        if ev_uid == uid:
            ev.set()
    for task_uid, task in list(running_tasks.items()):
        if task_uid == uid and not task.done():
            task.cancel()
            logger.info(f"stop_cmd: cancelled task for {uid}")

    await reply(update.message, "⏹ Задача остановлена.")


async def stop_all_cmd(update: Update, _ctx):
    uid = update.effective_user.id
    stop_all_requests.add(uid)

    task_count = len(running_tasks)

    for ev in cancel_events.values():
        ev.set()
    for task in list(running_tasks.values()):
        if not task.done():
            task.cancel()

    running_tasks.clear()
    cancel_events.clear()
    stop_requests.clear()

    await reply(update.message, "⏹ **Все** задачи остановлены.")
    logger.warning(f"User {uid} stopped ALL tasks ({task_count} running)")


async def settings_cmd(update: Update, _ctx):
    uid = update.effective_user.id
    from firebase_db import get_user_settings, list_integrations
    settings = get_user_settings(uid)
    integrations = list_integrations(uid)

    lang = "🇷🇺 Русский" if settings.get("language") == "ru" else "🇬🇧 English"
    model = settings.get("model") or "по умолчанию"
    notif = "✅ Вкл" if settings.get("notifications") else "❌ Выкл"
    ints = ", ".join(integrations) if integrations else "—"

    kb = InlineKeyboardMarkup([
        [premium_btn(f"Язык: {lang}", callback_data="settings_lang")],
        [premium_btn(f"Модель: {model[:20]}", callback_data="settings_model")],
        [premium_btn(f"Уведомления: {notif}", callback_data="settings_notif")],
        [premium_btn("🔗 Интеграции", callback_data="settings_integrations")],
        [premium_btn("❌ Закрыть", callback_data="settings_close")],
    ])
    await reply(update.message,
        f"⚙️ **Настройки**\n\n"
        f"Язык: {lang}\n"
        f"Модель: {model}\n"
        f"Уведомления: {notif}\n"
        f"Подключено: {ints}",
        reply_markup=kb,
    )


async def integrations_cmd(update: Update, _ctx):
    uid = update.effective_user.id
    from firebase_db import list_integrations, get_integration

    services = list_integrations(uid)
    lines = ["🔗 **Подключенные сервисы**\n"]
    if services:
        for s in services:
            data = get_integration(uid, s)
            connected = data.get("updated_at", "") if data else ""
            lines.append(f"• **{s}** — ✅ подключено")
    else:
        lines.append("Нет подключенных сервисов.")

    lines.append("\nДоступно: Gmail, GitHub (скоро), Discord (скоро)")
    await reply(update.message, "\n".join(lines))


async def prompts_cmd(update: Update, _ctx):
    from prompt_loader import get_prompt_stats
    await reply(update.message, get_prompt_stats())


async def feedback_cmd(update: Update, _ctx):
    text = update.message.text.replace("/feedback", "").strip()
    if not text:
        await reply(update.message, "Напиши что пошло не так:\n`/feedback бот неправильно понял задачу`")
        return

    await reply(update.message, "📝 Спасибо! Отправляю на анализ...")

    from prompt_critic import analyze_error
    result = analyze_error(
        user_message=text,
        ai_response="(жалоба пользователя)",
        error_info=text,
    )
    if result and result.get("rule"):
        from prompt_loader import add_rule
        filename = add_rule(result["rule"], category="feedback")
        await reply(update.message, f"✅ Проанализировано. Добавлено правило: `{filename}`\n\n{result['analysis']}")
    else:
        await reply(update.message, "❌ Не удалось извлечь правило. Ошибка может быть внешней.")


BUTTON_COMMANDS = {
    "🌐 Создать сайт": "создай сайт и запусти его",
    "🔍 Поиск": "найди информацию в интернете",
    "📁 Мои файлы": "/projects",
    "🧹 Очистить": "/clean",
    "🛑 Стоп": "/stop",
    "📋 Статус": "/status",
    "⚙️ Настройки": "/settings",
}


async def handle_message(update: Update, _ctx):
    uid = update.effective_user.id
    text = update.message.text
    if not text:
        return

    text = BUTTON_COMMANDS.get(text, text)
    if text.startswith("/"):
        cmd = text[1:].split()[0]
        cmd_map = {
            "stop": stop_cmd, "stop_all": stop_all_cmd, "reset": reset, "clean": clean,
            "status": status, "projects": projects_cmd,
            "settings": settings_cmd, "integrations": integrations_cmd,
            "prompts": prompts_cmd, "feedback": feedback_cmd,
        }
        handler = cmd_map.get(cmd)
        if handler:
            await handler(update, _ctx)
            return
    # non-command message → user wants to continue, clear stop state
    stop_requests.discard(uid)
    stop_all_requests.discard(uid)
    messages = user_history[uid]
    messages.append({"role": "user", "content": text})
    status_msg = await reply(update.message, "🤔 Анализирую задачу...")
    await _execute_agent_task(
        update, uid, messages, status_msg,
        cancel_events, running_tasks, user_history, task_semaphore, user_rate_limits,
    )


async def main():
    if not TELEGRAM_BOT_TOKEN:
        logger.error("TELEGRAM_BOT_TOKEN не задан!")
        return

    from config import AGENT_MODEL
    logger.info(f"ТНИИ: {FREELLM_BASE_URL} | Модель: {AGENT_MODEL} | Workspace: {WORKSPACE_DIR}")

    from openai import OpenAI
    try:
        OpenAI(base_url=FREELLM_BASE_URL, api_key="unused").models.list()
        logger.info("ТНИИ OK")
    except Exception as e:
        logger.warning(f"ТНИИ недоступен: {e}")

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
    app.add_handler(CommandHandler("stop_all", stop_all_cmd))
    app.add_handler(CommandHandler("settings", settings_cmd))
    app.add_handler(CommandHandler("integrations", integrations_cmd))
    app.add_handler(CommandHandler("prompts", prompts_cmd))
    app.add_handler(CommandHandler("feedback", feedback_cmd))
    app.add_handler(CallbackQueryHandler(handle_callback))
    app.add_handler(MessageHandler(filters.Document.ALL | filters.PHOTO, handle_file))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    _load_histories()
    init_firebase()
    init_prompts()
    await app.initialize()
    await app.start()

    shutdown_event = asyncio.Event()

    async def _shutdown():
        logger.info("Shutting down...")
        for uid, task in list(running_tasks.items()):
            if not task.done():
                task.cancel()
        await asyncio.sleep(5)
        shutdown_event.set()

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, lambda: asyncio.ensure_future(_shutdown()))
        except NotImplementedError:
            pass

    await asyncio.gather(
        start_web_server(telegram_app=app, shutdown_event=shutdown_event),
        run_cleanup_loop(shutdown_event),
    )

    logger.info("Остановка...")
    await app.stop()
    await app.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
