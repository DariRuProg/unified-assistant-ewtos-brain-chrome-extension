"""Vault-CRUD + Scaffold Endpoints. ewtos.com"""
from __future__ import annotations

import logging

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from tools import wiki_reader
from tools import saeulen as saeulen_tool
from tools import blueprint as blueprint_tool
import chat
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
def vaults_list() -> dict[str, Any]:
    return {"vaults": [_enrich_vault(v) for v in settings.get_vaults()]}


@router.post("/vaults")
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
@router.post("/vaults/preview-claude-md")
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


@router.get("/vaults/{vault_id}/saeulen")
def vaults_saeulen(vault_id: str) -> dict[str, Any]:
    return {"saeulen": saeulen_tool.list_allowed()}


@router.get("/vaults/{vault_id}/raw_folders")
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


@router.get("/vaults/{vault_id}")
def vaults_get(vault_id: str) -> dict[str, Any]:
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, "Vault nicht gefunden")
    return _enrich_vault(v)


@router.post("/vaults/{vault_id}")
def vaults_update(vault_id: str, req: VaultUpdate) -> dict[str, Any]:
    updated = settings.update_vault(vault_id, **req.model_dump(exclude_none=True))
    if not updated:
        raise HTTPException(404, "Vault nicht gefunden")
    return updated


@router.delete("/vaults/{vault_id}")
def vaults_delete(vault_id: str) -> dict[str, Any]:
    if not settings.remove_vault(vault_id):
        raise HTTPException(404, "Vault nicht gefunden")
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


@router.post("/vaults/{vault_id}/apply_blueprint")
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
