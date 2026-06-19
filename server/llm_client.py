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
from llm_providers.ollama_backend import OllamaBackend
from llm_providers.openai_backend import OpenAIBackend

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

    if provider == "openai":
        api_key = settings.get("openai_api_key")
        if not api_key:
            raise ValueError("Kein OpenAI-API-Key in den Settings/Env")
        return OpenAIBackend(api_key=api_key)

    if provider == "ollama":
        base_url = settings.get("ollama_base_url") or "http://localhost:11434"
        return OllamaBackend(base_url=base_url)

    if provider == "mistral":
        api_key = settings.get("mistral_api_key")
        if not api_key:
            raise ValueError("Kein Mistral-API-Key in den Settings/Env")
        return OpenAIBackend(api_key=api_key, base_url="https://api.mistral.ai/v1")

    if provider == "openrouter":
        api_key = settings.get("openrouter_api_key")
        if not api_key:
            raise ValueError("Kein OpenRouter-API-Key in den Settings/Env")
        base_url = settings.get("openrouter_base_url") or "https://openrouter.ai/api/v1"
        return OpenAIBackend(api_key=api_key, base_url=base_url)

    log.warning("Unbekannter LLM-Provider '%s' — Fallback auf Anthropic", provider)
    api_key = settings.get("anthropic_api_key")
    if not api_key:
        raise ValueError(f"Provider '{provider}' unbekannt und kein Anthropic-API-Key für Fallback")
    return AnthropicBackend(api_key=api_key)
