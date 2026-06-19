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
import shutil
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
_SKILL_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9\-]*$")


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


def _meta(bp: dict, bid: str, source: str, trusted: bool) -> dict:
    extends = bp.get("extends", []) or []
    category = bp.get("category") or ("base" if not extends else "addon")
    return {
        "id": bp.get("blueprint_id", bid),
        "name": bp.get("blueprint_name", bid),
        "version": bp.get("blueprint_version", ""),
        "source": source,
        "trusted": trusted,
        "description": bp.get("description", ""),
        "when_to_use": bp.get("when_to_use", ""),
        "category": category,
        "tags": bp.get("tags", []),
        "extends": extends,
    }


def list_available() -> list[dict]:
    """Liefert Metadaten-Dicts: id, name, version, source, trusted, description,
    when_to_use, category (base|addon, ggf. aus extends abgeleitet), tags, extends."""
    result: list[dict] = []
    for bid in _list_builtin_ids():
        result.append(_meta(load_builtin(bid), bid, "builtin", True))
    for entry in settings.get_imported_blueprints():
        bp = entry.get("blueprint") or {}
        result.append(_meta(bp, bp.get("blueprint_id", ""), "imported", bool(entry.get("trusted"))))
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

    # skills: Set-Union mit stabiler Reihenfolge
    merged_skills: list[str] = []
    seen_skills: set[str] = set()
    for sk in (parent.get("skills") or []) + (child.get("skills") or []):
        if sk not in seen_skills:
            seen_skills.add(sk)
            merged_skills.append(sk)
    out["skills"] = merged_skills

    # commands: Set-Union mit stabiler Reihenfolge
    merged_cmds: list[str] = []
    seen_cmds: set[str] = set()
    for cm in (parent.get("commands") or []) + (child.get("commands") or []):
        if cm not in seen_cmds:
            seen_cmds.add(cm)
            merged_cmds.append(cm)
    out["commands"] = merged_cmds

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

    for skill_name in resolved.get("skills") or []:
        rel = f".claude/skills/{skill_name}"
        if (vault_path / ".claude" / "skills" / skill_name).exists():
            would_skip.append(rel)
        else:
            would_create.append(rel + "/")

    for cmd_name in resolved.get("commands") or []:
        rel = f".claude/commands/{cmd_name}.md"
        if (vault_path / ".claude" / "commands" / f"{cmd_name}.md").exists():
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


_AUTO_INDEX_TEMPLATE = """---
typ: index
aktualisiert: {today}
---

# {label}

## Pages
"""

_FM_TITLE_RE = re.compile(r"^\s*titel\s*:\s*(.+?)\s*$", re.MULTILINE | re.IGNORECASE)
_H1_RE = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)


def _folder_has_content(folder: Path) -> bool:
    """True, wenn unter `folder` (rekursiv, ohne hidden) ≥1 .md ausser index.md liegt.
    Massstab dafuer, ob ein Index-Hub ueberhaupt etwas zu mappen hat."""
    try:
        for p in folder.rglob("*.md"):
            if p.name == "index.md":
                continue
            if any(part.startswith(".") for part in p.relative_to(folder).parts):
                continue
            return True
    except OSError:
        return False
    return False


def _ensure_wiki_indexes(vault_path: Path, created: list[str]) -> None:
    """Index-Konvention (Karpathy/PARA, flach + nur bei Inhalt): index.md-Hub fuer
    den wiki-Root (immer) sowie Buckets (Ebene 1) und Themen-Ordner (Ebene 2) — dort
    aber NUR wenn der Ordner Inhalt hat. Tiefer (≥3) kein Hub. Leere Buckets bekommen
    keinen Hub. Idempotent — vorhandene index.md bleiben."""
    wiki = vault_path / "wiki"
    if not wiki.is_dir():
        return
    candidates = [wiki] + [d for d in wiki.rglob("*") if d.is_dir()]
    for d in sorted(candidates):
        rel = d.relative_to(wiki).parts
        if any(part.startswith(".") for part in rel):
            continue
        depth = len(rel)  # wiki=0, bucket=1, topic=2
        if depth >= 3:
            continue
        if depth in (1, 2) and not _folder_has_content(d):
            continue
        idx = d / "index.md"
        if idx.exists():
            continue
        label = "Wiki" if depth == 0 else d.name.replace("-", " ").title()
        idx.write_text(
            _AUTO_INDEX_TEMPLATE.format(label=label, today=date.today().isoformat()),
            encoding="utf-8",
        )
        created.append(f"{d.relative_to(vault_path).as_posix()}/index.md")


def _is_prunable_stub(idx: Path) -> bool:
    """True, wenn idx.md ein unveraenderter Auto-Stub ist: keine Wikilinks, keine
    Listenpunkte, keine ##-Sektion ausser '## Pages'. Schuetzt handkuratierte Hubs."""
    try:
        text = idx.read_text(encoding="utf-8")
    except OSError:
        return False
    if "[[" in text:
        return False
    for line in text.splitlines():
        s = line.strip()
        if s.startswith(("- ", "* ")):
            return False
        if s.startswith("## ") and s.lower() != "## pages":
            return False
    return True


def _prune_empty_hubs(vault_path: Path, removed: list[str]) -> None:
    """Entfernt index.md in Bucket-/Themen-Ordnern (Ebene 1–2), die keinen Inhalt
    haben UND ein unveraenderter Auto-Stub sind. wiki-Root wird nie entfernt."""
    wiki = vault_path / "wiki"
    if not wiki.is_dir():
        return
    for idx in list(wiki.rglob("index.md")):
        folder = idx.parent
        if folder == wiki:
            continue
        rel = folder.relative_to(wiki).parts
        if any(part.startswith(".") for part in rel):
            continue
        depth = len(rel)
        if depth not in (1, 2):
            continue
        if _folder_has_content(folder):
            continue
        if _is_prunable_stub(idx):
            try:
                idx.unlink()
                removed.append(idx.relative_to(vault_path).as_posix())
            except OSError:
                pass


def _md_title(path: Path) -> str:
    """Titel einer Seite: Frontmatter `titel:`, sonst erste `# `-Ueberschrift, sonst Dateiname."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return path.stem
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            m = _FM_TITLE_RE.search(text[3:end])
            if m:
                return m.group(1).strip()
    m = _H1_RE.search(text)
    return m.group(1).strip() if m else path.stem


def _replace_pages_section(content: str, body: str) -> str:
    """Ersetzt den Block unter '## Pages' bis zur naechsten '## '-Ueberschrift durch body.
    Fehlt die Sektion, wird sie am Ende ergaenzt. Sonstiger Inhalt bleibt erhalten."""
    lines = content.splitlines()
    head = next((i for i, l in enumerate(lines) if l.strip().lower() == "## pages"), None)
    new_block = ["## Pages"] + (["", *body.splitlines()] if body else [])
    if head is None:
        base = content.rstrip("\n")
        return (base + "\n\n" + "\n".join(new_block) + "\n") if base else "\n".join(new_block) + "\n"
    end = len(lines)
    for j in range(head + 1, len(lines)):
        if lines[j].startswith("## "):
            end = j
            break
    tail = lines[end:]
    rebuilt = lines[:head] + new_block + ([""] if tail else []) + tail
    return "\n".join(rebuilt).rstrip("\n") + "\n"


def _rebuild_wiki_mocs(vault_path: Path, changed: list[str]) -> None:
    """Baut die '## Pages'-Sektion jeder wiki/-index.md (inkl. wiki-Root) neu auf:
    Kind-Hubs (Unterordner mit index.md) zuerst, dann fuer Unterordner OHNE Hub deren
    Seiten flach (damit kein Hub leer bleibt und nichts orphaned ist), dann eigene
    Direkt-Seiten. Statische [[wikilinks]], non-destruktiv (nur die ## Pages-Sektion)."""
    wiki = vault_path / "wiki"
    if not wiki.is_dir():
        return

    def _page_link(p: Path) -> str:
        rel = p.with_suffix("").relative_to(vault_path).as_posix()
        return f"- [[{rel}|{_md_title(p)}]]"

    for idx in wiki.rglob("index.md"):
        if any(part.startswith(".") for part in idx.relative_to(vault_path).parts):
            continue
        folder = idx.parent
        try:
            children = sorted(folder.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            continue
        entries: list[str] = []
        for p in children:
            if not p.is_dir() or p.name.startswith("."):
                continue
            if (p / "index.md").exists():  # Kind-Hub
                rel = (p / "index").relative_to(vault_path).as_posix()
                entries.append(f"- [[{rel}|{p.name.replace('-', ' ')}]]")
            else:  # Hub-los → Seiten flach mitlisten
                for page in sorted(p.rglob("*.md")):
                    if page.name == "index.md" or any(pt.startswith(".") for pt in page.relative_to(p).parts):
                        continue
                    entries.append(_page_link(page))
        for p in children:  # eigene Direkt-Seiten
            if p.suffix == ".md" and p.name != "index.md":
                entries.append(_page_link(p))
        old = idx.read_text(encoding="utf-8")
        new = _replace_pages_section(old, "\n".join(entries))
        if new != old:
            idx.write_text(new, encoding="utf-8")
            changed.append(idx.relative_to(vault_path).as_posix())


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
            file_vars = {**(resolved.get("vars") or {}), **(f.get("vars") or {})}
            ctx = _make_context(vault_name, vault_path, file_vars)
            content = _render_template(f["template"], ctx)

        _write_file(target, content)
        created.append(rel)

    # 2b. Index-Konvention: Hub-index.md fuer wiki-Root + Buckets/Themen MIT Inhalt.
    _ensure_wiki_indexes(vault_path, created)
    # 2c. Leere Auto-Stub-Hubs entfernen.
    pruned_hubs: list[str] = []
    _prune_empty_hubs(vault_path, pruned_hubs)
    # 2d. Statische MOC-Pflege: ## Pages in jeder wiki/-index.md neu aufbauen.
    mocs_updated: list[str] = []
    _rebuild_wiki_mocs(vault_path, mocs_updated)

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
                ctx = _make_context(vault_name, vault_path, resolved.get("vars"))
                sec["content"] = _render_template(sec["template"], ctx)
                sec.pop("template", None)
            sec.setdefault("merge_policy", "replace_if_marker")
            rendered_sections.append(sec)
            merged_sections.append(sec["id"])
        new_text = claude_md_merger.merge(existing, rendered_sections)
        _write_file(claude_md_path, new_text)

    # 5. Skills — gebuendelte Skill-Trees nach .claude/skills/<name> kopieren
    copied_skills: list[str] = []
    for skill_name in resolved.get("skills") or []:
        if not _SKILL_NAME_RE.match(skill_name):
            raise BlueprintError(f"skills[]: ungueltiger Skill-Name '{skill_name}'")
        src = paths.skills_dir() / skill_name
        rel = f".claude/skills/{skill_name}"
        if not src.is_dir():
            continue
        dest = vault_path / ".claude" / "skills" / skill_name
        if dest.exists():
            skipped.append(rel)
            continue
        shutil.copytree(src, dest)
        created.append(rel + "/")
        copied_skills.append(skill_name)

    # 5b. Commands — gebuendelte Slash-Command-Prompts nach .claude/commands/<name>.md
    copied_commands: list[str] = []
    for cmd_name in resolved.get("commands") or []:
        if not _SKILL_NAME_RE.match(cmd_name):
            raise BlueprintError(f"commands[]: ungueltiger Command-Name '{cmd_name}'")
        src = paths.commands_dir() / f"{cmd_name}.md"
        rel = f".claude/commands/{cmd_name}.md"
        if not src.is_file():
            continue
        dest = vault_path / ".claude" / "commands" / f"{cmd_name}.md"
        if dest.exists():
            skipped.append(rel)
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        created.append(rel)
        copied_commands.append(cmd_name)

    # 6. Snapshot + settings.blueprint_ref
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
        "copied_skills": copied_skills,
        "copied_commands": copied_commands,
        "mocs_updated": mocs_updated,
        "pruned_hubs": pruned_hubs,
        "blueprint_snapshot": str(snap_path),
    }


def rebuild_vault_indexes(vault_id: str) -> dict:
    """On-demand Index-/MOC-Pflege fuer einen bestehenden Vault (ohne Blueprint-Commit):
    legt fehlende Hub-index.md an (Bucket/Sammel-Themen) und baut alle ## Pages neu auf.
    Idempotent, non-destruktiv. Fuer Wartung nach Aenderungen ausserhalb des Commit-Pfads."""
    v = settings.get_vault(vault_id)
    if not v:
        raise BlueprintError(f"Vault nicht gefunden: {vault_id}")
    vault_path = Path(v["path"])
    if not vault_path.exists():
        raise BlueprintError(f"Vault-Pfad existiert nicht: {vault_path}")
    created: list[str] = []
    _ensure_wiki_indexes(vault_path, created)
    pruned: list[str] = []
    _prune_empty_hubs(vault_path, pruned)
    updated: list[str] = []
    _rebuild_wiki_mocs(vault_path, updated)
    return {"ok": True, "created_hubs": created, "pruned_hubs": pruned, "mocs_updated": updated}


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

DEFAULT_BLUEPRINT_ID = "kontext-base"


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
            ctx = _make_context(v["name"], vault_path, resolved.get("vars"))
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
