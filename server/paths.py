# @author Dario | ewtos.com
"""Zentrale Pfad-Aufloesung — bundle-aware (PyInstaller) + User-Datenverzeichnis.

Read-only Assets (Schemas, Templates, Trust-Anchor) liegen im Bundle
(bundle_dir()). Alle Laufzeit-Schreibpfade (settings.json, Chats, Sessions,
generierte Bilder, .env, Logs) liegen im User-Datenverzeichnis (data_dir()),
damit eine in Program Files installierte .exe ohne Admin-Rechte schreiben kann.
"""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

APP_NAME = "EwtosBrain"


def is_frozen() -> bool:
    return getattr(sys, "frozen", False)


def bundle_dir() -> Path:
    """Verzeichnis der gebuendelten Code-/Asset-Dateien."""
    if is_frozen():
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return Path(__file__).parent


def data_dir() -> Path:
    """User-beschreibbares Datenverzeichnis, wird angelegt."""
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    else:
        base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    root = Path(base) / APP_NAME
    root.mkdir(parents=True, exist_ok=True)
    return root


# --- Schreibpfade (data_dir) ----------------------------------------------

def settings_file() -> Path:
    return data_dir() / "settings.json"


def env_file() -> Path:
    return data_dir() / ".env"


def chat_dir() -> Path:
    return data_dir()


def sessions_dir() -> Path:
    return data_dir() / "setup_sessions"


def generated_images_dir() -> Path:
    return data_dir() / "generated_images"


def logs_dir() -> Path:
    p = data_dir() / "logs"
    p.mkdir(parents=True, exist_ok=True)
    return p


# --- Read-only Assets (bundle_dir) ----------------------------------------

def schemas_dir() -> Path:
    return bundle_dir() / "tools" / "blueprint_schemas"


def templates_dir() -> Path:
    return bundle_dir() / "tools" / "blueprint_templates"


def skills_dir() -> Path:
    """Gebuendelte Agent-Skill-Trees (kepano obsidian-skills), die Blueprints
    nach <vault>/.claude/skills/ scaffolden koennen."""
    return bundle_dir() / "tools" / "blueprint_templates" / "_skills"


def commands_dir() -> Path:
    """Gebuendelte Claude-Code-Slash-Command-Prompts, die Blueprints nach
    <vault>/.claude/commands/<name>.md scaffolden koennen."""
    return bundle_dir() / "tools" / "blueprint_templates" / "_commands"


def trusted_keys_file() -> Path:
    return bundle_dir() / "blueprint_trusted_keys.json"


def scrape_dom_js() -> Path:
    """Gemeinsamer DOM→Markdown-Konverter (extension/tools/scrape_dom.js), den
    der Playwright-Scraper per page.evaluate injiziert. Dev: Repo-Pfad neben
    server/. Frozen: muss als data-File ins Bundle-Root (ewtosbrain.spec)."""
    if is_frozen():
        return bundle_dir() / "scrape_dom.js"
    return Path(__file__).parent.parent / "extension" / "tools" / "scrape_dom.js"


# --- Migration -------------------------------------------------------------

def migrate_legacy_data() -> list[str]:
    """Kopiert Daten aus dem alten Code-nahen Layout (server/) ins data_dir.

    Idempotent: ueberschreibt nichts, was im data_dir schon existiert. Greift
    nur im Dev-Modus (nicht frozen), wo server/ die Altdaten haelt.
    """
    if is_frozen():
        return []
    legacy = Path(__file__).parent
    dest = data_dir()
    if legacy.resolve() == dest.resolve():
        return []
    moved: list[str] = []
    for name in ("settings.json", ".env"):
        src, dst = legacy / name, dest / name
        if src.exists() and not dst.exists():
            shutil.copy2(src, dst)
            moved.append(name)
    for src in legacy.glob("chat*.json"):
        dst = dest / src.name
        if not dst.exists():
            shutil.copy2(src, dst)
            moved.append(src.name)
    for name in ("setup_sessions", "generated_images"):
        src, dst = legacy / name, dest / name
        if src.exists() and not dst.exists():
            shutil.copytree(src, dst)
            moved.append(name + "/")
    return moved
