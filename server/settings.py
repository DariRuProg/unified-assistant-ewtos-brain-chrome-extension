"""Runtime settings persisted in settings.json next to main.py.

Schema:
    {
      "anthropic_api_key": "...",      // secret, write-only via API
      "chat_model": "claude-opus-4-7",
      "max_user_turns": 20,
      "vaults": [
        {"id": "a3f29b7c", "name": "Karpathy-Wiki",
         "path": "E:\\...", "system_prompt": "Du bist..."}
      ]
    }
"""
from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any

import config

SETTINGS_FILE = Path(__file__).parent / "settings.json"
EDITABLE_KEYS = {
    "anthropic_api_key",
    "chat_model",
    "max_user_turns",
    "llm_provider",
    "llm_model",
    "openai_api_key",
    "ollama_base_url",
    "mistral_api_key",
    "gemini_api_key",
    "image_gen_model",
}
SECRET_KEYS = {"anthropic_api_key", "openai_api_key", "mistral_api_key", "gemini_api_key"}
SECRET_ENV_MAP = {
    "anthropic_api_key": "ANTHROPIC_API_KEY",
    "openai_api_key": "OPENAI_API_KEY",
    "mistral_api_key": "MISTRAL_API_KEY",
    "gemini_api_key": "GEMINI_API_KEY",
}

_cache: dict[str, Any] | None = None


def _load_from_disk() -> dict[str, Any]:
    if not SETTINGS_FILE.exists():
        return {}
    try:
        return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _flush() -> None:
    global _cache
    if _cache is None:
        return
    tmp = SETTINGS_FILE.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(_cache, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    tmp.replace(SETTINGS_FILE)


def all() -> dict[str, Any]:
    global _cache
    if _cache is None:
        _cache = _load_from_disk()
    return dict(_cache)


def get(key: str, default: Any = None) -> Any:
    env_var = SECRET_ENV_MAP.get(key)
    if env_var:
        env_val = os.getenv(env_var)
        if env_val:
            return env_val
    return all().get(key, default)


def update(values: dict[str, Any]) -> dict[str, Any]:
    global _cache
    current = all()
    filtered = {k: v for k, v in values.items() if k in EDITABLE_KEYS and v}
    current.update(filtered)
    _cache = current
    _flush()
    return dict(current)


# --- Vaults ----------------------------------------------------------------

def _normalize_vault(v: dict[str, Any]) -> dict[str, Any]:
    """Backwards-Compat: setze `use_local_notes` default False, wenn fehlt.
    So bleiben bestehende Vaults beim globalen Notes-Pfad."""
    out = dict(v)
    if "use_local_notes" not in out:
        out["use_local_notes"] = False
    else:
        out["use_local_notes"] = bool(out["use_local_notes"])
    return out


def get_vaults() -> list[dict[str, Any]]:
    return [_normalize_vault(v) for v in (all().get("vaults") or [])]


def get_vault(vault_id: str) -> dict[str, Any] | None:
    for v in get_vaults():
        if v.get("id") == vault_id:
            return dict(v)
    return None


def _new_id() -> str:
    return uuid.uuid4().hex[:8]


DEFAULT_VAULT_PERMISSIONS = {"write_raw": False, "write_playlists": False}

DEFAULT_BRIEFING_PROFILES = [
    {
        "id": "default",
        "name": "Morgen-Briefing",
        "sources": ["wetter", "todos", "fristen", "lernstreak"],
        "standorte": ["Paderborn"],
    }
]


def add_vault(
    name: str,
    path: str,
    system_prompt: str = "",
    use_local_notes: bool | None = None,
) -> dict[str, Any]:
    global _cache
    current = all()
    vaults = list(current.get("vaults") or [])
    vault = {
        "id": _new_id(),
        "name": name.strip(),
        "path": path.strip(),
        "system_prompt": system_prompt or "",
        "permissions": dict(DEFAULT_VAULT_PERMISSIONS),
        # NEUE Vaults default True — bestehende Vaults bleiben unverändert (False
        # via _normalize_vault, da Feld dort fehlt).
        "use_local_notes": True if use_local_notes is None else bool(use_local_notes),
    }
    vaults.append(vault)
    current["vaults"] = vaults
    _cache = current
    _flush()
    return dict(vault)


def update_vault(vault_id: str, **fields: Any) -> dict[str, Any] | None:
    global _cache
    current = all()
    vaults = list(current.get("vaults") or [])
    for i, v in enumerate(vaults):
        if v.get("id") == vault_id:
            updated = dict(v)
            for k in ("name", "path", "system_prompt"):
                if k in fields and fields[k] is not None:
                    updated[k] = fields[k]
            if "use_local_notes" in fields and fields["use_local_notes"] is not None:
                updated["use_local_notes"] = bool(fields["use_local_notes"])
            if "permissions" in fields and fields["permissions"] is not None:
                merged = dict(DEFAULT_VAULT_PERMISSIONS)
                merged.update(updated.get("permissions") or {})
                merged.update(fields["permissions"])
                updated["permissions"] = merged
            vaults[i] = updated
            current["vaults"] = vaults
            _cache = current
            _flush()
            return dict(updated)
    return None


def vault_notes_dir(vault_id: str | None) -> Path:
    """Liefert das Notes-Verzeichnis für einen Vault.

    - vault_id None → globaler `notes_path` aus Settings/Config.
    - vault gefunden + use_local_notes=True → `<vault.path>/inbox/` (PARA-Schema, neu)
      oder `<vault.path>/notes/` (Legacy-Schema, falls inbox/ nicht existiert).
    - vault nicht gefunden ODER use_local_notes=False → globaler Pfad (Fallback).

    Legt den Pfad bei Bedarf an. Neue Vaults bekommen `inbox/` über den Scaffold-
    Endpoint; bestehende Vaults behalten ihr `notes/`-Verzeichnis.
    """
    if vault_id:
        v = get_vault(vault_id)
        if v and v.get("use_local_notes"):
            vault_root = Path(v["path"])
            inbox = vault_root / "inbox"
            legacy_notes = vault_root / "notes"
            # Prefer existing dir; default to inbox/ for new vaults.
            if legacy_notes.exists() and not inbox.exists():
                p = legacy_notes
            else:
                p = inbox
            p.mkdir(parents=True, exist_ok=True)
            return p
    p = Path(get("notes_path") or config.NOTES_PATH)
    p.mkdir(parents=True, exist_ok=True)
    return p


def vault_permission(vault_id: str, key: str) -> bool:
    v = get_vault(vault_id)
    if not v:
        return False
    perms = v.get("permissions") or {}
    return bool(perms.get(key, DEFAULT_VAULT_PERMISSIONS.get(key, False)))


def remove_vault(vault_id: str) -> bool:
    global _cache
    current = all()
    vaults = list(current.get("vaults") or [])
    new_vaults = [v for v in vaults if v.get("id") != vault_id]
    if len(new_vaults) == len(vaults):
        return False
    current["vaults"] = new_vaults
    _cache = current
    _flush()
    return True


def migrate_legacy_vault_path(default_chat_file: Path) -> dict[str, Any] | None:
    """If old `vault_path` exists and no `vaults` list, create one entry and
    rename the legacy chat.json. Returns the new vault dict, or None if no
    migration was needed."""
    global _cache
    current = all()
    if current.get("vaults"):
        return None
    legacy_path = current.get("vault_path")
    if not legacy_path:
        return None
    name = Path(legacy_path).name or "Default"
    vault = {
        "id": _new_id(),
        "name": name,
        "path": legacy_path,
        "system_prompt": "",
    }
    current["vaults"] = [vault]
    current.pop("vault_path", None)
    _cache = current
    _flush()
    new_chat_file = default_chat_file.parent / f"chat-{vault['id']}.json"
    if default_chat_file.exists() and not new_chat_file.exists():
        try:
            default_chat_file.rename(new_chat_file)
        except Exception:
            pass
    return dict(vault)
