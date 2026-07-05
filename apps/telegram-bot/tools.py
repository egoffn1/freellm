import asyncio
import base64
import contextvars
import json
import subprocess
import re
import uuid
from pathlib import Path
from typing import Any

from openai import OpenAI

from config import (
    WORKSPACE_DIR, ALLOWED_BASH_PREFIXES, CONFIRM_COMMANDS, MAX_TOOL_CALLS,
    FREELLM_BASE_URL, FREELLM_API_KEY, AGENT_MODEL, MAX_FILE_SIZE_MB,
)

TOKEN_FILE = Path(WORKSPACE_DIR) / ".user_tokens.json"


def _get_user_token(uid: int) -> str:
    tokens = {}
    if TOKEN_FILE.exists():
        tokens = json.loads(TOKEN_FILE.read_text())
    suid = str(uid)
    if suid not in tokens:
        tokens[suid] = uuid.uuid4().hex[:16]
        TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        TOKEN_FILE.write_text(json.dumps(tokens, ensure_ascii=False))
    return tokens[suid]


def _parse_json_arg(arg):
    if isinstance(arg, str):
        return json.loads(arg)
    return arg


def _resolve_uid_by_token(token: str) -> int | None:
    if not TOKEN_FILE.exists():
        return None
    tokens = json.loads(TOKEN_FILE.read_text())
    for suid, tok in tokens.items():
        if tok == token:
            return int(suid)
    return None


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

        start = max(offset, 0) if offset >= 0 else 0
        end = min(start + limit if limit else len(lines), len(lines))
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
    uid = current_user_id.get()
    return {"projects": list_projects(uid)}


async def tool_get_project(name: str) -> dict[str, Any]:
    from artifacts import get_project, build_project_summary
    uid = current_user_id.get()
    proj = get_project(name, uid)
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
    token = _get_user_token(uid) if uid else ""
    serve_path = f"{token}/{filename}" if token else filename
    url = f"{PUBLIC_URL}/serve/{serve_path}"
    return {"url": url, "filename": filename, "message": f"Файл доступен по ссылке: {url}"}


# ─── Gmail tools ─────────────────────────────────────────────

from config import GMAIL_ENABLED
from gmail import gmail_list as _gmail_list, gmail_read as _gmail_read, gmail_send as _gmail_send, gmail_search as _gmail_search, gmail_unread_count as _gmail_unread_count


async def tool_gmail_list(max_results: int = 10, query: str = "") -> str:
    if not GMAIL_ENABLED:
        return "❌ Gmail отключён. Установи GMAIL_ENABLED=true"
    return await _gmail_list(max_results=max_results, query=query)


async def tool_gmail_read(message_id: str) -> str:
    if not GMAIL_ENABLED:
        return "❌ Gmail отключён."
    return await _gmail_read(message_id=message_id)


async def tool_gmail_send(to: str, subject: str, body: str) -> str:
    if not GMAIL_ENABLED:
        return "❌ Gmail отключён."
    return await _gmail_send(to=to, subject=subject, body=body)


async def tool_gmail_search(query: str, max_results: int = 10) -> str:
    if not GMAIL_ENABLED:
        return "❌ Gmail отключён."
    return await _gmail_search(query=query, max_results=max_results)


async def tool_gmail_unread_count() -> str:
    if not GMAIL_ENABLED:
        return "❌ Gmail отключён."
    return await _gmail_unread_count()


# ─── User settings tools ──────────────────────────────────────

async def tool_user_settings_update(settings_json: str) -> str:
    from firebase_db import get_user_settings, save_user_settings
    uid = current_user_id.get()
    if not uid:
        return "❌ Нет data пользователя."
    try:
        updates = _parse_json_arg(settings_json)
    except (json.JSONDecodeError, TypeError):
        return "❌ Невалидный JSON."

    allowed = {"language", "model", "notifications"}
    if "notifications" in updates:
        updates["notifications"] = str(updates["notifications"]).lower() in ("true", "1", "да", "yes")

    save_user_settings(uid, {k: v for k, v in updates.items() if k in allowed})
    settings = get_user_settings(uid)
    model_label = settings.get("model") or "по умолчанию"
    return f"✅ Настройки обновлены. Модель: {model_label}, язык: {settings.get('language', 'ru')}, уведомления: {'вкл' if settings.get('notifications', True) else 'выкл'}"


async def tool_user_settings_get() -> str:
    from firebase_db import get_user_settings, list_integrations
    uid = current_user_id.get()
    if not uid:
        return "❌ Нет data пользователя."
    settings = get_user_settings(uid)
    integrations = list_integrations(uid)
    lines = [f"Язык: {settings.get('language', 'ru')}"]
    model = settings.get("model")
    if model:
        lines.append(f"Модель: {model}")
    lines.append(f"Уведомления: {'вкл' if settings.get('notifications', True) else 'выкл'}")
    if integrations:
        lines.append(f"Подключено: {', '.join(integrations)}")
    return "\n".join(lines)


async def tool_user_settings_set(key: str, value: str) -> str:
    allowed = {"language", "model", "notifications"}
    if key not in allowed:
        return f"❌ Нельзя изменить {key}. Допустимо: {', '.join(allowed)}"
    from firebase_db import get_user_settings, save_user_settings
    uid = current_user_id.get()
    if not uid:
        return "❌ Нет data пользователя."
    settings = get_user_settings(uid)
    if key == "notifications":
        value = str(value).lower() in ("true", "1", "да", "yes")
    settings[key] = value
    save_user_settings(uid, {key: value})
    model_label = settings.get("model") or "по умолчанию"
    return f"✅ {key} = {value}. Текущая модель: {model_label}, язык: {settings.get('language', 'ru')}"


# ─── Integration & MCP tools ─────────────────────────────────

async def tool_integration_list() -> str:
    from firebase_db import list_all_integrations
    uid = current_user_id.get()
    if not uid:
        return "❌ Нет data пользователя."
    integrations = list_all_integrations(uid)
    if not integrations:
        return "Нет подключенных сервисов."
    lines = ["🔗 **Интеграции:**"]
    for i in integrations:
        svc = i.get("service", "?")
        mcp_type = " (MCP)" if i.get("type") == "mcp" else ""
        enabled = "✅" if i.get("enabled") else "❌"
        lines.append(f"  {enabled} **{svc}**{mcp_type}")
    return "\n".join(lines)


async def tool_integration_connect(service: str, config_json: str = "") -> str:
    from firebase_db import save_integration
    uid = current_user_id.get()
    if not uid:
        return "❌ Нет data пользователя."

    config = {}
    if config_json:
        try:
            config = json.loads(config_json)
        except json.JSONDecodeError:
            return "❌ config_json невалидный JSON."

    if service == "gmail":
        result = await _gmail_list(max_results=1)
        if "❌" in result:
            return f"❌ Gmail не подключён: {result}"
        save_integration(uid, "gmail", {"enabled": True, **config})
        return "✅ Gmail подключён!"

    save_integration(uid, service, {"enabled": True, **config})
    return f"✅ {service} подключён."


async def tool_integration_disconnect(service: str) -> str:
    from firebase_db import delete_integration
    uid = current_user_id.get()
    if not uid:
        return "❌ Нет data пользователя."
    delete_integration(uid, service)
    return f"✅ {service} отключён."


async def tool_mcp_connect(name: str, command: str, args_json: str = "[]", env_json: str = "{}") -> str:
    from firebase_db import save_mcp_server, get_mcp_server
    uid = current_user_id.get()
    if not uid:
        return "❌ Нет data пользователя."

    try:
        args = _parse_json_arg(args_json)
        env = _parse_json_arg(env_json)
    except (json.JSONDecodeError, TypeError):
        return "❌ args_json или env_json невалидный JSON."

    save_mcp_server(uid, name, {"command": command, "args": args, "env": env, "enabled": True})
    return f"✅ MCP сервер '{name}' сохранён. Проверь командой mcp_test."


async def tool_mcp_disconnect(name: str) -> str:
    from firebase_db import delete_mcp_server
    uid = current_user_id.get()
    if not uid:
        return "❌ Нет data пользователя."
    delete_mcp_server(uid, name)
    return f"✅ MCP сервер '{name}' удалён."


async def tool_mcp_list() -> str:
    from firebase_db import list_mcp_servers
    uid = current_user_id.get()
    if not uid:
        return "❌ Нет data пользователя."
    servers = list_mcp_servers(uid)
    if not servers:
        return "Нет подключенных MCP серверов."
    lines = ["🔌 **MCP серверы:**"]
    for s in servers:
        enabled = "✅" if s.get("enabled") else "❌"
        lines.append(f"  {enabled} **{s.get('name', '?')}** — `{s.get('command', '')}`")
    return "\n".join(lines)


async def tool_mcp_test(name: str, tool_name: str = "", args_json: str = "{}") -> str:
    from firebase_db import get_mcp_server
    from mcp_client import mcp_call_server, mcp_list_tools, HAS_MCP

    if not HAS_MCP:
        return "❌ MCP пакет не установлен."

    uid = current_user_id.get()
    if not uid:
        return "❌ Нет data пользователя."

    server = get_mcp_server(uid, name)
    if not server:
        return f"❌ MCP сервер '{name}' не найден."
    if not server.get("enabled"):
        return f"❌ MCP сервер '{name}' отключён."

    command = server.get("command", "")
    args = server.get("args", [])

    if not tool_name:
        tools = await mcp_list_tools(command, args)
        if not tools:
            return f"❌ Не удалось получить список инструментов от '{name}'."
        lines = [f"🔧 **Инструменты MCP '{name}':**"]
        for t in tools:
            lines.append(f"  • **{t['name']}** — {t['description'][:100]}")
        return "\n".join(lines)

    try:
        arguments = _parse_json_arg(args_json)
    except (json.JSONDecodeError, TypeError):
        return "❌ args_json невалидный JSON."

    result = await mcp_call_server(command, args, tool_name, arguments)
    return result


# ─── Tool definitions ─────────────────────────────────────────

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
    {
        "type": "function",
        "function": {
            "name": "gmail_list",
            "description": "List emails from Gmail inbox. Optionally filter by query (same as Gmail search syntax). Returns sender, subject, date, and message ID for each.",
            "parameters": {
                "type": "object",
                "properties": {
                    "max_results": {"type": "integer", "description": "Max results to return (1-50)", "default": 10},
                    "query": {"type": "string", "description": "Gmail search query (e.g. 'from:someone@gmail.com', 'is:unread')"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "gmail_read",
            "description": "Read full content of a specific email by its message ID. Returns headers (from, to, subject, date) and body text.",
            "parameters": {
                "type": "object",
                "properties": {
                    "message_id": {"type": "string", "description": "ID of the message to read"},
                },
                "required": ["message_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "gmail_send",
            "description": "Send an email via Gmail. Requires the recipient address, subject, and body text.",
            "parameters": {
                "type": "object",
                "properties": {
                    "to": {"type": "string", "description": "Recipient email address"},
                    "subject": {"type": "string", "description": "Email subject"},
                    "body": {"type": "string", "description": "Email body text"},
                },
                "required": ["to", "subject", "body"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "gmail_search",
            "description": "Search emails using Gmail search syntax. Same as gmail_list but with required query.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Gmail search query"},
                    "max_results": {"type": "integer", "description": "Max results (1-50)", "default": 10},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "gmail_unread_count",
            "description": "Check Gmail inbox stats: unread count and total messages.",
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "user_settings_get",
            "description": "Get current user settings (language, model, notifications, connected integrations).",
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "user_settings_set",
            "description": "Change ONE user setting. For changing multiple at once use user_settings_update. Allowed keys: language (ru/en), model (model name or empty string for default), notifications (true/false).",
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {"type": "string", "description": "Setting key. Use 'model' to change AI model. Examples: 'groq/qwen-qwq-32b', 'free-fast', 'free-smart'"},
                    "value": {"type": "string", "description": "Setting value. For model: put the full model name like 'groq/qwen-qwq-32b' or 'free-fast' or empty string for default"},
                },
                "required": ["key", "value"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "user_settings_update",
            "description": "Change MULTIPLE user settings at once. Pass a JSON object with the settings to change. Example: {\"model\": \"groq/qwen-qwq-32b\", \"language\": \"ru\"}. Leave model empty string for default.",
            "parameters": {
                "type": "object",
                "properties": {
                    "settings_json": {"type": "string", "description": "JSON object with settings: {\"model\": \"...\", \"language\": \"ru/en\", \"notifications\": true/false}"},
                },
                "required": ["settings_json"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "integration_list",
            "description": "List all connected integrations (Gmail, MCP servers, etc.) for the current user.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "integration_connect",
            "description": "Connect a new integration/service. For Gmail, just call this with service='gmail'. For custom services, pass config_json.",
            "parameters": {
                "type": "object",
                "properties": {
                    "service": {"type": "string", "description": "Service name: gmail, github, discord, etc."},
                    "config_json": {"type": "string", "description": "Optional JSON config for the service"},
                },
                "required": ["service"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "integration_disconnect",
            "description": "Disconnect and remove an integration/service.",
            "parameters": {
                "type": "object",
                "properties": {
                    "service": {"type": "string", "description": "Service name to disconnect"},
                },
                "required": ["service"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "mcp_list",
            "description": "List all configured MCP servers for the current user.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "mcp_connect",
            "description": "Configure a new MCP server. Provide name, command (e.g. npx, python, uvx), args as JSON array, and optional env vars as JSON object.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Name for this MCP server"},
                    "command": {"type": "string", "description": "Command to run (e.g. npx, python, uvx)"},
                    "args_json": {"type": "string", "description": "JSON array of CLI arguments, e.g. [\"-y\", \"@modelcontextprotocol/server-filesystem\", \"/tmp\"]"},
                    "env_json": {"type": "string", "description": "Optional JSON object of environment variables"},
                },
                "required": ["name", "command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "mcp_disconnect",
            "description": "Remove an MCP server configuration.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "MCP server name to remove"},
                },
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "mcp_test",
            "description": "Test an MCP server: list its tools or call a specific tool. If tool_name is empty, lists all tools. If tool_name is provided, calls that tool with args_json.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "MCP server name"},
                    "tool_name": {"type": "string", "description": "Tool name to call (leave empty to list tools)"},
                    "args_json": {"type": "string", "description": "JSON object of arguments for the tool"},
                },
                "required": ["name"],
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
    "gmail_list": tool_gmail_list,
    "gmail_read": tool_gmail_read,
    "gmail_send": tool_gmail_send,
    "gmail_search": tool_gmail_search,
    "gmail_unread_count": tool_gmail_unread_count,
    "user_settings_get": tool_user_settings_get,
    "user_settings_set": tool_user_settings_set,
    "user_settings_update": tool_user_settings_update,
    "integration_list": tool_integration_list,
    "integration_connect": tool_integration_connect,
    "integration_disconnect": tool_integration_disconnect,
    "mcp_list": tool_mcp_list,
    "mcp_connect": tool_mcp_connect,
    "mcp_disconnect": tool_mcp_disconnect,
    "mcp_test": tool_mcp_test,
}
