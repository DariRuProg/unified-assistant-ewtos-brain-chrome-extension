"""Bookmarks tool — leichte URL-Inbox in notes/bookmarks.md.

Format pro Zeile:
    - [YYYY-MM-DD] [Titel](URL) — optional Notiz _(quelle: source)_
"""
from __future__ import annotations

import re
from datetime import date

from tools import notes_file

BOOKMARK_RE = re.compile(
    r"^-\s+\[(\d{4}-\d{2}-\d{2})\]\s+\[([^\]]+)\]\(([^)]+)\)"
    r"(?:\s+—\s+(.+?))?"
    r"(?:\s+_\(quelle:\s*([^)]+)\)_)?\s*$"
)


def list_bookmarks() -> list[dict]:
    data = notes_file.load("bookmarks")
    items: list[dict] = []
    for line in data["content"].splitlines():
        m = BOOKMARK_RE.match(line)
        if not m:
            continue
        date_str, title, url, note, source = m.groups()
        items.append({
            "date": date_str,
            "title": title.strip(),
            "url": url.strip(),
            "note": note.strip() if note else None,
            "source": source.strip() if source else None,
        })
    return items


def add_bookmark(url: str, title: str | None = None, note: str | None = None, source: str = "manual") -> dict:
    url = (url or "").strip()
    if not url:
        raise ValueError("URL darf nicht leer sein")
    if not (url.startswith("http://") or url.startswith("https://")):
        raise ValueError(f"URL muss mit http:// oder https:// beginnen, nicht: {url[:40]}")
    title = (title or url).strip()
    today = date.today().isoformat()
    line = f"- [{today}] [{title}]({url})"
    if note and note.strip():
        line += f" — {note.strip()}"
    if source and source != "manual":
        line += f" _(quelle: {source})_"
    data = notes_file.load("bookmarks")
    body = data["content"].rstrip()
    new_content = (body + "\n" + line + "\n") if body else (line + "\n")
    notes_file.save("bookmarks", new_content)
    return {"added": title, "url": url, "source": source}


def delete_bookmark(match: str) -> dict:
    needle = (match or "").strip().lower()
    if not needle:
        raise ValueError("match darf nicht leer sein")
    data = notes_file.load("bookmarks")
    lines = data["content"].splitlines()
    matches: list[tuple[int, str, str]] = []  # (idx, full_line, title)
    for idx, line in enumerate(lines):
        m = BOOKMARK_RE.match(line)
        if not m:
            continue
        _, title, url, _, _ = m.groups()
        if needle in title.lower() or needle in url.lower():
            matches.append((idx, line, title.strip()))
    if not matches:
        raise ValueError(f"Kein Bookmark gefunden, das '{match}' enthält")
    if len(matches) > 1:
        preview = "; ".join(t for _, _, t in matches[:5])
        raise ValueError(f"Mehrere Bookmarks matchen '{match}': {preview} — bitte präziser.")
    idx, _, title = matches[0]
    del lines[idx]
    body = "\n".join(lines).rstrip()
    notes_file.save("bookmarks", body + "\n" if body else "")
    return {"deleted": title}
