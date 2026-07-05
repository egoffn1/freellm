import asyncio
import base64
import contextvars
import subprocess
import re
from pathlib import Path
from typing import Any

from openai import OpenAI

from config import (
    WORKSPACE_DIR, ALLOWED_BASH_PREFIXES, CONFIRM_COMMANDS, MAX_TOOL_CALLS,
    FREELLM_BASE_URL, FREELLM_API_KEY, AGENT_MODEL, MAX_FILE_SIZE_MB,
)


_vison_client = OpenAI(base_url=FREELLM_BASE_URL, api_key=FREELLM_API_KEY)

WORKSPACE = Path(WORKSPACE_DIR).resolve()
MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024

current_user_id = contextvars.ContextVar('current_user_id', default=0)

CREATED_FILES: dict[int, set[str]] = {}


def get_and_clear_created_files(uid: int | None = None) -> set[str]:
    global CREATED_FILES
    if uid is not None:
        files = CREATED_FILES.get(uid, set()).copy()
        CREATED_FILES.pop(uid, None)
        return files
    all_files = set()
    for u in list(CREATED_FILES.keys()):
        all_files.update(CREATED_FILES[u])
    CREATED_FILES.clear()
    return all_files


def _get_user_workspace() -> Path:
    uid = current_user_id.get()
    if uid:
        return WORKSPACE / str(uid)
    return WORKSPACE


def _resolve_path(file_path: str) -> Path:
    p = Path(file_path)
    if not p.is_absolute():
        p = _get_user_workspace() / p
    p = p.resolve()
    base = _get_user_workspace().resolve()
    if not str(p).startswith(str(base)):
        raise PermissionError(f"Path outside user workspace: {file_path}")
    return p


def _check_bash_safe(command: str) -> str | None:
    stripped = command.strip().lstrip("$ ")
    parts = stripped.split()
    if not parts:
        return "Empty command"

    cmd = parts[0]
    base = cmd.split("/")[-1].split(".")[0]

    if base in CONFIRM_COMMANDS and base not in ALLOWED_BASH_PREFIXES:
        return f"SECURITY BLOCKED: command '{base}' is dangerous and not allowed for safety reasons. Use a different approach."

    if base not in ALLOWED_BASH_PREFIXES:
        return f"SECURITY BLOCKED: command '{base}' is not in the allowed commands list. Allowed: basic dev tools, git, python, pip, npm, go, cargo, ls, cat, mkdir, etc."

    return None


async def tool_read(file_path: str, offset: int = 0, limit: int = 2000) -> dict[str, Any]:
    try:
        p = _resolve_path(file_path)
        if not p.exists():
            return {"error": f"File not found: {file_path}"}
        if not p.is_file():
            return {"error": f"Not a file: {file_path}"}

        content = p.read_text(encoding="utf-8", errors="replace")
        lines = content.splitlines()

        start = offset if offset >= 0 else 0
        end = start + limit if limit else len(lines)
        selected = lines[start:end]

        return {
            "content": "\n".join(selected),
            "total_lines": len(lines),
            "start_line": start + 1,
            "end_line": min(end, len(lines)),
        }
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": str(e)}


async def tool_write(file_path: str, content: str) -> dict[str, Any]:
    try:
        if len(content.encode("utf-8")) > MAX_FILE_SIZE_BYTES:
            return {"error": f"File too large: max {MAX_FILE_SIZE_MB}MB"}
        p = _resolve_path(file_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        uid = current_user_id.get()
        rel = str(p.relative_to(_get_user_workspace()))
        CREATED_FILES.setdefault(uid, set()).add(rel)
        return {"written": True, "path": str(p), "size": len(content)}
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": str(e)}


async def tool_edit(file_path: str, old_string: str, new_string: str) -> dict[str, Any]:
    try:
        p = _resolve_path(file_path)
        if not p.exists():
            return {"error": f"File not found: {file_path}"}

        content = p.read_text(encoding="utf-8")
        if old_string not in content:
            return {"error": "old_string not found in file"}

        new_content = content.replace(old_string, new_string, 1)
        if len(new_content.encode("utf-8")) > MAX_FILE_SIZE_BYTES:
            return {"error": f"File too large after edit: max {MAX_FILE_SIZE_MB}MB"}
        p.write_text(new_content, encoding="utf-8")
        uid = current_user_id.get()
        rel = str(p.relative_to(_get_user_workspace()))
        CREATED_FILES.setdefault(uid, set()).add(rel)
        return {"edited": True, "path": str(p)}
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": str(e)}


async def tool_glob(pattern: str, path: str | None = None) -> dict[str, Any]:
    try:
        search_dir = _resolve_path(path) if path else _get_user_workspace()
        matches = sorted(search_dir.rglob(pattern))
        base = _get_user_workspace()
        return {"matches": [str(m.relative_to(base)) for m in matches if m.is_file()]}
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": str(e)}


async def tool_grep(pattern: str, include: str | None = None, path: str | None = None) -> dict[str, Any]:
    try:
        search_dir = _resolve_path(path) if path else _get_user_workspace()
        cmd = ["rg", "-n", pattern, str(search_dir)]
        if include:
            cmd.extend(["-g", include])

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()

        if proc.returncode != 0 and proc.returncode != 1:
            return {"error": stderr.decode() or f"Exit code {proc.returncode}"}

        lines = stdout.decode().strip().split("\n") if stdout.decode().strip() else []
        return {"matches": lines[:200], "total": len(lines)}
    except PermissionError as e:
        return {"error": str(e)}
    except FileNotFoundError:
        return {"error": "rg (ripgrep) not found, use: apt install ripgrep"}
    except Exception as e:
        return {"error": str(e)}


async def tool_bash(command: str, timeout: int = 60, workdir: str | None = None) -> dict[str, Any]:
    danger = _check_bash_safe(command)
    if danger:
        return {"error": danger, "requires_confirmation": True, "command": command}

    try:
        cwd = _resolve_path(workdir) if workdir else _get_user_workspace()
    except PermissionError:
        cwd = _get_user_workspace()

    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(cwd),
            timeout=timeout,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)

        out = stdout.decode("utf-8", errors="replace").strip()
        err = stderr.decode("utf-8", errors="replace").strip()

        result = {
            "exit_code": proc.returncode,
            "stdout": out[:5000],
            "stderr": err[:2000] if err else None,
        }

        if len(out) > 5000:
            result["truncated"] = True

        return result
    except asyncio.TimeoutError:
        return {"error": f"Command timed out after {timeout}s"}
    except Exception as e:
        return {"error": str(e)}


async def tool_web_fetch(url: str, format: str = "markdown") -> dict[str, Any]:
    import httpx
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url, follow_redirects=True)
            resp.raise_for_status()
            text = resp.text

            if format == "markdown":
                try:
                    from markdownify import markdownify as md
                    text = md(text, heading_style="ATX")
                except ImportError:
                    pass

            return {"content": text[:8000], "url": url, "status": resp.status_code}
    except Exception as e:
        return {"error": str(e)}


async def tool_vision(file_path: str, prompt: str = "Опиши что на этом изображении") -> dict[str, Any]:
    try:
        p = _resolve_path(file_path)
        if not p.exists():
            return {"error": f"File not found: {file_path}"}

        if len(p.read_bytes()) > MAX_FILE_SIZE_BYTES:
            return {"error": f"Image too large: max {MAX_FILE_SIZE_MB}MB"}

        raw = p.read_bytes()
        b64 = base64.b64encode(raw).decode("utf-8")
        ext = p.suffix.lower()
        mime = {
            ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".png": "image/png", ".gif": "image/gif",
            ".webp": "image/webp", ".bmp": "image/bmp",
        }.get(ext, "image/png")

        data_url = f"data:{mime};base64,{b64}"

        loop = asyncio.get_event_loop()
        resp = await loop.run_in_executor(
            None,
            lambda: _vison_client.chat.completions.create(
                model="free-smart",
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {"type": "image_url", "image_url": {"url": data_url}},
                        ],
                    }
                ],
                max_tokens=2000,
                timeout=60,
            ),
        )

        return {"analysis": resp.choices[0].message.content}
    except Exception as e:
        return {"error": str(e)}


async def tool_sandbox(code: str, language: str = "python") -> dict[str, Any]:
    from sandbox import run_sandboxed
    return await run_sandboxed(code, language)


async def tool_research(query: str) -> dict[str, Any]:
    from web_search import web_search
    results = await web_search(query)
    return results


async def tool_scaffold(name: str, files: list[dict]) -> dict[str, Any]:
    from artifacts import scaffold_project
    uid = current_user_id.get()
    manifest = await scaffold_project(name, files, user_id=uid)
    return {"project": manifest["name"], "files": manifest["files"], "entry": manifest.get("entry")}


async def tool_list_projects() -> dict[str, Any]:
    from artifacts import list_projects
    return {"projects": list_projects()}


async def tool_get_project(name: str) -> dict[str, Any]:
    from artifacts import get_project, build_project_summary
    proj = get_project(name)
    if not proj:
        return {"error": f"Project '{name}' not found"}
    return {"summary": build_project_summary(proj), "manifest": proj}


async def tool_host_file(filename: str) -> dict[str, Any]:
    from pathlib import Path
    from config import WORKSPACE_DIR
    import os
    PUBLIC_URL = os.getenv("RENDER_EXTERNAL_URL", "https://freellm-bot.onrender.com")
    uid = current_user_id.get()
    fpath = _get_user_workspace() / filename
    if not fpath.exists():
        return {"error": f"File '{filename}' not found in workspace"}
    serve_path = f"{uid}/{filename}" if uid else filename
    url = f"{PUBLIC_URL}/serve/{serve_path}"
    return {"url": url, "filename": filename, "message": f"Файл доступен по ссылке: {url}"}


TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "read",
            "description": "Read the contents of a file. Use offset and limit to read specific sections of large files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {"type": "string", "description": "Path to the file (absolute or relative to workspace)"},
                    "offset": {"type": "integer", "description": "Line number to start from (0-indexed)", "default": 0},
                    "limit": {"type": "integer", "description": "Number of lines to read", "default": 2000},
                },
                "required": ["file_path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write",
            "description": "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {"type": "string", "description": "Path where to write the file"},
                    "content": {"type": "string", "description": "Full content to write"},
                },
                "required": ["file_path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit",
            "description": "Edit a file by replacing the first occurrence of old_string with new_string. Use for targeted changes.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {"type": "string", "description": "Path to the file"},
                    "old_string": {"type": "string", "description": "Text to search for (must be unique)"},
                    "new_string": {"type": "string", "description": "Replacement text"},
                },
                "required": ["file_path", "old_string", "new_string"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "glob",
            "description": "Search for files matching a glob pattern. E.g. '**/*.py' finds all Python files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Glob pattern to match"},
                    "path": {"type": "string", "description": "Directory to search in (defaults to workspace root)"},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "grep",
            "description": "Search file contents using a regex pattern. Uses ripgrep internally.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Regex pattern to search for"},
                    "include": {"type": "string", "description": "File glob filter, e.g. '*.py' or '*.{ts,tsx}'"},
                    "path": {"type": "string", "description": "Directory to search in"},
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Execute a shell command in the workspace. Returns stdout and stderr. Only allowed commands are permitted.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Shell command to execute"},
                    "timeout": {"type": "integer", "description": "Timeout in seconds", "default": 60},
                    "workdir": {"type": "string", "description": "Working directory for the command"},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "vision",
            "description": "Analyze an image file using AI vision. Send the file path and a question about the image. Use this for photos, screenshots, diagrams, etc.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {"type": "string", "description": "Path to the image file"},
                    "prompt": {"type": "string", "description": "Question or instruction about the image", "default": "Опиши что на этом изображении"},
                },
                "required": ["file_path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "web_fetch",
            "description": "Fetch content from a URL. Returns the page content as markdown or text.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "URL to fetch"},
                    "format": {"type": "string", "enum": ["markdown", "text", "html"], "default": "markdown"},
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "task_done",
            "description": "Call this when you have completed the user's request. Provide a summary of what was done.",
            "parameters": {
                "type": "object",
                "properties": {
                    "summary": {"type": "string", "description": "Summary of what was accomplished"},
                    "files": {"type": "array", "items": {"type": "string"}, "description": "List of files created or modified"},
                },
                "required": ["summary"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sandbox",
            "description": "Execute Python code in a secure sandbox with resource limits. Use to test code, run calculations, or analyze data.",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {"type": "string", "description": "Python code to execute"},
                    "language": {"type": "string", "enum": ["python", "shell"], "default": "python"},
                },
                "required": ["code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "research",
            "description": "Search the web for current information. Use when you need up-to-date facts, documentation, or data.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "scaffold",
            "description": "Create a multi-file project. Use for generating complete applications with multiple files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Project name"},
                    "files": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": {"type": "string", "description": "File path relative to project root"},
                                "content": {"type": "string", "description": "File content"},
                                "language": {"type": "string", "description": "Programming language"},
                            },
                            "required": ["path", "content"],
                        },
                        "description": "List of files to create",
                    },
                },
                "required": ["name", "files"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "host_file",
            "description": "CRITICAL: Make a workspace file publicly accessible via URL. You MUST call this after creating ANY HTML files so the user can see the result in a browser. The URL is the ONLY way for users to view web pages you create.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": {"type": "string", "description": "Name of the file in workspace to host"},
                },
                "required": ["filename"],
            },
        },
    },
]

TOOL_NAME_MAP = {
    "read": tool_read,
    "write": tool_write,
    "edit": tool_edit,
    "glob": tool_glob,
    "grep": tool_grep,
    "bash": tool_bash,
    "web_fetch": tool_web_fetch,
    "vision": tool_vision,
    "sandbox": tool_sandbox,
    "research": tool_research,
    "scaffold": tool_scaffold,
    "host_file": tool_host_file,
}
