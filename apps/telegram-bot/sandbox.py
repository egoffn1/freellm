import asyncio
import resource
import tempfile
import os
from pathlib import Path

SANDBOX_TIMEOUT = 30
MAX_MEMORY_MB = 256
MAX_OUTPUT_CHARS = 10000


def _set_limits():
    try:
        resource.setrlimit(resource.RLIMIT_AS, (MAX_MEMORY_MB * 1024 * 1024, -1))
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


async def _run_shell_sandbox(command: str) -> dict:
    blocked = ["rm -rf", "mkfs", "dd if=", "> /dev/", "sudo", "su "]
    for b in blocked:
        if b in command:
            return {"error": f"Blocked command pattern: {b}"}

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
