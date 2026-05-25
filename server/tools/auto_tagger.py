"""Auto-Tagger — analysiert YouTube-Transcript + Titel via LLM und schlägt
Säule, Playlist und Tags vor."""
from __future__ import annotations

__author__ = "Dario | ewtos.com"

import json
import re

import settings
from llm_client import effective_llm_config, get_backend
from tools import saeulen
from tools import playlists as playlists_tool

SYSTEM_PROMPT = """\
Du bist ein Wissens-Kategorisierer. Analysiere den Titel und Transcript-Ausschnitt eines YouTube-Videos.
Antworte NUR mit validem JSON (kein Markdown, keine Erklärung):
{"saeule": "<name>", "playlist_name": "<name oder null>", "tags": ["tag1", "tag2"], "confidence": "high|medium|low"}

Verfügbare Säulen: {saeulen_liste}
Verfügbare Playlists: {playlists_liste}\
"""

_JSON_RE = re.compile(r"\{[\s\S]*\}")

_FALLBACK = {"saeule": "knowledge-library/ai", "playlist_name": None, "tags": [], "confidence": "low"}


def auto_tag(transcript: str, title: str, vault_id: str) -> dict:
    try:
        raw_playlists = playlists_tool.list_playlists(vault_id)
        playlist_names = [p["name"] for p in raw_playlists]
    except (PermissionError, ValueError):
        playlist_names = []

    saeulen_liste = ", ".join(saeulen.list_allowed())
    playlists_liste = ", ".join(playlist_names) if playlist_names else "(keine)"

    system = SYSTEM_PROMPT.format(
        saeulen_liste=saeulen_liste,
        playlists_liste=playlists_liste,
    )

    user_message = f"Titel: {title}\n\nTranscript-Ausschnitt:\n{transcript[:3000]}"

    try:
        _, model = effective_llm_config()
        model = model or "claude-haiku-4-5"
        backend = get_backend()
        result = backend.complete(
            model=model,
            max_tokens=256,
            system=system,
            messages=[{"role": "user", "content": user_message}],
        )
        text = "".join(b.text for b in result.content if b.type == "text").strip()
        m = _JSON_RE.search(text)
        if not m:
            return dict(_FALLBACK)
        parsed = json.loads(m.group())
        return {
            "saeule": str(parsed.get("saeule") or _FALLBACK["saeule"]),
            "playlist_name": parsed.get("playlist_name") or None,
            "tags": list(parsed.get("tags") or []),
            "confidence": str(parsed.get("confidence") or "low"),
        }
    except Exception:
        return dict(_FALLBACK)
