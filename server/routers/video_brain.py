"""video-brain Supabase-Sync. ewtos.com"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from tools import video_brain_sync as _vb_sync
import config
import settings

router = APIRouter()

# --- video-brain Sync --------------------------------------------------------

from tools import video_brain_sync as _vb_sync

@router.post("/tools/video-brain/resync/{vault_id}")
def video_brain_resync(vault_id: str) -> dict[str, Any]:
    """Spiegelt alle Video-Pages eines Vaults in die Kunden-Supabase.
    Für Erstbefüllung und Reparatur — Lizenz-Check läuft intern."""
    return _vb_sync.resync_all(vault_id)


@router.post("/tools/video-brain/sync/{vault_id}/{slug}")
def video_brain_sync_one(vault_id: str, slug: str) -> dict[str, Any]:
    """Spiegelt ein einzelnes Video manuell."""
    return _vb_sync.sync_video(vault_id, slug)


@router.get("/tools/video-brain/status")
def video_brain_status() -> dict[str, Any]:
    """Zeigt ob video-brain konfiguriert ist (keine Secrets im Klartext)."""
    s = settings.all()
    return {
        "configured": bool(
            s.get("video_brain_supabase_url")
            and s.get("video_brain_supabase_service_key")
            and s.get("video_brain_supabase_user_id")
        ),
        "license_key_set": bool(s.get("video_brain_license_key")),
        "supabase_url": s.get("video_brain_supabase_url") or "",
        "supabase_user_id": s.get("video_brain_supabase_user_id") or "",
    }


@router.get("/tools/video-brain/pair-config")
def video_brain_pair_config() -> dict[str, str]:
    """Gibt BYO-Supabase-Config für QR-Pairing zurück.
    supabase_anon_key ist public-safe (Client-Key, designed für Browser-Zugriff).
    supabase_service_key wird NICHT zurückgegeben."""
    s = settings.all()
    return {
        "supabase_url": s.get("video_brain_supabase_url") or "",
        "supabase_anon_key": s.get("video_brain_supabase_anon_key") or "",
        "user_id": s.get("video_brain_supabase_user_id") or "",
        "license_key": s.get("video_brain_license_key") or "",
    }
