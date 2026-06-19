# @author Dario | ewtos.com
"""Setup-Agent: LLM-Tool-Loop fuer iteratives Vault-Onboarding (Fresh + Extend).

Public API:
    start_session(vault_id, *, mode, templates, use_case_hint) -> dict
    send_message(session_id, message) -> dict
    get_state(session_id) -> dict
    commit(session_id) -> dict
    cleanup_expired(ttl_hours) -> int

Sessions liegen in server/setup_sessions/<id>.json (24h-TTL).
LLM modifiziert ein Working-Blueprint per Tool-Calls — niemals direkter Commit
aus dem Tool. Der echte Commit lauft ueber den separaten HTTP-Endpoint.
"""
from __future__ import annotations

import json
import logging
import re
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import paths
import settings
import llm_client
from llm_providers.base import LLMBackend
from llm_providers.anthropic_backend import AnthropicBackend
from llm_providers.ollama_backend import OllamaBackend
from llm_providers.openai_backend import OpenAIBackend
from tools import blueprint as blueprint_tool

log = logging.getLogger("ewtosbrain.setup_agent")

SESSIONS_DIR = paths.sessions_dir()
MAX_TOOL_ITERATIONS = 10
MAX_TOKENS = 4096


class SetupAgentError(Exception):
    """Fehler im Setup-Agent (Session nicht da, Commit-Voraussetzung verletzt, ...)."""


# --- System-Prompts -------------------------------------------------------

_FRESH_PROMPT = """Du bist der EwtosBrain-Setup-Agent. Du richtest per Interview ein persoenliches Zweites Gehirn (Obsidian-Vault) ein.

Das Working-Blueprint ist bereits mit der Basis `kontext-base` geladen: Kontext-Profil (`kontext/`), PARA-Buckets (`wiki/projects|areas|resources|archive`), `inbox/`, `journal/` und die Obsidian-Skills. Du musst diese Basis NICHT neu laden. Deine Aufgabe ist, sie durch ein kurzes Interview zu **personalisieren**.

## Ablauf — stelle die Fragen EINZELN, eine nach der anderen, warte jeweils auf die Antwort

1. Rolle/Beruf: Wer bist du, was machst du? (Hintergrund, Erfahrung)
2. Hauptthemen: 2-3 Fachgebiete/Bereiche.
3. Sprache des Vaults (Deutsch/Englisch/gemischt) und Arbeitsstil (strukturiert vs. kreativ-chaotisch).
4. Projekte: konkrete Vorhaben mit Ziel/Ende.
5. Areas: laufende Verantwortungen ohne Ende (z.B. Akquise, Buchhaltung, Gesundheit). Erklaere kurz den Unterschied zu Projekten.
6. Ressourcen-Themen: wozu sammelst du regelmaessig Wissen.
7. Kontext-Profil (je EINE Frage): Zielgruppe/ICP -> Angebot -> Schreibstil (Duzen/Siezen, Regeln, Vermeiden) -> Branding (Name, Farben, Logo). Bei wenig Input: trotzdem festhalten, kann spaeter ergaenzt werden.

## Wie du Antworten festhaeltst (Tool-Calls, max. EIN Schritt pro Antwort)

- Kontext-Profil-Inhalte via `set_var` (die `kontext/*`-Dateien rendern diese Variablen automatisch). Nutze GENAU diese Keys, mit ausformulierten Saetzen als Wert:
  - ueber-mich: `ueber_mich`, `fachgebiete`, `positionierung`
  - zielgruppe: `zielgruppe`, `zielgruppe_probleme`, `zielgruppe_ziele`, `zielgruppe_hilfe`
  - angebot: `angebot`, `angebot_usp`, `angebot_preise`
  - schreibstil: `schreibstil_ton`, `schreibstil_ansprache`, `schreibstil_regeln`, `schreibstil_vermeiden`
  - branding: `branding_name`, `branding_farben`, `branding_schrift`, `branding_logo`, `branding_sonstiges`
- Fuer jedes genannte Projekt: lege je eine Datei via `propose_file` unter `wiki/projects/<slug>.md` an (Projekte sind einzelne Dateien, kein Unterordner). Nutze die Struktur aus `templates/projekt.md`. Das Frontmatter MUSS diese Pflicht-Keys enthalten: `typ: project`, `titel: <Projektname>`, `status: aktiv`, `zuletzt: <heutiges Datum YYYY-MM-DD>` (dazu `tags: [projekt]`), gefolgt vom Ziel. Pflicht-Frontmatter `typ, titel, status, zuletzt` gilt fuer JEDE wiki-Seite, die du anlegst.
- Fuer jede Area/jedes Ressourcen-Thema: `propose_folder` unter `wiki/areas/<name>` bzw. `wiki/resources/<name>` (kind `bucket`).

## Zusatz-Module anbieten (vor dem Abschluss)

Wenn das Profil steht, biete passende Module an (nutze `list_available_blueprints` fuer die echten Beschreibungen, Kategorie `addon`):
- **Farming** (`karpathy-para-base`) — Wissen aus Quellen (YouTube/Artikel) ins Wiki farmen, Video/Creator/Playlist-Vorlagen + `/ingest /query /farm`.
- **Research** (`researcher`) — Themen/Papers/Fragen mit Tabellen-Ansichten.
- **Lernen** (`karpathy-lerner`) — Ingest/Query-Routinen + Playlist-Trending im Briefing.

Frage kurz: "Moechtest du eines davon dazunehmen?" Bei Ja: `merge_blueprint_template(<id>)` (additiv, nichts wird ueberschrieben). Bei Nein: weiter. Keines aufdraengen.

## Abschluss

- Wenn alles erfasst ist: `preview_diff` aufrufen und dem User die geplante Struktur zeigen.
- ERST wenn der User explizit "fertig", "passt", "commit", "los" sagt: `commit_blueprint(confirm=true)`. **Niemals ohne explizite Bestaetigung.**

Halte Antworten knapp und freundlich. Deutsche Sprache. Stelle echte Fragen als Text — Tool-Calls nur zum Festhalten/Bauen, nicht um Fragen zu stellen."""

_EXTEND_TAIL = """

---

Du erweiterst einen bereits eingerichteten Vault. Working-Blueprint ist der **bestehende** Blueprint des Vaults.

REGELN:
- Nur additiv: keine bestehenden folders/files/bases entfernen.
- Bei CLAUDE.md-Sections: `merge_policy: replace_if_marker` ist OK fuer Updates bestehender Sections — bestehende User-Text-Bereiche ausserhalb der Marker werden vom System sowieso nicht angetastet.
- Bei `propose_folder` mit bekanntem Pfad: warnen, dass das ein No-op ist.
- Du darfst Zusatz-Module anbieten (siehe "Zusatz-Module anbieten") und bei Zustimmung per `merge_blueprint_template(<id>)` additiv erweitern — das ist hier der haeufigste Anwendungsfall ("ich will mein Vault um Farming/Research/Lernen erweitern").

Sonst: alles wie im Fresh-Modus."""


# --- Tool-Schemas (Anthropic-style) --------------------------------------

TOOL_SCHEMAS: list[dict] = [
    {
        "name": "list_available_blueprints",
        "description": "Liefert alle verfuegbaren Blueprint-Templates (builtin + importiert) mit id, name, version, description.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "load_blueprint_template",
        "description": "Ersetzt das Working-Blueprint komplett durch das angegebene Template (mit aufgeloesten extends). Nutze NICHT im Extend-Modus.",
        "input_schema": {
            "type": "object",
            "properties": {
                "blueprint_id": {"type": "string", "description": "ID des Templates, z.B. 'karpathy-para-base'."},
            },
            "required": ["blueprint_id"],
        },
    },
    {
        "name": "merge_blueprint_template",
        "description": "Mergt ein zusaetzliches Template ins Working-Blueprint (Union der folders/files/bases per Pfad, briefing_sources Set-Union, claude_md_sections per id).",
        "input_schema": {
            "type": "object",
            "properties": {
                "blueprint_id": {"type": "string"},
            },
            "required": ["blueprint_id"],
        },
    },
    {
        "name": "propose_folder",
        "description": "Fuegt einen Ordner ins Working-Blueprint. kind: system|raw|bucket|asset|area|journal.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Pfad relativ zum Vault-Root, ohne fuehrendes /."},
                "kind": {"type": "string", "enum": ["system", "raw", "bucket", "asset", "area", "journal"]},
                "label": {"type": "string"},
                "emoji": {"type": "string"},
            },
            "required": ["path", "kind"],
        },
    },
    {
        "name": "propose_file",
        "description": "Fuegt eine Datei (mit Inline-Content) ins Working-Blueprint. merge_policy: skip_if_exists (default) | overwrite | replace_if_marker.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "template_inline": {"type": "string", "description": "Vollstaendiger Datei-Inhalt als Plain-Text. Variable-Interpolation NICHT verfuegbar."},
                "vars": {"type": "object", "description": "Optionale Variablen (werden zurzeit nicht ersetzt, nur gespeichert)."},
                "merge_policy": {"type": "string", "enum": ["skip_if_exists", "overwrite", "replace_if_marker"]},
            },
            "required": ["path", "template_inline"],
        },
    },
    {
        "name": "propose_base_view",
        "description": "Fuegt eine Obsidian-Base-Datei (.base) ins Working-Blueprint.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "title": {"type": "string"},
                "source": {"type": "object", "description": "z.B. {\"folder\": \"wiki/areas/kunden\"}"},
                "filters": {"type": "array", "items": {"type": "object"}},
                "columns": {"type": "array", "items": {"type": "object"}},
                "views": {"type": "array", "items": {"type": "object"}},
            },
            "required": ["path", "source", "columns", "views"],
        },
    },
    {
        "name": "extend_claude_md",
        "description": "Fuegt eine CLAUDE.md-Section ins Working-Blueprint (per Marker-Merger).",
        "input_schema": {
            "type": "object",
            "properties": {
                "section_id": {"type": "string"},
                "order": {"type": "integer"},
                "title": {"type": "string"},
                "content": {"type": "string"},
                "merge_policy": {"type": "string", "enum": ["replace_if_marker", "skip_if_exists"]},
            },
            "required": ["section_id", "order", "content"],
        },
    },
    {
        "name": "add_briefing_source",
        "description": "Aktiviert eine Briefing-Source (z.B. wetter, todos, youtube_trending). Set-Union, doppelt = No-op.",
        "input_schema": {
            "type": "object",
            "properties": {
                "source_name": {"type": "string"},
            },
            "required": ["source_name"],
        },
    },
    {
        "name": "set_var",
        "description": "Setzt eine Variable im Working-Blueprint (vars[key]=value). Beispiel: owner_name, branche.",
        "input_schema": {
            "type": "object",
            "properties": {
                "key": {"type": "string"},
                "value": {"description": "Beliebiger Wert (string, number, bool, object, array)."},
            },
            "required": ["key", "value"],
        },
    },
    {
        "name": "preview_diff",
        "description": "Zeigt was beim Commit angelegt/geskippt wuerde. Sollte vor jedem commit_blueprint gerufen werden.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "commit_blueprint",
        "description": "Fordert den Commit an. WICHTIG: confirm=true erforderlich. Tool fuehrt den Commit NICHT selbst aus — es markiert die Session nur als 'pending'. Den eigentlichen Commit triggert der User via separaten Endpoint-Klick. Nach Aufruf NICHT weiter Tools rufen, sondern dem User sagen: 'Bestaetige durch Klick auf den Commit-Button.'",
        "input_schema": {
            "type": "object",
            "properties": {
                "confirm": {"type": "boolean", "description": "MUSS true sein. Sonst Fehler."},
            },
            "required": ["confirm"],
        },
    },
]


# --- Session-State-Persistenz --------------------------------------------

def _session_path(session_id: str) -> Path:
    return SESSIONS_DIR / f"{session_id}.json"


def _save_session(state: dict) -> None:
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    state["updated_at"] = datetime.utcnow().isoformat()
    path = _session_path(state["session_id"])
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def _load_session(session_id: str) -> dict:
    path = _session_path(session_id)
    if not path.exists():
        raise SetupAgentError(f"Session {session_id} nicht gefunden")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        raise SetupAgentError(f"Session {session_id} kaputt: {e}") from None


def cleanup_expired(ttl_hours: int = 24) -> int:
    if not SESSIONS_DIR.exists():
        return 0
    cutoff = time.time() - (ttl_hours * 3600)
    removed = 0
    for p in SESSIONS_DIR.glob("*.json"):
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
                removed += 1
        except OSError:
            pass
    return removed


# --- Backend-Wahl (eigenes Provider/Model fuer Setup) --------------------

def _effective_setup_config() -> tuple[str, str]:
    """Returns (provider, model). Leere setup_agent_* fallen auf Standard-LLM zurueck."""
    provider = (settings.get("setup_agent_provider") or "").strip().lower()
    model = (settings.get("setup_agent_model") or "").strip()
    if not provider or not model:
        return llm_client.effective_llm_config()
    return provider, model


def _get_setup_backend() -> LLMBackend:
    """Eigenes Backend wenn setup_agent_provider != aktiver Standard-Provider, sonst Standard.

    Logik analog zu llm_client.get_backend(), aber gegen setup_agent_provider.
    """
    provider, _ = _effective_setup_config()
    standard_provider, _ = llm_client.effective_llm_config()
    if provider == standard_provider:
        return llm_client.get_backend()

    if provider == "anthropic":
        api_key = settings.get("anthropic_api_key")
        if not api_key:
            raise ValueError("Setup-Agent: kein Anthropic-API-Key")
        return AnthropicBackend(api_key=api_key)
    if provider == "openai":
        api_key = settings.get("openai_api_key")
        if not api_key:
            raise ValueError("Setup-Agent: kein OpenAI-API-Key")
        return OpenAIBackend(api_key=api_key)
    if provider == "ollama":
        base_url = settings.get("ollama_base_url") or "http://localhost:11434"
        return OllamaBackend(base_url=base_url)
    if provider == "mistral":
        api_key = settings.get("mistral_api_key")
        if not api_key:
            raise ValueError("Setup-Agent: kein Mistral-API-Key")
        return OpenAIBackend(api_key=api_key, base_url="https://api.mistral.ai/v1")
    if provider == "openrouter":
        api_key = settings.get("openrouter_api_key")
        if not api_key:
            raise ValueError("Setup-Agent: kein OpenRouter-API-Key")
        base_url = settings.get("openrouter_base_url") or "https://openrouter.ai/api/v1"
        return OpenAIBackend(api_key=api_key, base_url=base_url)

    log.warning("Setup-Agent: unbekannter Provider '%s' — Fallback Anthropic", provider)
    api_key = settings.get("anthropic_api_key")
    if not api_key:
        raise ValueError(f"Setup-Agent: Provider '{provider}' unbekannt und kein Anthropic-Fallback-Key")
    return AnthropicBackend(api_key=api_key)


# --- Helpers --------------------------------------------------------------

def _empty_blueprint() -> dict:
    return {
        "schema_version": "1.0",
        "blueprint_id": "setup-working",
        "blueprint_name": "Working Blueprint",
        "blueprint_version": "0.0.1",
        "extends": [],
        "folders": [],
        "files": [],
        "bases": [],
        "claude_md_sections": [],
        "briefing_sources": [],
        "skills": [],
        "commands": [],
        "vars": {},
    }


def _load_template_resolved(blueprint_id: str) -> dict:
    """Built-in oder importiert, dann extends aufloesen."""
    try:
        bp = blueprint_tool.load_builtin(blueprint_id)
    except blueprint_tool.BlueprintError:
        bp = blueprint_tool.load_imported(blueprint_id)
        if bp is None:
            raise blueprint_tool.BlueprintError(f"Blueprint nicht gefunden: {blueprint_id}")
    return blueprint_tool.resolve_extends(bp)


def _merge_into_working(working: dict, addition: dict) -> dict:
    """Mergt `addition` in `working` (additiv). Nutzt die gleichen Merge-Regeln wie resolve_extends.

    Implementiert hier inline (nicht ueber blueprint._merge_blueprints, weil das private API ist) —
    fuer den Setup-Loop reicht eine einfache Union-Variante.
    """
    out = dict(working)

    def _union_by_key(parent: list, child: list, key: str) -> list:
        seen: dict[str, int] = {}
        result: list = []
        for item in (parent or []):
            k = item.get(key)
            if k is None:
                continue
            seen[k] = len(result)
            result.append(dict(item))
        for item in (child or []):
            k = item.get(key)
            if k is None:
                continue
            if k in seen:
                result[seen[k]] = dict(item)
            else:
                seen[k] = len(result)
                result.append(dict(item))
        return result

    out["folders"] = _union_by_key(working.get("folders") or [], addition.get("folders") or [], "path")
    out["files"] = _union_by_key(working.get("files") or [], addition.get("files") or [], "path")
    out["bases"] = _union_by_key(working.get("bases") or [], addition.get("bases") or [], "path")
    out["claude_md_sections"] = _union_by_key(
        working.get("claude_md_sections") or [], addition.get("claude_md_sections") or [], "id"
    )

    src_seen: set[str] = set()
    merged_src: list[str] = []
    for s in (working.get("briefing_sources") or []) + (addition.get("briefing_sources") or []):
        if s not in src_seen:
            src_seen.add(s)
            merged_src.append(s)
    out["briefing_sources"] = merged_src

    sk_seen: set[str] = set()
    merged_sk: list[str] = []
    for s in (working.get("skills") or []) + (addition.get("skills") or []):
        if s not in sk_seen:
            sk_seen.add(s)
            merged_sk.append(s)
    out["skills"] = merged_sk

    cmd_seen: set[str] = set()
    merged_cmd: list[str] = []
    for c in (working.get("commands") or []) + (addition.get("commands") or []):
        if c not in cmd_seen:
            cmd_seen.add(c)
            merged_cmd.append(c)
    out["commands"] = merged_cmd

    out["vars"] = {**(working.get("vars") or {}), **(addition.get("vars") or {})}
    return out


def _upsert_by_key(items: list[dict], new_item: dict, key: str) -> tuple[list[dict], bool]:
    """Returns (new_list, was_overwrite)."""
    out = []
    overwritten = False
    found = False
    for it in items:
        if it.get(key) == new_item.get(key):
            out.append(new_item)
            found = True
            overwritten = True
        else:
            out.append(it)
    if not found:
        out.append(new_item)
    return out, overwritten


def _build_system_prompt(state: dict) -> list[dict]:
    """Anthropic-style system mit Cache-Control."""
    text = _FRESH_PROMPT
    if state.get("mode") == "extend":
        text = text + _EXTEND_TAIL
    return [{"type": "text", "text": text}]


def _block_to_input(block: Any) -> dict:
    """Convert response content block -> input-safe dict."""
    t = getattr(block, "type", None)
    if t == "text":
        return {"type": "text", "text": getattr(block, "text", "")}
    if t == "tool_use":
        return {
            "type": "tool_use",
            "id": block.id,
            "name": block.name,
            "input": block.input,
        }
    if t == "thinking":
        out = {"type": "thinking", "thinking": getattr(block, "thinking", "")}
        sig = getattr(block, "signature", None)
        if sig:
            out["signature"] = sig
        return out
    # Fallback
    if hasattr(block, "model_dump"):
        d = block.model_dump()
        for k in ("parsed_output", "caller"):
            d.pop(k, None)
        return d
    return {"type": str(t or "unknown")}


def _extract_text(content: list[Any]) -> str:
    parts = []
    for b in content:
        if getattr(b, "type", None) == "text":
            parts.append(getattr(b, "text", ""))
    return "".join(parts).strip()


# --- Tool-Execution -------------------------------------------------------

def _execute_tool(state: dict, name: str, tool_input: dict) -> dict:
    """Mutiert state["working_blueprint"] (oder state-Flags). Liefert dict fuer Tool-Result-Content."""
    working = state["working_blueprint"]
    vault_id = state["vault_id"]

    if name == "list_available_blueprints":
        return {"blueprints": blueprint_tool.list_available()}

    if name == "load_blueprint_template":
        bid = tool_input.get("blueprint_id", "")
        if not bid:
            raise ValueError("blueprint_id fehlt")
        resolved = _load_template_resolved(bid)
        # Identitaet vom Working uebernehmen, Inhalt vom Template
        new_working = dict(resolved)
        new_working["blueprint_id"] = working.get("blueprint_id") or "setup-working"
        new_working["blueprint_name"] = working.get("blueprint_name") or "Working Blueprint"
        new_working["blueprint_version"] = working.get("blueprint_version") or "0.0.1"
        new_working["extends"] = []
        state["working_blueprint"] = new_working
        return {
            "ok": True,
            "loaded": bid,
            "folders": len(new_working.get("folders") or []),
            "files": len(new_working.get("files") or []),
            "bases": len(new_working.get("bases") or []),
        }

    if name == "merge_blueprint_template":
        bid = tool_input.get("blueprint_id", "")
        if not bid:
            raise ValueError("blueprint_id fehlt")
        addition = _load_template_resolved(bid)
        state["working_blueprint"] = _merge_into_working(working, addition)
        applied = state.setdefault("templates", [])
        if bid not in applied:
            applied.append(bid)
        return {"ok": True, "merged": bid}

    if name == "propose_folder":
        path = tool_input.get("path", "")
        if not path:
            raise ValueError("path fehlt")
        new_item = {
            "path": path,
            "kind": tool_input.get("kind", "bucket"),
        }
        if tool_input.get("label"):
            new_item["label"] = tool_input["label"]
        if tool_input.get("emoji"):
            new_item["emoji"] = tool_input["emoji"]
        items, overwrote = _upsert_by_key(working.get("folders") or [], new_item, "path")
        working["folders"] = items
        warn = f"WARN: Pfad '{path}' war schon im Working — wurde ueberschrieben." if overwrote else None
        return {"ok": True, "warning": warn}

    if name == "propose_file":
        path = tool_input.get("path", "")
        inline = tool_input.get("template_inline")
        if not path or inline is None:
            raise ValueError("path und template_inline erforderlich")
        new_item = {
            "path": path,
            "template_inline": inline,
            "merge_policy": tool_input.get("merge_policy", "skip_if_exists"),
        }
        if tool_input.get("vars"):
            new_item["vars"] = tool_input["vars"]
        items, overwrote = _upsert_by_key(working.get("files") or [], new_item, "path")
        working["files"] = items
        return {"ok": True, "overwrote": overwrote}

    if name == "propose_base_view":
        path = tool_input.get("path", "")
        if not path:
            raise ValueError("path fehlt")
        new_item = {
            "path": path,
            "source": tool_input.get("source") or {},
            "columns": tool_input.get("columns") or [],
            "views": tool_input.get("views") or [],
        }
        if tool_input.get("title"):
            new_item["title"] = tool_input["title"]
        if tool_input.get("filters"):
            new_item["filters"] = tool_input["filters"]
        items, overwrote = _upsert_by_key(working.get("bases") or [], new_item, "path")
        working["bases"] = items
        return {"ok": True, "overwrote": overwrote}

    if name == "extend_claude_md":
        sid = tool_input.get("section_id", "")
        if not sid:
            raise ValueError("section_id fehlt")
        new_item = {
            "id": sid,
            "order": int(tool_input.get("order", 50)),
            "content": tool_input.get("content", ""),
            "merge_policy": tool_input.get("merge_policy", "replace_if_marker"),
        }
        if tool_input.get("title"):
            new_item["title"] = tool_input["title"]
        items, overwrote = _upsert_by_key(working.get("claude_md_sections") or [], new_item, "id")
        working["claude_md_sections"] = items
        return {"ok": True, "overwrote": overwrote}

    if name == "add_briefing_source":
        src = tool_input.get("source_name", "")
        if not src:
            raise ValueError("source_name fehlt")
        srcs = list(working.get("briefing_sources") or [])
        if src in srcs:
            return {"ok": True, "noop": True, "message": f"'{src}' war schon aktiv"}
        srcs.append(src)
        working["briefing_sources"] = srcs
        return {"ok": True}

    if name == "set_var":
        k = tool_input.get("key", "")
        if not k:
            raise ValueError("key fehlt")
        vars_dict = dict(working.get("vars") or {})
        vars_dict[k] = tool_input.get("value")
        working["vars"] = vars_dict
        return {"ok": True}

    if name == "preview_diff":
        diff = blueprint_tool.preview(vault_id, working)
        state["last_diff_preview"] = diff
        state["diff_preview_seen"] = True
        return diff

    if name == "commit_blueprint":
        if not tool_input.get("confirm"):
            raise ValueError("confirm muss true sein")
        state["pending_commit"] = True
        return {
            "ok": True,
            "message": "Commit angefordert. Server fuehrt erst nach explizitem User-Klick auf den Commit-Button aus. NICHT weiter Tools aufrufen — dem User sagen: 'Bestaetige durch Klick auf den Commit-Button.'",
        }

    raise ValueError(f"Unbekanntes Tool: {name}")


# --- Public API -----------------------------------------------------------

# --- Reverse-Blueprint: Struktur aus bestehendem Fremd-Vault ableiten -------

_INFER_IGNORE = {".git", ".obsidian", ".ewtosbrain", ".trash", "node_modules", "__pycache__"}
_INFER_KIND_BY_NAME = {"inbox": "system", "raw": "raw", "journal": "journal"}
_FM_KEY_RE = re.compile(r"^([A-Za-z_][\w-]*)\s*:", re.MULTILINE)


def _vault_is_empty(vault_path: Path) -> bool:
    """True, wenn der Vault-Root keine inhaltlichen Eintraege hat (versteckte/
    ignorierte Ordner wie .obsidian zaehlen nicht). Ein solcher Ordner, der als
    'bestehend' verbunden wurde, wird wie ein frischer Vault behandelt — sonst
    entstaende ein leeres Vault ohne OS-Schicht (CLAUDE.md, index, kontext, Skills)."""
    try:
        for p in vault_path.iterdir():
            if p.name in _INFER_IGNORE or p.name.startswith("."):
                continue
            return False
    except OSError:
        return False
    return True


def _frontmatter_keys(text: str) -> set[str]:
    if not text.startswith("---"):
        return set()
    end = text.find("\n---", 3)
    if end == -1:
        return set()
    return set(_FM_KEY_RE.findall(text[3:end]))


def _detect_required_frontmatter(vault_path: Path) -> list[str]:
    """Schnittmenge der Top-Level-Frontmatter-Keys über die wiki/-Seiten = die
    tatsächlich gelebte Konvention des Vaults (Stichprobe max. 80 Seiten)."""
    wiki = vault_path / "wiki"
    if not wiki.exists():
        return []
    key_sets: list[set[str]] = []
    for p in wiki.rglob("*.md"):
        if p.name == "index.md":
            continue
        if any(part.startswith(".") for part in p.relative_to(vault_path).parts):
            continue
        try:
            keys = _frontmatter_keys(p.read_text(encoding="utf-8"))
        except Exception:
            keys = set()
        if keys:
            key_sets.append(keys)
        if len(key_sets) >= 80:
            break
    if not key_sets:
        return []
    common = set(key_sets[0])
    for ks in key_sets[1:]:
        common &= ks
    return sorted(common)


def _infer_blueprint_from_disk(vault_path: Path) -> dict:
    """Baut ein Working-Blueprint aus der vorhandenen Vault-Struktur (Fremd-Vault
    ohne Snapshot): vorhandene Ordner (Top-Level + eine Ebene tiefer) + gelebte
    Frontmatter-Keys. KEINE files/claude_md_sections → commit scaffoldet nichts
    drüber, CLAUDE.md bleibt unberührt."""
    bp = _empty_blueprint()
    bp["blueprint_id"] = "inferred"
    bp["blueprint_name"] = "Abgeleitet von bestehender Struktur"
    bp["description"] = "Aus der vorhandenen Vault-Struktur abgeleitet (extend-Modus, Fremd-Vault)."

    folders: list[dict] = []
    seen: set[str] = set()

    def _add(rel: str, name: str) -> None:
        if rel in seen:
            return
        seen.add(rel)
        entry: dict = {"path": rel}
        kind = _INFER_KIND_BY_NAME.get(name)
        if kind:
            entry["kind"] = kind
        folders.append(entry)

    try:
        top = sorted(
            (p for p in vault_path.iterdir()
             if p.is_dir() and p.name not in _INFER_IGNORE and not p.name.startswith(".")),
            key=lambda p: p.name,
        )
    except OSError:
        top = []
    for d in top:
        _add(d.name, d.name)
        try:
            subs = sorted(
                (p for p in d.iterdir() if p.is_dir() and not p.name.startswith(".")),
                key=lambda p: p.name,
            )
        except OSError:
            subs = []
        for sub in subs:
            _add(f"{d.name}/{sub.name}", sub.name)

    bp["folders"] = folders
    fm = _detect_required_frontmatter(vault_path)
    if fm:
        bp["vars"] = {**(bp.get("vars") or {}), "frontmatter_required": fm}
    return bp


def start_session(
    vault_id: str,
    *,
    mode: str = "fresh",
    templates: list[str] | None = None,
    use_case_hint: str | None = None,
) -> dict:
    if mode not in ("fresh", "extend"):
        raise SetupAgentError(f"Unbekannter Mode: {mode}")
    if not settings.get_vault(vault_id):
        raise SetupAgentError(f"Vault nicht gefunden: {vault_id}")

    cleanup_expired()

    session_id = uuid.uuid4().hex
    now = datetime.utcnow().isoformat()

    inferred = False
    if mode == "extend":
        existing = blueprint_tool.export_vault_blueprint(vault_id)
        if existing:
            working = dict(existing)
        else:
            vault_path = Path(settings.get_vault(vault_id)["path"])
            if _vault_is_empty(vault_path):
                # Leerer Ordner als "bestehend" verbunden → wie fresh behandeln,
                # sonst entstaende ein leeres Vault ohne OS-Schicht.
                mode = "fresh"
            else:
                # Befuellter Fremd-Vault ohne Snapshot: echte Struktur ableiten
                # statt PARA aufzwingen.
                working = _infer_blueprint_from_disk(vault_path)
                inferred = True

    if mode == "fresh":
        if not templates:
            templates = ["kontext-base"]
        working = _empty_blueprint()
        for tid in templates:
            try:
                addition = _load_template_resolved(tid)
                working = _merge_into_working(working, addition)
            except blueprint_tool.BlueprintError as e:
                log.warning("Template '%s' nicht ladbar: %s", tid, e)

    opener_bits = []
    if inferred:
        nf = len(working.get("folders") or [])
        fmk = (working.get("vars") or {}).get("frontmatter_required") or []
        intro = f"Hi — ich habe deinen bestehenden Vault eingelesen: {nf} vorhandene Ordner"
        if fmk:
            intro += f", Frontmatter-Konvention {', '.join(fmk)}"
        opener_bits.append(intro + ".")
        opener_bits.append("Ich erweitere nur additiv und scaffolde NICHTS über deine Struktur. Was soll dazukommen? (neue Kategorie, Ordner, Briefing-Quelle …)")
    elif mode == "fresh":
        opener_bits.append("Hi — ich richte dir per kurzem Interview dein Zweites Gehirn ein (Kontext-Profil + PARA + Obsidian-Skills).")
        if templates and templates != ["kontext-base"]:
            opener_bits.append(f"Zusatz-Bausteine: {', '.join(t for t in templates if t != 'kontext-base')}.")
        opener_bits.append("Erste Frage: Wer bist du und was machst du beruflich? Erzaehl ruhig etwas zu Hintergrund und Erfahrung.")
    else:
        opener_bits.append("Hi — wir erweitern deinen bestehenden Vault. Nur additiv, nichts wird geloescht.")
        opener_bits.append("Was soll ergaenzt werden? (neuer Mitarbeiter-Ordner, neue Kategorie, Briefing-Source …)")

    if use_case_hint:
        opener_bits.append(f"(Dein Hint: {use_case_hint})")

    opening = " ".join(opener_bits)

    state = {
        "session_id": session_id,
        "vault_id": vault_id,
        "mode": mode,
        "created_at": now,
        "updated_at": now,
        "working_blueprint": working,
        "templates": [t for t in (templates or []) if t],
        "message_log": [
            {
                "role": "assistant",
                "content": [{"type": "text", "text": opening}],
            }
        ],
        "committed": False,
        "commit_result": None,
        "last_diff_preview": None,
        "diff_preview_seen": False,
        "pending_commit": False,
    }
    if use_case_hint:
        state["use_case_hint"] = use_case_hint

    _save_session(state)

    return {
        "session_id": session_id,
        "working_blueprint": working,
        "mode": mode,
        "opening_assistant_message": opening,
    }


def send_message(session_id: str, message: str) -> dict:
    state = _load_session(session_id)
    if state.get("committed"):
        raise SetupAgentError("Session wurde bereits committed")

    message = (message or "").strip()
    if not message:
        raise SetupAgentError("Leere Nachricht")

    backend = _get_setup_backend()
    _, model = _effective_setup_config()
    if not model:
        raise SetupAgentError("Setup-Agent: kein Model konfiguriert (setup_agent_model leer und Standard-LLM unset)")

    api_messages: list[dict] = list(state["message_log"])
    api_messages.append({"role": "user", "content": message})

    collected_tool_calls: list[dict] = []
    final_response = None

    for iteration in range(MAX_TOOL_ITERATIONS):
        response = backend.complete(
            model=model,
            messages=api_messages,
            system=_build_system_prompt(state),
            tools=TOOL_SCHEMAS,
            max_tokens=MAX_TOKENS,
        )
        final_response = response
        api_messages.append({
            "role": "assistant",
            "content": [_block_to_input(b) for b in response.content],
        })

        if response.stop_reason != "tool_use":
            break

        tool_results: list[dict] = []
        for block in response.content:
            if getattr(block, "type", None) != "tool_use":
                continue
            tool_name = block.name
            tool_input = block.input or {}
            try:
                result = _execute_tool(state, tool_name, tool_input)
                content_str = json.dumps(result, ensure_ascii=False, default=str)
                is_error = False
            except Exception as e:
                log.exception("Tool '%s' fehlgeschlagen", tool_name)
                content_str = f"ERROR: {e}"
                result = {"error": str(e)}
                is_error = True
            collected_tool_calls.append({
                "name": tool_name,
                "input": tool_input,
                "result": result,
                "is_error": is_error,
            })
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": content_str,
                "is_error": is_error,
            })

        api_messages.append({"role": "user", "content": tool_results})
        # Persistiere nach jedem Loop-Schritt
        state["message_log"] = api_messages
        _save_session(state)
    else:
        # Loop voll ausgeschoepft ohne Break -> hard-stop
        log.warning("Setup-Agent: Tool-Loop hat MAX_TOOL_ITERATIONS=%d erreicht", MAX_TOOL_ITERATIONS)

    state["message_log"] = api_messages
    _save_session(state)

    reply_text = _extract_text(final_response.content) if final_response else ""
    if not reply_text:
        reply_text = "(keine Textantwort)"

    return {
        "reply": reply_text,
        "tool_calls": collected_tool_calls,
        "working_blueprint": state["working_blueprint"],
        "diff_preview": state.get("last_diff_preview"),
        "pending_commit": bool(state.get("pending_commit")),
    }


def get_state(session_id: str) -> dict:
    state = _load_session(session_id)
    return state


def commit(session_id: str) -> dict:
    state = _load_session(session_id)
    if state.get("committed"):
        # Idempotent: liefere altes Ergebnis zurueck
        return {"already_committed": True, **(state.get("commit_result") or {})}

    if not state.get("diff_preview_seen"):
        raise SetupAgentError(
            "Commit verweigert: erst preview_diff durchlaufen lassen (Defense-in-Depth)."
        )

    vault_id = state["vault_id"]
    working = state["working_blueprint"]

    result = blueprint_tool.commit(vault_id, working)
    applied = [t for t in (state.get("templates") or []) if t] or ["kontext-base"]
    settings.add_applied_blueprints(vault_id, applied)

    state["committed"] = True
    state["commit_result"] = result
    state["pending_commit"] = False
    _save_session(state)
    return result


# --- Verifikation ---------------------------------------------------------

if __name__ == "__main__":
    import sys

    print("== Setup-Agent Verifikation ==")
    vaults = settings.get_vaults()
    if not vaults:
        print("Keine Vaults in settings.json — bitte zuerst einen anlegen.")
        sys.exit(0)

    vault = vaults[0]
    print(f"Vault: {vault['id']} ({vault['name']}) @ {vault['path']}")

    res = start_session(
        vault["id"],
        mode="fresh",
        templates=["karpathy-para-base"],
        use_case_hint="Demo-Verifikation",
    )
    print(f"session_id: {res['session_id']}")
    print(f"folders in working: {len(res['working_blueprint'].get('folders') or [])}")
    print(f"files in working:   {len(res['working_blueprint'].get('files') or [])}")
    print(f"opening: {res['opening_assistant_message'][:100]}...")
    print("\n(send_message-Demo geskippt — kein API-Key noetig fuer diese Verifikation.)")
    sys.exit(0)
