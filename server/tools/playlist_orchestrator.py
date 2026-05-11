"""Playlist-Orchestrator — Bulk-Pull aller pending Transcripts einer Playlist.

Iteriert seriell über die Items einer Playlist, prüft pro Video ob bereits
ein Transcript existiert (Frontmatter-Feld `transcript:` leer = pending),
und triggert bei pending das `youtube_transcript`-Tool über die WS-Bridge
zur Chrome-Extension. Erfolgreiche Transcripts werden via
`transcript_writer.save_transcript` abgelegt — das setzt automatisch das
Frontmatter-Feld, sodass beim nächsten Lauf das Item nicht mehr pending ist
(idempotent).

Seriell statt parallel: jeder Pull öffnet ein Hidden-Window in Chrome —
parallele Pulls würden mehrere gleichzeitig öffnen und Memory-/CPU-Last
erzeugen. Plus 1s Inter-Item-Delay für sauberes Window-Cleanup.

Lock gegen Doppel-Trigger: nur ein Orchestrierungs-Lauf gleichzeitig.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import settings
from tools import playlists, saeulen, transcript_writer, videos

log = logging.getLogger(__name__)

INTER_ITEM_DELAY_SECONDS = 1.0
TRANSCRIPT_PULL_TIMEOUT_SECONDS = 90

_active_lock = asyncio.Lock()


async def pull_pending_transcripts(
    vault_id: str,
    playlist_name: str,
    bridge,
    saeule: str | None = None,
    with_timestamps: bool = False,
    summarize: bool = False,
) -> dict[str, Any]:
    """Hole alle pending Transcripts einer Playlist seriell ab.

    Args:
        vault_id, playlist_name, saeule: identifizieren die Playlist (Default 'knowledge-library/ai').
        bridge: ExtensionBridge-Instanz aus main.py (für `bridge.call`).
        with_timestamps: wenn True, Transcript mit `[HH:MM:SS]`-Prefix.
        summarize: wenn True, ruft pro erfolgreich-transcribed Item zusätzlich
            `summary_writer.generate_summary`. Achtung: kostet Anthropic-Tokens.

    Returns:
        Statistik-Dict: total, transcribed, skipped_already_done, failed,
        aborted (mit abort_reason), failed_summaries (bei summarize=True).
    """
    s = saeulen.validate_saeule(saeule)

    if not settings.vault_permission(vault_id, "write_raw"):
        raise PermissionError("write_raw-Recht fehlt im Vault — in den Einstellungen aktivieren")
    if not settings.vault_permission(vault_id, "write_playlists"):
        raise PermissionError("write_playlists-Recht fehlt im Vault — in den Einstellungen aktivieren")
    if not bridge.connected:
        raise ValueError("EwtosBrain-Extension nicht verbunden — bitte Chrome-Extension öffnen")

    if _active_lock.locked():
        return {
            "playlist": playlist_name,
            "saeule": s,
            "total": 0,
            "transcribed": 0,
            "skipped_already_done": 0,
            "failed": [],
            "aborted": True,
            "abort_reason": "already_running — eine andere Orchestrierung läuft gerade",
        }

    async with _active_lock:
        return await _run(vault_id, playlist_name, s, bridge, with_timestamps, summarize)


async def _run(
    vault_id: str,
    playlist_name: str,
    saeule: str,
    bridge,
    with_timestamps: bool,
    summarize: bool,
) -> dict[str, Any]:
    playlist = playlists.get_playlist(vault_id, playlist_name, saeule=saeule)
    items = playlist.get("items") or []

    result: dict[str, Any] = {
        "playlist": playlist_name,
        "saeule": saeule,
        "total": len(items),
        "transcribed": 0,
        "skipped_already_done": 0,
        "failed": [],
        "aborted": False,
        "abort_reason": None,
    }
    if summarize:
        result["summarized"] = 0
        result["failed_summaries"] = []

    for idx, item in enumerate(items):
        title = item.get("title") or "(unbekannt)"
        url = (item.get("url") or "").strip()
        page = (item.get("page") or "").strip()
        slug = page.rsplit("/", 1)[-1] if page else None

        if not slug:
            result["failed"].append({"title": title, "url": url, "error": "missing_video_page_link"})
            continue
        if not url:
            result["failed"].append({"title": title, "url": url, "error": "no_url"})
            continue

        # Pending-Check via Master-Page-Frontmatter
        try:
            video = videos.get_video(vault_id, slug, saeule=saeule)
        except Exception as e:
            result["failed"].append({"title": title, "url": url, "error": f"get_video: {e}"})
            continue
        if not video:
            result["failed"].append({"title": title, "url": url, "error": "missing_video_master_page"})
            continue
        existing = (video["frontmatter"].get("transcript") or "")
        if isinstance(existing, str) and existing.strip():
            result["skipped_already_done"] += 1
            continue

        log.info("Orchestrator [%d/%d]: pull %s", idx + 1, len(items), title[:60])

        # Pull via Bridge
        try:
            pull_result = await asyncio.wait_for(
                bridge.call("youtube_transcript", {"url": url, "with_timestamps": with_timestamps}),
                timeout=TRANSCRIPT_PULL_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            result["failed"].append({
                "title": title, "url": url,
                "error": f"timeout nach {TRANSCRIPT_PULL_TIMEOUT_SECONDS}s",
            })
            continue
        except RuntimeError as e:
            # Bridge-Disconnect mid-call → Abbruch
            msg = str(e)
            if "disconnected" in msg.lower() or "reconnected" in msg.lower():
                result["aborted"] = True
                result["abort_reason"] = f"bridge_disconnected: {msg}"
                return result
            result["failed"].append({"title": title, "url": url, "error": msg})
            continue
        except Exception as e:
            result["failed"].append({"title": title, "url": url, "error": str(e)})
            continue

        # Bridge-Result-Schape: {ok: bool, data?: {transcript: ...}, error?: str}
        if not pull_result.get("ok"):
            result["failed"].append({
                "title": title, "url": url,
                "error": f"extension: {pull_result.get('error', 'unbekannt')}",
            })
            continue
        text = (pull_result.get("data") or {}).get("transcript") or ""
        if not text.strip():
            result["failed"].append({"title": title, "url": url, "error": "leeres Transcript"})
            continue

        # Speichern
        try:
            transcript_writer.save_transcript(
                vault_id, slug, text, with_timestamps=with_timestamps, saeule=saeule,
            )
            result["transcribed"] += 1
        except PermissionError as e:
            result["aborted"] = True
            result["abort_reason"] = f"permission: {e}"
            return result
        except Exception as e:
            result["failed"].append({"title": title, "url": url, "error": f"save: {e}"})
            continue

        # Optional Summary
        if summarize:
            try:
                from tools import summary_writer
                summary_writer.generate_summary(vault_id, slug, saeule=saeule)
                result["summarized"] += 1
            except Exception as e:
                result["failed_summaries"].append({"title": title, "error": str(e)})

        # Inter-Item-Delay
        if idx + 1 < len(items):
            await asyncio.sleep(INTER_ITEM_DELAY_SECONDS)

    return result
