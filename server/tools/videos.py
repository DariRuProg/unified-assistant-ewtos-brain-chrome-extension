"""Video-Pages — Master-Datei pro Video unter wiki/resources/videos/<slug>.md.

Eine Video-Page existiert genau einmal pro Video, kann zu mehreren Playlists
gehören (Frontmatter `playlists: [<slug>, ...]`). Transcript + Summary werden
hier nachträglich befüllt.

Ordnerstruktur ist flach (PARA): alle Videos liegen unter wiki/resources/videos/.
Die Themen-Achse ist das freie Frontmatter-Feld `thema` (kein Ordner, keine
Whitelist). Schema folgt templates/video.md.j2.

Nutzt dieselbe `write_playlists`-Permission wie playlists.py.
"""
from __future__ import annotations

import re
from datetime import date
from pathlib import Path

import settings
from tools import saeulen

SLUG_RE = re.compile(r"[^a-z0-9]+")
_VIDEO_ID_RE = re.compile(r"(?:v=|youtu\.be/|/shorts/|/embed/)([A-Za-z0-9_-]{11})")


def video_dir_rel() -> Path:
    """Relativer Pfad zum flachen Videos-Ordner (wiki/resources/videos)."""
    return saeulen.VIDEOS_REL


def _slugify(text: str) -> str:
    s = SLUG_RE.sub("-", (text or "").strip().lower()).strip("-")
    return s[:60] or "video"


def extract_video_id(url: str) -> str:
    """Zieht die 11-stellige YouTube-Video-ID aus einer URL. Leerer String wenn nichts passt."""
    m = _VIDEO_ID_RE.search(url or "")
    return m.group(1) if m else ""


def _vault(vault_id: str) -> dict:
    v = settings.get_vault(vault_id)
    if not v:
        raise ValueError(f"Vault {vault_id} nicht gefunden")
    if not settings.vault_permission(vault_id, "write_playlists"):
        raise PermissionError(
            f"Kein write_playlists-Recht im Vault '{v['name']}'. "
            f"In den Einstellungen aktivieren."
        )
    return v


def _videos_dir(vault_id: str) -> Path:
    v = _vault(vault_id)
    p = Path(v["path"]) / video_dir_rel()
    p.mkdir(parents=True, exist_ok=True)
    return p


def video_path(vault_id: str, slug: str) -> Path:
    return _videos_dir(vault_id) / f"{slug}.md"


def _split_frontmatter(text: str) -> tuple[str, str]:
    if not text.startswith("---"):
        return "", text
    end = text.find("\n---", 3)
    if end == -1:
        return "", text
    fm_end = end + 4
    if fm_end < len(text) and text[fm_end] == "\n":
        fm_end += 1
    return text[:fm_end], text[fm_end:]


def _parse_yaml_value(line: str) -> tuple[str, str] | None:
    m = re.match(r"^([a-zA-Z_]\w*):\s*(.*)$", line)
    if not m:
        return None
    return m.group(1), m.group(2)


def _parse_list_value(value: str) -> list[str]:
    value = value.strip()
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1]
        return [item.strip() for item in inner.split(",") if item.strip()]
    return []


def _format_list_value(items: list[str]) -> str:
    return "[" + ", ".join(items) + "]"


def get_video(vault_id: str, slug: str) -> dict | None:
    p = video_path(vault_id, slug)
    if not p.exists():
        return None
    text = p.read_text(encoding="utf-8")
    fm, body = _split_frontmatter(text)
    meta: dict[str, str | list[str]] = {}
    for line in fm.splitlines():
        kv = _parse_yaml_value(line)
        if not kv:
            continue
        key, value = kv
        if value.startswith("["):
            meta[key] = _parse_list_value(value)
        else:
            meta[key] = value
    return {"slug": slug, "path": str(p), "frontmatter": meta, "body": body}


def upsert_video(
    vault_id: str,
    title: str,
    url: str,
    youtuber: str | None = None,
    dauer: str | None = None,
    playlist_slug: str | None = None,
    slug: str | None = None,
    views: str | None = None,
    published: str | None = None,
    likes: str | None = None,
    description: str | None = None,
    thema: str | None = None,
    video_id: str | None = None,
    thumbnail_url: str | None = None,
) -> dict:
    """Create or update video page. Idempotent — re-call with same URL extends
    playlists-array and fills missing metadata fields if they were empty.

    Frontmatter folgt templates/video.md.j2 (kanal, upload_datum, aufrufe,
    thumbnail_url, video_id, thema)."""
    if not (url and url.strip()):
        raise ValueError("url darf nicht leer sein")
    if not (title and title.strip()):
        raise ValueError("title darf nicht leer sein")
    slug = slug or _slugify(title)
    p = video_path(vault_id, slug)
    today = date.today().isoformat()
    vid = (video_id or extract_video_id(url) or "").strip()
    thumb = (thumbnail_url or (f"https://i.ytimg.com/vi/{vid}/maxresdefault.jpg" if vid else "")).strip()

    if p.exists():
        # Existing page: extend playlists, optionally fill empty meta fields
        existing = get_video(vault_id, slug)
        fm = existing["frontmatter"] if existing else {}
        playlists = fm.get("playlists") or []
        if not isinstance(playlists, list):
            playlists = []
        if playlist_slug and playlist_slug not in playlists:
            playlists.append(playlist_slug)
            _rewrite_frontmatter_field(p, "playlists", _format_list_value(playlists))
        # Fill missing meta if we have new data (param → Template-Feld)
        for key, val in [
            ("kanal", youtuber),
            ("dauer", dauer),
            ("aufrufe", views),
            ("upload_datum", published),
            ("likes", likes),
            ("thema", thema),
            ("video_id", vid),
            ("thumbnail_url", thumb),
        ]:
            if val and not fm.get(key):
                _rewrite_frontmatter_field(p, key, str(val).strip())
        _rewrite_frontmatter_field(p, "zuletzt", today)
        return {"created": False, "slug": slug, "path": str(p)}

    # New page
    playlists_list = [playlist_slug] if playlist_slug else []
    fm_lines = [
        "---",
        "typ: video",
        f"titel: {title.strip()}",
        "status: aktiv",
        f"quelle_url: {url.strip()}",
    ]
    if vid:
        fm_lines.append(f"video_id: {vid}")
    if thumb:
        fm_lines.append(f"thumbnail_url: {thumb}")
    if youtuber:
        fm_lines.append(f"kanal: {youtuber.strip()}")
    if published:
        fm_lines.append(f"upload_datum: {published.strip()}")
    if dauer:
        fm_lines.append(f"dauer: {dauer.strip()}")
    if views:
        fm_lines.append(f"aufrufe: {views.strip()}")
    if likes:
        fm_lines.append(f"likes: {likes.strip()}")
    if thema and thema.strip():
        fm_lines.append(f"thema: {thema.strip()}")
    fm_lines.append("transcript: ")
    fm_lines.append(f"playlists: {_format_list_value(playlists_list)}")
    fm_lines.append("tags: [video]")
    fm_lines.append(f"zuletzt: {today}")
    fm_lines.append("---")
    fm_block = "\n".join(fm_lines) + "\n"

    body_lines = [
        f"# {title.strip()}",
        "",
    ]
    if thumb:
        body_lines.extend([f"![Thumbnail]({thumb})", ""])
    meta_bits = []
    if youtuber:
        meta_bits.append(f"**Kanal:** {youtuber.strip()}")
    if published:
        meta_bits.append(f"**Upload:** {published.strip()}")
    if dauer:
        meta_bits.append(f"**Dauer:** {dauer.strip()}")
    if meta_bits:
        body_lines.extend(["- " + " · ".join(meta_bits), ""])
    body_lines.extend([
        "## Beschreibung",
        description.strip() if description else "_(keine Beschreibung)_",
        "",
        "## Zusammenfassung",
        "_(noch keine Zusammenfassung)_",
        "",
        "## Transkript",
        "_(noch nicht abgerufen)_",
        "",
    ])
    body = "\n".join(body_lines)
    p.write_text(fm_block + "\n" + body, encoding="utf-8")
    return {"created": True, "slug": slug, "path": str(p)}


def _rewrite_frontmatter_field(p: Path, key: str, new_value: str) -> None:
    text = p.read_text(encoding="utf-8")
    fm, body = _split_frontmatter(text)
    if not fm:
        return
    lines = fm.splitlines()
    found = False
    for i, line in enumerate(lines):
        kv = _parse_yaml_value(line)
        if kv and kv[0] == key:
            lines[i] = f"{key}: {new_value}"
            found = True
            break
    if not found:
        # Insert before the closing ---
        for i in range(len(lines) - 1, -1, -1):
            if lines[i].strip() == "---":
                lines.insert(i, f"{key}: {new_value}")
                break
    new_fm = "\n".join(lines)
    if not fm.endswith("\n"):
        new_fm += "\n"
    elif not new_fm.endswith("\n"):
        new_fm += "\n"
    p.write_text(new_fm + body, encoding="utf-8")


def set_transcript_path(
    vault_id: str,
    slug: str,
    transcript_rel_path: str,
) -> dict:
    _vault(vault_id)
    p = video_path(vault_id, slug)
    if not p.exists():
        raise ValueError(f"Video '{slug}' nicht gefunden")
    _rewrite_frontmatter_field(p, "transcript", transcript_rel_path)
    _rewrite_frontmatter_field(p, "zuletzt", date.today().isoformat())
    return {"updated": True, "slug": slug, "transcript": transcript_rel_path}


def remove_from_playlists_array(
    vault_id: str,
    slug: str,
    playlist_slug: str,
) -> dict:
    """Entfernt einen Playlist-Slug aus dem frontmatter `playlists`-Array
    der Video-Master-Page. Returns {playlists: list[str], became_orphan: bool}."""
    _vault(vault_id)
    p = video_path(vault_id, slug)
    if not p.exists():
        return {"playlists": [], "became_orphan": False, "exists": False}
    existing = get_video(vault_id, slug)
    fm = existing["frontmatter"] if existing else {}
    playlists = fm.get("playlists") or []
    if not isinstance(playlists, list):
        playlists = []
    if playlist_slug in playlists:
        playlists = [x for x in playlists if x != playlist_slug]
        _rewrite_frontmatter_field(p, "playlists", _format_list_value(playlists))
        _rewrite_frontmatter_field(p, "zuletzt", date.today().isoformat())
    return {"playlists": playlists, "became_orphan": len(playlists) == 0, "exists": True}


def delete_video(vault_id: str, slug: str) -> dict:
    """Löscht die Video-Master-Page und das verlinkte raw-Transcript-File (falls vorhanden).

    Returns {deleted: bool, master_path: str, transcript_path: str | None}.
    """
    v = _vault(vault_id)
    p = video_path(vault_id, slug)
    if not p.exists():
        return {"deleted": False, "master_path": str(p), "transcript_path": None}
    existing = get_video(vault_id, slug)
    transcript_rel = (existing["frontmatter"].get("transcript") if existing else None) or ""
    transcript_rel = str(transcript_rel).strip()
    transcript_deleted_path = None
    if transcript_rel:
        tp = Path(v["path"]) / transcript_rel
        if tp.exists():
            tp.unlink()
            transcript_deleted_path = str(tp)
    p.unlink()
    return {"deleted": True, "master_path": str(p), "transcript_path": transcript_deleted_path}
