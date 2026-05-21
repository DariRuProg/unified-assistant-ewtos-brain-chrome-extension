"""EwtosBrain server — FastAPI + WebSocket bridge to Chrome extension."""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import date
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
from tools import playlist_orchestrator
from tools import summary_writer, transcript_writer
from tools import briefing as briefing_tool
from tools import auto_tagger
from tools import raw_promoter
from tools import saeulen as saeulen_tool

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


@app.post("/tools/page_scrape")
async def page_scrape_endpoint() -> dict[str, Any]:
    result = await bridge.call("page_scrape", {})
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
def bookmarks_list() -> dict[str, Any]:
    return {"items": bookmarks_tool.list_bookmarks()}


@app.post("/tools/bookmarks")
def bookmarks_add(req: BookmarkAddRequest) -> dict[str, Any]:
    try:
        return bookmarks_tool.add_bookmark(
            req.url, req.title, req.note, req.source or "manual", themen=req.themen,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/tools/bookmarks/edit")
def bookmarks_edit(req: BookmarkUpdateRequest) -> dict[str, Any]:
    try:
        return bookmarks_tool.update_bookmark(
            req.match, date=req.date, title=req.title, note=req.note, themen=req.themen,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/tools/bookmarks/delete")
def bookmarks_delete(req: BookmarkDeleteRequest) -> dict[str, Any]:
    try:
        return bookmarks_tool.delete_bookmark(req.match, req.date)
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
async def briefing_get(profile: str = "default", vault_id: str | None = None) -> dict[str, Any]:
    try:
        data = await briefing_tool.get_briefing(profile_id=profile, vault_id=vault_id)
        return {"ok": True, "data": data}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/tools/briefing/profiles")
def briefing_profiles_list() -> dict[str, Any]:
    return {"ok": True, "data": briefing_tool.list_profiles()}


class BriefingProfileSaveRequest(BaseModel):
    id: str | None = None
    name: str
    sources: list[str]
    standorte: list[str] | None = None


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
    ingest_now: bool = True


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
        )
        if req.ingest_now:
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
                result["ingest_warning"] = str(ingest_err)
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


@app.get("/vaults/{vault_id}/saeulen")
def vaults_saeulen(vault_id: str) -> dict[str, Any]:
    return {"saeulen": saeulen_tool.list_allowed()}


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


@app.post("/vaults/{vault_id}/scaffold")
def vaults_scaffold(vault_id: str) -> dict[str, Any]:
    """Create standard Karpathy vault structure. Non-destructive — skips existing files."""
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, "Vault nicht gefunden")
    vault_path = Path(v["path"])
    if not vault_path.exists():
        raise HTTPException(400, f"Pfad existiert nicht: {vault_path}")

    today = date.today().isoformat()
    vault_name = v["name"]

    templates = {
        "CLAUDE.md": f"# {vault_name}\n\nDieser Vault folgt der Karpathy-Methode.\n\n## Struktur\n\n- `raw/` — Rohdaten und Quellen\n- `wiki/` — Kuratierte Wissensseiten\n- `notes/` — Persönliche Notizen\n",
        "notes/todos.md": "---\ntyp: todos\n---\n\n",
        "notes/scratchpad.md": f"---\ntyp: scratchpad\n---\n\n## {today}\n\n",
        "wiki/index.md": f"---\ntyp: index\naktualisiert: {today}\n---\n\n# Index\n\n",
        "wiki/log.md": f"---\ntyp: log\n---\n\n## {today} — Vault erstellt\n\nVault wurde mit EwtosBrain Setup-Wizard erstellt.\n",
    }

    created = []
    skipped = []
    for rel, content in templates.items():
        target = vault_path / rel
        if target.exists():
            skipped.append(rel)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        created.append(rel)

    raw_dir = vault_path / "raw"
    if not raw_dir.exists():
        raw_dir.mkdir(parents=True, exist_ok=True)
        created.append("raw/")

    return {"ok": True, "created": created, "skipped": skipped}


# --- Chat -----------------------------------------------------------------

class ChatSendRequest(BaseModel):
    message: str
    page_context: str | None = None


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

    uvicorn.run("main:app", host=config.HOST, port=config.PORT, reload=False)
