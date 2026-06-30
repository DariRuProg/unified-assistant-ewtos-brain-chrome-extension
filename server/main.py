"""EwtosBrain server — FastAPI + WebSocket bridge to Chrome extension."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from dotenv import load_dotenv

import paths

paths.migrate_legacy_data()
load_dotenv(paths.env_file())

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

import chat
import config
import settings
import auth
import users
from bridge import bridge, SERVER_VERSION, _version_compatible
from routers import auth as auth_router
from routers import notes
from routers import images
from routers import playlists
from routers import briefing
from routers import brain
from routers import video_brain
from routers import vaults
from routers import blueprints
from routers import chat as chat_router
from routers import web_tools
from routers import vault_files
from routers import videos
from routers import settings as settings_router
from routers import system

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("ewtosbrain")



def _ensure_demo_vault() -> None:
    """Registriert im Demo-Modus den gebündelten Beispiel-Vault (read-only), falls
    noch nicht vorhanden."""
    import paths
    demo_path = str(paths.demo_vault_dir())
    for v in settings.get_vaults():
        if str(v.get("path")) == demo_path:
            return
    vault = settings.add_vault("Demo-Vault", demo_path, use_local_notes=False)
    log.info("Demo-Modus: Beispiel-Vault registriert id=%s path=%s", vault["id"], demo_path)


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Server starting on %s:%s", config.HOST, config.PORT)
    legacy = settings.migrate_legacy_vault_path(chat.CHAT_DIR / "chat.json")
    if legacy:
        log.info("Migration: legacy vault_path -> vault id=%s name=%r", legacy["id"], legacy["name"])
    if config.DEMO_MODE:
        log.info("Demo-Modus AKTIV — read-only, Beispiel-Vault")
        _ensure_demo_vault()
    yield
    log.info("Server shutting down")


app = FastAPI(title="EwtosBrain", version=SERVER_VERSION, lifespan=lifespan)
app.middleware("http")(auth.auth_middleware)
app.include_router(auth_router.router)
app.include_router(notes.router)
app.include_router(images.router)
app.include_router(playlists.router)
app.include_router(briefing.router)
app.include_router(brain.router)
app.include_router(video_brain.router)
app.include_router(vaults.router)
app.include_router(blueprints.router)
app.include_router(chat_router.router)
app.include_router(web_tools.router)
app.include_router(vault_files.router)
app.include_router(videos.router)
app.include_router(settings_router.router)
app.include_router(system.router)


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    # Auth: bei aktivierten Usern Token als Query-Param ?token= verlangen.
    if settings.user_count() > 0 and not users.decode_token(ws.query_params.get("token", "")):
        await ws.close(code=1008)
        return
    await ws.accept()
    await bridge.attach(ws)
    try:
        while True:
            msg = await ws.receive_json()
            mtype = msg.get("type")
            if mtype == "hello":
                client_version = msg.get("version")
                compatible = _version_compatible(client_version)
                log.info(
                    "Hello from %s v%s (compatible=%s)",
                    msg.get("client"), client_version, compatible,
                )
                await ws.send_json({
                    "type": "hello_ack",
                    "server_version": SERVER_VERSION,
                    "compatible": compatible,
                })
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


if __name__ == "__main__":
    import socket
    import sys
    import uvicorn

    # Klarer Hinweis statt Stacktrace, wenn der Port schon belegt ist (alter Server laeuft noch).
    _probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        _probe.bind((config.HOST, config.PORT))
    except OSError:
        print(
            f"[FEHLER] Port {config.PORT} ist bereits belegt - laeuft EwtosBrain schon?\n"
            f"Beende den alten Prozess (start-server.bat erledigt das automatisch) und starte erneut."
        )
        sys.exit(1)
    finally:
        _probe.close()

    uvicorn.run(app, host=config.HOST, port=config.PORT, reload=False)
