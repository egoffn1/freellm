import asyncio
import re
from openai import OpenAI
from config import FREELLM_BASE_URL, FREELLM_API_KEY


_client = OpenAI(base_url=FREELLM_BASE_URL, api_key=FREELLM_API_KEY)

FILE_PATTERN = re.compile(
    r"(?:создай|напиши|сгенерируй|сделай|make|create|generate|write)\s+"
    r"(?:файл|file|скрипт|script|программу|program|модуль)\s+"
    r"(?:\w+[./])*\w+\.\w+",
    re.IGNORECASE,
)

EXTENSION_MAP = {
    ".py": "python", ".js": "javascript", ".ts": "typescript",
    ".tsx": "typescript", ".jsx": "javascript", ".go": "go",
    ".rs": "rust", ".rb": "ruby", ".java": "java", ".kt": "kotlin",
    ".c": "c", ".cpp": "cpp", ".h": "c", ".hpp": "cpp",
    ".sh": "bash", ".bash": "bash", ".yaml": "yaml", ".yml": "yaml",
    ".json": "json", ".toml": "toml", ".ini": "ini", ".cfg": "ini",
    ".md": "markdown", ".html": "html", ".css": "css",
    ".sql": "sql", ".dockerfile": "dockerfile",
}


def is_file_request(text: str) -> bool:
    return bool(FILE_PATTERN.search(text))


def extract_filename(text: str) -> str | None:
    match = re.search(r"\b[\w./\\]+\.\w+", text)
    return match.group(0) if match else None


def get_extension(filename: str) -> str:
    _, _, ext = filename.rpartition(".")
    return f".{ext}" if ext else ""


async def generate_file_content(messages: list) -> str | None:
    loop = asyncio.get_event_loop()
    file_msg = {
        "role": "system",
        "content": (
            "Ты — генератор файлов. Пользователь просит создать файл. "
            "Верни ТОЛЬКО содержимое файла без пояснений, без markdown-разметки. "
            "Если нужен код — верни только код."
        ),
    }

    try:
        resp = await loop.run_in_executor(
            None,
            lambda: _client.chat.completions.create(
                model="free-smart",
                messages=[file_msg] + messages,
                timeout=120,
            ),
        )
        return resp.choices[0].message.content
    except Exception:
        return None
