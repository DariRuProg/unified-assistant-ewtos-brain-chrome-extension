"""Guten-Morgen-Briefing — liest Todos, Vault-Fristen, Lernstreak, Wetter."""
from __future__ import annotations

__author__ = "Dario | ewtos.com"

import uuid
from datetime import date, datetime
from pathlib import Path
from typing import Any

import httpx
import yaml

import settings
from tools import notes_file

DEFAULT_PROFILES = [
    {
        "id": "default",
        "name": "Morgen-Briefing",
        "sources": ["wetter", "todos", "fristen", "lernstreak"],
        "standorte": ["Paderborn"],
    }
]


# --- Profile Management ---------------------------------------------------

def list_profiles() -> list[dict]:
    return list(settings.all().get("briefing_profiles") or DEFAULT_PROFILES)


def get_profile(profile_id: str) -> dict | None:
    for p in list_profiles():
        if p.get("id") == profile_id:
            return dict(p)
    return None


def save_profile(profile: dict) -> dict:
    global_cache = settings.all()
    profiles = list(global_cache.get("briefing_profiles") or DEFAULT_PROFILES)
    if not profile.get("id"):
        profile["id"] = uuid.uuid4().hex[:8]
    for i, p in enumerate(profiles):
        if p.get("id") == profile["id"]:
            profiles[i] = profile
            break
    else:
        profiles.append(profile)
    global_cache["briefing_profiles"] = profiles
    settings._cache = global_cache
    settings._flush()
    return dict(profile)


def delete_profile(profile_id: str) -> bool:
    if profile_id == "default":
        return False
    global_cache = settings.all()
    profiles = list(global_cache.get("briefing_profiles") or DEFAULT_PROFILES)
    new_profiles = [p for p in profiles if p.get("id") != profile_id]
    if len(new_profiles) == len(profiles):
        return False
    global_cache["briefing_profiles"] = new_profiles
    settings._cache = global_cache
    settings._flush()
    return True


# --- Section builders -----------------------------------------------------

async def _build_wetter(standorte: list[str]) -> dict:
    items = []
    async with httpx.AsyncClient(timeout=8.0) as client:
        for stadt in standorte:
            try:
                r = await client.get(f"https://wttr.in/{stadt}?format=j1")
                r.raise_for_status()
                data = r.json()
                cond = data["current_condition"][0]
                items.append({
                    "stadt": stadt,
                    "temp_c": int(cond["temp_C"]),
                    "beschreibung": cond["weatherDesc"][0]["value"],
                    "luftfeuchtigkeit": int(cond["humidity"]),
                    "windgeschwindigkeit": int(cond["windspeedKmph"]),
                })
            except Exception as exc:
                items.append({"stadt": stadt, "error": str(exc)})
    return {"type": "wetter", "title": "Wetter", "items": items}


def _build_todos(vault_id: str | None = None) -> dict:
    try:
        all_todos = notes_file.list_todos(vault_id=vault_id)
        open_todos = [t for t in all_todos if not t["done"]]
        open_todos.sort(key=lambda t: t["due"] or "9999-99-99")
        return {"type": "todos", "title": "Offene Todos", "items": open_todos}
    except Exception as exc:
        return {"type": "todos", "title": "Offene Todos", "error": str(exc)}


def _parse_frontmatter(text: str) -> dict:
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end == -1:
        return {}
    try:
        return yaml.safe_load(text[3:end]) or {}
    except Exception:
        return {}


_FRIST_FIELDS = ("ablauf", "deadline", "frist", "gueltig_bis", "ende")


def _build_fristen(vault_path: str) -> dict:
    today = date.today()
    items = []
    wiki_dir = Path(vault_path) / "wiki"
    if not wiki_dir.exists():
        wiki_dir = Path(vault_path)
    try:
        for md_file in wiki_dir.rglob("*.md"):
            try:
                text = md_file.read_text(encoding="utf-8")
                fm = _parse_frontmatter(text)
                title = fm.get("titel") or fm.get("title") or md_file.stem
                for field in _FRIST_FIELDS:
                    val = fm.get(field)
                    if not val:
                        continue
                    try:
                        d = date.fromisoformat(str(val))
                    except ValueError:
                        continue
                    days_left = (d - today).days
                    if 0 <= days_left <= 90:
                        try:
                            rel = str(md_file.relative_to(Path(vault_path))).replace("\\", "/")
                        except ValueError:
                            rel = str(md_file)
                        items.append({
                            "title": str(title),
                            "date": d.isoformat(),
                            "days_left": days_left,
                            "file": rel,
                        })
                    break
            except Exception:
                continue
        items.sort(key=lambda x: x["date"])
    except Exception as exc:
        return {"type": "fristen", "title": "Fristen & Deadlines", "error": str(exc)}
    return {"type": "fristen", "title": "Fristen & Deadlines", "items": items}


def _build_lernstreak(vault_path: str) -> dict:
    today = date.today()
    wiki_dir = Path(vault_path) / "wiki"
    if not wiki_dir.exists():
        wiki_dir = Path(vault_path)
    best_date: date | None = None
    best_title: str | None = None
    try:
        for md_file in wiki_dir.rglob("*.md"):
            try:
                text = md_file.read_text(encoding="utf-8")
                fm = _parse_frontmatter(text)
                if str(fm.get("typ", "")).lower() != "video":
                    continue
                zuletzt = fm.get("zuletzt")
                if not zuletzt:
                    continue
                d = date.fromisoformat(str(zuletzt))
                if best_date is None or d > best_date:
                    best_date = d
                    best_title = str(fm.get("titel") or fm.get("title") or md_file.stem)
            except Exception:
                continue
    except Exception as exc:
        return {"type": "lernstreak", "title": "Lernstreak", "error": str(exc)}

    if best_date is None:
        return {
            "type": "lernstreak",
            "title": "Lernstreak",
            "last_video_title": None,
            "days_ago": None,
            "last_date": None,
        }
    return {
        "type": "lernstreak",
        "title": "Lernstreak",
        "last_video_title": best_title,
        "days_ago": (today - best_date).days,
        "last_date": best_date.isoformat(),
    }


def _first_vault_path() -> str | None:
    vaults = settings.get_vaults()
    if vaults:
        return vaults[0].get("path")
    return None


# --- Main entry point -----------------------------------------------------

async def get_briefing(profile_id: str = "default", vault_id: str | None = None) -> dict:
    profile = get_profile(profile_id)
    if profile is None:
        profile = get_profile("default") or DEFAULT_PROFILES[0]

    vault_path: str | None = None
    if vault_id:
        v = settings.get_vault(vault_id)
        if v:
            vault_path = v["path"]
    if vault_path is None:
        vault_path = _first_vault_path()

    sources = profile.get("sources") or []
    standorte = profile.get("standorte") or ["Paderborn"]
    sections: list[dict[str, Any]] = []

    for source in sources:
        if source == "wetter":
            try:
                sections.append(await _build_wetter(standorte))
            except Exception as exc:
                sections.append({"type": "wetter", "title": "Wetter", "error": str(exc)})
        elif source == "todos":
            sections.append(_build_todos(vault_id=vault_id))
        elif source == "fristen":
            if vault_path:
                sections.append(_build_fristen(vault_path))
            else:
                sections.append({"type": "fristen", "title": "Fristen & Deadlines", "error": "Kein Vault konfiguriert"})
        elif source == "lernstreak":
            if vault_path:
                sections.append(_build_lernstreak(vault_path))
            else:
                sections.append({"type": "lernstreak", "title": "Lernstreak", "error": "Kein Vault konfiguriert"})

    return {
        "profile": {"id": profile.get("id", "default"), "name": profile.get("name", "Morgen-Briefing")},
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "sections": sections,
    }
