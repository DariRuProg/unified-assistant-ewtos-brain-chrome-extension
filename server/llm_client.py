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


def sensitive_llm_config() -> tuple[str, str]:
    """Liefert (provider, model) der für sensible Dateien freigegebenen LLM.
    Leerer Provider = nicht konfiguriert → sensible Inhalte sind dann komplett gesperrt."""
    provider = (settings.get("sensitive_llm_provider") or "").strip().lower()
    model = (settings.get("sensitive_llm_model") or "").strip()
    return provider, model


def active_allowed_for_sensitive() -> bool:
    """True, wenn die aktive LLM die für sensible Dateien freigegebene ist.
    Ist kein sicheres LLM konfiguriert, ist sensibler Inhalt grundsätzlich gesperrt.
    Ist nur ein Provider (ohne Modell) freigegeben, zählt der Provider allein."""
    s_provider, s_model = sensitive_llm_config()
    if not s_provider:
        return False
    a_provider, a_model = effective_llm_config()
    if a_provider != s_provider:
        return False
    if s_model and a_model != s_model:
        return False
    return True


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
        # OpenRouter versteht Anthropic-style cache_control-Breakpoints (für Anthropic-Modelle);
        # Gemini/OpenAI cachen implizit und ignorieren es unschädlich.
        return OpenAIBackend(api_key=api_key, base_url=base_url, cache_control=True)

    log.warning("Unbekannter LLM-Provider '%s' — Fallback auf Anthropic", provider)
    api_key = settings.get("anthropic_api_key")
    if not api_key:
        raise ValueError(f"Provider '{provider}' unbekannt und kein Anthropic-API-Key für Fallback")
    return AnthropicBackend(api_key=api_key)
