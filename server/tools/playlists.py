"""Playlists — themen-kuratierte Video-Sammlungen unter wiki/ki/playlists/.

Pro Playlist eine .md, die als Index dient. Jedes Item ist ein Block:
    ## <Video-Titel>
    - **Channel:** <youtuber>
    - **Video:** <url>
    - **Page:** [[wiki/ki/videos/<slug>]]
    - *(hinzugefügt YYYY-MM-DD)*

Die Master-Daten (Summary, Transcript-Link, Metadata) liegen in der
Video-Page (`wiki/ki/videos/<slug>.md`). Playlists referenzieren nur.
"""
from __future__ import annotations

import re
from datetime import date
from pathlib import Path

import settings
from tools import videos

PLAYLIST_DIR_REL = Path("wiki") / "ki" / "playlists"

# Item-Block beginnt mit "## " und enthält dann **Channel:**, **Video:** etc.
ITEM_HEADER_RE = re.compile(r"^##\s+(.+?)\s*$")
CHANNEL_RE = re.compile(r"^-\s+\*\*Channel:\*\*\s+(.+?)\s*$")
URL_RE = re.compile(r"^-\s+\*\*Video:\*\*\s+(\S+)\s*$")
PAGE_RE = re.compile(r"^-\s+\*\*Page:\*\*\s+\[\[([^\]]+)\]\]\s*$")
ADDED_RE = re.compile(r"^-?\s*\*\(hinzugefügt\s+(\d{4}-\d{2}-\d{2})\)\*\s*$")

SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(text: str) -> str:
    s = SLUG_RE.sub("-", (text or "").strip().lower()).strip("-")
    return s[:60] or "playlist"


def _vault_root(vault_id: str) -> Path:
    vault = settings.get_vault(vault_id)
    if not vault:
        raise ValueError(f"Vault {vault_id} nicht gefunden")
    if not settings.vault_permission(vault_id, "write_playlists"):
        raise PermissionError(
            f"Kein write_playlists-Recht im Vault '{vault['name']}'. "
            f"In den Einstellungen aktivieren."
        )
    return Path(vault["path"])


def _playlist_dir(vault_id: str) -> Path:
    root = _vault_root(vault_id)
    p = root / PLAYLIST_DIR_REL
    p.mkdir(parents=True, exist_ok=True)
    return p


def _playlist_path(vault_id: str, name: str) -> Path:
    return _playlist_dir(vault_id) / f"{_slugify(name)}.md"


def _empty_playlist(name: str, thema: str | None) -> str:
    today = date.today().isoformat()
    fm = ["---", "typ: ki", f"titel: {name}", "status: aktiv"]
    if thema:
        fm.append(f"thema: {thema}")
    fm.extend([
        "tags: [playlist, video]",
        "quellen: []",
        f"zuletzt: {today}",
        "---",
        "",
        f"# {name}",
        "",
    ])
    return "\n".join(fm) + "\n"


def _split_frontmatter(text: str) -> tuple[str, str]:
    """Return (frontmatter_block, body_after) keeping the trailing newlines."""
    if not text.startswith("---"):
        return "", text
    end = text.find("\n---", 3)
    if end == -1:
        return "", text
    fm_end = end + 4
    if fm_end < len(text) and text[fm_end] == "\n":
        fm_end += 1
    return text[:fm_end], text[fm_end:]


def _parse_items_from_body(body: str) -> list[dict]:
    """Parse playlist body into list of items. Each item is a H2-Block with
    Channel/Video/Page/Datum bullets. Items are separated by H2 headers."""
    items: list[dict] = []
    current: dict | None = None
    for line in body.splitlines():
        h = ITEM_HEADER_RE.match(line)
        if h:
            if current and current.get("title"):
                items.append(current)
            current = {"title": h.group(1).strip(), "channel": None, "url": None, "page": None, "added": None}
            continue
        if current is None:
            continue
        m = CHANNEL_RE.match(line)
        if m:
            current["channel"] = m.group(1).strip()
            continue
        m = URL_RE.match(line)
        if m:
            current["url"] = m.group(1).strip()
            continue
        m = PAGE_RE.match(line)
        if m:
            current["page"] = m.group(1).strip()
            continue
        m = ADDED_RE.match(line)
        if m:
            current["added"] = m.group(1)
    if current and current.get("title"):
        items.append(current)
    return items


def _format_item_block(item: dict) -> str:
    lines = [f"## {item['title']}"]
    if item.get("channel"):
        lines.append(f"- **Channel:** {item['channel']}")
    if item.get("url"):
        lines.append(f"- **Video:** {item['url']}")
    if item.get("page"):
        lines.append(f"- **Page:** [[{item['page']}]]")
    if item.get("added"):
        lines.append(f"- *(hinzugefügt {item['added']})*")
    return "\n".join(lines)


# --- Public API ----------------------------------------------------------


def list_playlists(vault_id: str) -> list[dict]:
    pdir = _playlist_dir(vault_id)
    out = []
    for p in sorted(pdir.glob("*.md")):
        text = p.read_text(encoding="utf-8")
        _, body = _split_frontmatter(text)
        items = _parse_items_from_body(body)
        title_match = re.search(r"^titel:\s*(.+)$", text, re.MULTILINE)
        title = title_match.group(1).strip() if title_match else p.stem
        out.append({
            "name": title,
            "slug": p.stem,
            "path": str(p.relative_to(_vault_root(vault_id))).replace("\\", "/"),
            "item_count": len(items),
        })
    return out


def get_playlist(vault_id: str, name: str) -> dict:
    p = _playlist_path(vault_id, name)
    if not p.exists():
        raise ValueError(f"Playlist '{name}' nicht gefunden")
    text = p.read_text(encoding="utf-8")
    _, body = _split_frontmatter(text)
    items = _parse_items_from_body(body)
    return {"name": name, "slug": p.stem, "items": items, "path": str(p)}


def create_playlist(vault_id: str, name: str, thema: str | None = None) -> dict:
    name = (name or "").strip()
    if not name:
        raise ValueError("Playlist-Name darf nicht leer sein")
    p = _playlist_path(vault_id, name)
    if p.exists():
        raise ValueError(f"Playlist '{name}' existiert bereits ({p.name})")
    p.write_text(_empty_playlist(name, thema), encoding="utf-8")
    return {"created": True, "name": name, "slug": p.stem, "path": str(p)}


def add_to_playlist(
    vault_id: str,
    name: str,
    url: str,
    title: str | None = None,
    dauer: str | None = None,
    youtuber: str | None = None,
    views: str | None = None,
    published: str | None = None,
    likes: str | None = None,
    description: str | None = None,
) -> dict:
    """Add a video to a playlist. Creates/updates the master video page in
    wiki/ki/videos/<slug>.md, then writes a thin reference block in the
    playlist file."""
    url = (url or "").strip()
    if not url:
        raise ValueError("URL darf nicht leer sein")
    p = _playlist_path(vault_id, name)
    if not p.exists():
        raise ValueError(f"Playlist '{name}' nicht gefunden — vorher mit create_playlist anlegen.")
    title = (title or url).strip()
    text = p.read_text(encoding="utf-8")
    fm, body = _split_frontmatter(text)

    # Duplicate check by URL across existing items
    existing_items = _parse_items_from_body(body)
    for it in existing_items:
        if it.get("url") == url:
            return {"added": False, "reason": "duplicate", "url": url, "title": it["title"]}

    # Create or extend video page
    playlist_slug = p.stem
    video_res = videos.upsert_video(
        vault_id=vault_id,
        title=title,
        url=url,
        youtuber=youtuber,
        dauer=dauer,
        playlist_slug=playlist_slug,
        views=views,
        published=published,
        likes=likes,
        description=description,
    )
    page_link = f"wiki/ki/videos/{video_res['slug']}"

    item = {
        "title": title,
        "channel": youtuber,
        "url": url,
        "page": page_link,
        "added": date.today().isoformat(),
    }
    block = _format_item_block(item)
    new_body = body.rstrip()
    new_body = (new_body + "\n\n" + block + "\n") if new_body else (block + "\n")
    p.write_text(fm + new_body, encoding="utf-8")
    return {
        "added": True,
        "name": name,
        "url": url,
        "title": title,
        "video_page": page_link,
        "video_created": video_res["created"],
    }


def remove_from_playlist(vault_id: str, name: str, match: str) -> dict:
    """Remove an item-block (H2 + bullet lines) from the playlist file.
    Substring-match on title or URL. Multi-match raises."""
    needle = (match or "").strip().lower()
    if not needle:
        raise ValueError("match darf nicht leer sein")
    p = _playlist_path(vault_id, name)
    if not p.exists():
        raise ValueError(f"Playlist '{name}' nicht gefunden")
    text = p.read_text(encoding="utf-8")
    fm, body = _split_frontmatter(text)

    items = _parse_items_from_body(body)
    matches = [
        it for it in items
        if needle in (it.get("title") or "").lower()
        or needle in (it.get("url") or "").lower()
    ]
    if not matches:
        raise ValueError(f"Kein Item gefunden, das '{match}' enthält")
    if len(matches) > 1:
        preview = "; ".join(it["title"] for it in matches[:5])
        raise ValueError(f"Mehrere Treffer: {preview} — bitte präziser.")
    target_title = matches[0]["title"]

    # Walk lines and skip the matching block (from its H2 until next H2 or EOF)
    lines = body.splitlines()
    out = []
    skipping = False
    for line in lines:
        h = ITEM_HEADER_RE.match(line)
        if h:
            if h.group(1).strip() == target_title:
                skipping = True
                continue
            else:
                skipping = False
        if not skipping:
            out.append(line)
    new_body = "\n".join(out).rstrip() + "\n"
    p.write_text(fm + new_body, encoding="utf-8")
    return {"removed": True, "title": target_title}
