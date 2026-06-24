"""WebSocket-Bridge zur Chrome-Extension + Server-Version. ewtos.com"""
from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from fastapi import HTTPException, WebSocket

import config

log = logging.getLogger("ewtosbrain")

# Single Source der Server-Version. Muss mit extension/manifest.json "version"
# uebereinstimmen — der WS-Handshake gleicht major.minor ab.
SERVER_VERSION = "0.1.0"


def _version_compatible(client_version: str | None) -> bool:
    if not client_version:
        return False
    return client_version.split(".")[:2] == SERVER_VERSION.split(".")[:2]


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
            # Do NOT close the old socket — sending a close frame to an already-dead
            # SW connection would trigger onclose in the extension if the old SW
            # is still alive, causing an immediate reconnect loop.
            # The old connection dies naturally when the SW is terminated.
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
