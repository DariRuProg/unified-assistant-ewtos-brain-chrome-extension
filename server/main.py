"""EwtosBrain server — FastAPI + WebSocket bridge to Chrome extension."""
from __future__ import annotations

import asyncio
import logging
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import chat
import config
import settings
from tools import bookmarks as bookmarks_tool
from tools import notes_file, wiki_reader
from tools import playlists as playlists_tool
from tools import summary_writer, transcript_writer

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("ewtosbrain")


class ExtensionBridge:
    """Holds the active extension WebSocket and routes tool_call/tool_result by request_id."""

    def __init__(self) -> None:
        self.socket: WebSocket | None = None
        self.pending: dict[str, asyncio.Future[dict[str, Any]]] = {}

    @property
    def connected(self) -> bool:
        return self.socket is not None

    async def attach(self, ws: WebSocket) -> None:
        if self.socket is not None:
            log.warning("Replacing previous extension connection")
            for fut in list(self.pending.values()):
                if not fut.done():
                    fut.set_exception(RuntimeError("Extension reconnected mid-call"))
            self.pending.clear()
            try:
                await self.socket.close()
            except Exception:
                pass
        self.socket = ws
        log.info("Extension connected")

    async def detach(self, ws: WebSocket) -> None:
        if self.socket is ws:
            self.socket = None
            log.info("Extension disconnected")
            for fut in list(self.pending.values()):
                if not fut.done():
                    fut.set_exception(RuntimeError("Extension disconnected"))
            self.pending.clear()

    async def call(self, tool: str, params: dict[str, Any]) -> dict[str, Any]:
        if self.socket is None:
            raise HTTPException(503, "Extension not connected")
        request_id = uuid.uuid4().hex
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        self.pending[request_id] = fut
        try:
            await self.socket.send_json(
                {"type": "tool_call", "request_id": request_id, "tool": tool, "params": params}
            )
            return await asyncio.wait_for(fut, timeout=config.TOOL_TIMEOUT_SECONDS)
        finally:
            self.pending.pop(request_id, None)

    def deliver_result(self, payload: dict[str, Any]) -> None:
        request_id = payload.get("request_id")
        fut = self.pending.get(request_id) if request_id else None
        if fut and not fut.done():
            fut.set_result(payload)


bridge = ExtensionBridge()


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Server starting on %s:%s", config.HOST, config.PORT)
    legacy = settings.migrate_legacy_vault_path(chat.CHAT_DIR / "chat.json")
    if legacy:
        log.info("Migration: legacy vault_path -> vault id=%s name=%r", legacy["id"], legacy["name"])
    yield
    log.info("Server shutting down")


app = FastAPI(title="EwtosBrain", version="0.1.0", lifespan=lifespan)


@app.get("/")
def root() -> dict[str, Any]:
    return {
        "name": "EwtosBrain",
        "version": "0.1.0",
        "extension_connected": bridge.connected,
    }


@app.get("/status")
def status() -> dict[str, Any]:
    return {"extension_connected": bridge.connected, "pending_calls": len(bridge.pending)}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    await bridge.attach(ws)
    try:
        while True:
            msg = await ws.receive_json()
            mtype = msg.get("type")
            if mtype == "hello":
                log.info("Hello from %s v%s", msg.get("client"), msg.get("version"))
            elif mtype == "ping":
                await ws.send_json({"type": "pong"})
            elif mtype == "tool_result":
                bridge.deliver_result(msg)
            else:
                log.warning("Unknown WS message type: %s", mtype)
    except WebSocketDisconnect:
        pass
    finally:
        await bridge.detach(ws)


class YouTubeTranscriptRequest(BaseModel):
    url: str


@app.post("/tools/youtube_transcript")
async def youtube_transcript(req: YouTubeTranscriptRequest) -> dict[str, Any]:
    result = await bridge.call("youtube_transcript", {"url": req.url})
    if not result.get("ok"):
        raise HTTPException(500, result.get("error", "Tool call failed"))
    return result.get("data", {})


class NotesSaveRequest(BaseModel):
    content: str


class NotesExportRequest(BaseModel):
    path: str
    content: str


@app.get("/tools/notes/{kind}")
def notes_load(kind: str) -> dict[str, Any]:
    try:
        return notes_file.load(kind)
    except ValueError as e:
        raise HTTPException(404, str(e))


@app.post("/tools/notes/{kind}")
def notes_save(kind: str, req: NotesSaveRequest) -> dict[str, Any]:
    try:
        return notes_file.save(kind, req.content)
    except ValueError as e:
        raise HTTPException(404, str(e))


@app.post("/tools/notes/{kind}/export")
def notes_export(kind: str, req: NotesExportRequest) -> dict[str, Any]:
    try:
        return notes_file.export(req.path, req.content, source=kind)
    except ValueError as e:
        raise HTTPException(400, str(e))


class NotesAppendRequest(BaseModel):
    text: str


@app.post("/tools/notes/scratchpad/append")
def notes_scratchpad_append(req: NotesAppendRequest) -> dict[str, Any]:
    try:
        return notes_file.append_scratchpad(req.text)
    except ValueError as e:
        raise HTTPException(400, str(e))


# --- Bookmarks ------------------------------------------------------------

class BookmarkAddRequest(BaseModel):
    url: str
    title: str | None = None
    note: str | None = None
    source: str | None = "manual"


class BookmarkDeleteRequest(BaseModel):
    match: str


@app.get("/tools/bookmarks")
def bookmarks_list() -> dict[str, Any]:
    return {"items": bookmarks_tool.list_bookmarks()}


@app.post("/tools/bookmarks")
def bookmarks_add(req: BookmarkAddRequest) -> dict[str, Any]:
    try:
        return bookmarks_tool.add_bookmark(req.url, req.title, req.note, req.source or "manual")
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/tools/bookmarks/delete")
def bookmarks_delete(req: BookmarkDeleteRequest) -> dict[str, Any]:
    try:
        return bookmarks_tool.delete_bookmark(req.match)
    except ValueError as e:
        raise HTTPException(400, str(e))


# --- Playlists ------------------------------------------------------------

class PlaylistCreateRequest(BaseModel):
    name: str
    thema: str | None = None


class PlaylistAddItemRequest(BaseModel):
    url: str
    title: str | None = None
    dauer: str | None = None
    youtuber: str | None = None
    views: str | None = None
    published: str | None = None
    likes: str | None = None
    description: str | None = None


class PlaylistRemoveItemRequest(BaseModel):
    match: str


def _wrap_playlist_errors(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/tools/playlists/{vault_id}")
def playlists_list(vault_id: str) -> dict[str, Any]:
    return {"items": _wrap_playlist_errors(playlists_tool.list_playlists, vault_id)}


@app.post("/tools/playlists/{vault_id}")
def playlists_create(vault_id: str, req: PlaylistCreateRequest) -> dict[str, Any]:
    return _wrap_playlist_errors(playlists_tool.create_playlist, vault_id, req.name, req.thema)


@app.get("/tools/playlists/{vault_id}/{name}")
def playlists_get(vault_id: str, name: str) -> dict[str, Any]:
    return _wrap_playlist_errors(playlists_tool.get_playlist, vault_id, name)


@app.post("/tools/playlists/{vault_id}/{name}/items")
def playlists_add_item(vault_id: str, name: str, req: PlaylistAddItemRequest) -> dict[str, Any]:
    return _wrap_playlist_errors(
        playlists_tool.add_to_playlist,
        vault_id, name, req.url, req.title, req.dauer, req.youtuber,
        req.views, req.published, req.likes, req.description,
    )


@app.post("/tools/playlists/{vault_id}/{name}/items/delete")
def playlists_remove_item(vault_id: str, name: str, req: PlaylistRemoveItemRequest) -> dict[str, Any]:
    return _wrap_playlist_errors(
        playlists_tool.remove_from_playlist, vault_id, name, req.match,
    )


# --- Videos: Transcript + Summary ---------------------------------------

class TranscriptSaveRequest(BaseModel):
    transcript: str
    with_timestamps: bool = False


@app.post("/tools/videos/{vault_id}/{slug}/transcript")
def videos_save_transcript(vault_id: str, slug: str, req: TranscriptSaveRequest) -> dict[str, Any]:
    try:
        return transcript_writer.save_transcript(vault_id, slug, req.transcript, req.with_timestamps)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/tools/videos/{vault_id}/{slug}/summary")
def videos_generate_summary(vault_id: str, slug: str) -> dict[str, Any]:
    try:
        return summary_writer.generate_summary(vault_id, slug)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


class SettingsUpdate(BaseModel):
    notes_path: str | None = None
    anthropic_api_key: str | None = None
    chat_model: str | None = None
    max_user_turns: int | None = None


def _public_settings() -> dict[str, Any]:
    s = settings.all()
    return {
        "notes_path": s.get("notes_path") or config.NOTES_PATH,
        "chat_model": s.get("chat_model") or chat.DEFAULT_MODEL,
        "max_user_turns": s.get("max_user_turns") or chat.DEFAULT_MAX_TURNS,
        "anthropic_api_key_set": bool(s.get("anthropic_api_key")),
    }


@app.get("/settings")
def settings_get() -> dict[str, Any]:
    return _public_settings()


@app.post("/settings")
def settings_post(req: SettingsUpdate) -> dict[str, Any]:
    settings.update(req.model_dump(exclude_none=True))
    return _public_settings()


# --- Vaults ---------------------------------------------------------------

class VaultCreate(BaseModel):
    name: str
    path: str
    system_prompt: str | None = ""


class VaultUpdate(BaseModel):
    name: str | None = None
    path: str | None = None
    system_prompt: str | None = None
    permissions: dict[str, bool] | None = None


class GeneratePromptRequest(BaseModel):
    path: str


def _enrich_vault(v: dict[str, Any]) -> dict[str, Any]:
    perms = dict(settings.DEFAULT_VAULT_PERMISSIONS)
    perms.update(v.get("permissions") or {})
    return {
        **v,
        "permissions": perms,
        "has_claude_md": wiki_reader.find_claude_md(v["path"]) is not None,
    }


@app.get("/vaults")
def vaults_list() -> dict[str, Any]:
    return {"vaults": [_enrich_vault(v) for v in settings.get_vaults()]}


@app.post("/vaults")
def vaults_create(req: VaultCreate) -> dict[str, Any]:
    if not req.name.strip():
        raise HTTPException(400, "Name darf nicht leer sein")
    if not req.path.strip():
        raise HTTPException(400, "Pfad darf nicht leer sein")
    return settings.add_vault(req.name, req.path, req.system_prompt or "")


# Static POST routes BEFORE /vaults/{vault_id} to avoid path-param matching.
@app.post("/vaults/preview-claude-md")
def vaults_preview_claude_md(req: GeneratePromptRequest) -> dict[str, Any]:
    """Read CLAUDE.md from a path (no LLM call). Returns the content + the
    canned generator instruction so the user can copy & use externally."""
    content = chat.preview_claude_md(req.path)
    if not content:
        raise HTTPException(404, "Keine CLAUDE.md im Pfad oder dessen Parent gefunden")
    return {
        "claude_md": content,
        "generator_instruction": chat.generator_instruction(content),
    }


@app.post("/vaults/generate-prompt")
def vaults_generate_prompt(req: GeneratePromptRequest) -> dict[str, Any]:
    """Read CLAUDE.md and call Claude to generate a system prompt."""
    try:
        return chat.generate_system_prompt(req.path)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        log.exception("Prompt generation error")
        raise HTTPException(500, str(e))


@app.get("/vaults/{vault_id}")
def vaults_get(vault_id: str) -> dict[str, Any]:
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, "Vault nicht gefunden")
    return _enrich_vault(v)


@app.post("/vaults/{vault_id}")
def vaults_update(vault_id: str, req: VaultUpdate) -> dict[str, Any]:
    updated = settings.update_vault(vault_id, **req.model_dump(exclude_none=True))
    if not updated:
        raise HTTPException(404, "Vault nicht gefunden")
    return updated


@app.delete("/vaults/{vault_id}")
def vaults_delete(vault_id: str) -> dict[str, Any]:
    if not settings.remove_vault(vault_id):
        raise HTTPException(404, "Vault nicht gefunden")
    chat_file = chat.CHAT_DIR / f"chat-{vault_id}.json"
    if chat_file.exists():
        chat_file.unlink()
    return {"removed": True, "vault_id": vault_id}


# --- Chat -----------------------------------------------------------------

class ChatSendRequest(BaseModel):
    message: str


# Per-vault routes — static segments (clear, stream) declared first to avoid
# being matched as vault_id="clear" or vault_id="stream".
@app.post("/tools/chat/{vault_id}/clear")
def chat_clear(vault_id: str) -> dict[str, Any]:
    try:
        return chat.clear(vault_id)
    except LookupError as e:
        raise HTTPException(404, str(e))


@app.post("/tools/chat/{vault_id}/stream")
def chat_stream(vault_id: str, req: ChatSendRequest) -> StreamingResponse:
    """SSE stream of chat events: tool_start, tool_end, text_delta, done, error."""
    return StreamingResponse(
        chat.send_stream(vault_id, req.message),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/tools/chat/{vault_id}")
def chat_load(vault_id: str) -> dict[str, Any]:
    try:
        return chat.load(vault_id)
    except LookupError as e:
        raise HTTPException(404, str(e))


@app.post("/tools/chat/{vault_id}")
def chat_send(vault_id: str, req: ChatSendRequest) -> dict[str, Any]:
    try:
        return chat.send(vault_id, req.message)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        log.exception("Chat error")
        raise HTTPException(500, str(e))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host=config.HOST, port=config.PORT, reload=False)
