import asyncio
import logging
import os
from pathlib import Path
from aiohttp import web

from config import PORT, WORKSPACE_DIR
from tools import _resolve_uid_by_token

logger = logging.getLogger(__name__)

PUBLIC_URL = os.getenv("RENDER_EXTERNAL_URL", "https://freellm-bot.onrender.com")
_telegram_app = None
_webhook_set = False


async def handle_health(_request):
    return web.json_response({
        "status": "ok",
        "service": "freellm-bot",
        "webhook": _webhook_set,
        "public_url": PUBLIC_URL,
    })


async def handle_index(_request):
    ws = Path(WORKSPACE_DIR)
    files = []
    if ws.exists():
        for f in sorted(ws.iterdir()):
            if f.is_file() and not f.name.startswith("."):
                files.append({"name": f.name, "url": f"/serve/{f.name}"})
    return web.json_response({
        "service": "freellm-bot",
        "description": "Telegram bot for ТНИИ agent",
        "files": files,
    })


async def handle_serve(request):
    filename = request.match_info.get("filename", "")
    if not filename:
        raise web.HTTPBadRequest(text="Invalid filename")

    safe_path = Path(filename)
    if ".." in safe_path.parts or safe_path.is_absolute():
        raise web.HTTPBadRequest(text="Invalid filename")

    import html
    safe_name = html.escape(filename, quote=True)

    parts = filename.split("/", 1)
    if len(parts) == 2:
        uid = _resolve_uid_by_token(parts[0])
        if uid is not None:
            filepath = (Path(WORKSPACE_DIR) / str(uid) / parts[1]).resolve()
        else:
            raise web.HTTPForbidden(text="Invalid access token")
    else:
        filepath = (Path(WORKSPACE_DIR) / filename).resolve()

    base = Path(WORKSPACE_DIR).resolve()
    if not str(filepath).startswith(str(base)):
        raise web.HTTPForbidden(text="Access denied")

    if not filepath.exists() or not filepath.is_file():
        raise web.HTTPNotFound(text=f"File not found")

    content = filepath.read_bytes()
    ext = filepath.suffix.lower()
    mime = {
        ".html": "text/html", ".htm": "text/html",
        ".css": "text/css", ".js": "application/javascript",
        ".json": "application/json", ".png": "image/png",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".gif": "image/gif", ".svg": "image/svg+xml",
        ".txt": "text/plain", ".md": "text/markdown",
        ".py": "text/plain", ".zip": "application/zip",
        ".ico": "image/x-icon",
    }.get(ext, "application/octet-stream")

    return web.Response(
        body=content,
        content_type=mime,
        headers={"Access-Control-Allow-Origin": "*"},
    )


async def handle_webhook(request):
    from telegram import Update
    if not _telegram_app:
        return web.json_response({"error": "not ready"}, status=503)
    try:
        data = await request.json()
        update = Update.de_json(data, _telegram_app.bot)
        await _telegram_app.process_update(update)
        return web.Response(status=200)
    except Exception as e:
        logger.error(f"Webhook error: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def start_web_server(telegram_app=None, shutdown_event: asyncio.Event | None = None):
    global _telegram_app
    _telegram_app = telegram_app

    app = web.Application()
    app.router.add_get("/", handle_index)
    app.router.add_get("/healthz", handle_health)
    app.router.add_get("/serve/{filename:.+}", handle_serve)
    app.router.add_post("/webhook", handle_webhook)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", PORT)
    await site.start()

    logger.info(f"Web server running on 0.0.0.0:{PORT}")
    logger.info(f"Static files served at {PUBLIC_URL}/serve/")

    if _telegram_app:
        webhook_url = f"{PUBLIC_URL}/webhook"
        for attempt in range(5):
            try:
                await _telegram_app.bot.set_webhook(
                    url=webhook_url,
                    allowed_updates=["message", "edited_message", "callback_query"],
                )
                _webhook_set = True
                logger.info(f"Webhook set to {webhook_url}")
                break
            except Exception as e:
                logger.warning(f"Failed to set webhook (attempt {attempt+1}/5): {e}")
                if attempt < 4:
                    await asyncio.sleep(3 * (attempt + 1))

    if shutdown_event:
        await shutdown_event.wait()
        await runner.cleanup()
        if _telegram_app:
            try:
                await _telegram_app.bot.delete_webhook()
            except Exception:
                pass
