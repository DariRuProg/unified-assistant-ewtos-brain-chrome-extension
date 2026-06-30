"""Briefing + Profile Endpoints. ewtos.com"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from tools import briefing as briefing_tool
import settings

router = APIRouter()

# --- Briefing ------------------------------------------------------------

@router.get("/tools/briefing")
async def briefing_get(
    profile: str = "default",
    vault_id: str | None = None,
    archive: bool = False,
) -> dict[str, Any]:
    try:
        data = await briefing_tool.get_briefing(
            profile_id=profile, vault_id=vault_id, archive=archive
        )
        return {"ok": True, "data": data}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.get("/tools/briefing/lookback")
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


@router.get("/tools/briefing/profiles")
def briefing_profiles_list() -> dict[str, Any]:
    return {"ok": True, "data": briefing_tool.list_profiles()}


class BriefingProfileSaveRequest(BaseModel):
    id: str | None = None
    name: str
    sources: list[str]
    params: dict[str, dict] = {}


@router.post("/tools/briefing/profiles")
def briefing_profiles_save(req: BriefingProfileSaveRequest) -> dict[str, Any]:
    try:
        saved = briefing_tool.save_profile(req.model_dump(exclude_none=True))
        return {"ok": True, "data": saved}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.delete("/tools/briefing/profiles/{profile_id}")
def briefing_profiles_delete(profile_id: str) -> dict[str, Any]:
    deleted = briefing_tool.delete_profile(profile_id)
    if not deleted:
        raise HTTPException(400, "Profil nicht gefunden oder 'default' kann nicht gelöscht werden")
    return {"ok": True, "deleted": profile_id}
