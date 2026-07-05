import json
import os
import shutil
from pathlib import Path
from config import WORKSPACE_DIR

PROJECTS_DIR = Path(WORKSPACE_DIR) / ".projects"


def _project_path(name: str, user_id: int = 0) -> Path:
    base = PROJECTS_DIR / str(user_id) if user_id else PROJECTS_DIR
    base.mkdir(parents=True, exist_ok=True)
    return base / name


async def scaffold_project(name: str, files: list[dict], user_id: int = 0) -> dict:
    proj_path = _project_path(name, user_id)
    if proj_path.exists():
        shutil.rmtree(str(proj_path))
    proj_path.mkdir(parents=True, exist_ok=True)
    created = []
    entry = None
    for f in files:
        fpath = f.get("path", "")
        content = f.get("content", "")
        lang = f.get("language", "")
        full = proj_path / fpath
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(content, encoding="utf-8")
        rel = str(full.relative_to(PROJECTS_DIR))
        created.append(rel)
        if fpath in ("index.html", "main.py", "app.py", "index.js", "server.js"):
            entry = rel
    manifest = {
        "name": name,
        "user_id": user_id,
        "files": created,
        "entry": entry,
    }
    (proj_path / ".manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    return manifest


def get_project(name: str, user_id: int = 0) -> dict | None:
    base = PROJECTS_DIR / str(user_id) if user_id else PROJECTS_DIR
    manifest_path = base / name / ".manifest.json"
    if manifest_path.exists():
        return json.loads(manifest_path.read_text(encoding="utf-8"))
    return None


def list_projects(user_id: int = 0) -> list[str]:
    base = PROJECTS_DIR / str(user_id) if user_id else PROJECTS_DIR
    if not base.exists():
        return []
    return sorted(d.name for d in base.iterdir() if d.is_dir() and (d / ".manifest.json").exists())


def build_html_preview(name: str, user_id: int = 0) -> str:
    proj = get_project(name, user_id)
    if not proj:
        return "<h1>Project not found</h1>"
    entry = proj.get("entry")
    if entry and entry.endswith(".html"):
        return (PROJECTS_DIR / entry).read_text(encoding="utf-8")
    html = "<html><body><h1>Preview not available</h1><ul>"
    for f in proj.get("files", []):
        html += f"<li>{f}</li>"
    html += "</ul></body></html>"
    return html


def build_project_summary(manifest: dict) -> str:
    lines = [f"📦 Проект: {manifest['name']}"]
    for f in manifest.get("files", []):
        lines.append(f"  • {f}")
    if manifest.get("entry"):
        lines.append(f"\n🚀 Точка входа: {manifest['entry']}")
    return "\n".join(lines)
