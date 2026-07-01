"""Playlists Endpoints. ewtos.com"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import licensing
from bridge import bridge
from tools import playlists as playlists_tool
from tools import playlist_orchestrator

router = APIRouter()

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
    thema: str | None = None


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


@router.get("/tools/playlists/{vault_id}")
def playlists_list(vault_id: str) -> dict[str, Any]:
    """Listet alle Playlists des Vaults (wiki/resources/playlists/)."""
    return {"items": _wrap_playlist_errors(playlists_tool.list_playlists, vault_id)}


@router.post("/tools/playlists/{vault_id}")
def playlists_create(
    vault_id: str,
    req: PlaylistCreateRequest,
) -> dict[str, Any]:
    return _wrap_playlist_errors(
        playlists_tool.create_playlist, vault_id, req.name, req.thema,
    )


@router.get("/tools/playlists/{vault_id}/{name}")
def playlists_get(vault_id: str, name: str) -> dict[str, Any]:
    return _wrap_playlist_errors(playlists_tool.get_playlist, vault_id, name)


@router.post("/tools/playlists/{vault_id}/{name}/items")
def playlists_add_item(
    vault_id: str,
    name: str,
    req: PlaylistAddItemRequest,
) -> dict[str, Any]:
    return _wrap_playlist_errors(
        playlists_tool.add_to_playlist,
        vault_id, name, req.url,
        title=req.title, dauer=req.dauer, youtuber=req.youtuber,
        views=req.views, published=req.published, likes=req.likes,
        description=req.description, thema=req.thema,
    )


@router.post("/tools/playlists/{vault_id}/{name}/items/delete")
def playlists_remove_item(
    vault_id: str,
    name: str,
    req: PlaylistRemoveItemRequest,
) -> dict[str, Any]:
    return _wrap_playlist_errors(
        playlists_tool.remove_from_playlist, vault_id, name, req.match,
        also_delete_master=req.also_delete_master,
    )


class PlaylistPullPendingRequest(BaseModel):
    with_timestamps: bool = False
    summarize: bool = False


@router.post("/tools/playlists/{vault_id}/{name}/pull_pending",
             dependencies=[Depends(licensing.require_pro)])
async def playlists_pull_pending(
    vault_id: str,
    name: str,
    req: PlaylistPullPendingRequest,
) -> dict[str, Any]:
    """Bulk-Pull aller pending Transcripts einer Playlist via Multi-Video-Orchestrator.

    Long-running: kann je nach Playlist-Größe mehrere Minuten dauern (pro Item
    ~10-15s). Der Endpoint blockt bis fertig — der Client muss entsprechend
    Timeout setzen.
    """
    try:
        return await playlist_orchestrator.pull_pending_transcripts(
            vault_id, name, bridge,
            with_timestamps=req.with_timestamps, summarize=req.summarize,
        )
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
