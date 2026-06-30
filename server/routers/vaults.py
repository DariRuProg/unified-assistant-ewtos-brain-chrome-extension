"""Vault-CRUD + Scaffold Endpoints. ewtos.com"""
from __future__ import annotations

import logging

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from tools import wiki_reader
from tools import blueprint as blueprint_tool
import auth
import chat
from i18n import t
import settings

log = logging.getLogger("ewtosbrain")

router = APIRouter()

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
    members: list[str] | None = None


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


@router.get("/vaults")
def vaults_list(request: Request) -> dict[str, Any]:
    uid = auth.current_user_id(request)
    return {
        "vaults": [
            _enrich_vault(v)
            for v in settings.get_vaults()
            if settings.user_can_access_vault(uid, v["id"])
        ]
    }


@router.post("/vaults")
def vaults_create(req: VaultCreate, request: Request) -> dict[str, Any]:
    if not auth.is_admin(request):
        raise HTTPException(403, "Admin erforderlich")
    if not req.name.strip():
        raise HTTPException(400, t("err.vault_name_empty"))
    if not req.path.strip():
        raise HTTPException(400, t("err.vault_path_empty"))
    return settings.add_vault(
        req.name, req.path, req.system_prompt or "",
        use_local_notes=req.use_local_notes,
    )


# Static POST routes BEFORE /vaults/{vault_id} to avoid path-param matching.
@router.post("/vaults/preview-claude-md")
def vaults_preview_claude_md(req: GeneratePromptRequest) -> dict[str, Any]:
    """Read CLAUDE.md from a path (no LLM call). Returns the content + the
    canned generator instruction so the user can copy & use externally."""
    content = chat.preview_claude_md(req.path)
    if not content:
        raise HTTPException(404, t("err.vault_no_claude_md"))
    return {
        "claude_md": content,
        "generator_instruction": chat.generator_instruction(content),
    }


@router.post("/vaults/generate-prompt")
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


@router.get("/vaults/{vault_id}/raw_folders")
def vaults_raw_folders(vault_id: str) -> dict[str, Any]:
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, t("err.vault_not_found", id=vault_id))
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


@router.get("/vaults/{vault_id}")
def vaults_get(vault_id: str) -> dict[str, Any]:
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, t("err.vault_not_found", id=vault_id))
    return _enrich_vault(v)


@router.post("/vaults/{vault_id}")
def vaults_update(vault_id: str, req: VaultUpdate, request: Request) -> dict[str, Any]:
    if not auth.is_admin(request):
        raise HTTPException(403, "Admin erforderlich")
    updated = settings.update_vault(vault_id, **req.model_dump(exclude_none=True))
    if not updated:
        raise HTTPException(404, t("err.vault_not_found", id=vault_id))
    return updated


@router.delete("/vaults/{vault_id}")
def vaults_delete(vault_id: str, request: Request) -> dict[str, Any]:
    if not auth.is_admin(request):
        raise HTTPException(403, "Admin erforderlich")
    if not settings.remove_vault(vault_id):
        raise HTTPException(404, t("err.vault_not_found", id=vault_id))
    chat_file = chat.CHAT_DIR / f"chat-{vault_id}.json"
    if chat_file.exists():
        chat_file.unlink()
    return {"removed": True, "vault_id": vault_id}


@router.get("/vaults/{vault_id}/chat/history")
def vault_chat_history(vault_id: str) -> dict[str, Any]:
    messages = [
        m for m in chat._load_history(vault_id)
        if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)
    ]
    return {"messages": messages, "count": len(messages)}


@router.post("/vaults/{vault_id}/scaffold")
def vaults_scaffold(vault_id: str) -> dict[str, Any]:
    """Convenience-Endpoint: scaffold den Default-Vault (Kontext-Profil + PARA).

    Intern: ruft blueprint.commit(vault_id, load_builtin(DEFAULT_BLUEPRINT_ID)).
    Eine einzige Wahrheit fuer alle Scaffold-Pfade.
    """
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, t("err.vault_not_found", id=vault_id))
    try:
        bp = blueprint_tool.load_builtin(blueprint_tool.DEFAULT_BLUEPRINT_ID)
        result = blueprint_tool.commit(vault_id, bp)
        settings.add_applied_blueprints(vault_id, [blueprint_tool.DEFAULT_BLUEPRINT_ID])
        return result
    except blueprint_tool.BlueprintError as e:
        raise HTTPException(400, str(e))


class ApplyBlueprintRequest(BaseModel):
    blueprint_id: str


@router.post("/vaults/{vault_id}/apply_blueprint")
def vaults_apply_blueprint(vault_id: str, req: ApplyBlueprintRequest) -> dict[str, Any]:
    """Committet ein zusaetzliches builtin Blueprint non-destruktiv auf einen
    bestehenden Vault (z.B. 'karpathy-para-base' fuer die Farming-Erweiterung).
    skip_if_exists schuetzt vorhandene Dateien; Indexe/MOCs werden mitgepflegt."""
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, t("err.vault_not_found", id=vault_id))
    try:
        bp = blueprint_tool.load_builtin(req.blueprint_id)
        result = blueprint_tool.commit(vault_id, bp)
        settings.add_applied_blueprints(vault_id, [req.blueprint_id])
        return result
    except blueprint_tool.BlueprintError as e:
        raise HTTPException(400, str(e))
