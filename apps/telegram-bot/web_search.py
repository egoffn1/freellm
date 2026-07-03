import asyncio
import logging
import json

logger = logging.getLogger(__name__)


async def web_search(query: str) -> dict:
    try:
        from duckduckgo_search import DDGS
        loop = asyncio.get_event_loop()

        def _search():
            with DDGS() as ddgs:
                results = list(ddgs.text(query, max_results=5))
                return results

        results = await loop.run_in_executor(None, _search)
        if not results:
            return {"error": "No results found", "query": query}

        formatted = []
        for r in results:
            formatted.append({
                "title": r.get("title", ""),
                "url": r.get("href", ""),
                "snippet": r.get("body", "")[:500],
            })
        return {"results": formatted, "query": query, "total": len(formatted)}
    except ImportError:
        return {"error": "DuckDuckGo search not installed. Use 'pip install duckduckgo-search'", "query": query}
    except Exception as e:
        logger.warning(f"Web search failed: {e}")
        return {"error": str(e), "query": query}
