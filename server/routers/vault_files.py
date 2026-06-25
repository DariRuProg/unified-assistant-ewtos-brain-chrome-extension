"""Vault-Datei + Audit + Search + TTS. ewtos.com"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from tools import tts_elevenlabs as tts_tool
from tools import wiki_reader
from tools import blueprint as blueprint_tool
from tools import vault_audit as vault_audit_tool
import settings


router = APIRouter()

@router.get("/tools/vault_file/{vault_id}")
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


@router.get("/tools/vault_asset/{vault_id}/{rel_path:path}")
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


@router.post("/tools/tts")
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


@router.get("/tools/vault_list/{vault_id}")
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


@router.get("/tools/vault_audit/{vault_id}")
def vault_audit_run(vault_id: str) -> dict[str, Any]:
    """Read-only Health-Check: Orphans, un-ingestete raw, kaputte Links, Frontmatter, CLAUDE.md-Drift."""
    try:
        return vault_audit_tool.audit_vault(vault_id)
    except LookupError as e:
        raise HTTPException(404, str(e))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))


@router.get("/tools/vault_audit/{vault_id}/claude_md_preview")
def vault_audit_claude_md_preview(vault_id: str) -> dict[str, Any]:
    try:
        return blueprint_tool.preview_claude_md_upgrade(vault_id)
    except blueprint_tool.BlueprintError as e:
        raise HTTPException(400, str(e))


@router.post("/tools/vault_audit/{vault_id}/claude_md_apply")
def vault_audit_claude_md_apply(vault_id: str) -> dict[str, Any]:
    try:
        return blueprint_tool.apply_claude_md_upgrade(vault_id)
    except blueprint_tool.BlueprintError as e:
        raise HTTPException(400, str(e))


class VaultRepairRequest(BaseModel):
    category: str
    path: str


@router.post("/tools/vault_audit/{vault_id}/repair")
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


@router.get("/tools/vault_search/{vault_id}")
def vault_search(vault_id: str, q: str, max_results: int = 30) -> dict[str, Any]:
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, f"Vault {vault_id} nicht gefunden")
    if not q or not q.strip():
        raise HTTPException(400, "Suchbegriff darf nicht leer sein")
    results = wiki_reader.search_files(v["path"], q.strip(), max_results)
    return {"vault_id": vault_id, "q": q, "results": results}


@router.put("/tools/vault_file/{vault_id}")
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


@router.post("/tools/vault_file_new/{vault_id}")
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


@router.delete("/tools/vault_file/{vault_id}")
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
