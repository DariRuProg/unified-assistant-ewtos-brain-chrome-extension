"""Server-seitiger YouTube-Transcript-Fallback via youtube-transcript-api.

Wird gerufen, wenn der Browser-DOM-Scrape (extension/tools/youtube_transcript.js)
ein leeres Transcript liefert oder fehlschlaegt. Holt die Captions direkt von
YouTubes internem timedtext-Endpoint — kein Browser, kein DOM-Rendering.

Sprach-Praeferenz: Deutsch, dann Englisch, dann erste verfuegbare Sprache
(auto-generated zaehlt, weil viele Karpathy-/Tech-Videos nur Auto-Captions
haben).
"""
from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import parse_qs, urlparse

log = logging.getLogger(__name__)

PREFERRED_LANGS = ["de", "de-DE", "en", "en-US", "en-GB"]


def extract_video_id(url: str) -> str | None:
    """Holt die Video-ID aus den gaengigen YouTube-URL-Formen."""
    if not url:
        return None
    url = url.strip()
    # Direkt eine 11-Zeichen-ID?
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", url):
        return url
    try:
        parsed = urlparse(url)
    except Exception:
        return None
    host = (parsed.hostname or "").lower()
    if host.endswith("youtu.be"):
        vid = parsed.path.lstrip("/")
        return vid if re.fullmatch(r"[A-Za-z0-9_-]{11}", vid) else None
    if "youtube.com" in host:
        if parsed.path == "/watch":
            vid = parse_qs(parsed.query).get("v", [None])[0]
            return vid if vid and re.fullmatch(r"[A-Za-z0-9_-]{11}", vid) else None
        m = re.match(r"^/(?:embed|shorts|v|live)/([A-Za-z0-9_-]{11})", parsed.path)
        if m:
            return m.group(1)
    return None


def _format_timestamp(seconds: float) -> str:
    total = int(seconds)
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def fetch_transcript(url: str, with_timestamps: bool = False) -> dict[str, Any]:
    """Holt das Transcript via youtube-transcript-api.

    Returns:
        {"transcript": "<text>", "source": "server_fallback", "lang": "<code>"}

    Raises:
        ValueError: URL nicht parsebar oder keine Captions verfuegbar.
        ImportError: youtube-transcript-api nicht installiert.
    """
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        from youtube_transcript_api._errors import (
            NoTranscriptFound,
            TranscriptsDisabled,
            VideoUnavailable,
        )
    except ImportError as e:
        raise ImportError(
            "youtube-transcript-api fehlt. Bitte 'pip install youtube-transcript-api' im venv ausfuehren."
        ) from e

    video_id = extract_video_id(url)
    if not video_id:
        raise ValueError(f"Konnte keine Video-ID aus der URL extrahieren: {url}")

    api = YouTubeTranscriptApi()
    try:
        listing = api.list(video_id)
    except TranscriptsDisabled:
        raise ValueError("Captions sind fuer dieses Video deaktiviert")
    except VideoUnavailable:
        raise ValueError("Video nicht verfuegbar (privat/geloescht/regionsperre)")
    except Exception as e:
        raise ValueError(f"Konnte Caption-Liste nicht laden: {e}")

    # Manuelle Captions bevorzugen, sonst Auto-generated
    transcript_obj = None
    chosen_lang = None
    try:
        transcript_obj = listing.find_manually_created_transcript(PREFERRED_LANGS)
        chosen_lang = transcript_obj.language_code
    except NoTranscriptFound:
        pass

    if transcript_obj is None:
        try:
            transcript_obj = listing.find_generated_transcript(PREFERRED_LANGS)
            chosen_lang = transcript_obj.language_code
        except NoTranscriptFound:
            pass

    if transcript_obj is None:
        # Fallback: irgendeine Sprache nehmen
        for t in listing:
            transcript_obj = t
            chosen_lang = t.language_code
            break

    if transcript_obj is None:
        raise ValueError("Keine Captions in irgendeiner Sprache gefunden")

    try:
        fetched = transcript_obj.fetch()
    except Exception as e:
        raise ValueError(f"Caption-Download fehlgeschlagen: {e}")

    lines: list[str] = []
    for snip in fetched:
        # FetchedTranscriptSnippet: dataclass mit text/start/duration; aeltere
        # API-Versionen liefern dicts — beides abfangen.
        if isinstance(snip, dict):
            text = (snip.get("text") or "").replace("\n", " ").strip()
            start = float(snip.get("start") or 0)
        else:
            text = (getattr(snip, "text", "") or "").replace("\n", " ").strip()
            start = float(getattr(snip, "start", 0) or 0)
        if not text:
            continue
        if with_timestamps:
            lines.append(f"[{_format_timestamp(start)}] {text}")
        else:
            lines.append(text)

    transcript = "\n".join(lines)
    if not transcript.strip():
        raise ValueError("Captions geladen, aber leer nach Filterung")

    log.info("Fallback-Transcript geholt: %s (lang=%s, %d Zeilen)", video_id, chosen_lang, len(lines))
    return {"transcript": transcript, "source": "server_fallback", "lang": chosen_lang}
