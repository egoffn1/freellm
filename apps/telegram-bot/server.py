import asyncio
import logging
from aiohttp import web

from config import PORT

logger = logging.getLogger(__name__)


async def handle_health(_request):
    return web.json_response({"status": "ok", "service": "freellm-bot"})


async def handle_index(_request):
    return web.json_response({
        "service": "freellm-bot",
        "description": "Telegram bot for FreeLLM agent",
        "endpoints": {
            "/": "this page",
            "/healthz": "health check",
        },
    })


async def start_web_server(shutdown_event: asyncio.Event | None = None):
    app = web.Application()
    app.router.add_get("/", handle_index)
    app.router.add_get("/healthz", handle_health)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", PORT)
    await site.start()

    logger.info(f"Web server running on 0.0.0.0:{PORT}")

    if shutdown_event:
        await shutdown_event.wait()
        await runner.cleanup()
