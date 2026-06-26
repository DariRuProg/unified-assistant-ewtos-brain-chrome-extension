"""Playlists — themen-kuratierte Video-Sammlungen unter wiki/resources/playlists/.

Pfad-Schema: `wiki/resources/playlists/<slug>.md` (flach, PARA). Die Themen-Achse
ist das freie Frontmatter-Feld `thema` (kein Ordner). Jede Playlist ist eine .md
mit H2-Item-Blöcken:
    ## <Video-Titel>
    - **Channel:** <youtuber>
    - **Video:** <url>
    - **Page:** [[wiki/resources/videos/<slug>]]
    - *(hinzugefügt YYYY-MM-DD)*

Master-Daten (Summary, Transcript-Link, Metadata) liegen in der Video-Page
(`wiki/resources/videos/<slug>.md`). Playlists referenzieren nur.
"""
from __future__ import annotations

import re
from datetime import date
from pathlib import Path

import settings
from tools import saeulen, videos

# Item-Block beginnt mit "## " und enthält dann **Channel:**, **Video:** etc.
ITEM_HEADER_RE = re.compile(r"^##\s+(.+?)\s*$")
CHANNEL_RE = re.compile(r"^-\s+\*\*Channel:\*\*\s+(.+?)\s*$")
URL_RE = re.compile(r"^-\s+\*\*Video:\*\*\s+(\S+)\s*$")
PAGE_RE = re.compile(r"^-\s+\*\*Page:\*\*\s+\[\[([^\]]+)\]\]\s*$")
ADDED_RE = re.compile(r"^-?\s*\*\(hinzugefügt\s+(\d{4}-\d{2}-\d{2})\)\*\s*$")

SLUG_RE = re.compile(r"[^a-z0-9]+")


def playlist_dir_rel() -> Path:
    """Relativer Pfad zum flachen Playlist-Ordner (wiki/resources/playlists)."""
    return saeulen.PLAYLISTS_REL


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
    p = root / playlist_dir_rel()
    p.mkdir(parents=True, exist_ok=True)
    return p


def _playlist_path(vault_id: str, name: str) -> Path:
    return _playlist_dir(vault_id) / f"{_slugify(name)}.md"


def _update_playlist_index(root: Path, slug: str, name: str, thema: str | None) -> None:
    """Trägt eine neue Playlist in wiki/resources/playlists/index.md ein.
    Legt index.md an falls sie nicht existiert. Kein Duplikat wenn Slug bereits verlinkt."""
    index_path = root / playlist_dir_rel() / "index.md"
    entry_link = f"[[wiki/resources/playlists/{slug}]]"
    label = f"{name} ({thema})" if thema else name
    new_line = f"- {entry_link} — {label}"

    if index_path.exists():
        content = index_path.read_text(encoding="utf-8")
        if f"/{slug}]]" in content:
            return  # Bereits verlinkt — kein Duplikat
        if "## Pages" in content:
            content = content.rstrip("\n") + "\n" + new_line + "\n"
        else:
            content = content.rstrip("\n") + "\n\n## Pages\n" + new_line + "\n"
        index_path.write_text(content, encoding="utf-8")
    else:
        index_path.parent.mkdir(parents=True, exist_ok=True)
        index_path.write_text(
            f"---\ntitel: Playlists\nstatus: aktiv\n---\n\n# Playlists\n\n## Pages\n{new_line}\n",
            encoding="utf-8",
        )


def _empty_playlist(name: str, thema: str | None, quelle_url: str | None = None) -> str:
    today = date.today().isoformat()
    fm = ["---", "typ: playlist", f"titel: {name}"]
    fm.append(f"quelle_url: {quelle_url.strip() if quelle_url else ''}")
    if thema and thema.strip():
        fm.append(f"thema: {thema.strip()}")
    fm.extend([
        "tags: [playlist]",
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
    """Listet alle Playlists des Vaults unter wiki/resources/playlists/.

    Liefert pro Eintrag `{name, slug, thema, path, item_count}`.
    """
    vault = settings.get_vault(vault_id)
    if not vault:
        raise ValueError(f"Vault {vault_id} nicht gefunden")
    root = Path(vault["path"])
    pdir = root / playlist_dir_rel()
    if not pdir.exists():
        return []
    out = []
    for p in sorted(pdir.glob("*.md")):
        # index.md ist eine Übersichts-Seite, keine echte Playlist
        if p.stem == "index":
            continue
        text = p.read_text(encoding="utf-8")
        _, body = _split_frontmatter(text)
        items = _parse_items_from_body(body)
        title_match = re.search(r"^titel:\s*(.+)$", text, re.MULTILINE)
        title = title_match.group(1).strip() if title_match else p.stem
        thema_match = re.search(r"^thema:\s*(.+)$", text, re.MULTILINE)
        out.append({
            "name": title,
            "slug": p.stem,
            "thema": thema_match.group(1).strip() if thema_match else "",
            "path": str(p.relative_to(root)).replace("\\", "/"),
            "item_count": len(items),
        })
    return out


def get_playlist(vault_id: str, name: str) -> dict:
    vault = settings.get_vault(vault_id)
    if not vault:
        raise ValueError(f"Vault {vault_id} nicht gefunden")
    p = Path(vault["path"]) / playlist_dir_rel() / f"{_slugify(name)}.md"
    if not p.exists():
        raise ValueError(f"Playlist '{name}' nicht gefunden")
    text = p.read_text(encoding="utf-8")
    _, body = _split_frontmatter(text)
    items = _parse_items_from_body(body)
    return {"name": name, "slug": p.stem, "items": items, "path": str(p)}


def create_playlist(
    vault_id: str,
    name: str,
    thema: str | None = None,
    quelle_url: str | None = None,
) -> dict:
    name = (name or "").strip()
    if not name:
        raise ValueError("Playlist-Name darf nicht leer sein")
    p = _playlist_path(vault_id, name)
    if p.exists():
        raise ValueError(f"Playlist '{name}' existiert bereits ({p.name})")
    p.write_text(_empty_playlist(name, thema, quelle_url), encoding="utf-8")
    _update_playlist_index(Path(settings.get_vault(vault_id)["path"]), p.stem, name, thema)
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
    thema: str | None = None,
) -> dict:
    """Add a video to a playlist. Creates/updates the master video page in
    wiki/resources/videos/<slug>.md, then writes a thin reference block in the
    playlist file."""
    url = (url or "").strip()
    if not url:
        raise ValueError("URL darf nicht leer sein")
    p = _playlist_path(vault_id, name)
    if not p.exists():
        raise ValueError(
            f"Playlist '{name}' nicht gefunden — vorher mit create_playlist anlegen."
        )
    title = (title or url).strip()
    text = p.read_text(encoding="utf-8")
    fm, body = _split_frontmatter(text)

    # Duplicate check by URL across existing items
    existing_items = _parse_items_from_body(body)
    for it in existing_items:
        if it.get("url") == url:
            return {"added": False, "reason": "duplicate", "url": url, "title": it["title"]}

    # Create or extend master video page (thema aus der Playlist-Frontmatter erben falls nicht gesetzt)
    if thema is None:
        thema_match = re.search(r"^thema:\s*(.+)$", fm, re.MULTILINE)
        thema = thema_match.group(1).strip() if thema_match else None

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
        thema=thema,
    )
    page_link = f"wiki/resources/videos/{video_res['slug']}"

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


def remove_from_playlist(
    vault_id: str,
    name: str,
    match: str,
    also_delete_master: bool = False,
) -> dict:
    """Remove an item-block (H2 + bullet lines) from the playlist file.

    Substring-match on title or URL. Multi-match raises.

    Side-effects (immer):
    - Aus dem frontmatter `playlists`-Array der Video-Master-Page wird der
      eigene Playlist-Slug entfernt — sonst wäre die Master-Page-Frontmatter
      stale.

    Wenn `also_delete_master=True`:
    - Falls das Video in keiner anderen Playlist mehr ist (became_orphan),
      wird die Master-Page UND das raw-Transcript-File gelöscht.
    - Ansonsten bleibt die Master-Page erhalten (Hinweis im Returnwert).
    """
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
    target = matches[0]
    target_title = target["title"]
    target_page = (target.get("page") or "").strip()
    # Slug aus page = "wiki/resources/videos/<slug>"
    target_slug = target_page.rsplit("/", 1)[-1] if target_page else None

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

    playlist_slug = p.stem
    master_deleted = False
    transcript_deleted = None
    became_orphan = False
    if target_slug:
        upd = videos.remove_from_playlists_array(vault_id, target_slug, playlist_slug)
        became_orphan = bool(upd.get("became_orphan"))
        if also_delete_master and became_orphan and upd.get("exists"):
            res = videos.delete_video(vault_id, target_slug)
            master_deleted = bool(res.get("deleted"))
            transcript_deleted = res.get("transcript_path")

    return {
        "removed": True,
        "title": target_title,
        "video_slug": target_slug,
        "became_orphan": became_orphan,
        "master_deleted": master_deleted,
        "transcript_deleted": transcript_deleted,
    }
