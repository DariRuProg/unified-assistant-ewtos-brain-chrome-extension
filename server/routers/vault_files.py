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
from tools import crm_import
from tools import base_eval
from tools import sensitive as sensitive_tool
from i18n import t
import settings


router = APIRouter()


class VaultWriteRequest(BaseModel):
    content: str


class CrmImportPreviewRequest(BaseModel):
    csv_text: str


class CrmImportRequest(BaseModel):
    csv_text: str
    mapping: dict[str, str]
    sensitive: bool = False


class SensitiveFolderRequest(BaseModel):
    folder: str
    sensitive: bool


class SensitiveFileRequest(BaseModel):
    rel_path: str
    sensitive: bool


@router.post("/tools/crm/import_preview")
def crm_import_preview(req: CrmImportPreviewRequest) -> dict[str, Any]:
    """Parst CSV-Text und liefert Header, Zeilenzahl, Beispielzeilen + Auto-Zuordnung.
    Read-only, kein Schreibzugriff."""
    try:
        return crm_import.preview(req.csv_text)
    except Exception as e:
        raise HTTPException(400, str(e))


@router.post("/tools/crm/import/{vault_id}")
def crm_import_run(vault_id: str, req: CrmImportRequest) -> dict[str, Any]:
    """Legt je CSV-Zeile eine Kundenkarte unter crm/kunden/ an. Erfordert write_files.
    sensitive=True markiert alle erzeugten Karten mit `sensibel: true`."""
    try:
        return crm_import.import_customers(vault_id, req.csv_text, req.mapping, req.sensitive)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/tools/vault_file/{vault_id}")
def vault_file_read(vault_id: str, rel_path: str) -> dict[str, Any]:
    """Read-only Zugriff auf eine .md-Datei im Vault. Wird vom Sidepanel
    fürs Inline-Preview von Master-Pages und Transcripts genutzt.
    rel_path ist relativ zum Vault-Root."""
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, t("err.vault_not_found", id=vault_id))
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
        raise HTTPException(404, t("err.vault_not_found", id=vault_id))
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
        raise HTTPException(400, t("err.tts_text_missing"))
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
        raise HTTPException(404, t("err.vault_not_found", id=vault_id))
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


@router.get("/tools/vault_query/{vault_id}")
def vault_query(vault_id: str, folder: str = "crm/kunden", typ: str | None = None,
                recursive: bool = False) -> dict[str, Any]:
    """Listet .md-Dateien in `folder` und parst deren Frontmatter zu strukturierten
    Records — fuer Tabellen-Ansichten (z.B. CRM-Kundenliste). Read-only.
    Optionaler Filter `typ` auf das gleichnamige Frontmatter-Feld. 404 wenn der
    Ordner fehlt (Vault ohne CRM-Modul)."""
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, t("err.vault_not_found", id=vault_id))
    try:
        records = wiki_reader.query_frontmatter(v["path"], folder, typ=typ, recursive=recursive)
        return {"vault_id": vault_id, "folder": folder, "records": records}
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/tools/vault_base/{vault_id}")
def vault_base(vault_id: str, rel_path: str) -> dict[str, Any]:
    """Wertet eine `.base`-Datei aus und liefert fertige Views (Spalten/Zeilen/
    Gruppen) — fuer die Tabellen-Ansicht von Bases in der Extension. Read-only."""
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, t("err.vault_not_found", id=vault_id))
    if not rel_path.lower().endswith(".base"):
        raise HTTPException(400, "Keine .base-Datei")
    try:
        result = base_eval.evaluate_base(v["path"], rel_path)
        return {"vault_id": vault_id, **result}
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/tools/vault_sensitive/{vault_id}")
def vault_sensitive_state(vault_id: str) -> dict[str, Any]:
    """Liefert die als sensibel markierten Ordner + die einzeln (per Frontmatter)
    markierten Dateien — fuer die Schloss-Anzeige im Vault-Explorer."""
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, t("err.vault_not_found", id=vault_id))
    return {
        "vault_id": vault_id,
        "folders": settings.vault_sensitive_folders(vault_id),
        "files": sensitive_tool.list_sensitive_files(v["path"], vault_id),
    }


@router.post("/tools/vault_sensitive/folder/{vault_id}")
def vault_sensitive_folder(vault_id: str, req: SensitiveFolderRequest) -> dict[str, Any]:
    """Markiert/entfernt einen Ordner als sensibel (vault-Settings, kein Datei-Write)."""
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, t("err.vault_not_found", id=vault_id))
    try:
        folders = settings.set_vault_sensitive_folder(vault_id, req.folder, req.sensitive)
        return {"ok": True, "folders": folders}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/tools/vault_sensitive/file/{vault_id}")
def vault_sensitive_file(vault_id: str, req: SensitiveFileRequest) -> dict[str, Any]:
    """Setzt/entfernt `sensibel: true` im Frontmatter einer Datei. Erfordert write_files."""
    if not settings.vault_permission(vault_id, "write_files"):
        raise HTTPException(403, t("err.files_write_denied"))
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, t("err.vault_not_found", id=vault_id))
    try:
        state = sensitive_tool.set_file_sensitive(v["path"], req.rel_path, req.sensitive)
        return {"ok": True, "sensitive": state}
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/tools/vault_search/{vault_id}")
def vault_search(vault_id: str, q: str, max_results: int = 30) -> dict[str, Any]:
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, t("err.vault_not_found", id=vault_id))
    if not q or not q.strip():
        raise HTTPException(400, t("err.search_query_empty"))
    results = wiki_reader.search_files(v["path"], q.strip(), max_results)
    return {"vault_id": vault_id, "q": q, "results": results}


@router.put("/tools/vault_file/{vault_id}")
def vault_file_write(vault_id: str, rel_path: str, body: VaultWriteRequest) -> dict[str, Any]:
    if not settings.vault_permission(vault_id, "write_files"):
        raise HTTPException(403, t("err.files_write_denied"))
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, t("err.vault_not_found", id=vault_id))
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
        raise HTTPException(403, t("err.files_write_denied"))
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, t("err.vault_not_found", id=vault_id))
    try:
        wiki_reader.create_file(v["path"], rel_path, body.content)
        return {"ok": True}
    except FileExistsError as e:
        raise HTTPException(409, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/tools/vault_folder_new/{vault_id}")
def vault_folder_create(vault_id: str, rel_path: str) -> dict[str, Any]:
    """Legt einen neuen Ordner im Vault an. Erfordert write_files."""
    if not settings.vault_permission(vault_id, "write_files"):
        raise HTTPException(403, t("err.files_write_denied"))
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, t("err.vault_not_found", id=vault_id))
    try:
        wiki_reader.create_folder(v["path"], rel_path)
        return {"ok": True, "rel_path": rel_path}
    except FileExistsError as e:
        raise HTTPException(409, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/tools/vault_file/{vault_id}")
def vault_file_delete(vault_id: str, rel_path: str) -> dict[str, Any]:
    """Loescht eine Datei oder einen leeren Ordner. Erfordert write_files-Permission."""
    if not settings.vault_permission(vault_id, "write_files"):
        raise HTTPException(403, t("err.files_write_denied"))
    v = settings.get_vault(vault_id)
    if not v:
        raise HTTPException(404, t("err.vault_not_found", id=vault_id))
    try:
        kind = wiki_reader.delete_path(v["path"], rel_path)
        return {"ok": True, "deleted": rel_path, "kind": kind}
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
