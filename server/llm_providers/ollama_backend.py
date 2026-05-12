"""Ollama-Backend — lokal laufende LLMs für DSGVO-konforme Anwendungsfälle.

Ollama stellt eine OpenAI-kompatible API bereit (`/v1/chat/completions`).
Bekanntes Problem: Streaming + Tool-Use gleichzeitig ist in manchen Ollama-
Versionen fehlerhaft. Lösung: intern immer non-streaming + Tool-Use;
`stream_complete()` gibt einen FakeStreamHandle zurück, der den Text in einem
Stück liefert. Für reine Text-Antworten ohne Tools kein Problem.
"""
from __future__ import annotations

import logging
from typing import Iterator

from llm_providers.base import CompletionResult, StreamHandle
from llm_providers.openai_backend import OpenAIBackend

log = logging.getLogger(__name__)


class _OllamaFakeStreamHandle(StreamHandle):
    """Wrapper um ein fertig berechnetes CompletionResult — tut so als wäre es ein Stream."""

    def __init__(self, result: CompletionResult):
        self._result = result

    def __iter__(self) -> Iterator[str]:
        for block in self._result.content:
            if block.type == "text" and block.text:
                yield block.text

    def get_final_result(self) -> CompletionResult:
        return self._result


class OllamaBackend(OpenAIBackend):
    """Backend für lokal laufendes Ollama.

    Nutzt die OpenAI-kompatible Endpoint-Variante von Ollama (`/v1/`).
    `stream_complete()` verwendet intern `complete()` und gibt einen FakeStream
    zurück — kein progressives Streaming, aber korrekte Tool-Use-Verarbeitung.
    """

    def __init__(self, base_url: str = "http://localhost:11434"):
        clean = base_url.rstrip("/")
        super().__init__(api_key="ollama", base_url=f"{clean}/v1")
        log.info("OllamaBackend initialisiert: %s/v1", clean)

    def stream_complete(self, *, model, messages, system=None, tools=None, max_tokens=4096) -> StreamHandle:
        result = self.complete(
            model=model, messages=messages, system=system, tools=tools, max_tokens=max_tokens
        )
        return _OllamaFakeStreamHandle(result)
