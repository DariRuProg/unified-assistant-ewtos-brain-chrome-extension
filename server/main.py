"""EwtosBrain server — FastAPI + WebSocket bridge to Chrome extension."""
from __future__ import annotations

import asyncio
import logging
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

import config
import settings
from tools import notes_file

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
    log.info("Vault path: %s", config.VAULT_PATH)
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


class SettingsUpdate(BaseModel):
    notes_path: str | None = None


@app.get("/settings")
def settings_get() -> dict[str, Any]:
    s = settings.all()
    return {"notes_path": s.get("notes_path") or config.NOTES_PATH}


@app.post("/settings")
def settings_post(req: SettingsUpdate) -> dict[str, Any]:
    updated = settings.update(req.model_dump(exclude_none=True))
    return {"notes_path": updated.get("notes_path") or config.NOTES_PATH}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host=config.HOST, port=config.PORT, reload=False)
