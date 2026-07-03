import json
import logging
import asyncio
from openai import OpenAI
from config import FREELLM_BASE_URL, FREELLM_API_KEY, AGENT_MODEL, MAX_TOOL_CALLS
from tools import TOOL_DEFINITIONS, TOOL_NAME_MAP


logger = logging.getLogger(__name__)
_client = OpenAI(base_url=FREELLM_BASE_URL, api_key=FREELLM_API_KEY)


AGENT_SYSTEM_PROMPT = """You are an AI coding assistant called FreeLLM Agent, similar to Opencode or Claude Code. You have access to a set of tools that let you explore, read, write, and modify files in a workspace.

## Rules
1. You can use tools to complete the user's request step by step.
2. After each tool call, you will receive the result. Use it to decide the next action.
3. When you are done, call `task_done` with a summary.
4. You work in the workspace directory. All file paths are relative to it.
5. Use `read` to examine files before editing them.
6. Use `glob` and `grep` to find relevant files in the codebase.
7. Use `bash` to run build commands, tests, linters, etc.
8. Use `web_fetch` to look up documentation or resources.
9. Think step by step before each action.

## Available tools
- `read`: Read file contents
- `write`: Write/create a file
- `edit`: Edit a file (replace text)
- `glob`: Find files by pattern
- `grep`: Search file contents
- `bash`: Run shell commands
- `web_fetch`: Fetch URLs
- `task_done`: Signal completion"""


async def run_agent(
    messages: list,
    on_status: callable = None,
) -> str:
    sys_msg = {"role": "system", "content": AGENT_SYSTEM_PROMPT}
    full_messages = [sys_msg] + messages

    tool_calls_count = 0

    while tool_calls_count < MAX_TOOL_CALLS:
        if on_status:
            await on_status(f"🔄 Шаг {tool_calls_count + 1}: анализ...")

        try:
            loop = asyncio.get_event_loop()
            resp = await loop.run_in_executor(
                None,
                lambda: _client.chat.completions.create(
                    model=AGENT_MODEL,
                    messages=full_messages,
                    tools=TOOL_DEFINITIONS,
                    tool_choice="auto",
                    timeout=120,
                ),
            )
        except Exception as e:
            logger.error(f"AI call failed: {e}", exc_info=True)
            return f"❌ Ошибка AI: {e}"

        msg = resp.choices[0].message

        if not msg.tool_calls:
            final = msg.content or "✅ Готово."
            full_messages.append({"role": "assistant", "content": final})
            messages[:] = [m for m in full_messages if m.get("role") != "system"]
            return final

        for tc in msg.tool_calls:
            tool_calls_count += 1
            fn_name = tc.function.name
            try:
                fn_args = json.loads(tc.function.arguments)
            except json.JSONDecodeError:
                fn_args = {}

            if on_status:
                args_str = json.dumps(fn_args, ensure_ascii=False)[:80]
                await on_status(f"🛠 Шаг {tool_calls_count}: `{fn_name}` {args_str}...")

            if fn_name == "task_done":
                summary = fn_args.get("summary", "")
                files = fn_args.get("files", [])
                result = summary
                if files:
                    result += "\n\n📁 Файлы:\n" + "\n".join(f"• `{f}`" for f in files)
                full_messages.append({"role": "assistant", "content": result})
                messages[:] = [m for m in full_messages if m.get("role") != "system"]
                return result

            tool_fn = TOOL_NAME_MAP.get(fn_name)
            if not tool_fn:
                result = {"error": f"Unknown tool: {fn_name}"}
            else:
                result = await tool_fn(**fn_args)

            full_messages.append({
                "role": "assistant",
                "content": None,
                "tool_calls": [tc],
            })
            full_messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": json.dumps(result, ensure_ascii=False),
            })

    final = "⚠️ Достигнут лимит шагов. Задача не завершена."
    full_messages.append({"role": "assistant", "content": final})
    messages[:] = [m for m in full_messages if m.get("role") != "system"]
    return final
