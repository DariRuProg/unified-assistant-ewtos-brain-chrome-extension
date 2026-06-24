"""YouTube-Metadaten synchron abrufen.

Primaer via yt-dlp (subprocess, --dump-json), Fallback/Ergaenzung via oEmbed.
Fehlertolerant: wirft nie, liefert immer ein dict (notfalls leer bzw. nur
video_id + thumbnail). Keine Abhaengigkeit von config/settings.
"""
# @author Dario | ewtos.com

import json
import logging
import re
import subprocess

import httpx

import settings as _settings

logger = logging.getLogger("ewtosbrain.youtube_metadata")

_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def _extract_video_id(url_or_id: str) -> str | None:
    """Extrahiert die 11-stellige Video-ID aus URL oder roher ID."""
    if not url_or_id:
        return None
    candidate = url_or_id.strip()

    if _VIDEO_ID_RE.match(candidate):
        return candidate

    patterns = [
        r"(?:v=|/v/|youtu\.be/|/embed/|/shorts/)([A-Za-z0-9_-]{11})",
        r"[?&]v=([A-Za-z0-9_-]{11})",
    ]
    for pat in patterns:
        m = re.search(pat, candidate)
        if m:
            return m.group(1)
    return None


def _parse_duration(seconds) -> str | None:
    """Sekunden -> 'H:MM:SS' bzw. 'M:SS'."""
    try:
        total = int(seconds)
    except (TypeError, ValueError):
        return None
    if total < 0:
        return None
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def _parse_upload_date(raw) -> str | None:
    """'YYYYMMDD' -> 'YYYY-MM-DD'."""
    if not raw:
        return None
    s = str(raw).strip()
    if len(s) == 8 and s.isdigit():
        return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"
    return None


def _best_thumbnail(info: dict, video_id: str | None) -> str | None:
    """Bestes verfuegbares Thumbnail aus yt-dlp-Info, sonst maxres-Fallback."""
    thumbs = info.get("thumbnails")
    if isinstance(thumbs, list) and thumbs:
        def _area(t):
            try:
                return int(t.get("width", 0)) * int(t.get("height", 0))
            except (TypeError, ValueError):
                return 0
        best = max(thumbs, key=_area)
        if best.get("url"):
            return best["url"]

    if info.get("thumbnail"):
        return info["thumbnail"]

    if video_id:
        return f"https://i.ytimg.com/vi/{video_id}/maxresdefault.jpg"
    return None


def _fetch_ytdlp(url: str) -> dict:
    """yt-dlp via subprocess. Leeres dict bei Fehler/Nichtvorhandensein."""
    proxy = _settings.get("youtube_proxy_url") or ""
    cmd = ["yt-dlp", "--dump-json", "--no-warnings", "--skip-download"]
    if proxy:
        cmd += ["--proxy", proxy]
    cmd.append(url)
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except FileNotFoundError:
        logger.info("yt-dlp nicht installiert, nutze oEmbed-Fallback")
        return {}
    except subprocess.TimeoutExpired:
        logger.warning("yt-dlp Timeout fuer %s", url)
        return {}
    except Exception as exc:  # noqa: BLE001
        logger.warning("yt-dlp Fehler: %s", exc)
        return {}

    if proc.returncode != 0:
        logger.warning("yt-dlp returncode %s: %s", proc.returncode, (proc.stderr or "")[:200])
        return {}

    try:
        return json.loads(proc.stdout)
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("yt-dlp JSON-Parse-Fehler: %s", exc)
        return {}


def _fetch_oembed(url: str) -> dict:
    """oEmbed fuer title/author/thumbnail. Leeres dict bei Fehler."""
    try:
        resp = httpx.get(
            "https://www.youtube.com/oembed",
            params={"url": url, "format": "json"},
            timeout=10,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:  # noqa: BLE001
        logger.info("oEmbed-Fallback fehlgeschlagen: %s", exc)
        return {}


def fetch_metadata(url_or_id: str) -> dict:
    """Holt YouTube-Metadaten zu einer URL oder Video-ID.

    Returns dict mit (soweit verfuegbar):
        video_id, title, channel, channel_url, duration, views, likes,
        upload_date, thumbnail, description
    Wirft nie; liefert mindestens {} bzw. {video_id, thumbnail}.
    """
    video_id = _extract_video_id(url_or_id)

    if video_id:
        watch_url = f"https://www.youtube.com/watch?v={video_id}"
    else:
        watch_url = (url_or_id or "").strip()

    result: dict = {}
    if video_id:
        result["video_id"] = video_id

    info = _fetch_ytdlp(watch_url) if watch_url else {}

    if info:
        if not video_id and info.get("id"):
            video_id = info["id"]
            result["video_id"] = video_id

        title = info.get("title")
        if title:
            result["title"] = title

        channel = info.get("uploader") or info.get("channel")
        if channel:
            result["channel"] = channel

        channel_url = info.get("uploader_url") or info.get("channel_url")
        if channel_url:
            result["channel_url"] = channel_url

        duration = _parse_duration(info.get("duration"))
        if duration:
            result["duration"] = duration

        if info.get("view_count") is not None:
            result["views"] = info["view_count"]

        if info.get("like_count") is not None:
            result["likes"] = info["like_count"]

        upload_date = _parse_upload_date(info.get("upload_date"))
        if upload_date:
            result["upload_date"] = upload_date

        description = info.get("description")
        if description:
            result["description"] = description[:800]

    # oEmbed nutzen, wenn yt-dlp fehlt/leer oder Felder fehlen
    if not info or not result.get("title") or not result.get("channel"):
        if watch_url:
            oembed = _fetch_oembed(watch_url)
            if oembed:
                if not result.get("title") and oembed.get("title"):
                    result["title"] = oembed["title"]
                if not result.get("channel") and oembed.get("author_name"):
                    result["channel"] = oembed["author_name"]
                if not result.get("channel_url") and oembed.get("author_url"):
                    result["channel_url"] = oembed["author_url"]
                if not result.get("thumbnail") and oembed.get("thumbnail_url"):
                    result["thumbnail"] = oembed["thumbnail_url"]

    if not result.get("thumbnail"):
        thumb = _best_thumbnail(info, video_id)
        if thumb:
            result["thumbnail"] = thumb

    return result
