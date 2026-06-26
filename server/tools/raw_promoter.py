"""Promote scratchpad/todo entries into a vault's raw/ folder.

The promote workflow closes the inbox -> source loop in the Karpathy method:
- Mini-input lands in notes/scratchpad.md or notes/todos.md (inbox)
- When a user marks an entry as worth keeping, it moves to vault/raw/<subfolder>/
- Ingest into wiki/ stays a separate Claude-Code operation.
"""
from __future__ import annotations

import re
from datetime import date
from pathlib import Path
from typing import Any

import settings
from tools import notes_file, saeulen

ALLOWED_SUBFOLDERS_PREFIX = ("artikel", "eigene-notizen", "kunden-input", "chat-archive")
SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(text: str) -> str:
    s = SLUG_RE.sub("-", text.strip().lower()).strip("-")
    return s[:60] or "eintrag"


def _validate_subfolder(target: str) -> str:
    target = (target or "").strip().strip("/\\").replace("\\", "/")
    if not target:
        raise ValueError("target_subfolder darf nicht leer sein")
    head = target.split("/", 1)[0]
    if head not in ALLOWED_SUBFOLDERS_PREFIX:
        raise ValueError(
            f"target_subfolder muss mit einem dieser beginnen: {', '.join(ALLOWED_SUBFOLDERS_PREFIX)}"
        )
    return target


def _extract_scratchpad_block(content: str, identifier: str) -> tuple[str, str] | None:
    """Find a dated scratchpad block. identifier is either a date 'YYYY-MM-DD'
    or a substring of the block body. Returns (header_line, body_text) or None.

    Scratchpad format: blocks separated by '## YYYY-MM-DD' headers.
    """
    lines = content.splitlines()
    blocks: list[tuple[int, str, list[str]]] = []  # (start_line, header, body_lines)
    current_header = None
    current_start = -1
    current_body: list[str] = []
    for idx, line in enumerate(lines):
        m = re.match(r"^##\s+(\d{4}-\d{2}-\d{2})\s*$", line)
        if m:
            if current_header is not None:
                blocks.append((current_start, current_header, current_body))
            current_header = line.strip()
            current_start = idx
            current_body = []
        else:
            if current_header is not None:
                current_body.append(line)
    if current_header is not None:
        blocks.append((current_start, current_header, current_body))

    needle = identifier.strip().lower()
    matches = []
    for start, header, body in blocks:
        body_text = "\n".join(body).strip()
        date_in_header = header[3:].strip()
        if needle == date_in_header.lower() or needle in body_text.lower():
            matches.append((start, header, body_text))
    if not matches:
        return None
    if len(matches) > 1:
        previews = "; ".join(f"{h}" for _, h, _ in matches[:5])
        raise ValueError(
            f"Mehrere Scratchpad-Blöcke matchen '{identifier}': {previews}. Bitte präziser (z.B. exaktes Datum)."
        )
    _, header, body_text = matches[0]
    return header, body_text


def _mark_scratchpad_block(content: str, header: str, raw_path: str) -> str:
    """Append a [PROMOTED → ...] marker to the block whose header matches."""
    lines = content.splitlines()
    out = []
    in_target_block = False
    for line in lines:
        if line.strip() == header:
            in_target_block = True
            out.append(line)
            continue
        if in_target_block and re.match(r"^##\s+\d{4}-\d{2}-\d{2}\s*$", line):
            out.append(f"\n> [PROMOTED → {raw_path}]")
            in_target_block = False
        out.append(line)
    if in_target_block:
        out.append(f"\n> [PROMOTED → {raw_path}]")
    return "\n".join(out) + ("\n" if not content.endswith("\n") else "")


def _find_todo(content: str, identifier: str) -> tuple[int, str, str] | None:
    """Find a todo line matching identifier. Returns (line_idx, full_line, todo_text)."""
    lines = content.splitlines()
    needle = identifier.strip().lower()
    matches = []
    for idx, line in enumerate(lines):
        m = notes_file.TODO_RE.match(line)
        if not m:
            continue
        text = m.group(2).strip()
        if needle in text.lower():
            matches.append((idx, line, text))
    if not matches:
        return None
    if len(matches) > 1:
        preview = "; ".join(t for _, _, t in matches[:5])
        raise ValueError(f"Mehrere Todos matchen '{identifier}': {preview}. Bitte präziser.")
    return matches[0]


def _mark_todo_promoted(line: str, raw_path: str) -> str:
    return f"{line.rstrip()} → {raw_path}"


def promote_to_raw(
    vault_id: str,
    source: str,
    identifier: str,
    target_subfolder: str,
    filename_slug: str | None = None,
    title: str | None = None,
    description: str | None = None,
) -> dict:
    """Move a scratchpad block or todo into vault/raw/<subfolder>/<date>-<slug>.md.

    Permissions: requires `write_raw` on the target vault.
    Source-side: scratchpad block gets a [PROMOTED] marker, todo line gets a → marker.
    """
    if source not in {"scratchpad", "todos"}:
        raise ValueError(f"source muss 'scratchpad' oder 'todos' sein, nicht '{source}'")

    vault = settings.get_vault(vault_id)
    if not vault:
        raise ValueError(f"Vault {vault_id} nicht gefunden")
    if not settings.vault_permission(vault_id, "write_raw"):
        raise PermissionError(
            f"Kein Schreibrecht auf raw/ im Vault '{vault['name']}'. "
            f"In den Einstellungen aktivieren: 'EwtosBrain darf in raw/ schreiben'."
        )

    subfolder = _validate_subfolder(target_subfolder)
    today = date.today().isoformat()

    # Resolve content + source-side marker
    if source == "scratchpad":
        data = notes_file.read_scratchpad(vault_id=vault_id)
        result = _extract_scratchpad_block(data["content"], identifier)
        if not result:
            raise ValueError(f"Kein Scratchpad-Block gefunden für '{identifier}'")
        header, body = result
        promoted_body = body
        slug = filename_slug or _slugify(title or body[:80])
    else:  # todos
        data = notes_file.load("todos", vault_id=vault_id)
        match = _find_todo(data["content"], identifier)
        if not match:
            raise ValueError(f"Kein Todo gefunden, das '{identifier}' enthält")
        idx, line, text = match
        promoted_body = text
        slug = filename_slug or _slugify(title or text)

    # Build raw file
    vault_root = Path(vault["path"])
    raw_dir = vault_root / "raw" / subfolder
    raw_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{today}-{slug}.md"
    raw_file = raw_dir / filename

    if raw_file.exists():
        # Avoid overwrite: append a counter suffix
        counter = 2
        while True:
            candidate = raw_dir / f"{today}-{slug}-{counter}.md"
            if not candidate.exists():
                raw_file = candidate
                break
            counter += 1

    frontmatter_lines = [
        "---",
        f"datum: {today}",
        f"quelle: notes/{source}.md",
        f"promoted: {today}",
    ]
    if title:
        frontmatter_lines.append(f"titel: {title.strip()}")
    if description:
        frontmatter_lines.append(f"beschreibung: {description.strip()}")
    frontmatter_lines.append("---")
    frontmatter = "\n".join(frontmatter_lines)

    body_block = []
    if title:
        body_block.append(f"# {title.strip()}")
    if description:
        body_block.append(description.strip())
    body_block.append(promoted_body.strip())
    body_text = "\n\n".join(b for b in body_block if b)

    raw_file.write_text(f"{frontmatter}\n\n{body_text}\n", encoding="utf-8")

    raw_rel = f"raw/{subfolder}/{raw_file.name}"

    # Source-side markers
    if source == "scratchpad":
        new_scratch = _mark_scratchpad_block(data["content"], header, raw_rel)
        notes_file.save("scratchpad", new_scratch, vault_id=vault_id)
    else:
        lines = data["content"].splitlines()
        lines[idx] = _mark_todo_promoted(lines[idx], raw_rel)
        body = "\n".join(lines).rstrip()
        notes_file.save("todos", body + "\n" if body else "", vault_id=vault_id)

    return {
        "promoted": True,
        "source": source,
        "vault": vault["name"],
        "raw_path": raw_rel,
        "absolute_path": str(raw_file),
        "ingest_hint": f"In Claude Code: 'ingeste {raw_rel}' für Wiki-Ingest",
    }


def save_raw_content(
    vault_id: str,
    title: str,
    content: str,
    target_subfolder: str,
    description: str | None = None,
    filename_slug: str | None = None,
    url: str | None = None,
    meta_title: str | None = None,
    meta_beschreibung: str | None = None,
    og_bild: str | None = None,
    canonical: str | None = None,
    h1: str | None = None,
    tags: list[str] | None = None,
) -> dict[str, Any]:
    """Save arbitrary content to vault/raw/<subfolder>/<date>-<slug>.md.

    Permissions: requires `write_raw` on the target vault.
    """
    vault = settings.get_vault(vault_id)
    if not vault:
        raise ValueError(f"Vault {vault_id} nicht gefunden")
    if not settings.vault_permission(vault_id, "write_raw"):
        raise PermissionError(
            f"Kein Schreibrecht auf raw/ im Vault '{vault['name']}'. "
            f"In den Einstellungen aktivieren: 'EwtosBrain darf in raw/ schreiben'."
        )

    subfolder = saeulen.safe_raw_subpath(target_subfolder)
    today = date.today().isoformat()
    slug = filename_slug or _slugify(title or "inhalt")

    vault_root = Path(vault["path"])
    raw_dir = vault_root / "raw" / subfolder
    raw_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{today}-{slug}.md"
    raw_file = raw_dir / filename

    if raw_file.exists():
        counter = 2
        while True:
            candidate = raw_dir / f"{today}-{slug}-{counter}.md"
            if not candidate.exists():
                raw_file = candidate
                break
            counter += 1

    frontmatter_lines = [
        "---",
        f"datum: {today}",
        f"titel: {title.strip()}",
    ]
    if description:
        frontmatter_lines.append(f"beschreibung: {description.strip()}")
    if tags:
        frontmatter_lines.append(f"tags: [{', '.join(tags)}]")
    if url:
        frontmatter_lines.append(f"url: {url}")
    if canonical and canonical != url:
        frontmatter_lines.append(f"canonical: {canonical}")
    if meta_title:
        frontmatter_lines.append(f"meta_titel: {meta_title}")
    if meta_beschreibung:
        frontmatter_lines.append(f"meta_beschreibung: {meta_beschreibung}")
    if og_bild:
        frontmatter_lines.append(f"og_bild: {og_bild}")
    if h1:
        frontmatter_lines.append(f"h1: {h1}")
    frontmatter_lines.append("---")
    frontmatter = "\n".join(frontmatter_lines)

    body_parts = [f"# {title.strip()}"]
    if description:
        body_parts.append(description.strip())
    body_parts.append(content.strip())
    body_text = "\n\n".join(p for p in body_parts if p)

    raw_file.write_text(f"{frontmatter}\n\n{body_text}\n", encoding="utf-8")

    raw_rel = f"raw/{subfolder}/{raw_file.name}"
    return {
        "raw_path": raw_rel,
        "vault": vault["name"],
        "ingest_hint": f"In Claude Code: 'ingeste {raw_rel}' für Wiki-Ingest",
    }


def save_video_to_raw(
    vault_id: str,
    url: str,
    title: str,
    transcript: str,
    playlist_name: str = "",
    tags: list[str] | None = None,
    channel: str | None = None,
    duration: str | None = None,
    views: int | None = None,
    likes: int | None = None,
    upload_date: str | None = None,
    thumbnail_url: str | None = None,
    description: str | None = None,
    thema: str | None = None,
) -> dict[str, Any]:
    """Save a video transcript to vault/raw/youtube/<date>-<slug>.md.

    Permissions: requires `write_raw` on the target vault.
    Optionale Metadaten (kanal/dauer/aufrufe/likes/upload/thumbnail/beschreibung/thema)
    werden nur geschrieben wenn vorhanden — sonst ehrlich weggelassen.
    Returns {raw_path, slug, vault}.
    """
    vault = settings.get_vault(vault_id)
    if not vault:
        raise ValueError(f"Vault {vault_id} nicht gefunden")
    if not settings.vault_permission(vault_id, "write_raw"):
        raise PermissionError(
            f"Kein Schreibrecht auf raw/ im Vault '{vault['name']}'. "
            f"In den Einstellungen aktivieren: 'EwtosBrain darf in raw/ schreiben'."
        )

    today = date.today().isoformat()
    slug = _slugify(title or url)

    vault_root = Path(vault["path"])
    raw_dir = vault_root / "raw" / "youtube"
    raw_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{today}-{slug}.md"
    raw_file = raw_dir / filename
    if raw_file.exists():
        counter = 2
        while True:
            candidate = raw_dir / f"{today}-{slug}-{counter}.md"
            if not candidate.exists():
                raw_file = candidate
                break
            counter += 1

    tag_list = tags or []
    frontmatter_lines = [
        "---",
        f"datum: {today}",
        f"quelle: {url}",
        f"titel: {title.strip() if title else ''}",
        f"target_playlist: {playlist_name.strip() if playlist_name else ''}",
        f"tags: [{', '.join(tag_list)}]",
        "typ: video",
    ]
    if thema:
        frontmatter_lines.append(f"thema: {thema}")
    if channel:
        frontmatter_lines.append(f"kanal: {channel}")
    if duration:
        frontmatter_lines.append(f"dauer: {duration}")
    if views is not None:
        frontmatter_lines.append(f"aufrufe: {views}")
    if likes is not None:
        frontmatter_lines.append(f"likes: {likes}")
    if upload_date:
        frontmatter_lines.append(f"upload_datum: {upload_date}")
    if thumbnail_url:
        frontmatter_lines.append(f"thumbnail_url: {thumbnail_url}")
    frontmatter_lines.append("---")
    frontmatter = "\n".join(frontmatter_lines)

    heading = f"# {title.strip() if title else url}"
    parts = [heading]
    if thumbnail_url:
        parts.append(f"![Thumbnail]({thumbnail_url})")
    if description:
        parts.append("## Beschreibung\n\n" + description.strip())
    if transcript:
        parts.append("## Transkript\n\n" + transcript.strip())
    body = "\n\n".join(parts) + "\n"
    raw_file.write_text(f"{frontmatter}\n\n{body}", encoding="utf-8")

    raw_rel = f"raw/youtube/{raw_file.name}"
    return {
        "raw_path": raw_rel,
        "slug": raw_file.stem,
        "vault": vault["name"],
        "ingest_hint": f"In Claude Code: 'ingeste {raw_rel}' für Wiki-Ingest",
    }
