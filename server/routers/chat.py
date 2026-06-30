"""Chat (Vault/Page/Source Streams). ewtos.com"""
from __future__ import annotations

import logging

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import chat

log = logging.getLogger("ewtosbrain")

router = APIRouter()

# --- Chat -----------------------------------------------------------------

class ChatSendRequest(BaseModel):
    message: str
    page_context: str | None = None
    pinned_file: dict | None = None  # {"vault_id", "rel_path"} — Datei-Chat (schreibfähig)
    tool_level: str = "full"  # "none" | "knowledge" | "full" — Chat-Modus-Schalter


class PageChatRequest(BaseModel):
    message: str
    page_content: str
    history: list[dict] = []
    strict_page: bool = True


class SourceChatRequest(BaseModel):
    source_type: str  # "page" | "transcript" | "video"
    source_ref: dict
    message: str
    history: list[dict] = []
    strict_source: bool = True
    include_tools: bool = False
    vault_id: str | None = None
    tool_level: str | None = None  # "none" | "knowledge" | "full"; None → Fallback auf include_tools


class GeneralChatRequest(BaseModel):
    message: str
    history: list[dict] = []
    provider: str | None = None  # per-Request-Override; None → aktive Settings
    model: str | None = None     # per-Request-Override; None → aktive Settings / Default


# Static routes declared before {vault_id} routes so "page"/"source"/"general" aren't matched as vault_id.
@router.post("/tools/chat/page/stream")
def chat_page_stream(req: PageChatRequest) -> StreamingResponse:
    """SSE stream: chat about a scraped page — no vault needed. (Legacy, delegates to source-stream.)"""
    return StreamingResponse(
        chat.send_source_stream(
            "page",
            {"content": req.page_content},
            req.message,
            req.history,
            strict_source=req.strict_page,
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/tools/chat/general/stream")
def chat_general_stream(req: GeneralChatRequest) -> StreamingResponse:
    """SSE stream: vault-freier Allgemein-Chat mit optionalem per-Request Provider/Modell."""
    return StreamingResponse(
        chat.send_general_stream(req.message, req.history, provider=req.provider, model=req.model),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/tools/chat/source/stream")
def chat_source_stream(req: SourceChatRequest) -> StreamingResponse:
    """SSE stream: chat about a single source (page / transcript / video). No vault tools, no persistence."""
    return StreamingResponse(
        chat.send_source_stream(
            req.source_type,
            req.source_ref,
            req.message,
            req.history,
            strict_source=req.strict_source,
            include_tools=req.include_tools,
            vault_id=req.vault_id,
            tool_level=req.tool_level,
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# Per-vault routes — static segments (clear, stream) declared first to avoid
# being matched as vault_id="clear" or vault_id="stream".
@router.post("/tools/chat/{vault_id}/clear")
def chat_clear(vault_id: str) -> dict[str, Any]:
    try:
        return chat.clear(vault_id)
    except LookupError as e:
        raise HTTPException(404, str(e))


@router.post("/tools/chat/{vault_id}/stream")
def chat_stream(vault_id: str, req: ChatSendRequest) -> StreamingResponse:
    """SSE stream of chat events: tool_start, tool_end, text_delta, done, error."""
    return StreamingResponse(
        chat.send_stream(vault_id, req.message, page_context=req.page_context,
                         pinned_file=req.pinned_file, tool_level=req.tool_level),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/tools/chat/{vault_id}/debug-context")
def chat_debug_context(vault_id: str, tool_level: str = "full", pinned_rel: str = "") -> dict[str, Any]:
    """Token-Breakdown für Debug-UI."""
    try:
        return chat.debug_context(vault_id, tool_level=tool_level, pinned_rel=pinned_rel)
    except LookupError as e:
        raise HTTPException(404, str(e))


@router.get("/tools/chat/{vault_id}")
def chat_load(vault_id: str) -> dict[str, Any]:
    try:
        return chat.load(vault_id)
    except LookupError as e:
        raise HTTPException(404, str(e))


@router.post("/tools/chat/{vault_id}")
def chat_send(vault_id: str, req: ChatSendRequest) -> dict[str, Any]:
    try:
        return chat.send(vault_id, req.message, page_context=req.page_context,
                         pinned_file=req.pinned_file, tool_level=req.tool_level)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        log.exception("Chat error")
        raise HTTPException(500, str(e))
