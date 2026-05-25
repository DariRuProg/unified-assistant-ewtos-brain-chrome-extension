"""Generic notes-file tool — backs scratchpad and todos with same logic."""
from __future__ import annotations

import re
import threading
from contextlib import contextmanager
from datetime import date
from pathlib import Path
from typing import Callable

import settings

# Defensiver Lock gegen TOCTOU bei parallelen Write-Adds (z.B. Multi-Tab-Bulk).
# FastAPI führt sync-def-Endpunkte im Threadpool aus → ohne Lock kann ein Save
# einen anderen überschreiben (Lost Update). RLock erlaubt verschachtelte Reentrant-
# Aufrufe innerhalb desselben Threads.
_file_lock = threading.RLock()


@contextmanager
def locked():
    """Public Context-Manager: hält den File-Lock über mehrere load+save-Calls
    in einer Read-Modify-Write-Sequenz. Beispiel:

        with notes_file.locked():
            data = notes_file.load("bookmarks")
            ... mutate ...
            notes_file.save("bookmarks", new_content)
    """
    with _file_lock:
        yield

TODO_RE = re.compile(r"^- \[([ xX])\] (.+?)(?: @(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?))?\s*$")

KIND_CONFIG: dict[str, dict[str, str]] = {
    "scratchpad": {"filename": "scratchpad.md", "tag": "scratchpad"},
    "todos": {"filename": "todos.md", "tag": "todos"},
    "bookmarks": {"filename": "bookmarks.md", "tag": "bookmarks"},
}


def _config_for(kind: str) -> dict[str, str]:
    if kind not in KIND_CONFIG:
        raise ValueError(f"Unbekannter Notes-Typ: {kind}")
    return KIND_CONFIG[kind]


def _notes_dir(vault_id: str | None = None) -> Path:
    return settings.vault_notes_dir(vault_id)


def _file_path(kind: str, vault_id: str | None = None) -> Path:
    return _notes_dir(vault_id) / _config_for(kind)["filename"]


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


def load(kind: str, vault_id: str | None = None) -> dict:
    cfg = _config_for(kind)
    path = _file_path(kind, vault_id)
    with _file_lock:
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


def save(kind: str, content: str, vault_id: str | None = None) -> dict:
    cfg = _config_for(kind)
    path = _file_path(kind, vault_id)
    with _file_lock:
        started = None
        if path.exists():
            started = _parse_started(path.read_text(encoding="utf-8"))
        if not started:
            started = date.today().isoformat()
        body = f"---\nstarted: {started}\ntags: [{cfg['tag']}]\n---\n\n{content}"
        # Atomarer Write: tmp + replace, damit parallele Reader nie eine halb
        # geschriebene Datei sehen.
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(body, encoding="utf-8")
        tmp.replace(path)
    return {"started": started, "saved": True, "path": str(path)}


def atomic_update(
    kind: str,
    mutator: Callable[[dict], str],
    vault_id: str | None = None,
) -> dict:
    """Read-Modify-Write atomar — `mutator` bekommt die geladenen Daten und
    returnt den neuen Content-String. Lock wird über die ganze Operation gehalten.

    Empfohlen für Bookmark/Todo-Mutationen, wenn mehrere parallele Adds möglich
    sind (z.B. Multi-Tab-Capture)."""
    with _file_lock:
        data = load(kind, vault_id)
        new_content = mutator(data)
        save(kind, new_content, vault_id)
    return {"updated": True, "kind": kind}


# --- Granular operations for the chat agent --------------------------------

def list_todos(vault_id: str | None = None) -> list[dict]:
    data = load("todos", vault_id)
    items: list[dict] = []
    for line in data["content"].splitlines():
        m = TODO_RE.match(line)
        if not m:
            continue
        check, text, due = m.groups()
        items.append({
            "text": text.strip(),
            "done": check.lower() == "x",
            "due": due,
        })
    return items


def add_todo(text: str, due: str | None = None, vault_id: str | None = None) -> dict:
    text = (text or "").strip()
    if not text:
        raise ValueError("Todo-Text darf nicht leer sein")
    line = f"- [ ] {text}"
    if due:
        line += f" @{due.strip()}"
    data = load("todos", vault_id)
    body = data["content"].rstrip()
    new_content = (body + "\n" + line + "\n") if body else (line + "\n")
    save("todos", new_content, vault_id)
    return {"added": text, "due": due}


def update_todo(match_text: str, action: str, vault_id: str | None = None) -> dict:
    if action not in {"complete", "uncomplete", "delete"}:
        raise ValueError(f"action muss complete|uncomplete|delete sein, nicht {action}")
    needle = (match_text or "").strip().lower()
    if not needle:
        raise ValueError("match_text darf nicht leer sein")
    data = load("todos", vault_id)
    lines = data["content"].splitlines()
    matches: list[tuple[int, str, str]] = []  # (idx, full_line, todo_text)
    for idx, line in enumerate(lines):
        m = TODO_RE.match(line)
        if not m:
            continue
        todo_text = m.group(2).strip()
        if needle in todo_text.lower():
            matches.append((idx, line, todo_text))
    if not matches:
        raise ValueError(f"Kein Todo gefunden, das '{match_text}' enthält")
    if len(matches) > 1:
        preview = "; ".join(t for _, _, t in matches[:5])
        raise ValueError(f"Mehrere Treffer für '{match_text}': {preview} — bitte präziser oder eindeutiger Text")
    idx, line, todo_text = matches[0]
    if action == "delete":
        del lines[idx]
    elif action == "complete":
        lines[idx] = re.sub(r"^- \[[ xX]\]", "- [x]", line, count=1)
    else:  # uncomplete
        lines[idx] = re.sub(r"^- \[[ xX]\]", "- [ ]", line, count=1)
    body = "\n".join(lines).rstrip()
    save("todos", body + "\n" if body else "", vault_id)
    return {"action": action, "todo": todo_text}


def read_scratchpad(vault_id: str | None = None) -> dict:
    return load("scratchpad", vault_id)


def append_scratchpad(text: str, vault_id: str | None = None) -> dict:
    text = (text or "").strip()
    if not text:
        raise ValueError("Text darf nicht leer sein")
    today = date.today().isoformat()
    data = load("scratchpad", vault_id)
    body = data["content"].rstrip()
    section = f"## {today}\n{text}\n"
    new_content = (body + "\n\n" + section) if body else section
    save("scratchpad", new_content, vault_id)
    return {"appended": text, "date": today}


def replace_scratchpad(content: str, vault_id: str | None = None) -> dict:
    save("scratchpad", content or "", vault_id)
    return {"replaced": True, "length": len(content or "")}


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
