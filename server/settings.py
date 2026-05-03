"""Runtime settings persisted in settings.json next to main.py."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

SETTINGS_FILE = Path(__file__).parent / "settings.json"
EDITABLE_KEYS = {"notes_path"}

_cache: dict[str, Any] | None = None


def _load_from_disk() -> dict[str, Any]:
    if not SETTINGS_FILE.exists():
        return {}
    try:
        return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


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
    SETTINGS_FILE.write_text(
        json.dumps(current, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return dict(current)
