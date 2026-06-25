"""Blueprints + Setup-Agent Endpoints. ewtos.com"""
from __future__ import annotations

import logging

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from tools import blueprint as blueprint_tool
from tools import setup_agent as setup_agent_tool
import settings

log = logging.getLogger("ewtosbrain")

router = APIRouter()

# --- Blueprints -----------------------------------------------------------


@router.get("/blueprints")
def blueprints_list() -> dict[str, Any]:
    return {"blueprints": blueprint_tool.list_available()}


@router.get("/blueprints/{blueprint_id}")
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


@router.post("/blueprints/import")
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


@router.delete("/blueprints/{blueprint_id}")
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


@router.post("/vaults/{vault_id}/blueprint/preview")
def vault_blueprint_preview(vault_id: str, body: BlueprintBody) -> dict[str, Any]:
    if not settings.get_vault(vault_id):
        raise HTTPException(404, "Vault nicht gefunden")
    try:
        return blueprint_tool.preview(vault_id, body.blueprint)
    except blueprint_tool.BlueprintError as e:
        raise HTTPException(400, str(e))


@router.post("/vaults/{vault_id}/blueprint/commit")
def vault_blueprint_commit(vault_id: str, body: BlueprintBody) -> dict[str, Any]:
    if not settings.get_vault(vault_id):
        raise HTTPException(404, "Vault nicht gefunden")
    try:
        return blueprint_tool.commit(vault_id, body.blueprint)
    except blueprint_tool.BlueprintError as e:
        raise HTTPException(400, str(e))


@router.get("/vaults/{vault_id}/blueprint")
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


@router.post("/vaults/{vault_id}/setup_agent/start")
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


@router.post("/vaults/{vault_id}/setup_agent/message")
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


@router.get("/vaults/{vault_id}/setup_agent/state")
def setup_agent_state(vault_id: str, session_id: str = Query(...)) -> dict[str, Any]:
    if not settings.get_vault(vault_id):
        raise HTTPException(404, "Vault nicht gefunden")
    try:
        return setup_agent_tool.get_state(session_id)
    except setup_agent_tool.SetupAgentError as e:
        raise HTTPException(404, str(e))


@router.post("/vaults/{vault_id}/setup_agent/commit")
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
