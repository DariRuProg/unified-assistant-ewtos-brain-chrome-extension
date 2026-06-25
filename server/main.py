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
from tools import web_scraper
import auth
from bridge import bridge, SERVER_VERSION, _version_compatible
from routers import notes
from routers import images
from routers import playlists
from routers import briefing
from routers import brain
from routers import video_brain
from routers import vaults
from routers import blueprints
from routers import chat

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("ewtosbrain")



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
app.include_router(notes.router)
app.include_router(images.router)
app.include_router(playlists.router)
app.include_router(briefing.router)
app.include_router(brain.router)
app.include_router(video_brain.router)
app.include_router(vaults.router)
app.include_router(blueprints.router)
app.include_router(chat.router)


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


class ScrapeUrlRequest(BaseModel):
    url: str
    mode: str = "content"


@app.post("/tools/scrape_url")
async def scrape_url_endpoint(req: ScrapeUrlRequest) -> dict[str, Any]:
    result = await web_scraper.scrape_url(req.url, req.mode)
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
    # video-brain Sync
    video_brain_supabase_url: str | None = None
    video_brain_supabase_anon_key: str | None = None
    video_brain_supabase_service_key: str | None = None
    video_brain_supabase_user_id: str | None = None
    video_brain_license_key: str | None = None


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
        # video-brain Sync
        "video_brain_supabase_url": s.get("video_brain_supabase_url") or "",
        "video_brain_supabase_anon_key_set": bool(s.get("video_brain_supabase_anon_key")),
        "video_brain_supabase_service_key_set": bool(s.get("video_brain_supabase_service_key")),
        "video_brain_supabase_user_id": s.get("video_brain_supabase_user_id") or "",
        "video_brain_license_key_set": bool(s.get("video_brain_license_key")),
    }


@app.get("/settings")
def settings_get() -> dict[str, Any]:
    return _public_settings()


@app.post("/settings")
def settings_post(req: SettingsUpdate) -> dict[str, Any]:
    settings.update(req.model_dump(exclude_none=True))
    return _public_settings()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=config.HOST, port=config.PORT, reload=False)
