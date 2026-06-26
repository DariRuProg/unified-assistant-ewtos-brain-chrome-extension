"""Auto-Tag, Auto-Brain, Raw-Save, Ingest, Promote. ewtos.com"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, File, Form, UploadFile
from pydantic import BaseModel

from bridge import bridge
from tools import playlists as playlists_tool
from tools import auto_tagger
from tools import raw_promoter
from tools import pdf_ingest as pdf_ingest_tool
import settings

router = APIRouter()

# --- Auto-Tag ------------------------------------------------------------

class AutoTagRequest(BaseModel):
    transcript: str
    title: str
    vault_id: str


@router.post("/tools/auto_tag")
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


@router.post("/tools/auto_brain")
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
    thema: str | None = None
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


@router.post("/tools/brain/save")
def brain_save_endpoint(req: BrainSaveRequest) -> dict[str, Any]:
    try:
        result = raw_promoter.save_video_to_raw(
            vault_id=req.vault_id,
            url=req.url,
            title=req.title,
            transcript=req.transcript,
            thema=req.thema,
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
                        req.vault_id, req.playlist_name, req.url, req.title, thema=req.thema
                    )
                except ValueError as ve:
                    if "nicht gefunden" in str(ve):
                        playlists_tool.create_playlist(req.vault_id, req.playlist_name, thema=req.thema)
                        playlists_tool.add_to_playlist(
                            req.vault_id, req.playlist_name, req.url, req.title, thema=req.thema
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


@router.post("/tools/raw/save")
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


@router.post("/tools/ingest/document")
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
        info = pdf_ingest_tool.extract_info(data, file.filename or "")
    except ImportError as e:
        raise HTTPException(500, str(e))
    except ValueError as e:
        raise HTTPException(422, str(e))
    content = info["text"]
    if not content.strip():
        raise HTTPException(422, "Kein Text extrahierbar.")
    doc_title = title.strip() or info.get("title") or (file.filename or "Dokument").rsplit(".", 1)[0]
    desc_parts = [f"Importiert aus {file.filename}"]
    if info.get("author"):
        desc_parts.append(f"Autor: {info['author']}")
    if info.get("pages"):
        desc_parts.append(f"{info['pages']} Seite(n)")
    try:
        result = raw_promoter.save_raw_content(
            vault_id=vault_id,
            title=doc_title,
            content=content,
            target_subfolder=subfolder,
            description=" | ".join(desc_parts),
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
    thema: str | None = None
    tags: list[str] = []


@router.post("/tools/raw/save_video")
def raw_video_save_endpoint(req: VideoRawSaveRequest) -> dict[str, Any]:
    try:
        result = raw_promoter.save_video_to_raw(
            vault_id=req.vault_id,
            url=req.url,
            title=req.title,
            transcript=req.transcript,
            thema=req.thema,
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


@router.post("/tools/promote")
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
