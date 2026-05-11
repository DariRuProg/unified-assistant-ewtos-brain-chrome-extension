"""Summary-Writer — generiert eine Video-Zusammenfassung via Anthropic API
und schreibt sie in die Master-Video-Page (ersetzt die "noch keine
Zusammenfassung"-Sektionen).
"""
from __future__ import annotations

import re
from datetime import date
from pathlib import Path

import settings
from llm_client import effective_llm_config, get_backend
from tools import saeulen, videos


SUMMARY_PROMPT = """Du bekommst gleich das Transcript eines Videos (typisch YouTube). Erstelle eine knappe, dichte Zusammenfassung auf Deutsch in genau diesem Format:

## Kern-Insights
- 3-7 Bullet-Points mit den wichtigsten Erkenntnissen, je 1 Satz, präzise
- jede Aussage muss substanziell sein (nicht Zusammenfassung der Zusammenfassung)

## Zusammenfassung
2-4 Absätze die den Inhalt logisch nachvollziehbar machen. Wer sollte zusehen, was lernt man, was sind die Kern-Argumente. Konkret, kein Marketing-Sprech.

Antworte NUR mit diesen beiden Sektionen — keine Einleitung, kein "Hier ist die Zusammenfassung". Beginne direkt mit `## Kern-Insights`.

Titel: {title}
Channel: {channel}

Transcript:
{transcript}"""


def _vault(vault_id: str) -> dict:
    v = settings.get_vault(vault_id)
    if not v:
        raise ValueError(f"Vault {vault_id} nicht gefunden")
    if not settings.vault_permission(vault_id, "write_playlists"):
        raise PermissionError(
            f"Kein write_playlists-Recht im Vault '{v['name']}'."
        )
    return v


def _read_transcript(vault_path: str, transcript_rel: str) -> str:
    p = Path(vault_path) / transcript_rel
    if not p.exists():
        raise ValueError(f"Transcript-Datei nicht gefunden: {transcript_rel}")
    text = p.read_text(encoding="utf-8")
    # Strip frontmatter
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            text = text[end + 4 :].lstrip("\n")
    return text


def generate_summary(vault_id: str, video_slug: str, saeule: str | None = None) -> dict:
    s = saeulen.validate_saeule(saeule)
    v = _vault(vault_id)
    video = videos.get_video(vault_id, video_slug, s)
    if not video:
        raise ValueError(f"Video '{video_slug}' nicht gefunden in Säule '{s}'")
    fm = video["frontmatter"]
    transcript_path = fm.get("transcript")
    if not transcript_path or not str(transcript_path).strip():
        raise ValueError(f"Video '{video_slug}' hat noch kein Transcript — vorher pull_transcript")

    transcript_text = _read_transcript(v["path"], str(transcript_path))
    title = fm.get("titel") or video_slug
    channel = fm.get("youtuber") or "(unbekannt)"

    _, model = effective_llm_config()
    model = model or "claude-haiku-4-5"

    backend = get_backend()
    prompt = SUMMARY_PROMPT.format(
        title=title,
        channel=channel,
        transcript=transcript_text[:80000],  # safety cap
    )
    response = backend.complete(
        model=model,
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}],
    )
    summary_text = "".join(b.text for b in response.content if b.type == "text").strip()
    if not summary_text:
        raise RuntimeError("Anthropic-Antwort war leer")

    # Replace the placeholder sections in the video page
    p = videos.video_path(vault_id, video_slug, s)
    page_text = p.read_text(encoding="utf-8")

    # Split frontmatter
    if page_text.startswith("---"):
        end = page_text.find("\n---", 3)
        if end != -1:
            fm_block = page_text[: end + 4]
            body = page_text[end + 4 :]
        else:
            fm_block = ""
            body = page_text
    else:
        fm_block = ""
        body = page_text

    # Replace from "## Kern-Insights" up to "## Transcript" (or end)
    new_body = re.sub(
        r"## Kern-Insights[\s\S]*?(?=## Transcript|\Z)",
        summary_text.rstrip() + "\n\n",
        body,
        count=1,
    )
    if new_body == body:
        # Pattern not found — append at end
        new_body = body.rstrip() + "\n\n" + summary_text + "\n"

    p.write_text(fm_block + new_body, encoding="utf-8")

    today = date.today().isoformat()
    videos._rewrite_frontmatter_field(p, "zuletzt", today)

    return {
        "summarized": True,
        "video_slug": video_slug,
        "saeule": s,
        "model": model,
        "summary_chars": len(summary_text),
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
    }
