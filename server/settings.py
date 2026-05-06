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
import uuid
from pathlib import Path
from typing import Any

SETTINGS_FILE = Path(__file__).parent / "settings.json"
EDITABLE_KEYS = {"anthropic_api_key", "chat_model", "max_user_turns"}
SECRET_KEYS = {"anthropic_api_key"}

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
    SETTINGS_FILE.write_text(
        json.dumps(_cache, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def all() -> dict[str, Any]:
    global _cache
    if _cache is None:
        _cache = _load_from_disk()
    return dict(_cache)


def get(key: str, default: Any = None) -> Any:
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

def get_vaults() -> list[dict[str, Any]]:
    return list(all().get("vaults") or [])


def get_vault(vault_id: str) -> dict[str, Any] | None:
    for v in get_vaults():
        if v.get("id") == vault_id:
            return dict(v)
    return None


def _new_id() -> str:
    return uuid.uuid4().hex[:8]


def add_vault(name: str, path: str, system_prompt: str = "") -> dict[str, Any]:
    global _cache
    current = all()
    vaults = list(current.get("vaults") or [])
    vault = {
        "id": _new_id(),
        "name": name.strip(),
        "path": path.strip(),
        "system_prompt": system_prompt or "",
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
            vaults[i] = updated
            current["vaults"] = vaults
            _cache = current
            _flush()
            return dict(updated)
    return None


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
