"""OpenAI-Backend für das LLM-Provider-Interface.

Adapter zwischen Anthropic-nahem internen Schema (Tool-Defs mit `input_schema`,
Nachrichten mit `tool_result`-Blöcken) und OpenAI-Chat-Completions-API.
Wird auch von `MistralBackend` als Basis genutzt (OpenAI-kompatible API).
"""
from __future__ import annotations

import json
import logging
from typing import Iterator

import openai

from llm_providers.base import (
    CompletionResult,
    LLMBackend,
    StreamHandle,
    TextBlock,
    ToolUseBlock,
    Usage,
)

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Format-Adapter: Anthropic → OpenAI
# ---------------------------------------------------------------------------

def _to_oai_tools(tools: list[dict]) -> list[dict]:
    """Konvertiert Anthropic-style Tool-Defs zu OpenAI-Format."""
    return [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t.get("description", ""),
                "parameters": t.get("input_schema", {"type": "object", "properties": {}}),
            },
        }
        for t in tools
    ]


def _system_text(system) -> str | None:
    if system is None:
        return None
    if isinstance(system, str):
        return system or None
    if isinstance(system, list):
        parts = [b.get("text", "") for b in system if b.get("type") == "text"]
        text = "\n".join(p for p in parts if p)
        return text or None
    return str(system) or None


def _has_cache_control(system) -> bool:
    """True, wenn der System-Prompt einen ephemeral-Cache-Breakpoint trägt."""
    return isinstance(system, list) and any(
        isinstance(b, dict) and b.get("cache_control") for b in system
    )


def _to_oai_messages(messages: list[dict], system, cache_control: bool = False) -> list[dict]:
    """Konvertiert Anthropic-Nachrichten-Liste + System-Prompt zu OpenAI-Format.

    Wichtige Übersetzungen:
    - System → role:system als erstes Element
    - user/content=str → role:user
    - user/content=[tool_result,...] → mehrere role:tool-Nachrichten
    - assistant/content=[text+tool_use,...] → role:assistant mit tool_calls

    cache_control=True (nur OpenRouter): trägt der System-Block einen Cache-Breakpoint,
    wird das System als strukturierter Content-Part mit `cache_control` ausgegeben, damit
    OpenRouter den Prefix für Anthropic-Modelle cacht (Gemini/OpenAI cachen ohnehin implizit).
    """
    result = []

    sys_text = _system_text(system)
    if sys_text:
        if cache_control and _has_cache_control(system):
            result.append({"role": "system", "content": [
                {"type": "text", "text": sys_text, "cache_control": {"type": "ephemeral"}},
            ]})
        else:
            result.append({"role": "system", "content": sys_text})

    for msg in messages:
        role = msg["role"]
        content = msg["content"]

        if role == "user":
            if isinstance(content, str):
                result.append({"role": "user", "content": content})
            elif isinstance(content, list):
                if content and content[0].get("type") == "tool_result":
                    for tr in content:
                        result.append({
                            "role": "tool",
                            "tool_call_id": tr["tool_use_id"],
                            "content": str(tr.get("content", "")),
                        })
                else:
                    text = "".join(b.get("text", "") for b in content if b.get("type") == "text")
                    result.append({"role": "user", "content": text})

        elif role == "assistant":
            if isinstance(content, str):
                result.append({"role": "assistant", "content": content})
            elif isinstance(content, list):
                text_parts = [b.get("text", "") for b in content if b.get("type") == "text"]
                tool_calls = [
                    {
                        "id": b["id"],
                        "type": "function",
                        "function": {
                            "name": b["name"],
                            "arguments": json.dumps(b["input"], ensure_ascii=False),
                        },
                    }
                    for b in content if b.get("type") == "tool_use"
                ]
                msg_dict: dict = {"role": "assistant", "content": "".join(text_parts) or ""}
                if tool_calls:
                    msg_dict["tool_calls"] = tool_calls
                result.append(msg_dict)

    return result


# ---------------------------------------------------------------------------
# Format-Adapter: OpenAI → CompletionResult
# ---------------------------------------------------------------------------

def _build_completion(
    text: str,
    tool_calls_data: list[dict],
    finish_reason: str | None,
    usage_obj,
) -> CompletionResult:
    content: list = []
    if text:
        content.append(TextBlock(text=text))
    for tc in tool_calls_data:
        try:
            input_data = json.loads(tc["arguments"] or "{}")
        except Exception:
            input_data = {}
        content.append(ToolUseBlock(id=tc["id"], name=tc["name"], input=input_data))

    stop_reason = "tool_use" if finish_reason == "tool_calls" else "end_turn"

    u = Usage()
    if usage_obj:
        u.input_tokens = getattr(usage_obj, "prompt_tokens", 0) or 0
        u.output_tokens = getattr(usage_obj, "completion_tokens", 0) or 0
        # Cache-Treffer sichtbar machen (OpenAI/OpenRouter: prompt_tokens_details.cached_tokens)
        details = getattr(usage_obj, "prompt_tokens_details", None)
        if details is not None:
            cached = getattr(details, "cached_tokens", None)
            if cached is None and isinstance(details, dict):
                cached = details.get("cached_tokens")
            u.cache_read_input_tokens = cached or 0

    return CompletionResult(content=content, stop_reason=stop_reason, usage=u)


# ---------------------------------------------------------------------------
# Streaming Handle
# ---------------------------------------------------------------------------

class _OpenAIStreamHandle(StreamHandle):
    """Iteriert über OpenAI-SSE-Chunks; sammelt Tool-Calls intern."""

    def __init__(self, client: openai.OpenAI, kwargs: dict):
        self._client = client
        self._kwargs = kwargs
        self._final: CompletionResult | None = None

    def __iter__(self) -> Iterator[str]:
        accumulated_text: list[str] = []
        accumulated_tools: dict[int, dict] = {}
        stop_reason: str | None = None
        usage_obj = None

        stream = self._client.chat.completions.create(
            **self._kwargs,
            stream=True,
            stream_options={"include_usage": True},
        )
        for chunk in stream:
            if getattr(chunk, "usage", None):
                usage_obj = chunk.usage
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            delta = choice.delta

            if delta.content:
                accumulated_text.append(delta.content)
                yield delta.content

            if delta.tool_calls:
                for tc in delta.tool_calls:
                    idx = tc.index
                    if idx not in accumulated_tools:
                        accumulated_tools[idx] = {"id": "", "name": "", "arguments": ""}
                    if tc.id:
                        accumulated_tools[idx]["id"] = tc.id
                    if tc.function:
                        if tc.function.name:
                            accumulated_tools[idx]["name"] = tc.function.name
                        if tc.function.arguments:
                            accumulated_tools[idx]["arguments"] += tc.function.arguments

            if choice.finish_reason:
                stop_reason = choice.finish_reason

        tool_calls_list = [accumulated_tools[i] for i in sorted(accumulated_tools)]
        self._final = _build_completion(
            "".join(accumulated_text),
            tool_calls_list,
            stop_reason or "stop",
            usage_obj,
        )

    def get_final_result(self) -> CompletionResult:
        if self._final is None:
            raise RuntimeError("Stream noch nicht iteriert — erst iterieren, dann get_final_result() aufrufen")
        return self._final


# ---------------------------------------------------------------------------
# Backend
# ---------------------------------------------------------------------------

class OpenAIBackend(LLMBackend):
    """Backend für OpenAI (und OpenAI-kompatible APIs wie Mistral)."""

    def __init__(self, api_key: str, base_url: str | None = None, cache_control: bool = False):
        self._client = openai.OpenAI(api_key=api_key, base_url=base_url)
        # Nur Provider, die das Anthropic-style cache_control verstehen (OpenRouter).
        self._cache_control = cache_control

    def _build_kwargs(self, *, model, messages, system, tools, max_tokens) -> dict:
        kwargs: dict = {
            "model": model,
            "messages": _to_oai_messages(messages, system, cache_control=self._cache_control),
            "max_tokens": max_tokens,
        }
        if tools:
            kwargs["tools"] = _to_oai_tools(tools)
            kwargs["tool_choice"] = "auto"
        return kwargs

    def complete(self, *, model, messages, system=None, tools=None, max_tokens=4096) -> CompletionResult:
        kwargs = self._build_kwargs(
            model=model, messages=messages, system=system, tools=tools, max_tokens=max_tokens
        )
        response = self._client.chat.completions.create(**kwargs)
        choice = response.choices[0]
        msg = choice.message

        tc_list = []
        for tc in (msg.tool_calls or []):
            tc_list.append({
                "id": tc.id,
                "name": tc.function.name,
                "arguments": tc.function.arguments or "{}",
            })

        return _build_completion(
            msg.content or "",
            tc_list,
            choice.finish_reason,
            response.usage,
        )

    def stream_complete(self, *, model, messages, system=None, tools=None, max_tokens=4096) -> StreamHandle:
        kwargs = self._build_kwargs(
            model=model, messages=messages, system=system, tools=tools, max_tokens=max_tokens
        )
        return _OpenAIStreamHandle(self._client, kwargs)
