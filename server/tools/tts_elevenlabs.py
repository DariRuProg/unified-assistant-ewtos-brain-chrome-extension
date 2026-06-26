"""Text-to-Speech via ElevenLabs.

Synchroner Aufruf gegen die ElevenLabs-API, liefert MP3-bytes zurueck.
Ergebnisse werden content-addressiert gecacht (SHA256 von text + voice_id),
damit wiederholte Synthesen keine API-Kosten verursachen.
API-Key kommt aus settings ('elevenlabs_api_key'), Stimme optional aus
'elevenlabs_voice_id' (sonst Default Rachel).
"""
# @author Dario | ewtos.com

import hashlib
import logging

import httpx

import paths
import settings

logger = logging.getLogger("ewtosbrain.tts_elevenlabs")

DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"  # Rachel
MAX_CHARS = 5000


def _cache_key(text: str, voice_id: str) -> str:
    return hashlib.sha256(f"{voice_id}|{text}".encode()).hexdigest()


def synth(text: str, voice_id: str | None = None) -> bytes:
    """Wandelt Text in Sprache (MP3-bytes) via ElevenLabs.

    Prueft zuerst den lokalen Cache. Bei Cache-Hit kein API-Aufruf.

    Raises:
        PermissionError: kein API-Key gesetzt.
        ValueError: HTTP-Fehler von ElevenLabs.
    """
    api_key = settings.get("elevenlabs_api_key")
    if not api_key:
        raise PermissionError("Kein ElevenLabs-API-Key gesetzt (Options → Chat).")

    if not voice_id:
        voice_id = settings.get("elevenlabs_voice_id") or DEFAULT_VOICE_ID

    text = (text or "")[:MAX_CHARS]

    cache_file = paths.tts_cache_dir() / f"{_cache_key(text, voice_id)}.mp3"
    if cache_file.exists():
        logger.debug("TTS cache hit: %s", cache_file.name)
        return cache_file.read_bytes()

    logger.info("TTS API call: voice=%s chars=%d", voice_id, len(text))
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
    headers = {"xi-api-key": api_key}
    payload = {"text": text, "model_id": "eleven_multilingual_v2"}

    response = httpx.post(url, headers=headers, json=payload, timeout=60)

    if response.status_code >= 400:
        body = response.text or ""
        raise ValueError(f"ElevenLabs-Fehler {response.status_code}: {body[:200]}")

    audio = response.content
    cache_file.write_bytes(audio)
    return audio
