"""Web-Tools (YouTube, Scrape, SEO, Screenshot via WS-Bridge). ewtos.com"""
from __future__ import annotations

import logging
import asyncio

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import licensing
from bridge import bridge
from tools import youtube_metadata as youtube_metadata_tool
from tools import youtube_transcript_fallback
from tools import web_scraper

log = logging.getLogger("ewtosbrain")

router = APIRouter()

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


@router.post("/tools/youtube_transcript", dependencies=[Depends(licensing.require_pro)])
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


@router.post("/tools/page_scrape", dependencies=[Depends(licensing.require_pro)])
async def page_scrape_endpoint(req: PageScrapeRequest = None) -> dict[str, Any]:
    mode = req.mode if req else "content"
    result = await bridge.call("page_scrape", {"mode": mode})
    if not result.get("ok"):
        raise HTTPException(500, result.get("error", "Tool call failed"))
    return result.get("data", {})


class ScrapeUrlRequest(BaseModel):
    url: str
    mode: str = "content"


@router.post("/tools/scrape_url", dependencies=[Depends(licensing.require_pro)])
async def scrape_url_endpoint(req: ScrapeUrlRequest) -> dict[str, Any]:
    result = await web_scraper.scrape_url(req.url, req.mode)
    if not result.get("ok"):
        raise HTTPException(500, result.get("error", "Tool call failed"))
    return result.get("data", {})


@router.post("/tools/seo_check", dependencies=[Depends(licensing.require_pro)])
async def seo_check_endpoint() -> dict[str, Any]:
    result = await bridge.call("seo_check", {})
    if not result.get("ok"):
        raise HTTPException(500, result.get("error", "Tool call failed"))
    return result.get("data", {})


@router.post("/tools/image_analyse", dependencies=[Depends(licensing.require_pro)])
async def image_analyse_endpoint() -> dict[str, Any]:
    result = await bridge.call("image_analyse", {})
    if not result.get("ok"):
        raise HTTPException(500, result.get("error", "Tool call failed"))
    return result.get("data", {})


@router.post("/tools/color_picker")
async def color_picker_endpoint() -> dict[str, Any]:
    result = await bridge.call("color_picker", {})
    if not result.get("ok"):
        raise HTTPException(500, result.get("error", "Tool call failed"))
    return result.get("data", {})


@router.post("/tools/screenshot")
async def screenshot_endpoint() -> dict[str, Any]:
    result = await bridge.call("screenshot", {})
    if not result.get("ok"):
        raise HTTPException(500, result.get("error", "Tool call failed"))
    return result.get("data", {})


class UrlExtractorRequest(BaseModel):
    filter_domain: bool = True


@router.post("/tools/url_extractor")
async def url_extractor_endpoint(req: UrlExtractorRequest) -> dict[str, Any]:
    result = await bridge.call("url_extractor", {"filter_domain": req.filter_domain})
    if not result.get("ok"):
        raise HTTPException(500, result.get("error", "Tool call failed"))
    return result.get("data", {})
