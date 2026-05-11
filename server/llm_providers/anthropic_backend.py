"""Anthropic-Backend für das LLM-Provider-Interface.

1:1-Port der bestehenden `anthropic.Anthropic`-Calls aus chat.py und
summary_writer.py. Verhalten ist identisch zum Direkt-Aufruf — kein Refactor,
nur Wrapper.
"""
from __future__ import annotations

from typing import Iterator

import anthropic

from llm_providers.base import CompletionResult, LLMBackend, StreamHandle, Usage


def _usage(u) -> Usage:
    return Usage(
        input_tokens=u.input_tokens,
        output_tokens=u.output_tokens,
        cache_read_input_tokens=getattr(u, "cache_read_input_tokens", 0) or 0,
        cache_creation_input_tokens=getattr(u, "cache_creation_input_tokens", 0) or 0,
    )


class _AnthropicStreamHandle(StreamHandle):
    def __init__(self, stream_ctx):
        self._stream_ctx = stream_ctx
        self._final = None

    def __iter__(self) -> Iterator[str]:
        with self._stream_ctx as stream:
            for event in stream:
                if event.type == "content_block_delta" and event.delta.type == "text_delta":
                    yield event.delta.text
            self._final = stream.get_final_message()

    def get_final_result(self) -> CompletionResult:
        if self._final is None:
            raise RuntimeError("Stream noch nicht iteriert — get_final_result() erst nach Iteration aufrufen")
        return CompletionResult(
            content=list(self._final.content),
            stop_reason=self._final.stop_reason,
            usage=_usage(self._final.usage),
        )


class AnthropicBackend(LLMBackend):
    def __init__(self, api_key: str):
        self._client = anthropic.Anthropic(api_key=api_key)

    def _kwargs(self, *, model, messages, system, tools, max_tokens) -> dict:
        kwargs: dict = {"model": model, "max_tokens": max_tokens, "messages": messages}
        if system is not None:
            kwargs["system"] = system
        if tools is not None:
            kwargs["tools"] = tools
        return kwargs

    def complete(self, *, model, messages, system=None, tools=None, max_tokens=4096) -> CompletionResult:
        r = self._client.messages.create(
            **self._kwargs(model=model, messages=messages, system=system, tools=tools, max_tokens=max_tokens)
        )
        return CompletionResult(content=list(r.content), stop_reason=r.stop_reason, usage=_usage(r.usage))

    def stream_complete(self, *, model, messages, system=None, tools=None, max_tokens=4096) -> StreamHandle:
        ctx = self._client.messages.stream(
            **self._kwargs(model=model, messages=messages, system=system, tools=tools, max_tokens=max_tokens)
        )
        return _AnthropicStreamHandle(ctx)
