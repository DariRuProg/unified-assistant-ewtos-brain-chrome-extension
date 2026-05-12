"""LLM-Backend-Abstraktion — provider-neutrales Interface.

Stand Phase 6 Stufe 1: nur Anthropic-Backend nutzt das Interface tatsächlich.
chat.py + summary_writer.py werden in Stufe 2 darauf umgebogen. Schema ist
bewusst Anthropic-near gewählt, damit der 1:1-Port trivial bleibt — OpenAI-,
Ollama- und Mistral-Backends übersetzen in Stufen 4-6 intern in dieses Schema.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Iterator


@dataclass
class TextBlock:
    """Anthropic-style text content block (provider-neutral)."""
    text: str
    type: str = "text"


@dataclass
class ToolUseBlock:
    """Anthropic-style tool_use content block (provider-neutral)."""
    id: str
    name: str
    input: dict = field(default_factory=dict)
    type: str = "tool_use"


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0


@dataclass
class CompletionResult:
    """Backend-agnostisches Ergebnis eines (Multi-Turn-)Completion-Calls.

    `content` ist eine Liste von Content-Blocks im Anthropic-Stil. Jeder Block
    hat ein `.type`-Feld plus type-spezifische Attribute:
      - text-Block: `.text`
      - tool_use-Block: `.id`, `.name`, `.input`
      - thinking-Block: `.thinking` (extended thinking)
      - redacted_thinking-Block: `.data`

    Non-Anthropic-Backends emittieren dieselbe Form (übersetzen intern).
    """
    content: list[Any]
    stop_reason: str | None
    usage: Usage


class StreamHandle(ABC):
    """Wrapper um einen Streaming-Call.

    Iteration liefert nur die `text_delta`-Strings (für Live-Output an die
    Extension). Nach Iteration: `get_final_result()` liefert das vollständige
    CompletionResult inkl. tool_use-Blocks für den Tool-Loop.
    """

    @abstractmethod
    def __iter__(self) -> Iterator[str]: ...

    @abstractmethod
    def get_final_result(self) -> CompletionResult: ...


class LLMBackend(ABC):
    """Provider-Backend. Wird per `llm_client.get_backend()` instanziiert."""

    @abstractmethod
    def complete(
        self,
        *,
        model: str,
        messages: list[dict],
        system: list[dict] | str | None = None,
        tools: list[dict] | None = None,
        max_tokens: int = 4096,
    ) -> CompletionResult: ...

    @abstractmethod
    def stream_complete(
        self,
        *,
        model: str,
        messages: list[dict],
        system: list[dict] | str | None = None,
        tools: list[dict] | None = None,
        max_tokens: int = 4096,
    ) -> StreamHandle: ...
