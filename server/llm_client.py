"""LLM-Client-Factory — wählt das aktive Backend basierend auf den Settings.

Stand Phase 6 Stufe 1: nur Anthropic. Stufen 4-6 ergänzen OpenAI, Ollama,
Mistral. Settings-Schema:
  - `llm_provider`: "anthropic" (Default) | "openai" | "ollama" | "mistral"
  - `llm_model`: Modell-Name (provider-spezifisch)
  - API-Keys pro Provider: `anthropic_api_key`, `openai_api_key`, ...

Backward-Compat: ohne `llm_provider` fällt alles auf "anthropic" + `chat_model`
zurück. Alte settings.json läuft ohne Migration weiter.
"""
from __future__ import annotations

import logging

import settings
from llm_providers.anthropic_backend import AnthropicBackend
from llm_providers.base import LLMBackend

log = logging.getLogger(__name__)


def effective_llm_config() -> tuple[str, str]:
    """Liefert (provider, model) basierend auf Settings mit Backward-Compat.

    Wenn `llm_provider` nicht gesetzt → "anthropic". Wenn `llm_model` nicht
    gesetzt → Fallback auf `chat_model` (Anthropic-Modellname).
    """
    provider = (settings.get("llm_provider") or "anthropic").strip().lower()
    model = (settings.get("llm_model") or settings.get("chat_model") or "").strip()
    return provider, model


def get_backend() -> LLMBackend:
    """Instanziiert das aktive Backend. Wirft, wenn der nötige API-Key fehlt."""
    provider, _ = effective_llm_config()

    if provider == "anthropic":
        api_key = settings.get("anthropic_api_key")
        if not api_key:
            raise ValueError("Kein Anthropic-API-Key in den Settings/Env")
        return AnthropicBackend(api_key=api_key)

    # Stufe 4-6 ergänzen openai/ollama/mistral. Bis dahin: Fallback mit Warnung.
    log.warning("LLM-Provider '%s' noch nicht implementiert — Fallback auf Anthropic", provider)
    api_key = settings.get("anthropic_api_key")
    if not api_key:
        raise ValueError(f"Provider '{provider}' nicht implementiert und kein Anthropic-API-Key für Fallback")
    return AnthropicBackend(api_key=api_key)
