import asyncio
import logging
import time
from pathlib import Path

from config import WORKSPACE_DIR, FILE_TTL_DAYS, CLEANUP_INTERVAL_HOURS


logger = logging.getLogger(__name__)

WORKSPACE = Path(WORKSPACE_DIR).resolve()


async def _cleanup_once():
    if not WORKSPACE.is_dir():
        logger.warning(f"Workspace not found: {WORKSPACE}")
        return

    now = time.time()
    cutoff = now - (FILE_TTL_DAYS * 86400)
    removed = 0
    cleaned = 0

    for entry in list(WORKSPACE.rglob("*")):
        if not entry.is_file():
            continue

        try:
            rel = entry.relative_to(WORKSPACE)
        except ValueError:
            continue

        if any(part.startswith(".") for part in rel.parts):
            continue

        mtime = entry.stat().st_mtime
        if mtime < cutoff:
            try:
                entry.unlink()
                removed += 1
            except Exception as e:
                logger.debug(f"Can't delete {rel}: {e}")

    # remove empty dirs
    for entry in sorted(WORKSPACE.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        if entry.is_dir() and entry != WORKSPACE:
            try:
                entry.rmdir()
                cleaned += 1
            except OSError:
                pass  # not empty

    if removed or cleaned:
        logger.info(f"Cleanup: {removed} files deleted, {cleaned} empty dirs removed")


async def run_cleanup_loop(shutdown_event: asyncio.Event):
    logger.info(f"Auto-cleanup: TTL={FILE_TTL_DAYS}d, check every {CLEANUP_INTERVAL_HOURS}h")

    await _cleanup_once()

    while not shutdown_event.is_set():
        try:
            await asyncio.wait_for(shutdown_event.wait(), timeout=CLEANUP_INTERVAL_HOURS * 3600)
            break
        except asyncio.TimeoutError:
            await _cleanup_once()

    logger.info("Cleanup stopped")
