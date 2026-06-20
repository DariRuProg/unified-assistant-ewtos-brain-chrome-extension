"""EwtosBrain server — FastAPI + WebSocket bridge to Chrome extension."""
from __future__ import annotations

import asyncio
import logging
import subprocess
import sys
import uuid
from datetime import date
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

import paths

paths.migrate_legacy_data()
load_dotenv(paths.env_file())

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

import chat
import config
import settings
from tools import youtube_metadata as youtube_metadata_tool
from tools import tts_elevenlabs as tts_tool
from tools import bookmarks as bookmarks_tool
from tools import notes_file, wiki_reader
from tools import playlists as playlists_tool
from tools import playlist_orchestrator
from tools import summary_writer, transcript_writer
from tools import youtube_transcript_fallback
from tools import briefing as briefing_tool
from tools import auto_tagger
from tools import raw_promoter
from tools import pdf_ingest as pdf_ingest_tool
from tools import saeulen as saeulen_tool
from tools import image_generator as image_generator_tool
from tools import blueprint as blueprint_tool
from tools import setup_agent as setup_agent_tool
from tools import vault_audit as vault_audit_tool
import auth

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
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


app = FastAPI(title="EwtosBrain", version=SERVER_VERSION, lifespan=lifespan)
app.middleware("http")(auth.api_key_middleware)


@app.get("/")
def root() -> dict[str, Any]:
    return {
        "name": "EwtosBrain",
        "version": SERVER_VERSION,
        "extension_connected": bridge.connected,
    }


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "version": SERVER_VERSION}


@app.get("/pick_folder")
def pick_folder() -> dict[str, Any]:
    """Oeffnet einen nativen Ordner-Dialog auf der Server-Maschine (lokal) und
    gibt den gewaehlten Pfad zurueck. Fuer den Vault-Pfad im Setup-Wizard."""
    if sys.platform != "win32":
        return {"ok": False, "error": "Ordner-Dialog nur unter Windows verfügbar."}
    ps = (
        "Add-Type -AssemblyName System.Windows.Forms;"
        "$f=New-Object System.Windows.Forms.FolderBrowserDialog;"
        "$f.Description='EwtosBrain: Vault-Ordner wählen';"
        "$f.ShowNewFolderButton=$true;"
        "if($f.ShowDialog() -eq 'OK'){[Console]::Out.Write($f.SelectedPath)}"
    )
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", ps],
            capture_output=True, text=True, timeout=180,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        path = out.stdout.strip()
        return {"ok": bool(path), "path": path}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


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


class YouTubeTranscriptRequest(BaseModel):
    url: str
    with_timestamps: bool = False


async def _merge_youtube_meta(data: dict[str, Any], url: str) -> dict[str, Any]:
    """Ergaenzt das Transkript-Result um YouTube-Metadaten (yt-dlp/oEmbed), ohne den
    Event-Loop zu blockieren. Fehler werden geschluckt — nur vorhandene Felder gesetzt."""
    try:
        meta = await asyncio.to_thread(youtube_metadata_tool.fetch_metadata, url)
    except Exception as e:
        log.info("YouTube-Metadaten konnten nicht geladen werden: %s", e)
        meta = {}
    if meta.get("title") and not data.get("title"):
        data["title"] = meta["title"]
    for src, dst in (("channel", "channel"), ("channel_url", "channel_url"),
                     ("duration", "duration"), ("views", "views"), ("likes", "likes"),
                     ("upload_date", "upload_date"), ("thumbnail", "thumbnail_url"),
                     ("description", "description")):
        if meta.get(src) is not None:
            data[dst] = meta[src]
    return data


@app.post("/tools/youtube_transcript")
async def youtube_transcript(req: YouTubeTranscriptRequest) -> dict[str, Any]:
    """Hybrid-Pull: erst Server-API (youtube-transcript-api), Browser als Fallback.

    Reihenfolge bewusst: API-Pfad ist schneller und robuster gegen YouTube-DOM-
    Aenderungen. Browser-Scrape nur, wenn die API IP-blockt o.ae. Antwort enthaelt
    'source': 'server_api' | 'extension' (+ 'server_error' wenn Browser einsprang).
    """
    server_error: str | None = None
    try:
        data = youtube_transcript_fallback.fetch_transcript(
            req.url, with_timestamps=req.with_timestamps,
        )
        data["url"] = req.url
        data["source"] = "server_api"
        return await _merge_youtube_meta(data, req.url)
    except (ValueError, ImportError) as e:
        server_error = str(e)
        log.info("Server-API fail, versuche Browser-Fallback: %s", server_error)

    if bridge.connected:
        try:
            result = await bridge.call(
                "youtube_transcript",
                {"url": req.url, "with_timestamps": req.with_timestamps},
            )
            if result.get("ok"):
                data = result.get("data") or {}
                text = (data.get("transcript") or "").strip()
                if text:
                    data["source"] = "extension"
                    data["server_error"] = server_error
                    return await _merge_youtube_meta(data, req.url)
                browser_error = "leeres Transcript vom Browser-Scrape"
            else:
                browser_error = result.get("error") or "Browser-Scrape fehlgeschlagen"
        except HTTPException:
            raise
        except Exception as e:
            browser_error = str(e)
        raise HTTPException(500, f"API: {server_error} | Browser: {browser_error}")

    raise HTTPException(500, f"API: {server_error} (Extension nicht verbunden — kein Browser-Fallback verfuegbar)")


class PageScrapeRequest(BaseModel):
    mode: str = "content"


@app.post("/tools/page_scrape")
async def page_scrape_endpoint(req: PageScrapeRequest = None) -> dict[str, Any]:
    mode = req.mode if req else "content"
    result = await bridge.call("page_scrape", {"mode": mode})
    if not result.get("ok"):
        raise HTTPException(500, result.get("error", "Tool call failed"))
    return result.get("data", {})


@app.post("/tools/seo_check")
async def seo_check_endpoint() -> dict[str, Any]:
    result = await bridge.call("seo_check", {})
    if not result.get("ok"):
        raise HTTPException(500, result.get("error", "Tool call failed"))
    return result.get("data", {})


@app.post("/tools/image_analyse")
async def image_analyse_endpoint() -> dict[str, Any]:
    result = await bridge.call("image_analyse", {})
    if not result.get("ok"):
        raise HTTPException(500, result.get("error", "Tool call failed"))
    return result.get("data", {})


@app.post("/tools/color_picker")
async def color_picker_endpoint() -> dict[str, Any]:
    result = await bridge.call("color_picker", {})
    if not result.get("ok"):
        raise HTTPException(500, result.get("error", "Tool call failed"))
    return result.get("data", {})


@app.post("/tools/screenshot")
async def screenshot_endpoint() -> dict[str, Any]:
    result = await bridge.call("screenshot", {})
    if not result.get("ok"):
        raise HTTPException(500, result.get("error", "Tool call failed"))
    return result.get("data", {})


class UrlExtractorRequest(BaseModel):
    filter_domain: bool = True


@app.post("/tools/url_extractor")
async def url_extractor_endpoint(req: UrlExtractorRequest) -> dict[str, Any]:
    result = await bridge.call("url_extractor", {"filter_domain": req.filter_domain})
    if not result.get("ok"):
        raise HTTPException(500, result.get("error", "Tool call failed"))
    return result.get("data", {})


# --- Image-Generator (Gemini Nano Banana) --------------------------------

class ImageGenRequest(BaseModel):
    prompt: str
    input_images: list[str] = []  # base64-Strings oder data-URLs
    input_files: list[str] = []   # relative Pfade in generated_images/
    model: str | None = None      # None -> Setting/Default


@app.post("/tools/image_generate")
def image_generate_endpoint(req: ImageGenRequest) -> dict[str, Any]:
    return image_generator_tool.generate_image(
        prompt=req.prompt,
        input_images=req.input_images,
        input_files=req.input_files,
        model=req.model,
    )


@app.get("/tools/image_gallery")
def image_gallery_list() -> dict[str, Any]:
    return {"items": image_generator_tool.list_index()}


@app.delete("/tools/image_gallery/{rel_path:path}")
def image_gallery_delete(rel_path: str) -> dict[str, Any]:
    try:
        return image_generator_tool.delete_entry(rel_path)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/tools/image_gallery/open")
def image_gallery_open() -> dict[str, Any]:
    try:
        return image_generator_tool.open_output_folder()
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/tools/image_generated/{rel_path:path}")
def image_generated_serve(rel_path: str):
    from fastapi.responses import Response
    try:
        data, mime = image_generator_tool.read_generated_file(rel_path)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return Response(content=data, media_type=mime)


class NotesSaveRequest(BaseModel):
    content: str


class NotesExportRequest(BaseModel):
    path: str
    content: str


@app.get("/tools/notes/{kind}")
def notes_load(kind: str, vault_id: str | None = Query(None)) -> dict[str, Any]:
    try:
        return notes_file.load(kind, vault_id=vault_id)
    except ValueError as e:
        raise HTTPException(404, str(e))


@app.post("/tools/notes/{kind}")
def notes_save(
    kind: str, req: NotesSaveRequest, vault_id: str | None = Query(None),
) -> dict[str, Any]:
    try:
        return notes_file.save(kind, req.content, vault_id=vault_id)
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
def notes_scratchpad_append(
    req: NotesAppendRequest, vault_id: str | None = Query(None),
) -> dict[str, Any]:
    try:
        return notes_file.append_scratchpad(req.text, vault_id=vault_id)
    except ValueError as e:
        raise HTTPException(400, str(e))


# --- Bookmarks ------------------------------------------------------------

class BookmarkAddRequest(BaseModel):
    url: str
    title: str | None = None
    note: str | None = None
    source: str | None = "manual"
    themen: list[str] | None = None


class BookmarkDeleteRequest(BaseModel):
    match: str
    date: str | None = None


class BookmarkUpdateRequest(BaseModel):
    match: str
    date: str | None = None
    title: str | None = None
    note: str | None = None
    themen: list[str] | None = None


@app.get("/tools/bookmarks")
def bookmarks_list(vault_id: str | None = Query(None)) -> dict[str, Any]:
    return {"items": bookmarks_tool.list_bookmarks(vault_id=vault_id)}


@app.post("/tools/bookmarks")
def bookmarks_add(
    req: BookmarkAddRequest, vault_id: str | None = Query(None),
) -> dict[str, Any]:
    try:
        return bookmarks_tool.add_bookmark(
            req.url, req.title, req.note, req.source or "manual",
            themen=req.themen, vault_id=vault_id,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/tools/bookmarks/edit")
def bookmarks_edit(
    req: BookmarkUpdateRequest, vault_id: str | None = Query(None),
) -> dict[str, Any]:
    try:
        return bookmarks_tool.update_bookmark(
            req.match, date=req.date, title=req.title, note=req.note,
            themen=req.themen, vault_id=vault_id,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/tools/bookmarks/delete")
def bookmarks_delete(
    req: BookmarkDeleteRequest, vault_id: str | None = Query(None),
) -> dict[str, Any]:
    try:
        return bookmarks_tool.delete_bookmark(req.match, req.date, vault_id=vault_id)
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
    also_delete_master: bool = False


def _wrap_playlist_errors(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/tools/playlists/{vault_id}")
def playlists_list(vault_id: str, saeule: str | None = None) -> dict[str, Any]:
    """Listet Playlists. Ohne `saeule` query → über alle erlaubten Säulen."""
    return {"items": _wrap_playlist_errors(playlists_tool.list_playlists, vault_id, saeule=saeule)}


@app.post("/tools/playlists/{vault_id}")
def playlists_create(
    vault_id: str,
    req: PlaylistCreateRequest,
    saeule: str | None = None,
) -> dict[str, Any]:
    return _wrap_playlist_errors(
        playlists_tool.create_playlist, vault_id, req.name, req.thema, saeule=saeule,
    )


@app.get("/tools/playlists/{vault_id}/{name}")
def playlists_get(vault_id: str, name: str, saeule: str | None = None) -> dict[str, Any]:
    return _wrap_playlist_errors(playlists_tool.get_playlist, vault_id, name, saeule=saeule)


@app.post("/tools/playlists/{vault_id}/{name}/items")
def playlists_add_item(
    vault_id: str,
    name: str,
    req: PlaylistAddItemRequest,
    saeule: str | None = None,
) -> dict[str, Any]:
    return _wrap_playlist_errors(
        playlists_tool.add_to_playlist,
        vault_id, name, req.url,
        title=req.title, dauer=req.dauer, youtuber=req.youtuber,
        views=req.views, published=req.published, likes=req.likes, description=req.description,
        saeule=saeule,
    )


@app.post("/tools/playlists/{vault_id}/{name}/items/delete")
def playlists_remove_item(
    vault_id: str,
    name: str,
    req: PlaylistRemoveItemRequest,
    saeule: str | None = None,
) -> dict[str, Any]:
    return _wrap_playlist_errors(
        playlists_tool.remove_from_playlist, vault_id, name, req.match,
        saeule=saeule, also_delete_master=req.also_delete_master,
    )


class PlaylistPullPendingRequest(BaseModel):
    with_timestamps: bool = False
    summarize: bool = False


@app.post("/tools/playlists/{vault_id}/{name}/pull_pending")
async def playlists_pull_pending(
    vault_id: str,
    name: str,
    req: PlaylistPullPendingRequest,
    saeule: str | None = None,
) -> dict[str, Any]:
    """Bulk-Pull aller pending Transcripts einer Playlist via Multi-Video-Orchestrator.

    Long-running: kann je nach Playlist-Größe mehrere Minuten dauern (pro Item
    ~10-15s). Der Endpoint blockt bis fertig — der Client muss entsprechend
    Timeout setzen.
    """
    try:
        return await playlist_orchestrator.pull_pending_transcripts(
            vault_id, name, bridge,
            saeule=saeule, with_timestamps=req.with_timestamps, summarize=req.summarize,
        )
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


# --- Briefing ------------------------------------------------------------

@app.get("/tools/briefing")
async def briefing_get(
    profile: str = "default",
    vault_id: str | None = None,
    archive: bool = True,
) -> dict[str, Any]:
    try:
        data = await briefing_tool.get_briefing(
            profile_id=profile, vault_id=vault_id, archive=archive
        )
        return {"ok": True, "data": data}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/tools/briefing/lookback")
def briefing_lookback(days: int = 1, vault_id: str | None = None) -> dict[str, Any]:
    vault_path: str | None = None
    if vault_id:
        v = settings.get_vault(vault_id)
        if v:
            vault_path = v["path"]
    if vault_path is None:
        vaults = settings.get_vaults()
        if vaults:
            vault_path = vaults[0].get("path")
    if not vault_path:
        return {"ok": False, "error": "Kein Vault konfiguriert"}
    return briefing_tool.read_journal_lookback(vault_path, days_ago=days)


@app.get("/tools/briefing/profiles")
def briefing_profiles_list() -> dict[str, Any]:
    return {"ok": True, "data": briefing_tool.list_profiles()}


class BriefingProfileSaveRequest(BaseModel):
    id: str | None = None
    name: str
    sources: list[str]
    params: dict[str, dict] = {}


@app.post("/tools/briefing/profiles")
def briefing_profiles_save(req: BriefingProfileSaveRequest) -> dict[str, Any]:
    try:
        saved = briefing_tool.save_profile(req.model_dump(exclude_none=True))
        return {"ok": True, "data": saved}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.delete("/tools/briefing/profiles/{profile_id}")
def briefing_profiles_delete(profile_id: str) -> dict[str, Any]:
    deleted = briefing_tool.delete_profile(profile_id)
    if not deleted:
        raise HTTPException(400, "Profil nicht gefunden oder 'default' kann nicht gelöscht werden")
    return {"ok": True, "deleted": profile_id}


# --- Auto-Tag ------------------------------------------------------------

class AutoTagRequest(BaseModel):
    transcript: str
    title: str
    vault_id: str


@app.post("/tools/auto_tag")
def auto_tag_endpoint(req: AutoTagRequest) -> dict[str, Any]:
    try:
        data = auto_tagger.auto_tag(req.transcript, req.title, req.vault_id)
        return {"ok": True, "data": data}
    except Exception as e:
        return {"ok": False, "error": str(e)}


class AutoBrainRequest(BaseModel):
    url: str
    vault_id: str
    tab_id: int | None = None
    with_timestamps: bool = False


@app.post("/tools/auto_brain")
async def auto_brain_endpoint(req: AutoBrainRequest) -> dict[str, Any]:
    params: dict[str, Any] = {"url": req.url, "vault_id": req.vault_id, "with_timestamps": req.with_timestamps}
    if req.tab_id is not None:
        params["tabId"] = req.tab_id
    result = await bridge.call("auto_brain", params)
    if not result.get("ok"):
        raise HTTPException(500, result.get("error", "auto_brain failed"))
    return {"ok": True, "data": result.get("data", {})}


class BrainSaveRequest(BaseModel):
    vault_id: str
    url: str
    title: str
    transcript: str
    saeule: str
    playlist_name: str
    tags: list[str] = []
    assign_playlist: bool = True
    channel: str | None = None
    duration: str | None = None
    views: int | None = None
    likes: int | None = None
    upload_date: str | None = None
    thumbnail_url: str | None = None
    description: str | None = None


@app.post("/tools/brain/save")
def brain_save_endpoint(req: BrainSaveRequest) -> dict[str, Any]:
    try:
        result = raw_promoter.save_video_to_raw(
            vault_id=req.vault_id,
            url=req.url,
            title=req.title,
            transcript=req.transcript,
            saeule=req.saeule,
            playlist_name=req.playlist_name,
            tags=req.tags,
            channel=req.channel,
            duration=req.duration,
            views=req.views,
            likes=req.likes,
            upload_date=req.upload_date,
            thumbnail_url=req.thumbnail_url,
            description=req.description,
        )
        if req.assign_playlist:
            try:
                try:
                    playlists_tool.add_to_playlist(
                        req.vault_id, req.playlist_name, req.url, req.title, saeule=req.saeule
                    )
                except ValueError as ve:
                    if "nicht gefunden" in str(ve):
                        playlists_tool.create_playlist(req.vault_id, req.playlist_name, saeule=req.saeule)
                        playlists_tool.add_to_playlist(
                            req.vault_id, req.playlist_name, req.url, req.title, saeule=req.saeule
                        )
                    else:
                        raise
            except Exception as ingest_err:
                result["playlist_warning"] = str(ingest_err)
        return {"ok": True, "data": result}
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))


class RawContentSaveRequest(BaseModel):
    vault_id: str
    title: str
    content: str
    target_subfolder: str
    description: str | None = None
    filename_slug: str | None = None
    url: str | None = None
    meta_title: str | None = None
    meta_beschreibung: str | None = None
    og_bild: str | None = None
    canonical: str | None = None
    h1: str | None = None
    tags: list[str] = []


@app.post("/tools/raw/save")
def raw_content_save_endpoint(req: RawContentSaveRequest) -> dict[str, Any]:
    try:
        result = raw_promoter.save_raw_content(
            vault_id=req.vault_id,
            title=req.title,
            content=req.content,
            target_subfolder=req.target_subfolder,
            description=req.description,
            filename_slug=req.filename_slug,
            url=req.url,
            meta_title=req.meta_title,
            meta_beschreibung=req.meta_beschreibung,
            og_bild=req.og_bild,
            canonical=req.canonical,
            h1=req.h1,
            tags=req.tags,
        )
        return {"ok": True, "data": result}
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/tools/ingest/document")
async def ingest_document_endpoint(
    file: UploadFile = File(...),
    vault_id: str = Form(...),
    subfolder: str = Form("artikel"),
    title: str = Form(""),
) -> dict[str, Any]:
    if not settings.vault_permission(vault_id, "write_raw"):
        raise HTTPException(403, "write_raw-Permission für diesen Vault nicht aktiviert.")
    allowed = ("application/pdf", "text/plain", "text/markdown")
    if file.content_type and not any(file.content_type.startswith(m) for m in allowed):
        raise HTTPException(400, f"Nicht unterstützter Dateityp: {file.content_type}")
    data = await file.read()
    try:
        content = pdf_ingest_tool.extract_text(data, file.filename or "")
    except ImportError as e:
        raise HTTPException(500, str(e))
    if not content.strip():
        raise HTTPException(422, "Kein Text extrahierbar.")
    doc_title = title.strip() or (file.filename or "Dokument").rsplit(".", 1)[0]
    try:
        result = raw_promoter.save_raw_content(
            vault_id=vault_id,
            title=doc_title,
            content=content,
            target_subfolder=subfolder,
            description=f"Importiert aus {file.filename}",
        )
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))
    return {"ok": True, "data": result}


class VideoRawSaveRequest(BaseModel):
    vault_id: str
    url: str
    title: str
    transcript: str
    channel: str | None = None
    duration: str | None = None
    views: int | None = None
    likes: int | None = None
    upload_date: str | None = None
    thumbnail_url: str | None = None
    description: str | None = None
    saeule: str = "youtube"
    tags: list[str] = []


@app.post("/tools/raw/save_video")
def raw_video_save_endpoint(req: VideoRawSaveRequest) -> dict[str, Any]:
    try:
        result = raw_promoter.save_video_to_raw(
            vault_id=req.vault_id,
            url=req.url,
            title=req.title,
            transcript=req.transcript,
            saeule=req.saeule,
            playlist_name="",
            channel=req.channel,
            duration=req.duration,
            views=req.views,
            likes=req.likes,
            upload_date=req.upload_date,
            thumbnail_url=req.thumbnail_url,
            description=req.description,
            tags=req.tags,
        )
        return {"ok": True, "data": result}
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))


class PromoteRequest(BaseModel):
    vault_id: str
    source: str
    identifier: str
    target_subfolder: str
    title: str | None = None
    description: str | None = None
    filename_slug: str | None = None


class VaultWriteRequest(BaseModel):
    content: str


@app.post("/tools/promote")
def promote_endpoint(req: PromoteRequest) -> dict[str, Any]:
    try:
        result = raw_promoter.promote_to_raw(
            vault_id=req.vault_id,
            source=req.source,
            identifier=req.identifier,
            target_subfolder=req.target_subfolder,
            filename_slug=req.filename_slug,
            title=req.title,
            description=req.description,
        )
        return {"ok": True, "data": result}
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))


# --- Videos: Transcript + Summary ---------------------------------------

class TranscriptSaveRequest(BaseModel):
    transcript: str
    with_timestamps: bool = False


@app.get("/tools/vault_file/{vault_id}")
def vault_file_read(vault_id: str, rel_path: str) -> dict[str, Any]:
    """Read-only Zugriff auf eine .md-Datei im Vault. Wird vom Sidepanel
    fürs Inline-Preview von Master-Pages und Transcripts genutzt.
    rel_path ist relativ zum Vault-Root."""
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, f"Vault {vault_id} nicht gefunden")
    try:
        content = wiki_reader.read_file(v["path"], rel_path)
        return {"vault_id": vault_id, "rel_path": rel_path, "content": content}
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/tools/vault_asset/{vault_id}/{rel_path:path}")
def vault_asset_serve(vault_id: str, rel_path: str) -> Response:
    """Liefert ein Bild-Asset (png/jpg/gif/webp/svg) aus dem Vault — fuer das
    Inline-Rendern lokaler Bilder im Explorer. Pfad-Traversal-geschuetzt."""
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, f"Vault {vault_id} nicht gefunden")
    try:
        data, mime = wiki_reader.read_asset(v["path"], rel_path)
        return Response(content=data, media_type=mime,
                        headers={"Cache-Control": "private, max-age=3600"})
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


class TtsRequest(BaseModel):
    text: str
    voice_id: str | None = None


@app.post("/tools/tts")
def tts_synthesize(req: TtsRequest) -> Response:
    """Wandelt Text per ElevenLabs (BYOK) in Sprache. Liefert MP3. 403 ohne Key."""
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(400, "text fehlt")
    try:
        audio = tts_tool.synth(text, req.voice_id)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(502, str(e))
    return Response(content=audio, media_type="audio/mpeg")


@app.get("/tools/vault_list/{vault_id}")
def vault_list_folder(vault_id: str, rel_path: str = "", show_hidden: bool = False) -> dict[str, Any]:
    """Listet Ordner und .md-Dateien an einem Pfad im Vault. rel_path leer
    = Vault-Root (bzw. wiki/-Unterordner falls vorhanden, siehe wiki_reader.resolve_dir).
    show_hidden=true zeigt versteckte/ignorierte Eintraege (.obsidian, .claude, Dotfiles)."""
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, f"Vault {vault_id} nicht gefunden")
    try:
        listing = wiki_reader.list_folder(v["path"], rel_path, show_hidden=show_hidden)
        return {"vault_id": vault_id, **listing, "show_hidden": show_hidden}
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/tools/vault_audit/{vault_id}")
def vault_audit_run(vault_id: str) -> dict[str, Any]:
    """Read-only Health-Check: Orphans, un-ingestete raw, kaputte Links, Frontmatter, CLAUDE.md-Drift."""
    try:
        return vault_audit_tool.audit_vault(vault_id)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@app.get("/tools/vault_audit/{vault_id}/claude_md_preview")
def vault_audit_claude_md_preview(vault_id: str) -> dict[str, Any]:
    try:
        return blueprint_tool.preview_claude_md_upgrade(vault_id)
    except blueprint_tool.BlueprintError as e:
        raise HTTPException(400, str(e))


@app.post("/tools/vault_audit/{vault_id}/claude_md_apply")
def vault_audit_claude_md_apply(vault_id: str) -> dict[str, Any]:
    try:
        return blueprint_tool.apply_claude_md_upgrade(vault_id)
    except blueprint_tool.BlueprintError as e:
        raise HTTPException(400, str(e))


class VaultRepairRequest(BaseModel):
    category: str
    path: str


@app.post("/tools/vault_audit/{vault_id}/repair")
def vault_audit_repair(vault_id: str, req: VaultRepairRequest) -> dict[str, Any]:
    """Repariert ein einzelnes Finding (nur orphan_index + structure_drift).
    Per-Finding bestätigt durch den Aufrufer (UI). Idempotent."""
    try:
        return vault_audit_tool.repair_finding(vault_id, req.category, req.path)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/tools/vault_search/{vault_id}")
def vault_search(vault_id: str, q: str, max_results: int = 30) -> dict[str, Any]:
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, f"Vault {vault_id} nicht gefunden")
    if not q or not q.strip():
        raise HTTPException(400, "Suchbegriff darf nicht leer sein")
    results = wiki_reader.search_files(v["path"], q.strip(), max_results)
    return {"vault_id": vault_id, "q": q, "results": results}


@app.put("/tools/vault_file/{vault_id}")
def vault_file_write(vault_id: str, rel_path: str, body: VaultWriteRequest) -> dict[str, Any]:
    if not settings.vault_permission(vault_id, "write_files"):
        raise HTTPException(403, "write_files-Permission nicht aktiviert. Einstellungen → Vault bearbeiten.")
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, f"Vault {vault_id} nicht gefunden")
    try:
        wiki_reader.write_file(v["path"], rel_path, body.content)
        return {"ok": True}
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/tools/vault_file_new/{vault_id}")
def vault_file_create(vault_id: str, rel_path: str, body: VaultWriteRequest) -> dict[str, Any]:
    if not settings.vault_permission(vault_id, "write_files"):
        raise HTTPException(403, "write_files-Permission nicht aktiviert. Einstellungen → Vault bearbeiten.")
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, f"Vault {vault_id} nicht gefunden")
    try:
        wiki_reader.create_file(v["path"], rel_path, body.content)
        return {"ok": True}
    except FileExistsError as e:
        raise HTTPException(409, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/tools/vault_file/{vault_id}")
def vault_file_delete(vault_id: str, rel_path: str) -> dict[str, Any]:
    """Loescht eine Datei oder einen leeren Ordner. Erfordert write_files-Permission."""
    if not settings.vault_permission(vault_id, "write_files"):
        raise HTTPException(403, "write_files-Permission nicht aktiviert. Einstellungen → Vault bearbeiten.")
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, f"Vault {vault_id} nicht gefunden")
    try:
        kind = wiki_reader.delete_path(v["path"], rel_path)
        return {"ok": True, "deleted": rel_path, "kind": kind}
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/tools/videos/{vault_id}/{slug}/transcript")
def videos_save_transcript(
    vault_id: str,
    slug: str,
    req: TranscriptSaveRequest,
    saeule: str | None = None,
) -> dict[str, Any]:
    try:
        return transcript_writer.save_transcript(
            vault_id, slug, req.transcript, req.with_timestamps, saeule=saeule,
        )
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/tools/videos/{vault_id}/{slug}/summary")
def videos_generate_summary(vault_id: str, slug: str, saeule: str | None = None) -> dict[str, Any]:
    try:
        return summary_writer.generate_summary(vault_id, slug, saeule=saeule)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


class SettingsUpdate(BaseModel):
    notes_path: str | None = None
    anthropic_api_key: str | None = None
    chat_model: str | None = None  # legacy, von llm_model abgelöst
    max_user_turns: int | None = None
    llm_provider: str | None = None
    llm_model: str | None = None
    openai_api_key: str | None = None
    ollama_base_url: str | None = None
    mistral_api_key: str | None = None
    openrouter_api_key: str | None = None
    openrouter_base_url: str | None = None
    gemini_api_key: str | None = None
    image_gen_model: str | None = None
    youtube_api_key: str | None = None
    setup_agent_provider: str | None = None
    setup_agent_model: str | None = None
    vault_search_enabled: bool | None = None
    chat_heavy_ops_mode: str | None = None
    elevenlabs_api_key: str | None = None
    elevenlabs_voice_id: str | None = None
    chat_tts_enabled: bool | None = None
    chat_show_sources: bool | None = None


def _public_settings() -> dict[str, Any]:
    s = settings.all()
    return {
        "notes_path": s.get("notes_path") or config.NOTES_PATH,
        "chat_model": s.get("chat_model") or chat.DEFAULT_MODEL,  # legacy für UI-Backward-Compat
        "max_user_turns": s.get("max_user_turns") or chat.DEFAULT_MAX_TURNS,
        "anthropic_api_key_set": bool(s.get("anthropic_api_key")),
        "llm_provider": s.get("llm_provider") or "anthropic",
        "llm_model": s.get("llm_model") or s.get("chat_model") or chat.DEFAULT_MODEL,
        "openai_api_key_set": bool(s.get("openai_api_key")),
        "ollama_base_url": s.get("ollama_base_url") or "http://localhost:11434",
        "mistral_api_key_set": bool(s.get("mistral_api_key")),
        "openrouter_api_key_set": bool(s.get("openrouter_api_key")),
        "openrouter_base_url": s.get("openrouter_base_url") or "https://openrouter.ai/api/v1",
        "gemini_api_key_set": bool(s.get("gemini_api_key")),
        "image_gen_model": s.get("image_gen_model") or "gemini-2.5-flash-image",
        "setup_agent_provider": s.get("setup_agent_provider") or "",
        "setup_agent_model": s.get("setup_agent_model") or "",
        "vault_search_enabled": s.get("vault_search_enabled", True),
        "chat_heavy_ops_mode": s.get("chat_heavy_ops_mode") or "full",
        "elevenlabs_api_key_set": bool(s.get("elevenlabs_api_key")),
        "elevenlabs_voice_id": s.get("elevenlabs_voice_id") or "",
        "chat_tts_enabled": bool(s.get("chat_tts_enabled", False)),
        "chat_show_sources": bool(s.get("chat_show_sources", True)),
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
    use_local_notes: bool | None = None


class VaultUpdate(BaseModel):
    name: str | None = None
    path: str | None = None
    system_prompt: str | None = None
    permissions: dict[str, bool] | None = None
    use_local_notes: bool | None = None


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
    return settings.add_vault(
        req.name, req.path, req.system_prompt or "",
        use_local_notes=req.use_local_notes,
    )


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


@app.get("/vaults/{vault_id}/saeulen")
def vaults_saeulen(vault_id: str) -> dict[str, Any]:
    return {"saeulen": saeulen_tool.list_allowed()}


@app.get("/vaults/{vault_id}/raw_folders")
def vaults_raw_folders(vault_id: str) -> dict[str, Any]:
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, "Vault nicht gefunden")
    raw_root = Path(v["path"]) / "raw"
    folders: list[str] = []
    if raw_root.is_dir():
        for p in raw_root.iterdir():
            if p.is_dir() and not p.name.startswith("."):
                folders.append(p.name)
                for sub in p.iterdir():
                    if sub.is_dir() and not sub.name.startswith("."):
                        folders.append(f"{p.name}/{sub.name}")
    return {"folders": sorted(folders)}


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


@app.get("/vaults/{vault_id}/chat/history")
def vault_chat_history(vault_id: str) -> dict[str, Any]:
    messages = [
        m for m in chat._load_history(vault_id)
        if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)
    ]
    return {"messages": messages, "count": len(messages)}


@app.post("/vaults/{vault_id}/scaffold")
def vaults_scaffold(vault_id: str) -> dict[str, Any]:
    """Convenience-Endpoint: scaffold den Default-Vault (Kontext-Profil + PARA).

    Intern: ruft blueprint.commit(vault_id, load_builtin(DEFAULT_BLUEPRINT_ID)).
    Eine einzige Wahrheit fuer alle Scaffold-Pfade.
    """
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, "Vault nicht gefunden")
    try:
        bp = blueprint_tool.load_builtin(blueprint_tool.DEFAULT_BLUEPRINT_ID)
        result = blueprint_tool.commit(vault_id, bp)
        settings.add_applied_blueprints(vault_id, [blueprint_tool.DEFAULT_BLUEPRINT_ID])
        return result
    except blueprint_tool.BlueprintError as e:
        raise HTTPException(400, str(e))


class ApplyBlueprintRequest(BaseModel):
    blueprint_id: str


@app.post("/vaults/{vault_id}/apply_blueprint")
def vaults_apply_blueprint(vault_id: str, req: ApplyBlueprintRequest) -> dict[str, Any]:
    """Committet ein zusaetzliches builtin Blueprint non-destruktiv auf einen
    bestehenden Vault (z.B. 'karpathy-para-base' fuer die Farming-Erweiterung).
    skip_if_exists schuetzt vorhandene Dateien; Indexe/MOCs werden mitgepflegt."""
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, "Vault nicht gefunden")
    try:
        bp = blueprint_tool.load_builtin(req.blueprint_id)
        result = blueprint_tool.commit(vault_id, bp)
        settings.add_applied_blueprints(vault_id, [req.blueprint_id])
        return result
    except blueprint_tool.BlueprintError as e:
        raise HTTPException(400, str(e))


# --- Blueprints -----------------------------------------------------------


@app.get("/blueprints")
def blueprints_list() -> dict[str, Any]:
    return {"blueprints": blueprint_tool.list_available()}


@app.get("/blueprints/{blueprint_id}")
def blueprints_get(blueprint_id: str) -> dict[str, Any]:
    try:
        bp = blueprint_tool.load_builtin(blueprint_id)
    except blueprint_tool.BlueprintError:
        bp = blueprint_tool.load_imported(blueprint_id)
    if not bp:
        raise HTTPException(404, "Blueprint nicht gefunden")
    try:
        resolved = blueprint_tool.resolve_extends(bp)
    except blueprint_tool.BlueprintError as e:
        raise HTTPException(400, str(e))
    return resolved


class BlueprintImportRequest(BaseModel):
    blueprint: dict[str, Any] | None = None
    url: str | None = None


@app.post("/blueprints/import")
def blueprints_import(req: BlueprintImportRequest) -> dict[str, Any]:
    if req.url and not req.blueprint:
        raise HTTPException(400, "URL-Import noch nicht implementiert — bitte JSON-Body senden.")
    if not req.blueprint:
        raise HTTPException(400, "Body braucht 'blueprint'-Objekt")
    bp = req.blueprint
    try:
        blueprint_tool.validate(bp)
    except blueprint_tool.BlueprintError as e:
        raise HTTPException(400, str(e))
    trusted, reason = blueprint_tool.verify_signature(bp)
    try:
        bid = blueprint_tool.save_imported(bp, trusted=trusted)
    except blueprint_tool.BlueprintError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "blueprint_id": bid, "trusted": trusted, "reason": reason}


@app.delete("/blueprints/{blueprint_id}")
def blueprints_delete(blueprint_id: str) -> dict[str, Any]:
    # Built-in nicht loeschbar
    try:
        builtin = blueprint_tool.load_builtin(blueprint_id)
        if builtin:
            raise HTTPException(400, "Built-in Blueprints koennen nicht geloescht werden")
    except blueprint_tool.BlueprintError:
        pass
    if not blueprint_tool.delete_imported(blueprint_id):
        raise HTTPException(404, "Importierter Blueprint nicht gefunden")
    return {"ok": True, "removed": blueprint_id}


class BlueprintBody(BaseModel):
    blueprint: dict[str, Any]


@app.post("/vaults/{vault_id}/blueprint/preview")
def vault_blueprint_preview(vault_id: str, body: BlueprintBody) -> dict[str, Any]:
    if not settings.get_vault(vault_id):
        raise HTTPException(404, "Vault nicht gefunden")
    try:
        return blueprint_tool.preview(vault_id, body.blueprint)
    except blueprint_tool.BlueprintError as e:
        raise HTTPException(400, str(e))


@app.post("/vaults/{vault_id}/blueprint/commit")
def vault_blueprint_commit(vault_id: str, body: BlueprintBody) -> dict[str, Any]:
    if not settings.get_vault(vault_id):
        raise HTTPException(404, "Vault nicht gefunden")
    try:
        return blueprint_tool.commit(vault_id, body.blueprint)
    except blueprint_tool.BlueprintError as e:
        raise HTTPException(400, str(e))


@app.get("/vaults/{vault_id}/blueprint")
def vault_blueprint_export(vault_id: str) -> dict[str, Any]:
    if not settings.get_vault(vault_id):
        raise HTTPException(404, "Vault nicht gefunden")
    bp = blueprint_tool.export_vault_blueprint(vault_id)
    if bp is None:
        raise HTTPException(404, "Kein Blueprint-Snapshot vorhanden")
    return bp


# --- Legacy scaffold code removed — moved to blueprint_schemas/karpathy-para-base.json
# (Statische agents.md/index.md/log.md/wiki-Hierarchie wird nun via blueprint.commit
# aus Jinja2-Templates erzeugt. Siehe server/tools/blueprint_templates/karpathy-para-base/)


# --- Setup-Agent ---------------------------------------------------------

class SetupAgentStartRequest(BaseModel):
    mode: str = "fresh"  # "fresh" | "extend"
    templates: list[str] | None = None
    use_case_hint: str | None = None


class SetupAgentMessageRequest(BaseModel):
    session_id: str
    message: str


class SetupAgentCommitRequest(BaseModel):
    session_id: str


@app.post("/vaults/{vault_id}/setup_agent/start")
def setup_agent_start(vault_id: str, req: SetupAgentStartRequest) -> dict[str, Any]:
    if not settings.get_vault(vault_id):
        raise HTTPException(404, "Vault nicht gefunden")
    try:
        return setup_agent_tool.start_session(
            vault_id,
            mode=req.mode,
            templates=req.templates,
            use_case_hint=req.use_case_hint,
        )
    except setup_agent_tool.SetupAgentError as e:
        raise HTTPException(400, str(e))
    except blueprint_tool.BlueprintError as e:
        raise HTTPException(400, str(e))


@app.post("/vaults/{vault_id}/setup_agent/message")
def setup_agent_message(vault_id: str, req: SetupAgentMessageRequest) -> dict[str, Any]:
    if not settings.get_vault(vault_id):
        raise HTTPException(404, "Vault nicht gefunden")
    try:
        return setup_agent_tool.send_message(req.session_id, req.message)
    except setup_agent_tool.SetupAgentError as e:
        # Session-not-found -> 404, sonst 400
        msg = str(e)
        code = 404 if "nicht gefunden" in msg else 400
        raise HTTPException(code, msg)
    except blueprint_tool.BlueprintError as e:
        raise HTTPException(400, str(e))


@app.get("/vaults/{vault_id}/setup_agent/state")
def setup_agent_state(vault_id: str, session_id: str = Query(...)) -> dict[str, Any]:
    if not settings.get_vault(vault_id):
        raise HTTPException(404, "Vault nicht gefunden")
    try:
        return setup_agent_tool.get_state(session_id)
    except setup_agent_tool.SetupAgentError as e:
        raise HTTPException(404, str(e))


@app.post("/vaults/{vault_id}/setup_agent/commit")
def setup_agent_commit(vault_id: str, req: SetupAgentCommitRequest) -> dict[str, Any]:
    if not settings.get_vault(vault_id):
        raise HTTPException(404, "Vault nicht gefunden")
    try:
        return setup_agent_tool.commit(req.session_id)
    except setup_agent_tool.SetupAgentError as e:
        msg = str(e)
        code = 404 if "nicht gefunden" in msg else 400
        raise HTTPException(code, msg)
    except blueprint_tool.BlueprintError as e:
        raise HTTPException(400, str(e))


# --- Chat -----------------------------------------------------------------

class ChatSendRequest(BaseModel):
    message: str
    page_context: str | None = None


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


# Static routes declared before {vault_id} routes so "page"/"source" aren't matched as vault_id.
@app.post("/tools/chat/page/stream")
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


@app.post("/tools/chat/source/stream")
def chat_source_stream(req: SourceChatRequest) -> StreamingResponse:
    """SSE stream: chat about a single source (page / transcript / video). No vault tools, no persistence."""
    return StreamingResponse(
        chat.send_source_stream(
            req.source_type,
            req.source_ref,
            req.message,
            req.history,
            strict_source=req.strict_source,
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


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
        chat.send_stream(vault_id, req.message, page_context=req.page_context),
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
        return chat.send(vault_id, req.message, page_context=req.page_context)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        log.exception("Chat error")
        raise HTTPException(500, str(e))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=config.HOST, port=config.PORT, reload=False)
