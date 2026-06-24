"""Notes + Bookmarks Endpoints. ewtos.com"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from tools import notes_file
from tools import bookmarks as bookmarks_tool

router = APIRouter()


class NotesSaveRequest(BaseModel):
    content: str


class NotesExportRequest(BaseModel):
    path: str
    content: str


@router.get("/tools/notes/{kind}")
def notes_load(kind: str, vault_id: str | None = Query(None)) -> dict[str, Any]:
    try:
        return notes_file.load(kind, vault_id=vault_id)
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.post("/tools/notes/{kind}")
def notes_save(
    kind: str, req: NotesSaveRequest, vault_id: str | None = Query(None),
) -> dict[str, Any]:
    try:
        return notes_file.save(kind, req.content, vault_id=vault_id)
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.post("/tools/notes/{kind}/export")
def notes_export(kind: str, req: NotesExportRequest) -> dict[str, Any]:
    try:
        return notes_file.export(req.path, req.content, source=kind)
    except ValueError as e:
        raise HTTPException(400, str(e))


class NotesAppendRequest(BaseModel):
    text: str


@router.post("/tools/notes/scratchpad/append")
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


@router.get("/tools/bookmarks")
def bookmarks_list(vault_id: str | None = Query(None)) -> dict[str, Any]:
    return {"items": bookmarks_tool.list_bookmarks(vault_id=vault_id)}


@router.post("/tools/bookmarks")
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


@router.post("/tools/bookmarks/edit")
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


@router.post("/tools/bookmarks/delete")
def bookmarks_delete(
    req: BookmarkDeleteRequest, vault_id: str | None = Query(None),
) -> dict[str, Any]:
    try:
        return bookmarks_tool.delete_bookmark(req.match, req.date, vault_id=vault_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
