"""Settings Endpoints. ewtos.com"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

import chat
import config
import settings


router = APIRouter()

class SettingsUpdate(BaseModel):
    notes_path: str | None = None
    anthropic_api_key: str | None = None
    chat_model: str | None = None  # legacy, von llm_model abgelöst
    max_user_turns: int | None = None
    llm_provider: str | None = None
    llm_model: str | None = None
    openai_api_key: str | None = None
    ollama_base_url: str | None = None
    mistral_api_key: str | None = None
    openrouter_api_key: str | None = None
    openrouter_base_url: str | None = None
    gemini_api_key: str | None = None
    image_gen_model: str | None = None
    youtube_api_key: str | None = None
    setup_agent_provider: str | None = None
    setup_agent_model: str | None = None
    vault_search_enabled: bool | None = None
    chat_heavy_ops_mode: str | None = None
    elevenlabs_api_key: str | None = None
    elevenlabs_voice_id: str | None = None
    chat_tts_enabled: bool | None = None
    chat_show_sources: bool | None = None
    chat_show_activity: bool | None = None
    # video-brain Sync
    video_brain_supabase_url: str | None = None
    video_brain_supabase_anon_key: str | None = None
    video_brain_supabase_service_key: str | None = None
    video_brain_supabase_user_id: str | None = None
    video_brain_license_key: str | None = None


def _public_settings() -> dict[str, Any]:
    s = settings.all()
    return {
        "notes_path": s.get("notes_path") or config.NOTES_PATH,
        "chat_model": s.get("chat_model") or chat.DEFAULT_MODEL,  # legacy für UI-Backward-Compat
        "max_user_turns": s.get("max_user_turns") or chat.DEFAULT_MAX_TURNS,
        "anthropic_api_key_set": bool(s.get("anthropic_api_key")),
        "llm_provider": s.get("llm_provider") or "anthropic",
        "llm_model": s.get("llm_model") or s.get("chat_model") or chat.DEFAULT_MODEL,
        "openai_api_key_set": bool(s.get("openai_api_key")),
        "ollama_base_url": s.get("ollama_base_url") or "http://localhost:11434",
        "mistral_api_key_set": bool(s.get("mistral_api_key")),
        "openrouter_api_key_set": bool(s.get("openrouter_api_key")),
        "openrouter_base_url": s.get("openrouter_base_url") or "https://openrouter.ai/api/v1",
        "gemini_api_key_set": bool(s.get("gemini_api_key")),
        "image_gen_model": s.get("image_gen_model") or "gemini-2.5-flash-image",
        "setup_agent_provider": s.get("setup_agent_provider") or "",
        "setup_agent_model": s.get("setup_agent_model") or "",
        "vault_search_enabled": s.get("vault_search_enabled", True),
        "chat_heavy_ops_mode": s.get("chat_heavy_ops_mode") or "full",
        "elevenlabs_api_key_set": bool(s.get("elevenlabs_api_key")),
        "elevenlabs_voice_id": s.get("elevenlabs_voice_id") or "",
        "chat_tts_enabled": bool(s.get("chat_tts_enabled", False)),
        "chat_show_sources": bool(s.get("chat_show_sources", True)),
        "chat_show_activity": bool(s.get("chat_show_activity", True)),
        # video-brain Sync
        "video_brain_supabase_url": s.get("video_brain_supabase_url") or "",
        "video_brain_supabase_anon_key_set": bool(s.get("video_brain_supabase_anon_key")),
        "video_brain_supabase_service_key_set": bool(s.get("video_brain_supabase_service_key")),
        "video_brain_supabase_user_id": s.get("video_brain_supabase_user_id") or "",
        "video_brain_license_key_set": bool(s.get("video_brain_license_key")),
    }


@router.get("/settings")
def settings_get() -> dict[str, Any]:
    return _public_settings()


@router.post("/settings")
def settings_post(req: SettingsUpdate) -> dict[str, Any]:
    settings.update(req.model_dump(exclude_none=True))
    return _public_settings()
