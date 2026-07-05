import os
import re
import logging
from pathlib import Path

from config import WORKSPACE_DIR

logger = logging.getLogger(__name__)

PROMPTS_DIR = Path(WORKSPACE_DIR) / ".prompts"
_INITIALIZED = False


def _ensure_dir():
    PROMPTS_DIR.mkdir(parents=True, exist_ok=True)


def init_prompts(seed: bool = True):
    global _INITIALIZED
    _ensure_dir()
    if seed:
        _seed_defaults()
    _INITIALIZED = True


def _seed_defaults():
    defaults = {
        "000_core.txt": """# Core Rules
- Always use tools to complete tasks, never just describe what you would do.
- If user asks about files, use glob/grep/read to find them first.
- After clone, explore the repo structure before answering questions about it.""",

        "001_errors.txt": """# Error Handling
- If you get rate limited (429), the bot auto-retries. Just continue where you left off.
- If a tool returns an error, report it to user and try an alternative approach.
- Never say you did something if the tool returned an error.""",

        "002_security.txt": """# Security Rules
- Only work within your user's workspace directory.
- Never access files outside the user workspace.
- Never run dangerous commands (rm -rf, sudo, etc.).""",
    }

    for name, content in defaults.items():
        path = PROMPTS_DIR / name
        if not path.exists():
            path.write_text(content, encoding="utf-8")
            logger.info(f"Created prompt file: {name}")


def load_prompts() -> str:
    _ensure_dir()
    files = sorted(PROMPTS_DIR.glob("*.txt"))
    parts = []
    for f in files:
        try:
            text = f.read_text(encoding="utf-8").strip()
            if text:
                parts.append(text)
        except Exception as e:
            logger.warning(f"Failed to read prompt {f.name}: {e}")
    return "\n\n".join(parts)


def add_rule(rule_text: str, category: str = "learned") -> str:
    _ensure_dir()
    existing = sorted(PROMPTS_DIR.glob("*.txt"))
    max_num = 0
    for f in existing:
        m = re.match(r"(\d+)", f.stem)
        if m:
            max_num = max(max_num, int(m.group(1)))

    new_num = max_num + 1
    filename = f"{new_num:03d}_{category}.txt"
    path = PROMPTS_DIR / filename
    path.write_text(rule_text.strip(), encoding="utf-8")
    logger.info(f"New prompt rule saved: {filename}")
    _INITIALIZED = False
    return filename


def reload_prompts():
    global _INITIALIZED
    _INITIALIZED = False
    return load_prompts()


def get_prompt_stats() -> str:
    files = sorted(PROMPTS_DIR.glob("*.txt"))
    lines = [f"📄 Файлов промптов: {len(files)}"]
    for f in files:
        size = len(f.read_text(encoding="utf-8"))
        lines.append(f"  • {f.stem} — {size} симв.")
    return "\n".join(lines)
