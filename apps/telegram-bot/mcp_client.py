import json
import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)

try:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    HAS_MCP = True
except ImportError:
    HAS_MCP = False
    ClientSession = None
    stdio_client = None


async def mcp_call_server(
    server_command: str,
    server_args: list[str],
    tool_name: str,
    arguments: dict[str, Any],
    timeout: int = 30,
) -> str:
    if not HAS_MCP:
        return "❌ mcp пакет не установлен. pip install mcp"

    try:
        server_params = StdioServerParameters(
            command=server_command,
            args=server_args,
        )

        async with stdio_client(server_params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()

                result = await asyncio.wait_for(
                    session.call_tool(tool_name, arguments),
                    timeout=timeout,
                )

                if hasattr(result, "content"):
                    parts = []
                    for item in result.content:
                        if hasattr(item, "text"):
                            parts.append(item.text)
                        elif hasattr(item, "data"):
                            parts.append(str(item.data))
                    return "\n".join(parts) if parts else str(result)
                return str(result)

    except asyncio.TimeoutError:
        return f"❌ Таймаут MCP вызова ({timeout}с)"
    except Exception as e:
        return f"❌ MCP ошибка: {e}"


async def mcp_list_tools(
    server_command: str,
    server_args: list[str],
) -> list[dict]:
    if not HAS_MCP:
        return []

    try:
        server_params = StdioServerParameters(
            command=server_command,
            args=server_args,
        )

        async with stdio_client(server_params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.list_tools()

                tools = []
                for tool in result.tools:
                    tools.append({
                        "name": tool.name,
                        "description": tool.description or "",
                        "input_schema": tool.inputSchema if hasattr(tool, "inputSchema") else {},
                    })
                return tools

    except Exception as e:
        logger.warning(f"MCP list_tools failed: {e}")
        return []
