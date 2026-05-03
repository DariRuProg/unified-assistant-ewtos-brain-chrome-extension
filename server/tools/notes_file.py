"""Generic notes-file tool — backs scratchpad and todos with same logic."""
from __future__ import annotations

from datetime import date
from pathlib import Path

import config
import settings

KIND_CONFIG: dict[str, dict[str, str]] = {
    "scratchpad": {"filename": "scratchpad.md", "tag": "scratchpad"},
    "todos": {"filename": "todos.md", "tag": "todos"},
}


def _config_for(kind: str) -> dict[str, str]:
    if kind not in KIND_CONFIG:
        raise ValueError(f"Unbekannter Notes-Typ: {kind}")
    return KIND_CONFIG[kind]


def _notes_dir() -> Path:
    p = Path(settings.get("notes_path") or config.NOTES_PATH)
    p.mkdir(parents=True, exist_ok=True)
    return p


def _file_path(kind: str) -> Path:
    return _notes_dir() / _config_for(kind)["filename"]


def _empty(tag: str, started: str) -> str:
    return f"---\nstarted: {started}\ntags: [{tag}]\n---\n\n"


def _parse_started(text: str) -> str | None:
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    if end == -1:
        return None
    for line in text[3:end].splitlines():
        line = line.strip()
        if line.startswith("started:"):
            return line.split(":", 1)[1].strip()
    return None


def _strip_frontmatter(text: str) -> str:
    if not text.startswith("---"):
        return text
    end = text.find("\n---", 3)
    if end == -1:
        return text
    return text[end + 4 :].lstrip("\n")


def load(kind: str) -> dict:
    cfg = _config_for(kind)
    path = _file_path(kind)
    if not path.exists():
        today = date.today().isoformat()
        path.write_text(_empty(cfg["tag"], today), encoding="utf-8")
        return {"started": today, "content": "", "path": str(path)}
    raw = path.read_text(encoding="utf-8")
    return {
        "started": _parse_started(raw),
        "content": _strip_frontmatter(raw),
        "path": str(path),
    }


def save(kind: str, content: str) -> dict:
    cfg = _config_for(kind)
    path = _file_path(kind)
    started = None
    if path.exists():
        started = _parse_started(path.read_text(encoding="utf-8"))
    if not started:
        started = date.today().isoformat()
    body = f"---\nstarted: {started}\ntags: [{cfg['tag']}]\n---\n\n{content}"
    path.write_text(body, encoding="utf-8")
    return {"started": started, "saved": True, "path": str(path)}


def export(target_path: str, content: str, source: str = "scratchpad") -> dict:
    if not target_path or not target_path.strip():
        raise ValueError("Pfad ist leer")
    p = Path(target_path.strip()).expanduser()
    if not p.suffix:
        p = p.with_suffix(".md")
    if p.suffix.lower() not in {".md", ".txt"}:
        raise ValueError(f"Nur .md oder .txt erlaubt, nicht {p.suffix}")
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.suffix.lower() == ".md":
        today = date.today().isoformat()
        body = f"---\nexported: {today}\nsource: {source}\n---\n\n{content.rstrip()}\n"
    else:
        body = content
    p.write_text(body, encoding="utf-8")
    return {"saved": True, "path": str(p)}
