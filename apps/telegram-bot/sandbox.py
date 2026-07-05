import asyncio
import resource
import tempfile
import shlex
import os
from pathlib import Path

SANDBOX_TIMEOUT = 30
MAX_MEMORY_MB = 256
MAX_OUTPUT_CHARS = 10000


def _set_limits():
    try:
        limit = MAX_MEMORY_MB * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
        resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
    except (ValueError, resource.error):
        pass


async def run_sandboxed(code: str, language: str = "python") -> dict:
    if language == "python":
        return await _run_python_sandbox(code)
    elif language == "shell":
        return await _run_shell_sandbox(code)
    else:
        return {"error": f"Unsupported language: {language}"}


async def _run_python_sandbox(code: str) -> dict:
    with tempfile.TemporaryDirectory() as tmpdir:
        script_path = os.path.join(tmpdir, "_sandbox_script.py")
        Path(script_path).write_text(code, encoding="utf-8")

        try:
            proc = await asyncio.create_subprocess_exec(
                "python3", "-u", script_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=tmpdir,
                env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                preexec_fn=_set_limits,
            )
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=SANDBOX_TIMEOUT)
            except asyncio.TimeoutError:
                proc.kill()
                return {"error": "Code execution timed out (30s)", "stdout": "", "stderr": "Timeout"}

            out = stdout.decode("utf-8", errors="replace")[:MAX_OUTPUT_CHARS]
            err = stderr.decode("utf-8", errors="replace")[:2000]

            return {
                "exit_code": proc.returncode,
                "stdout": out,
                "stderr": err if err else None,
            }
        except FileNotFoundError:
            return {"error": "Python not found in sandbox"}
        except Exception as e:
            return {"error": str(e)}


BLOCKED_SHELL_PATTERNS = [
    "rm -rf", "rm -fr", "rm --recursive",
    "mkfs", "dd if=", "> /dev/", "sudo", "su ",
    ":()", "fork bomb", "chmod 777 /", "chown ",
]


async def _run_shell_sandbox(command: str) -> dict:
    for b in BLOCKED_SHELL_PATTERNS:
        if b in command.lower():
            return {"error": f"Blocked command pattern: {b}"}

    first_word = shlex.split(command)[0] if command.strip() else ""
    dangerous = {"sudo", "su", "chown", "chgrp", "passwd", "dd", "mkfs", "reboot", "shutdown", "kill", "pkill"}
    if first_word in dangerous:
        return {"error": f"Command '{first_word}' is blocked for security"}

    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            preexec_fn=_set_limits,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=SANDBOX_TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            return {"error": "Command timed out (30s)"}

        out = stdout.decode("utf-8", errors="replace")[:MAX_OUTPUT_CHARS]
        err = stderr.decode("utf-8", errors="replace")[:2000]

        return {
            "exit_code": proc.returncode,
            "stdout": out,
            "stderr": err if err else None,
        }
    except Exception as e:
        return {"error": str(e)}
