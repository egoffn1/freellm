import json
import hashlib
import logging
import time
import numpy as np
from pathlib import Path
from collections import defaultdict

from config import WORKSPACE_DIR

logger = logging.getLogger(__name__)
MEMORY_DIR = Path(WORKSPACE_DIR) / ".memory"
MEMORY_TTL_DAYS = 7
MAX_CHUNKS = 1000


class SimpleRAG:
    def __init__(self):
        self.chunks: list[dict] = []
        self.embeddings: list[np.ndarray] = []
        MEMORY_DIR.mkdir(parents=True, exist_ok=True)
        self._clean_expired()
        self._load()

    def _hash(self, text: str) -> str:
        return hashlib.md5(text.encode()).hexdigest()

    def _simple_embed(self, text: str) -> np.ndarray:
        words = text.lower().split()
        vec = np.zeros(256)
        for w in words:
            h = int(hashlib.md5(w.encode()).hexdigest(), 16)
            idx = h % 256
            vec[idx] += 1.0
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec /= norm
        return vec

    def add(self, text: str, metadata: dict = None):
        h = self._hash(text)
        for c in self.chunks:
            if c["hash"] == h:
                return
        chunk = {"text": text, "hash": h, "metadata": metadata or {}, "ts": time.time()}
        self.chunks.append(chunk)
        self.embeddings.append(self._simple_embed(text))
        self._save_chunk(chunk)
        if len(self.chunks) > MAX_CHUNKS:
            oldest = sorted(self.chunks, key=lambda c: c.get("ts", 0))
            to_remove = oldest[:len(self.chunks) - MAX_CHUNKS]
            for c in to_remove:
                path = MEMORY_DIR / f"{c['hash']}.json"
                try:
                    path.unlink(missing_ok=True)
                except Exception:
                    pass
            self._reload()

    def search(self, query: str, top_k: int = 5) -> list[dict]:
        if not self.chunks:
            return []
        qvec = self._simple_embed(query)
        scores = []
        for i, emb in enumerate(self.embeddings):
            sim = float(np.dot(qvec, emb))
            scores.append((sim, i))
        scores.sort(reverse=True)
        results = []
        for sim, idx in scores[:top_k]:
            if sim > 0.15:
                results.append({**self.chunks[idx], "relevance": round(sim, 3)})
        return results

    def add_messages(self, messages: list[dict]):
        for msg in messages[-20:]:
            text = msg.get("content", "")
            if not text or len(text) < 20:
                continue
            role = msg.get("role", "user")
            self.add(text, {"role": role})

    def build_context(self, query: str, max_chars: int = 3000) -> str:
        results = self.search(query, top_k=5)
        if not results:
            return ""
        parts = []
        total = 0
        for r in results:
            snippet = f"[{r['metadata'].get('role', '?')}] {r['text'][:500]}"
            if total + len(snippet) > max_chars:
                break
            parts.append(snippet)
            total += len(snippet)
        return "\n\n".join(parts)

    def _clean_expired(self):
        if not MEMORY_DIR.exists():
            return
        cutoff = time.time() - MEMORY_TTL_DAYS * 86400
        for f in list(MEMORY_DIR.iterdir()):
            if f.suffix == ".json":
                try:
                    chunk = json.loads(f.read_text(encoding="utf-8"))
                    if chunk.get("ts", 0) < cutoff:
                        f.unlink()
                except Exception:
                    f.unlink()

    def _save_chunk(self, chunk: dict):
        path = MEMORY_DIR / f"{chunk['hash']}.json"
        try:
            path.write_text(json.dumps(chunk, ensure_ascii=False), encoding="utf-8")
        except Exception as e:
            logger.warning(f"Failed to save memory chunk: {e}")

    def _load(self):
        if not MEMORY_DIR.exists():
            return
        loaded = 0
        for f in sorted(MEMORY_DIR.iterdir()):
            if f.suffix == ".json":
                if loaded >= MAX_CHUNKS:
                    break
                try:
                    chunk = json.loads(f.read_text(encoding="utf-8"))
                    self.chunks.append(chunk)
                    self.embeddings.append(self._simple_embed(chunk["text"]))
                    loaded += 1
                except Exception as e:
                    logger.warning(f"Failed to load memory {f.name}: {e}")

    def _reload(self):
        self.chunks.clear()
        self.embeddings.clear()
        self._load()


rag = SimpleRAG()
