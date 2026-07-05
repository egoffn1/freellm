import asyncio
import logging
from pathlib import Path
from aiohttp import web

from config import PORT, WORKSPACE_DIR

logger = logging.getLogger(__name__)

PUBLIC_URL = "https://freellm-bot.onrender.com"


async def handle_health(_request):
    return web.json_response({"status": "ok", "service": "freellm-bot"})


async def handle_index(_request):
    ws = Path(WORKSPACE_DIR)
    files = []
    if ws.exists():
        for f in sorted(ws.iterdir()):
            if f.is_file() and not f.name.startswith("."):
                files.append({"name": f.name, "url": f"/serve/{f.name}"})
    return web.json_response({
        "service": "freellm-bot",
        "description": "Telegram bot for FreeLLM agent",
        "files": files,
    })


async def handle_serve(request):
    filename = request.match_info.get("filename", "")
    if not filename or ".." in filename or "/" in filename:
        raise web.HTTPBadRequest(text="Invalid filename")

    filepath = Path(WORKSPACE_DIR) / filename
    if not filepath.exists() or not filepath.is_file():
        raise web.HTTPNotFound(text=f"File {filename} not found")

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

    return web.Response(body=content, content_type=mime)


async def start_web_server(shutdown_event: asyncio.Event | None = None):
    app = web.Application()
    app.router.add_get("/", handle_index)
    app.router.add_get("/healthz", handle_health)
    app.router.add_get("/serve/{filename:.+}", handle_serve)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", PORT)
    await site.start()

    logger.info(f"Web server running on 0.0.0.0:{PORT}")
    logger.info(f"Static files served at {PUBLIC_URL}/serve/")

    if shutdown_event:
        await shutdown_event.wait()
        await runner.cleanup()
