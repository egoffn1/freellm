import asyncio
import logging

logger = logging.getLogger(__name__)


async def web_search(query: str, max_results: int = 5) -> dict:
    try:
        return await _search_duckduckgo(query, max_results)
    except ImportError:
        logger.info("duckduckgo_search not installed, falling back to httpx")
        return await _search_fallback(query, max_results)
    except Exception as e:
        logger.warning(f"DuckDuckGo search failed: {e}, trying fallback")
        try:
            return await _search_fallback(query, max_results)
        except Exception as e2:
            return {"error": str(e2), "query": query}


async def _search_duckduckgo(query: str, max_results: int) -> dict:
    from duckduckgo_search import DDGS
    loop = asyncio.get_event_loop()

    def _search():
        with DDGS() as ddgs:
            return list(ddgs.text(query, max_results=max_results))

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


async def _search_fallback(query: str, max_results: int) -> dict:
    import httpx
    from urllib.parse import quote

    url = f"https://html.duckduckgo.com/html/?q={quote(query)}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }

    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        resp = await client.get(url, headers=headers)
        resp.raise_for_status()

    import re
    html = resp.text
    results = []
    for match in re.finditer(
        r'<a[^>]*class="result__a"[^>]*href="(.*?)"[^>]*>(.*?)</a>',
        html, re.DOTALL
    ):
        snippet_match = re.search(
            r'class="result__snippet"[^>]*>(.*?)</a>',
            html[match.end():], re.DOTALL
        )
        snippet = re.sub(r"<[^>]+>", "", snippet_match.group(1)).strip() if snippet_match else ""
        # skip ads and non-result links
        if "//duckduckgo.com/y.js" in match.group(1):
            continue
        href = match.group(1)
        title = re.sub(r"<[^>]+>", "", match.group(2)).strip()
        results.append({"title": title, "url": href, "snippet": snippet[:500]})
        if len(results) >= max_results:
            break

    if not results:
        return {"error": "No results found", "query": query}
    return {"results": results, "query": query, "total": len(results)}
