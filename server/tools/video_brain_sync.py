"""video-brain Sync — spiegelt fertig verarbeitete Videos in die Kunden-eigene
Supabase (Bring-Your-Own-Supabase). Schreibt mit dem service_key (bypassed RLS)
und setzt user_id auf die konfigurierte video_brain_supabase_user_id, damit die
video-brain PWA die Zeilen per RLS (auth.uid() = user_id) lesen kann.

Zentrale Lizenz-Prüfung: vor jedem Sync-Aufruf wird ein einmalig gecachtes
check_license(p_key) gegen die zentrale Lizenz-Supabase gerufen. Ohne gültige
Lizenz wird der Sync abgelehnt; der Vault-Write läuft unberührt weiter.

Fehler werden immer geloggt und NIE weitergeworfen — Vault-Write darf nicht
durch einen Sync-Fehler scheitern (non-blocking).
"""
from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, parse_qs

import httpx

import settings

__author__ = "Dario | ewtos.com"

log = logging.getLogger("ewtosbrain.video_brain_sync")

# --- Zentrale Lizenz-Supabase (Dario) ----------------------------------------
# anon-key ist public-safe: RLS erlaubt nur Ausführung der check_license-RPC,
# kein direkter Tabellen-Zugriff für anon.
_LICENSE_SUPABASE_URL = "https://ircjdynyxetmhcdyspnr.supabase.co"   # TODO: nach Deployment setzen
_LICENSE_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlyY2pkeW55eGV0bWhjZHlzcG5yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwMTY2OTIsImV4cCI6MjA5NzU5MjY5Mn0.naUa2rbB0S7JOjTBsd8a2FTFQIaU21fWp50EEOAb5xc"  # TODO: nach Deployment setzen

_LICENSE_CACHE: dict[str, tuple[bool, float]] = {}  # key → (valid, expires_at)
_LICENSE_CACHE_TTL = 3600  # 1h


# --- Lizenz ------------------------------------------------------------------

def _license_valid() -> bool:
    """Prüft den konfigurierten Lizenz-Key gegen die zentrale Supabase.
    Ergebnis wird 1h gecacht. Bei Netzfehler wird die letzte bekannte Antwort
    genutzt (Offline-Grace); ohne jemals geprüfte Lizenz wird False geliefert."""
    key = settings.get("video_brain_license_key")
    if not key:
        log.warning("video_brain_license_key nicht konfiguriert")
        return False

    cached = _LICENSE_CACHE.get(key)
    if cached and time.time() < cached[1]:
        return cached[0]

    if not _LICENSE_SUPABASE_URL or not _LICENSE_SUPABASE_ANON_KEY:
        # Zentrale Supabase noch nicht konfiguriert — lokal ohne Lizenz-Check erlauben
        log.debug("Zentrale Lizenz-Supabase nicht konfiguriert, Sync ohne Check")
        return True

    try:
        resp = httpx.post(
            f"{_LICENSE_SUPABASE_URL}/rest/v1/rpc/check_license",
            headers={
                "apikey": _LICENSE_SUPABASE_ANON_KEY,
                "Authorization": f"Bearer {_LICENSE_SUPABASE_ANON_KEY}",
                "Content-Type": "application/json",
            },
            json={"p_key": key},
            timeout=10.0,
        )
        if resp.status_code == 200:
            rows = resp.json()
            valid = bool(rows and rows[0].get("status") == "active")
        else:
            log.warning("Lizenz-Check HTTP %s: %s", resp.status_code, resp.text[:200])
            valid = cached[0] if cached else False
    except Exception as exc:
        log.warning("Lizenz-Check fehlgeschlagen (Offline-Grace): %s", exc)
        valid = cached[0] if cached else False

    _LICENSE_CACHE[key] = (valid, time.time() + _LICENSE_CACHE_TTL)
    return valid


# --- Kunden-Supabase ---------------------------------------------------------

def _customer_cfg() -> dict[str, str]:
    url = settings.get("video_brain_supabase_url")
    service_key = settings.get("video_brain_supabase_service_key")
    user_id = settings.get("video_brain_supabase_user_id")
    if not url:
        raise PermissionError("video_brain_supabase_url nicht konfiguriert (Options → video-brain)")
    if not service_key:
        raise PermissionError("video_brain_supabase_service_key nicht konfiguriert (Options → video-brain)")
    if not user_id:
        raise PermissionError("video_brain_supabase_user_id nicht konfiguriert (Options → video-brain)")
    return {"url": url.rstrip("/"), "service_key": service_key, "user_id": user_id}


def _sb_headers(service_key: str) -> dict[str, str]:
    return {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
    }


# --- Video-Daten aus Vault lesen ---------------------------------------------

_VIDEO_ID_RE = re.compile(
    r"(?:youtube\.com/(?:watch\?v=|shorts/)|youtu\.be/)([A-Za-z0-9_-]{11})"
)
_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _extract_video_id(url: str) -> str | None:
    m = _VIDEO_ID_RE.search(url)
    if m:
        return m.group(1)
    try:
        qs = parse_qs(urlparse(url).query)
        if "v" in qs:
            return qs["v"][0]
    except Exception:
        pass
    return None


def _slugify(text: str) -> str:
    return _SLUG_RE.sub("-", (text or "").strip().lower()).strip("-")[:60] or "unknown"


def _parse_yaml_value(line: str) -> tuple[str, str] | None:
    m = re.match(r"^([a-zA-Z_]\w*):\s*(.*)$", line)
    if not m:
        return None
    return m.group(1), m.group(2).strip()


def _read_frontmatter(text: str) -> dict[str, Any]:
    meta: dict[str, Any] = {}
    if not text.startswith("---"):
        return meta
    end = text.find("\n---", 3)
    if end == -1:
        return meta
    for line in text[3:end].splitlines():
        kv = _parse_yaml_value(line)
        if not kv:
            continue
        k, v = kv
        if v.startswith("[") and v.endswith("]"):
            inner = v[1:-1]
            meta[k] = [i.strip() for i in inner.split(",") if i.strip()]
        else:
            meta[k] = v
    return meta


def _extract_section(body: str, heading: str) -> str:
    pattern = rf"^##\s+{re.escape(heading)}\s*\n"
    m = re.search(pattern, body, re.MULTILINE)
    if not m:
        return ""
    start = m.end()
    next_h = re.search(r"^##\s+", body[start:], re.MULTILINE)
    end = start + next_h.start() if next_h else len(body)
    return body[start:end].strip()


def _extract_bullets(section_text: str) -> list[str]:
    bullets = []
    for line in section_text.splitlines():
        line = line.strip()
        if line.startswith("- "):
            bullets.append(line[2:].strip())
        elif line.startswith("* "):
            bullets.append(line[2:].strip())
    return bullets


def _read_transcript_file(vault_path: str, transcript_rel: str) -> str:
    p = Path(vault_path) / transcript_rel
    if not p.exists():
        return ""
    text = p.read_text(encoding="utf-8")
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            text = text[end + 4:].lstrip("\n")
    return text


def _parse_int(val: Any) -> int | None:
    """Wandelt einen Frontmatter-Wert in int um. None bei Fehler."""
    if val is None:
        return None
    try:
        return int(str(val).replace(",", "").replace(".", "").replace(" ", "").strip())
    except (ValueError, TypeError):
        return None


def _build_history_row(vault_path: str, video_data: dict, user_id: str) -> dict | None:
    """Mappt ewtos-brain Video-Daten auf das video-brain history-Schema.

    Unterstützt beide Frontmatter-Varianten:
    - Säulen-Schema:  quelle_url / youtuber / published / views / likes / dauer
    - PARA/raw-Schema: quelle / kanal / upload_datum / aufrufe / likes
    - raw/youtube/*.md: Transcript steht inline im Body unter ## Transcript
    """
    fm = video_data.get("frontmatter") or {}
    body = video_data.get("body") or ""

    # URL: beide Varianten
    url = fm.get("quelle_url") or fm.get("quelle") or fm.get("url") or ""
    if not url:
        return None

    video_id = _extract_video_id(url)
    if not video_id:
        return None

    title = fm.get("titel") or fm.get("title") or video_data.get("slug") or ""
    # Kanal: Säulen-Schema "youtuber", PARA/raw-Schema "kanal", raw "channel"
    channel = fm.get("youtuber") or fm.get("kanal") or fm.get("channel") or ""

    # Thumbnail: explizit im Frontmatter hat Vorrang
    thumbnail_url = (
        fm.get("thumbnail_url")
        or fm.get("thumbnail")
        or f"https://img.youtube.com/vi/{video_id}/maxresdefault.jpg"
    )

    # Transcript: Säulen-Schema hat relativen Pfad im Frontmatter;
    # raw/youtube/*.md hat den Text direkt im Body unter ## Transcript
    transcript_rel = fm.get("transcript") or ""
    if transcript_rel:
        transcript_text = _read_transcript_file(vault_path, str(transcript_rel))
    else:
        transcript_text = _extract_section(body, "Transkript") or _extract_section(body, "Transcript")

    # Body-Sektionen (Säulen-Schema nach Summary-Generate)
    kern_section = _extract_section(body, "Kern-Insights")
    summary_section = _extract_section(body, "Zusammenfassung")
    key_insights = _extract_bullets(kern_section)

    tags = fm.get("tags") or []
    playlists = fm.get("playlists") or []
    topics = list({t for t in (tags + playlists) if t and t not in ("video", "youtube")})

    # Zählwerte als Integer für dedizierte Spalten
    yt_view_count = _parse_int(fm.get("views") or fm.get("aufrufe"))
    yt_like_count = _parse_int(fm.get("likes"))

    # Metadaten-JSON: alle ergänzenden Felder
    metadata: dict[str, Any] = {}
    dauer = fm.get("dauer")
    if dauer:
        metadata["duration"] = dauer
    upload = fm.get("published") or fm.get("upload_datum") or fm.get("upload_date")
    if upload:
        metadata["upload_date"] = upload
    description = fm.get("description")
    if description:
        metadata["description"] = description[:2000]
    channel_url = fm.get("channel_url")
    if channel_url:
        metadata["channel_url"] = channel_url

    # Live-Enrichment: fehlende Felder via yt-dlp nachladen
    if not yt_view_count and not metadata.get("description"):
        try:
            from tools.youtube_metadata import fetch_metadata as _yt_meta
            live = _yt_meta(video_id)
            if live:
                if yt_view_count is None and live.get("views") is not None:
                    yt_view_count = int(live["views"])
                if yt_like_count is None and live.get("likes") is not None:
                    yt_like_count = int(live["likes"])
                if not channel:
                    channel = live.get("channel") or channel
                if not metadata.get("description") and live.get("description"):
                    metadata["description"] = live["description"]
                if not metadata.get("channel_url") and live.get("channel_url"):
                    metadata["channel_url"] = live["channel_url"]
                if not metadata.get("duration") and live.get("duration"):
                    metadata["duration"] = live["duration"]
                if not metadata.get("upload_date") and live.get("upload_date"):
                    metadata["upload_date"] = live["upload_date"]
                if live.get("thumbnail") and "maxresdefault" in thumbnail_url:
                    thumbnail_url = live["thumbnail"]
        except Exception as exc:
            log.debug("Live-Enrichment für %s fehlgeschlagen: %s", video_id, exc)

    return {
        "video_id": video_id,
        "user_id": user_id,
        "url": url,
        "title": title,
        "channel": channel,
        "thumbnail_url": thumbnail_url,
        "summary": summary_section,
        "summary_short": (summary_section.split("\n\n")[0] if summary_section else "")[:500],
        "topics_json": json.dumps(topics, ensure_ascii=False),
        "key_insights_json": json.dumps(key_insights, ensure_ascii=False),
        "transcript": transcript_text,
        "yt_view_count": yt_view_count,
        "yt_like_count": yt_like_count,
        "creator_slug": _slugify(channel) if channel else None,
        "metadata_json": json.dumps(metadata, ensure_ascii=False) if metadata else None,
        "vault_synced": True,
    }


# --- Upsert ------------------------------------------------------------------

def _upsert_history(cfg: dict, row: dict) -> None:
    resp = httpx.post(
        f"{cfg['url']}/rest/v1/history",
        headers=_sb_headers(cfg["service_key"]),
        json=row,
        timeout=15.0,
    )
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"Supabase upsert fehlgeschlagen: HTTP {resp.status_code} — {resp.text[:300]}")


# --- Öffentliche API ---------------------------------------------------------

def sync_video(vault_id: str, video_slug: str, saeule: str | None = None) -> dict:
    """Spiegelt ein einzelnes fertig verarbeitetes Video in die Kunden-Supabase.
    Non-blocking: gibt immer ein dict zurück, wirft nie (Fehler nur geloggt)."""
    try:
        if not _license_valid():
            log.warning("video_brain sync übersprungen — Lizenz ungültig oder nicht konfiguriert")
            return {"ok": False, "reason": "license_invalid"}

        cfg = _customer_cfg()

        from tools import videos as videos_tool, saeulen
        s = saeulen.validate_saeule(saeule)
        vault = settings.get_vault(vault_id)
        if not vault:
            return {"ok": False, "reason": f"vault {vault_id} nicht gefunden"}

        video_data = videos_tool.get_video(vault_id, video_slug, s)
        if not video_data:
            return {"ok": False, "reason": f"video {video_slug} nicht gefunden"}

        row = _build_history_row(vault["path"], video_data, cfg["user_id"])
        if not row:
            return {"ok": False, "reason": "keine gültige YouTube-URL im Frontmatter"}

        _upsert_history(cfg, row)
        log.info("video_brain sync OK: %s (%s)", video_slug, row["video_id"])
        return {"ok": True, "video_id": row["video_id"], "video_slug": video_slug}

    except Exception as exc:
        log.error("video_brain sync Fehler für %s: %s", video_slug, exc)
        return {"ok": False, "reason": str(exc)}


def _parse_md_file(md_file: Path) -> dict:
    """Liest eine Markdown-Datei und gibt {slug, frontmatter, body} zurück.
    Unterstützt beide YAML-Frontmatter-Varianten (Säulen + PARA/raw)."""
    from tools.videos import _split_frontmatter, _parse_yaml_value, _parse_list_value  # type: ignore[attr-defined]
    text = md_file.read_text(encoding="utf-8")
    fm_text, body = _split_frontmatter(text)
    meta: dict[str, Any] = {}
    for line in fm_text.splitlines():
        kv = _parse_yaml_value(line)
        if not kv:
            continue
        key, value = kv
        if value.startswith("["):
            meta[key] = _parse_list_value(value)
        else:
            meta[key] = value
    return {"slug": md_file.stem, "path": str(md_file), "frontmatter": meta, "body": body}


def _collect_md_files(vault_path: Path) -> list[Path]:
    """Sammelt alle Video-relevanten .md-Dateien aus dem Vault.

    Scannt:
    - wiki/<säule>/videos/*.md   (klassische Säulen-Struktur)
    - wiki/**/videos/*.md         (PARA und andere Unterordner)
    - raw/youtube/*.md             (rohe YouTube-Transcripts)
    """
    seen: set[Path] = set()
    result: list[Path] = []

    def add(p: Path) -> None:
        rp = p.resolve()
        if rp not in seen:
            seen.add(rp)
            result.append(p)

    # wiki/**/videos/ — findet Säulen UND PARA-Struktur in einem Durchgang
    for f in sorted(vault_path.glob("wiki/**/videos/*.md")):
        if f.stem != "index":
            add(f)

    # raw/youtube/ — rohe Transkript-Dateien
    raw_yt = vault_path / "raw" / "youtube"
    if raw_yt.exists():
        for f in sorted(raw_yt.glob("*.md")):
            add(f)

    return result


def resync_all(vault_id: str) -> dict:
    """Iteriert alle Video-relevanten .md-Dateien im Vault (Säulen + PARA + raw/youtube)
    und synct sie in die Kunden-Supabase. Gibt Zähler und Fehlerliste zurück."""
    if not _license_valid():
        return {"ok": False, "reason": "license_invalid", "synced": 0, "failed": []}

    try:
        cfg = _customer_cfg()
    except PermissionError as exc:
        return {"ok": False, "reason": str(exc), "synced": 0, "failed": []}

    vault = settings.get_vault(vault_id)
    if not vault:
        return {"ok": False, "reason": f"vault {vault_id} nicht gefunden", "synced": 0, "failed": []}

    vault_path = Path(vault["path"])
    md_files = _collect_md_files(vault_path)
    synced = 0
    failed: list[dict] = []

    for md_file in md_files:
        slug = md_file.stem
        try:
            video_data = _parse_md_file(md_file)
            row = _build_history_row(vault["path"], video_data, cfg["user_id"])
            if not row:
                continue  # kein YouTube-Link → überspringen, kein Fehler
            _upsert_history(cfg, row)
            log.info("video_brain resync OK: %s (%s)", slug, row["video_id"])
            synced += 1
        except Exception as exc:
            log.error("video_brain resync Fehler für %s: %s", slug, exc)
            failed.append({"slug": slug, "path": str(md_file), "reason": str(exc)})

    log.info("video_brain resync_all: vault=%s synced=%d failed=%d", vault_id, synced, len(failed))
    return {"ok": True, "synced": synced, "failed": failed}
