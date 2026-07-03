import asyncio
import subprocess
import re
from pathlib import Path
from typing import Any

from config import WORKSPACE_DIR, ALLOWED_BASH_PREFIXES, CONFIRM_COMMANDS, MAX_TOOL_CALLS


WORKSPACE = Path(WORKSPACE_DIR).resolve()


def _resolve_path(file_path: str) -> Path:
    p = Path(file_path)
    if not p.is_absolute():
        p = WORKSPACE / p
    p = p.resolve()
    if not str(p).startswith(str(WORKSPACE)):
        raise PermissionError(f"Path outside workspace: {file_path}")
    return p


def _check_bash_safe(command: str) -> str | None:
    stripped = command.strip().lstrip("$ ")
    parts = stripped.split()
    if not parts:
        return "Empty command"

    cmd = parts[0]
    base = cmd.split("/")[-1].split(".")[0]

    if base in CONFIRM_COMMANDS and base not in ALLOWED_BASH_PREFIXES:
        return f"DANGEROUS: command '{base}' requires user confirmation"

    if base not in ALLOWED_BASH_PREFIXES:
        return f"Command '{base}' not in allowed list"

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
        p = _resolve_path(file_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
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
        p.write_text(new_content, encoding="utf-8")
        return {"edited": True, "path": str(p)}
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": str(e)}


async def tool_glob(pattern: str, path: str | None = None) -> dict[str, Any]:
    try:
        search_dir = _resolve_path(path) if path else WORKSPACE
        matches = sorted(search_dir.rglob(pattern))
        return {"matches": [str(m.relative_to(WORKSPACE)) for m in matches if m.is_file()]}
    except PermissionError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": str(e)}


async def tool_grep(pattern: str, include: str | None = None, path: str | None = None) -> dict[str, Any]:
    try:
        search_dir = _resolve_path(path) if path else WORKSPACE
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
        cwd = _resolve_path(workdir) if workdir else WORKSPACE
    except PermissionError:
        cwd = WORKSPACE

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
]

TOOL_NAME_MAP = {
    "read": tool_read,
    "write": tool_write,
    "edit": tool_edit,
    "glob": tool_glob,
    "grep": tool_grep,
    "bash": tool_bash,
    "web_fetch": tool_web_fetch,
}
