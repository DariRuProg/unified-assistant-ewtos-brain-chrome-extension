# @author Dario | ewtos.com
"""Vault-Blueprint Core: load, validate, resolve extends, preview, commit.

Public API (siehe Plan §1, §2, §6 — lass-uns-kurz-dar-ber-vectorized-lemur.md):
    load_builtin / load_imported / list_available
    validate / resolve_extends
    preview / commit / export_vault_blueprint
    save_imported / delete_imported
    verify_signature  (Stub — ed25519 folgt mit pynacl)

Schreibt nur in den Vault (commit) und in settings.json (save_imported / delete_imported).
Andere Module liefern die Bausteine:
    server/tools/base_generator.py    -> .base-YAML
    server/tools/claude_md_merger.py  -> CLAUDE.md-Marker-Merge
"""
from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path
from typing import Any

import jsonschema
from jinja2 import Environment, FileSystemLoader, StrictUndefined

import paths
import settings
from tools import base_generator, claude_md_merger

# Pfade
SCHEMAS_DIR = paths.schemas_dir()
TEMPLATES_DIR = paths.templates_dir()
V1_SCHEMA_FILE = SCHEMAS_DIR / "v1.json"
TRUSTED_KEYS_FILE = paths.trusted_keys_file()

# Jinja-Environment auf alle Templates
_jinja = Environment(
    loader=FileSystemLoader(str(TEMPLATES_DIR)),
    autoescape=False,
    undefined=StrictUndefined,
    keep_trailing_newline=True,
)

_PATH_BAD_RE = re.compile(r"(^/)|(\.\.)|(\\)")


class BlueprintError(Exception):
    """Fehler bei Validierung, Resolution oder Commit eines Blueprints."""


# --- Loading ---------------------------------------------------------------

def _load_schema() -> dict:
    return json.loads(V1_SCHEMA_FILE.read_text(encoding="utf-8"))


def load_builtin(blueprint_id: str) -> dict:
    """Laedt eingebauten Blueprint aus blueprint_schemas/<id>.json."""
    path = SCHEMAS_DIR / f"{blueprint_id}.json"
    if not path.exists() or blueprint_id == "v1":
        raise BlueprintError(f"Built-in Blueprint nicht gefunden: {blueprint_id}")
    return json.loads(path.read_text(encoding="utf-8"))


def load_imported(blueprint_id: str) -> dict | None:
    """Laedt importierten Blueprint aus settings (imported_blueprints[])."""
    for entry in settings.get_imported_blueprints():
        bp = entry.get("blueprint") or {}
        if bp.get("blueprint_id") == blueprint_id:
            return dict(bp)
    return None


def _list_builtin_ids() -> list[str]:
    if not SCHEMAS_DIR.exists():
        return []
    return sorted(
        p.stem for p in SCHEMAS_DIR.glob("*.json")
        if p.stem != "v1"
    )


def list_available() -> list[dict]:
    """Liefert Liste von Metadaten-Dicts: id, name, version, source, trusted, description."""
    result: list[dict] = []
    for bid in _list_builtin_ids():
        bp = load_builtin(bid)
        result.append({
            "id": bp.get("blueprint_id", bid),
            "name": bp.get("blueprint_name", bid),
            "version": bp.get("blueprint_version", ""),
            "source": "builtin",
            "trusted": True,
            "description": bp.get("description", ""),
            "tags": bp.get("tags", []),
            "extends": bp.get("extends", []),
        })
    for entry in settings.get_imported_blueprints():
        bp = entry.get("blueprint") or {}
        result.append({
            "id": bp.get("blueprint_id", ""),
            "name": bp.get("blueprint_name", ""),
            "version": bp.get("blueprint_version", ""),
            "source": "imported",
            "trusted": bool(entry.get("trusted")),
            "description": bp.get("description", ""),
            "tags": bp.get("tags", []),
            "extends": bp.get("extends", []),
        })
    return result


# --- Validation ------------------------------------------------------------

def _check_path(path: str, field: str) -> None:
    if not isinstance(path, str) or not path:
        raise BlueprintError(f"{field}: leerer Pfad")
    if _PATH_BAD_RE.search(path):
        raise BlueprintError(
            f"{field}: ungueltiger Pfad '{path}' (kein absoluter Pfad, kein '..', kein Backslash)"
        )


def validate(blueprint: dict) -> None:
    """Schema-Check + Path-Traversal-Check. Wirft BlueprintError mit klarer Message."""
    if not isinstance(blueprint, dict):
        raise BlueprintError("Blueprint muss ein Objekt sein")
    schema = _load_schema()
    try:
        jsonschema.validate(blueprint, schema)
    except jsonschema.ValidationError as e:
        loc = "/".join(str(x) for x in e.absolute_path) or "<root>"
        raise BlueprintError(f"Schema-Verletzung bei {loc}: {e.message}") from None

    for f in blueprint.get("folders") or []:
        _check_path(f["path"], f"folders[].path")
    for f in blueprint.get("files") or []:
        _check_path(f["path"], f"files[].path")
        has_tpl = "template" in f
        has_inline = "template_inline" in f
        if has_tpl and has_inline:
            raise BlueprintError(
                f"files[{f['path']}]: 'template' und 'template_inline' sind exklusiv"
            )
        if not has_tpl and not has_inline:
            raise BlueprintError(
                f"files[{f['path']}]: braucht entweder 'template' oder 'template_inline'"
            )
    for b in blueprint.get("bases") or []:
        _check_path(b["path"], f"bases[].path")


# --- Extends-Resolution ----------------------------------------------------

def _lookup_blueprint(bid: str) -> dict:
    try:
        return load_builtin(bid)
    except BlueprintError:
        pass
    bp = load_imported(bid)
    if bp is None:
        raise BlueprintError(f"extends-Ziel nicht gefunden: {bid}")
    return bp


def _merge_list_by_key(parent: list, child: list, key: str) -> list:
    """Union ueber `key`: child gewinnt bei Kollision, Reihenfolge parent dann child-neu."""
    out: list = []
    seen: dict[str, int] = {}
    for item in parent or []:
        k = item.get(key)
        if k in seen:
            out[seen[k]] = item
        else:
            seen[k] = len(out)
            out.append(item)
    for item in child or []:
        k = item.get(key)
        if k in seen:
            out[seen[k]] = item
        else:
            seen[k] = len(out)
            out.append(item)
    return out


def _merge_blueprints(parent: dict, child: dict) -> dict:
    """Merge-Regeln aus Plan §1.2."""
    out: dict[str, Any] = {}

    # Identitaet kommt vom Child (es ist DER Blueprint)
    for k in (
        "schema_version", "blueprint_id", "blueprint_name", "blueprint_version",
        "author", "license", "description", "tags", "signature",
    ):
        if k in child:
            out[k] = child[k]
        elif k in parent:
            out[k] = parent[k]

    # extends nicht weitertragen
    out["extends"] = []

    # vars merge (child overrides)
    out["vars"] = {**(parent.get("vars") or {}), **(child.get("vars") or {})}

    out["folders"] = _merge_list_by_key(parent.get("folders") or [], child.get("folders") or [], "path")
    out["files"] = _merge_list_by_key(parent.get("files") or [], child.get("files") or [], "path")
    out["bases"] = _merge_list_by_key(parent.get("bases") or [], child.get("bases") or [], "path")
    out["claude_md_sections"] = _merge_list_by_key(
        parent.get("claude_md_sections") or [], child.get("claude_md_sections") or [], "id"
    )

    # briefing_sources: Set-Union mit stabiler Reihenfolge
    merged_src: list[str] = []
    seen_src: set[str] = set()
    for src in (parent.get("briefing_sources") or []) + (child.get("briefing_sources") or []):
        if src not in seen_src:
            seen_src.add(src)
            merged_src.append(src)
    out["briefing_sources"] = merged_src

    # permissions_defaults: child overrides parent
    out["permissions_defaults"] = {
        **(parent.get("permissions_defaults") or {}),
        **(child.get("permissions_defaults") or {}),
    }

    # system_prompt_template: child wins
    if child.get("system_prompt_template"):
        out["system_prompt_template"] = child["system_prompt_template"]
    elif parent.get("system_prompt_template"):
        out["system_prompt_template"] = parent["system_prompt_template"]

    return out


def resolve_extends(blueprint: dict, _stack: tuple[str, ...] = ()) -> dict:
    """Resolved extends rekursiv. Zyklen -> BlueprintError."""
    bid = blueprint.get("blueprint_id", "<anon>")
    if bid in _stack:
        raise BlueprintError(f"Zyklischer extends-Pfad: {' -> '.join(_stack + (bid,))}")
    parents = blueprint.get("extends") or []
    if not parents:
        return dict(blueprint)

    accumulator: dict = {"blueprint_id": bid, "schema_version": blueprint.get("schema_version", "1.0")}
    for parent_id in parents:
        raw_parent = _lookup_blueprint(parent_id)
        resolved_parent = resolve_extends(raw_parent, _stack + (bid,))
        accumulator = _merge_blueprints(accumulator, resolved_parent)

    # Zum Schluss Child auf den Accu mergen
    merged = _merge_blueprints(accumulator, blueprint)
    return merged


# --- Render Helpers --------------------------------------------------------

def _render_template(template_ref: str, context: dict) -> str:
    try:
        tpl = _jinja.get_template(template_ref)
    except Exception as e:
        raise BlueprintError(f"Template nicht gefunden/lesbar: {template_ref} ({e})") from None
    return tpl.render(**context)


def _make_context(vault_name: str, vault_path: Path, extra_vars: dict | None) -> dict:
    ctx = {
        "vault_name": vault_name,
        "today": date.today().isoformat(),
        "vault_path": str(vault_path),
    }
    if extra_vars:
        for k, v in extra_vars.items():
            ctx[k] = v
    return ctx


# --- Preview ---------------------------------------------------------------

def preview(vault_id: str, blueprint: dict) -> dict:
    """Liefert Diff ohne Schreibzugriff."""
    validate(blueprint)
    resolved = resolve_extends(blueprint)

    v = settings.get_vault(vault_id)
    if not v:
        raise BlueprintError(f"Vault nicht gefunden: {vault_id}")
    vault_path = Path(v["path"])

    would_create: list[str] = []
    would_skip: list[str] = []
    warnings: list[str] = []

    for folder in resolved.get("folders") or []:
        rel = folder["path"]
        target = vault_path / rel
        if not target.exists():
            would_create.append(rel + "/")

    for f in resolved.get("files") or []:
        rel = f["path"]
        target = vault_path / rel
        policy = f.get("merge_policy", "skip_if_exists")
        if target.exists():
            if policy == "overwrite":
                would_create.append(rel + " (overwrite)")
            else:
                would_skip.append(rel)
        else:
            would_create.append(rel)

    for b in resolved.get("bases") or []:
        rel = b["path"]
        target = vault_path / rel
        if target.exists():
            would_skip.append(rel)
        else:
            would_create.append(rel)

    section_ids = [s["id"] for s in resolved.get("claude_md_sections") or []]

    return {
        "blueprint_id": resolved.get("blueprint_id"),
        "would_create": would_create,
        "would_skip": would_skip,
        "would_update_claude_md": section_ids,
        "warnings": warnings,
    }


# --- Commit ----------------------------------------------------------------

def _write_file(target: Path, content: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def _commit_snapshot(vault_path: Path, resolved: dict) -> Path:
    snap_dir = vault_path / ".ewtosbrain"
    snap_dir.mkdir(parents=True, exist_ok=True)
    snap = snap_dir / "blueprint.json"
    tmp = snap.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(resolved, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(snap)
    return snap


def commit(vault_id: str, blueprint: dict) -> dict:
    """Fuehrt Scaffold aus. Siehe Modul-Docstring."""
    validate(blueprint)
    resolved = resolve_extends(blueprint)

    v = settings.get_vault(vault_id)
    if not v:
        raise BlueprintError(f"Vault nicht gefunden: {vault_id}")
    vault_path = Path(v["path"])
    if not vault_path.exists():
        raise BlueprintError(f"Vault-Pfad existiert nicht: {vault_path}")
    vault_name = v["name"]

    created: list[str] = []
    skipped: list[str] = []

    # 1. Folders
    for folder in resolved.get("folders") or []:
        rel = folder["path"]
        target = vault_path / rel
        existed = target.exists()
        target.mkdir(parents=True, exist_ok=True)
        if not existed:
            created.append(rel + "/")

    # 2. Files
    for f in resolved.get("files") or []:
        rel = f["path"]
        target = vault_path / rel
        policy = f.get("merge_policy", "skip_if_exists")
        if target.exists() and policy == "skip_if_exists":
            skipped.append(rel)
            continue

        if "template_inline" in f:
            content = f["template_inline"]
        else:
            ctx = _make_context(vault_name, vault_path, f.get("vars"))
            content = _render_template(f["template"], ctx)

        _write_file(target, content)
        created.append(rel)

    # 3. Bases
    for b in resolved.get("bases") or []:
        rel = b["path"]
        target = vault_path / rel
        if target.exists():
            skipped.append(rel)
            continue
        base_generator.render_to_file(b, vault_path)
        created.append(rel)

    # 4. CLAUDE.md Sections
    merged_sections: list[str] = []
    sections = resolved.get("claude_md_sections") or []
    if sections:
        claude_md_path = vault_path / "CLAUDE.md"
        existing = claude_md_path.read_text(encoding="utf-8") if claude_md_path.exists() else ""
        rendered_sections: list[dict] = []
        for s in sections:
            sec = dict(s)
            if "template" in sec and sec.get("template"):
                ctx = _make_context(vault_name, vault_path, None)
                sec["content"] = _render_template(sec["template"], ctx)
                sec.pop("template", None)
            sec.setdefault("merge_policy", "replace_if_marker")
            rendered_sections.append(sec)
            merged_sections.append(sec["id"])
        new_text = claude_md_merger.merge(existing, rendered_sections)
        _write_file(claude_md_path, new_text)

    # 5. Snapshot + settings.blueprint_ref
    snap_path = _commit_snapshot(vault_path, resolved)
    bid = resolved.get("blueprint_id")
    if bid:
        settings.update_vault(vault_id, blueprint_ref=bid)

    return {
        "ok": True,
        "blueprint_id": bid,
        "created": created,
        "skipped": skipped,
        "merged_claude_md_sections": merged_sections,
        "blueprint_snapshot": str(snap_path),
    }


def export_vault_blueprint(vault_id: str) -> dict | None:
    v = settings.get_vault(vault_id)
    if not v:
        return None
    snap = Path(v["path"]) / ".ewtosbrain" / "blueprint.json"
    if not snap.exists():
        return None
    try:
        return json.loads(snap.read_text(encoding="utf-8"))
    except Exception:
        return None


# --- CLAUDE.md Upgrade (non-destruktiv, ohne Folders/Files/Bases) ----------

DEFAULT_BLUEPRINT_ID = "karpathy-para-base"


def _resolve_vault_blueprint(vault_id: str) -> dict:
    """Resolved Blueprint des Vaults — Snapshot wenn vorhanden, sonst der eingebaute Default."""
    snap = export_vault_blueprint(vault_id)
    if snap:
        return resolve_extends(snap)
    return resolve_extends(load_builtin(DEFAULT_BLUEPRINT_ID))


def _render_claude_md(vault_id: str) -> tuple[str, str, list[str]]:
    """Gibt (existing_text, merged_text, section_ids) zurück — schreibt NICHT."""
    v = settings.get_vault(vault_id)
    if not v:
        raise BlueprintError(f"Vault nicht gefunden: {vault_id}")
    vault_path = Path(v["path"])
    resolved = _resolve_vault_blueprint(vault_id)

    sections = resolved.get("claude_md_sections") or []
    claude_md_path = vault_path / "CLAUDE.md"
    existing = claude_md_path.read_text(encoding="utf-8") if claude_md_path.exists() else ""
    if not sections:
        return existing, existing, []

    rendered_sections: list[dict] = []
    section_ids: list[str] = []
    for s in sections:
        sec = dict(s)
        if sec.get("template"):
            ctx = _make_context(v["name"], vault_path, None)
            sec["content"] = _render_template(sec["template"], ctx)
            sec.pop("template", None)
        sec.setdefault("merge_policy", "replace_if_marker")
        rendered_sections.append(sec)
        section_ids.append(sec["id"])

    merged = claude_md_merger.merge(existing, rendered_sections)
    return existing, merged, section_ids


def preview_claude_md_upgrade(vault_id: str) -> dict:
    """Rendert die verwalteten CLAUDE.md-Sektionen + merged sie mit der bestehenden Datei,
    OHNE zu schreiben. Liefert {existing, merged, changed, sections}."""
    existing, merged, section_ids = _render_claude_md(vault_id)
    return {
        "existing": existing,
        "merged": merged,
        "changed": merged != existing,
        "sections": section_ids,
    }


def apply_claude_md_upgrade(vault_id: str) -> dict:
    """Schreibt das gemergte CLAUDE.md. Idempotent — kein Diff → kein Write."""
    existing, merged, section_ids = _render_claude_md(vault_id)
    if merged == existing:
        return {"written": False, "sections": section_ids}
    v = settings.get_vault(vault_id)
    _write_file(Path(v["path"]) / "CLAUDE.md", merged)
    return {"written": True, "sections": section_ids}


# --- Imported-Blueprints Persistence --------------------------------------

def save_imported(blueprint: dict, *, trusted: bool = False) -> str:
    validate(blueprint)
    bid = blueprint["blueprint_id"]
    settings.add_imported_blueprint(blueprint, trusted=trusted)
    return bid


def delete_imported(blueprint_id: str) -> bool:
    return settings.remove_imported_blueprint(blueprint_id)


# --- Signature Stub --------------------------------------------------------

def verify_signature(blueprint: dict) -> tuple[bool, str]:
    """Stub: ed25519-Verify ist noch nicht implementiert (pynacl fehlt in requirements)."""
    if not blueprint.get("signature"):
        return (False, "unsigned")
    return (False, "signature-verification-not-yet-implemented")


# --- Verifikation ----------------------------------------------------------

if __name__ == "__main__":
    import os
    import sys

    print("== load_builtin('karpathy-para-base') ==")
    bp = load_builtin("karpathy-para-base")
    print(f"  ok: {bp['blueprint_id']} v{bp.get('blueprint_version','?')}")

    print("== validate ==")
    validate(bp)
    print("  ok")

    print("== resolve_extends ==")
    resolved = resolve_extends(bp)
    print(f"  ok ({len(resolved.get('folders', []))} folders, {len(resolved.get('files', []))} files)")

    print("== list_available ==")
    for entry in list_available():
        print(f"  - {entry['id']} ({entry['source']}, trusted={entry['trusted']})")

    # Mocked preview
    test_vault = Path(os.environ.get("TEST_VAULT", "C:/tmp/ewtos-test-vault"))
    print(f"== preview gegen Mock-Vault: {test_vault} ==")

    # Monkey-patch settings.get_vault fuer den Demo-Run
    class _MockSettings:
        @staticmethod
        def get_vault(_vid):
            return {"id": "demo", "name": "DemoVault", "path": str(test_vault)}

    test_vault.mkdir(parents=True, exist_ok=True)
    orig_get_vault = settings.get_vault
    settings.get_vault = _MockSettings.get_vault  # type: ignore[assignment]
    try:
        diff = preview("demo", bp)
        print(json.dumps(diff, indent=2, ensure_ascii=False))
    finally:
        settings.get_vault = orig_get_vault  # type: ignore[assignment]

    print("== verify_signature (Stub) ==")
    print(verify_signature(bp))
    sys.exit(0)
