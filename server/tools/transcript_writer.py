"""Transcript-Writer — speichert YouTube-Transcripts als raw/youtube/<datum>-<slug>.md
und aktualisiert die Master-Video-Page mit dem Transcript-Pfad.
"""
from __future__ import annotations

from datetime import date
from pathlib import Path

import settings
from tools import saeulen, videos


def _vault(vault_id: str) -> dict:
    v = settings.get_vault(vault_id)
    if not v:
        raise ValueError(f"Vault {vault_id} nicht gefunden")
    if not settings.vault_permission(vault_id, "write_raw"):
        raise PermissionError(
            f"Kein write_raw-Recht im Vault '{v['name']}'. "
            f"In den Einstellungen aktivieren."
        )
    return v


def save_transcript(
    vault_id: str,
    video_slug: str,
    transcript_text: str,
    with_timestamps: bool = False,
) -> dict:
    """Save raw transcript file (raw/youtube/) + update video page frontmatter.

    Requires both write_raw (for raw/youtube/) AND write_playlists
    (for video page update — checked indirectly via videos.set_transcript_path).
    """
    if not transcript_text or not transcript_text.strip():
        raise ValueError("Transcript-Text ist leer")

    v = _vault(vault_id)
    video = videos.get_video(vault_id, video_slug)
    if not video:
        raise ValueError(f"Video '{video_slug}' nicht gefunden")
    fm = video["frontmatter"]
    title = fm.get("titel") or video_slug
    url = fm.get("quelle_url") or ""

    today = date.today().isoformat()
    raw_dir = Path(v["path"]) / saeulen.RAW_YOUTUBE_REL
    raw_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{today}-{video_slug}.md"
    raw_file = raw_dir / filename
    if raw_file.exists():
        counter = 2
        while True:
            candidate = raw_dir / f"{today}-{video_slug}-{counter}.md"
            if not candidate.exists():
                raw_file = candidate
                break
            counter += 1

    fm_lines = [
        "---",
        f"datum: {today}",
        f"quelle: {url}",
        f"titel: {title}",
        "typ: video",
    ]
    for raw_key, page_key in [
        ("kanal", "kanal"),
        ("dauer", "dauer"),
        ("aufrufe", "aufrufe"),
        ("likes", "likes"),
        ("upload_datum", "upload_datum"),
        ("thumbnail_url", "thumbnail_url"),
        ("video_id", "video_id"),
        ("thema", "thema"),
    ]:
        val = fm.get(page_key)
        if val:
            fm_lines.append(f"{raw_key}: {val}")
    fm_lines.append(f"with_timestamps: {'true' if with_timestamps else 'false'}")
    fm_lines.append(f"video_page: wiki/resources/videos/{video_slug}")
    fm_lines.append(f"abgerufen: {today}")
    fm_lines.append("---")
    raw_content = "\n".join(fm_lines) + "\n\n## Transkript\n\n" + transcript_text.rstrip() + "\n"
    raw_file.write_text(raw_content, encoding="utf-8")

    raw_rel = f"raw/youtube/{raw_file.name}"
    videos.set_transcript_path(vault_id, video_slug, raw_rel)

    # Also update the "## Transkript" body section to show the wikilink
    page_path = videos.video_path(vault_id, video_slug)
    page_text = page_path.read_text(encoding="utf-8")
    transcript_link = f"[[{raw_rel.removesuffix('.md')}]]"
    import re as _re
    new_text = _re.sub(
        r"## Transkript\s*\n_\(noch nicht abgerufen\)_\s*",
        f"## Transkript\n{transcript_link}\n",
        page_text,
        count=1,
    )
    if new_text == page_text:
        # Pattern didn't match (already updated or different shape) — try
        # to replace any "## Transkript ... _(noch nicht abgerufen)_" block
        new_text = _re.sub(
            r"## Transkript[\s\S]*?(?=\n## |\Z)",
            f"## Transkript\n{transcript_link}\n",
            page_text,
            count=1,
        )
    if new_text != page_text:
        page_path.write_text(new_text, encoding="utf-8")

    return {
        "saved": True,
        "transcript_path": raw_rel,
        "video_slug": video_slug,
        "char_count": len(transcript_text),
    }
