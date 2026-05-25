"""Bookmarks tool — leichte URL-Inbox in notes/bookmarks.md.

Format pro Zeile:
    - [YYYY-MM-DD] [Titel](URL) — optional Notiz _(quelle: source)_ #thema1 #thema2
Optionale Themen-Tags am Ende, kebab-case oder lowercase.
"""
from __future__ import annotations

import re
from datetime import date
from urllib.parse import urlparse

from tools import notes_file


# Domain → Default-Tags (Auto-Tagging beim Add ohne explizite themen)
DOMAIN_TAGS: dict[str, list[str]] = {
    "youtube.com": ["youtube", "video"],
    "www.youtube.com": ["youtube", "video"],
    "youtu.be": ["youtube", "video"],
    "github.com": ["github", "code"],
    "arxiv.org": ["paper"],
    "anthropic.com": ["anthropic", "ki"],
    "www.anthropic.com": ["anthropic", "ki"],
    "openai.com": ["openai", "ki"],
    "www.openai.com": ["openai", "ki"],
    "claude.ai": ["claude", "ki"],
    "huggingface.co": ["huggingface", "ki"],
    "stackoverflow.com": ["stackoverflow", "code"],
    "developer.mozilla.org": ["mdn", "code"],
    "wordpress.org": ["wordpress"],
    "wikipedia.org": ["wiki"],
    "de.wikipedia.org": ["wiki"],
    "en.wikipedia.org": ["wiki"],
    "medium.com": ["artikel"],
    "substack.com": ["artikel"],
    "twitter.com": ["twitter"],
    "x.com": ["twitter"],
    "linkedin.com": ["linkedin"],
    "reddit.com": ["reddit"],
}


def _auto_tags_for_url(url: str) -> list[str]:
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return []
    if host in DOMAIN_TAGS:
        return list(DOMAIN_TAGS[host])
    # subdomain match (z.B. blog.medium.com → medium.com)
    for domain, tags in DOMAIN_TAGS.items():
        if host.endswith("." + domain):
            return list(tags)
    return []

# Themen-Tags am Zeilenende (optional, beliebig viele): " #ki #recherche"
TAG_RE = re.compile(r"\s+#([a-zA-Z][\w\-/]*)")
BOOKMARK_RE = re.compile(
    r"^-\s+\[(\d{4}-\d{2}-\d{2})\]\s+\[([^\]]+)\]\(([^)]+)\)"
    r"(?:\s+—\s+(.+?))?"
    r"(?:\s+_\(quelle:\s*([^)]+)\)_)?"
    r"((?:\s+#[a-zA-Z][\w\-/]*)*)"
    r"\s*$"
)


def _parse_themen(tags_block: str | None) -> list[str]:
    if not tags_block:
        return []
    return [m.group(1) for m in TAG_RE.finditer(tags_block)]


def _format_themen(themen: list[str] | None) -> str:
    if not themen:
        return ""
    parts = []
    seen = set()
    for t in themen:
        t = (t or "").strip().lstrip("#").lower()
        if t and t not in seen and re.match(r"^[a-zA-Z][\w\-/]*$", t):
            seen.add(t)
            parts.append(f"#{t}")
    return (" " + " ".join(parts)) if parts else ""


def list_bookmarks(vault_id: str | None = None) -> list[dict]:
    data = notes_file.load("bookmarks", vault_id)
    items: list[dict] = []
    for line in data["content"].splitlines():
        m = BOOKMARK_RE.match(line)
        if not m:
            continue
        date_str, title, url, note, source, tags_block = m.groups()
        items.append({
            "date": date_str,
            "title": title.strip(),
            "url": url.strip(),
            "note": note.strip() if note else None,
            "source": source.strip() if source else None,
            "themen": _parse_themen(tags_block),
        })
    return items


def add_bookmark(
    url: str,
    title: str | None = None,
    note: str | None = None,
    source: str = "manual",
    themen: list[str] | None = None,
    vault_id: str | None = None,
) -> dict:
    url = (url or "").strip()
    if not url:
        raise ValueError("URL darf nicht leer sein")
    if not (url.startswith("http://") or url.startswith("https://")):
        raise ValueError(f"URL muss mit http:// oder https:// beginnen, nicht: {url[:40]}")
    title = (title or url).strip()
    today = date.today().isoformat()
    # Auto-Tagging: wenn keine Themen explizit gesetzt, aus Domain ableiten
    if not themen:
        themen = _auto_tags_for_url(url)
    line = f"- [{today}] [{title}]({url})"
    if note and note.strip():
        line += f" — {note.strip()}"
    if source and source != "manual":
        line += f" _(quelle: {source})_"
    line += _format_themen(themen)
    data = notes_file.load("bookmarks", vault_id)
    body = data["content"].rstrip()
    new_content = (body + "\n" + line + "\n") if body else (line + "\n")
    notes_file.save("bookmarks", new_content, vault_id)
    return {"added": title, "url": url, "source": source, "themen": themen or []}


def update_bookmark(
    match: str,
    date: str | None = None,
    title: str | None = None,
    note: str | None = None,
    themen: list[str] | None = None,
    vault_id: str | None = None,
) -> dict:
    """Editiert einen Bookmark per Substring-Match (URL/Titel) + optionalem Datum-Filter.

    Nur die übergebenen Felder werden überschrieben — None bedeutet 'unverändert'.
    `themen=[]` (leere Liste) löscht alle Tags.
    Bei Mehrfach-Match ohne Datum: Mehrdeutigkeits-Fehler. Mit Datum: erstes Match.
    """
    needle = (match or "").strip().lower()
    if not needle:
        raise ValueError("match darf nicht leer sein")
    date_filter = (date or "").strip() or None
    data = notes_file.load("bookmarks", vault_id)
    lines = data["content"].splitlines()
    matches: list[int] = []
    for idx, line in enumerate(lines):
        m = BOOKMARK_RE.match(line)
        if not m:
            continue
        d, t, u, _, _, _ = m.groups()
        if needle not in t.lower() and needle not in u.lower():
            continue
        if date_filter and d != date_filter:
            continue
        matches.append(idx)
    if not matches:
        raise ValueError(f"Kein Bookmark gefunden, das '{match}' enthält")
    if len(matches) > 1 and not date_filter:
        raise ValueError(f"Mehrere Bookmarks matchen '{match}' — bitte präziser oder mit date filtern.")
    idx = matches[0]
    m = BOOKMARK_RE.match(lines[idx])
    d, t, u, n, src, tags_block = m.groups()
    new_title = title.strip() if title is not None else t.strip()
    new_note = note.strip() if note is not None else (n.strip() if n else None)
    new_themen = themen if themen is not None else _parse_themen(tags_block)
    new_source = src.strip() if src else "manual"
    new_line = f"- [{d}] [{new_title}]({u.strip()})"
    if new_note:
        new_line += f" — {new_note}"
    if new_source and new_source != "manual":
        new_line += f" _(quelle: {new_source})_"
    new_line += _format_themen(new_themen)
    lines[idx] = new_line
    body = "\n".join(lines).rstrip()
    notes_file.save("bookmarks", body + "\n" if body else "", vault_id)
    return {"updated": new_title, "themen": new_themen or []}


def delete_bookmark(match: str, date: str | None = None, vault_id: str | None = None) -> dict:
    """Löscht einen Bookmark per Substring-Match auf Titel/URL.

    Wenn `date` (YYYY-MM-DD) gesetzt ist, wird zusätzlich auf das Datum
    gefiltert — eindeutiger bei doppelt erfassten Bookmarks (z.B. gleiche
    URL aus context-menu + multi-tab). Bei verbleibenden Mehrfach-Matches
    nach URL+Datum wird das ERSTE Item gelöscht (keine Fehler-Eskalation,
    weil UI-Klick eindeutigen User-Intent ausdrückt).

    Ohne `date` und mehreren Matches: Mehrdeutigkeits-Fehler wie bisher
    (für Chat-Agent-Sicherheit).
    """
    needle = (match or "").strip().lower()
    if not needle:
        raise ValueError("match darf nicht leer sein")
    date_filter = (date or "").strip() or None
    data = notes_file.load("bookmarks", vault_id)
    lines = data["content"].splitlines()
    matches: list[tuple[int, str, str]] = []  # (idx, full_line, title)
    for idx, line in enumerate(lines):
        m = BOOKMARK_RE.match(line)
        if not m:
            continue
        date_str, title, url, _, _, _ = m.groups()
        if needle not in title.lower() and needle not in url.lower():
            continue
        if date_filter and date_str != date_filter:
            continue
        matches.append((idx, line, title.strip()))
    if not matches:
        raise ValueError(f"Kein Bookmark gefunden, das '{match}' enthält")
    if len(matches) > 1 and not date_filter:
        preview = "; ".join(t for _, _, t in matches[:5])
        raise ValueError(f"Mehrere Bookmarks matchen '{match}': {preview} — bitte präziser.")
    # mit date-filter: erstes match löschen (UI-Klick = eindeutiger Intent)
    idx, _, title = matches[0]
    del lines[idx]
    body = "\n".join(lines).rstrip()
    notes_file.save("bookmarks", body + "\n" if body else "", vault_id)
    return {"deleted": title}
