"""Guten-Morgen-Briefing — liest Todos, Vault-Fristen, Lernstreak, Wetter,
YouTube-Trending, Competitor-Videos, Playlist-Trending, LLM-Empfehlungen."""
from __future__ import annotations

__author__ = "Dario | ewtos.com"

import json
import re
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import yaml

import settings
from tools import notes_file
from tools import wiki_reader
from tools import youtube_api

DEFAULT_PROFILES = [
    {
        "id": "default",
        "name": "Morgen-Briefing",
        "sources": ["wetter", "todos", "recent_pages", "fristen"],
        "params": {
            "wetter": {"standorte": ["Paderborn"]},
            "recent_pages": {"limit": 5},
        },
    }
]


@dataclass
class BriefingCtx:
    """Einheitlicher Kontext für alle Section-Builder."""
    vault_path: str | None
    vault_id: str | None
    params: dict


# Legacy-Felder, die früher flach im Profil lagen (vor dem params-Schema).
_LEGACY_PARAM_FIELDS = {
    "wetter": ["standorte"],
    "youtube_trending": ["youtube_nische"],
    "competitor_videos": ["competitor_channels"],
    "recommendations": ["recommendations_lookback_days"],
}


def _params_for(profile: dict, key: str) -> dict:
    """Pro-Baustein-Parameter aus profile['params'][key]. Hebt alte flache
    Profil-Felder als Fallback rein, damit vor dem Update gespeicherte Profile
    weiter funktionieren (kein Migrationsskript nötig)."""
    p = dict((profile.get("params") or {}).get(key) or {})
    for field in _LEGACY_PARAM_FIELDS.get(key, []):
        if field not in p and profile.get(field) is not None:
            p[field] = profile[field]
    return p


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

async def _build_wetter(ctx: BriefingCtx) -> dict:
    standorte = ctx.params.get("standorte") or ["Paderborn"]
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


def _build_todos(ctx: BriefingCtx) -> dict:
    try:
        all_todos = notes_file.list_todos(vault_id=ctx.vault_id)
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


def _build_fristen(ctx: BriefingCtx) -> dict:
    vault_path = ctx.vault_path
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


def _build_lernstreak(ctx: BriefingCtx) -> dict:
    vault_path = ctx.vault_path
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


# --- Neue Sources ---------------------------------------------------------

def _video_url(vid: str) -> str:
    return f"https://www.youtube.com/watch?v={vid}"


async def _build_youtube_trending(ctx: BriefingCtx) -> dict:
    nische = (ctx.params.get("youtube_nische") or "").strip()
    limit = int(ctx.params.get("limit") or 5)
    if not nische:
        return {
            "type": "youtube_trending",
            "title": "YouTube Trending",
            "items": [],
            "error": "Keine youtube_nische im Profil gesetzt",
        }
    try:
        published_after = datetime.now() - timedelta(days=7)
        videos = await youtube_api.search_videos(
            query=nische,
            published_after=published_after,
            order="viewCount",
            max_results=limit,
        )
        vids = [v["video_id"] for v in videos]
        stats = await youtube_api.get_video_stats(vids) if vids else {}
        items = []
        for v in videos:
            s = stats.get(v["video_id"]) or {}
            items.append({
                "title": v["title"],
                "channel_title": v["channel_title"],
                "views": s.get("views", 0),
                "likes": s.get("likes", 0),
                "url": _video_url(v["video_id"]),
                "thumbnail": v.get("thumbnail_url", ""),
            })
        items.sort(key=lambda x: x["views"], reverse=True)
        return {"type": "youtube_trending", "title": f"YouTube Trending — {nische}", "items": items, "error": None}
    except Exception as exc:
        return {"type": "youtube_trending", "title": "YouTube Trending", "items": [], "error": str(exc)}


async def _build_competitor_videos(ctx: BriefingCtx) -> dict:
    channels = ctx.params.get("competitor_channels") or []
    limit = int(ctx.params.get("limit") or 5)
    if not channels:
        return {
            "type": "competitor_videos",
            "title": "Competitor Videos",
            "items": [],
            "error": "Keine competitor_channels im Profil gesetzt",
        }
    try:
        published_after = datetime.now() - timedelta(days=7)
        aggregated: list[dict] = []
        for ch in channels:
            try:
                vids = await youtube_api.get_channel_uploads(
                    ch, max_results=5, published_after=published_after
                )
                aggregated.extend(vids)
            except youtube_api.YouTubeAPIError as exc:
                print(f"[briefing] competitor channel {ch} skipped: {exc}")
                continue
        vid_ids = [v["video_id"] for v in aggregated]
        stats = await youtube_api.get_video_stats(vid_ids) if vid_ids else {}
        items = []
        for v in aggregated:
            s = stats.get(v["video_id"]) or {}
            items.append({
                "title": v["title"],
                "channel_title": v["channel_title"],
                "views": s.get("views", 0),
                "likes": s.get("likes", 0),
                "url": _video_url(v["video_id"]),
                "published_at": v.get("published_at", ""),
            })
        items.sort(key=lambda x: x.get("published_at", ""), reverse=True)
        return {"type": "competitor_videos", "title": "Competitor Videos", "items": items[:limit], "error": None}
    except Exception as exc:
        return {"type": "competitor_videos", "title": "Competitor Videos", "items": [], "error": str(exc)}


_YT_ID_RE = re.compile(r"(?:youtube\.com/watch\?v=|youtu\.be/)([A-Za-z0-9_-]{11})")


async def _build_playlist_trending(ctx: BriefingCtx) -> dict:
    vault_path = ctx.vault_path
    limit = int(ctx.params.get("limit") or 5)
    base = Path(vault_path) / "wiki" / "resources" / "playlists"
    if not base.exists():
        return {
            "type": "playlist_trending",
            "title": "Playlist Trending",
            "items": [],
            "error": f"Pfad existiert nicht: {base}",
        }
    try:
        ids: list[str] = []
        for md in base.glob("*.md"):
            try:
                text = md.read_text(encoding="utf-8")
            except Exception:
                continue
            for m in _YT_ID_RE.finditer(text):
                vid = m.group(1)
                if vid not in ids:
                    ids.append(vid)
        if not ids:
            return {"type": "playlist_trending", "title": "Playlist Trending", "items": [], "error": None}

        stats = await youtube_api.get_video_stats(ids)
        items = []
        for vid, s in stats.items():
            items.append({
                "title": s.get("title", ""),
                "channel_title": s.get("channel_title", ""),
                "views": s.get("views", 0),
                "likes": s.get("likes", 0),
                "url": _video_url(vid),
                "thumbnail": s.get("thumbnail_url", ""),
            })
        items.sort(key=lambda x: x["views"], reverse=True)
        return {"type": "playlist_trending", "title": "Playlist Trending", "items": items[:limit], "error": None}
    except Exception as exc:
        return {"type": "playlist_trending", "title": "Playlist Trending", "items": [], "error": str(exc)}


def _read_recent_journal(vault_path: str, days: int = 14) -> str:
    base = Path(vault_path) / "journal"
    if not base.exists():
        return ""
    today = date.today()
    chunks: list[str] = []
    for i in range(days):
        d = today - timedelta(days=i)
        f = base / f"{d.isoformat()}.md"
        if f.exists():
            try:
                chunks.append(f"## {d.isoformat()}\n{f.read_text(encoding='utf-8')}")
            except Exception:
                continue
    return "\n\n".join(chunks)


def _read_inbox_file(vault_path: str, name: str) -> str:
    f = Path(vault_path) / "inbox" / name
    if not f.exists():
        return ""
    try:
        return f.read_text(encoding="utf-8")
    except Exception:
        return ""


_JSON_RE = re.compile(r"\{[\s\S]*\}")


async def _build_recommendations(ctx: BriefingCtx) -> dict:
    vault_path = ctx.vault_path
    try:
        from llm_client import effective_llm_config, get_backend
    except Exception as exc:
        return {"type": "recommendations", "title": "Empfehlungen", "items": [], "error": f"LLM nicht verfuegbar: {exc}"}

    lookback = int(ctx.params.get("recommendations_lookback_days") or 14)
    journal = _read_recent_journal(vault_path, days=lookback)
    scratch = _read_inbox_file(vault_path, "scratchpad.md")
    todos = _read_inbox_file(vault_path, "todos.md")

    system = (
        "Du bist Briefing-Assistent. Hier letzte Aktivitaet. Schlage 3 konkrete "
        "Themen vor: 1 Artikel-Idee, 1 Video-Idee, 1 'beschaeftige dich mit X'-Tipp. "
        "Antwort STRENG als JSON: "
        '{"artikel": "...", "video": "...", "tipp": "..."}'
    )
    user_msg = (
        f"Letzte 14 Tage Journal:\n{journal[:5000]}\n\n"
        f"Scratchpad:\n{scratch[:2000]}\n\n"
        f"Todos:\n{todos[:2000]}"
    )

    try:
        _, model = effective_llm_config()
        model = model or "claude-haiku-4-5"
        backend = get_backend()
        result = backend.complete(
            model=model,
            max_tokens=400,
            system=system,
            messages=[{"role": "user", "content": user_msg}],
        )
        text = "".join(b.text for b in result.content if b.type == "text").strip()
        m = _JSON_RE.search(text)
        if not m:
            return {"type": "recommendations", "title": "Empfehlungen", "items": [], "error": "LLM-Antwort nicht parsebar"}
        parsed = json.loads(m.group())
        items = [
            {"kind": "artikel", "text": str(parsed.get("artikel") or "")},
            {"kind": "video", "text": str(parsed.get("video") or "")},
            {"kind": "tipp", "text": str(parsed.get("tipp") or "")},
        ]
        items = [i for i in items if i["text"]]
        return {"type": "recommendations", "title": "Empfehlungen", "items": items, "error": None}
    except Exception as exc:
        return {"type": "recommendations", "title": "Empfehlungen", "items": [], "error": str(exc)}


def _build_vertrags_fristen(ctx: BriefingCtx) -> dict:
    vault_path = ctx.vault_path
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
                if str(fm.get("typ", "")).lower() != "kunde":
                    continue
                val = fm.get("vertrag_bis")
                if not val:
                    continue
                try:
                    d = date.fromisoformat(str(val))
                except ValueError:
                    continue
                days_left = (d - today).days
                if 0 <= days_left <= 60:
                    title = fm.get("titel") or fm.get("title") or md_file.stem
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
            except Exception:
                continue
        items.sort(key=lambda x: x["date"])
    except Exception as exc:
        return {"type": "vertrags_fristen", "title": "Vertrags-Fristen", "error": str(exc)}
    return {"type": "vertrags_fristen", "title": "Vertrags-Fristen", "items": items}


def _build_kampagnen_kickoffs(ctx: BriefingCtx) -> dict:
    vault_path = ctx.vault_path
    today = date.today()
    horizon = today + timedelta(days=14)
    items = []
    wiki_dir = Path(vault_path) / "wiki"
    if not wiki_dir.exists():
        wiki_dir = Path(vault_path)
    try:
        for md_file in wiki_dir.rglob("*.md"):
            try:
                text = md_file.read_text(encoding="utf-8")
                fm = _parse_frontmatter(text)
                if str(fm.get("typ", "")).lower() != "kampagne":
                    continue
                val = fm.get("kickoff")
                if not val:
                    continue
                try:
                    d = date.fromisoformat(str(val))
                except ValueError:
                    continue
                if d <= horizon:
                    days_left = (d - today).days
                    title = fm.get("titel") or fm.get("title") or md_file.stem
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
            except Exception:
                continue
        items.sort(key=lambda x: x["date"])
    except Exception as exc:
        return {"type": "kampagnen_kickoffs", "title": "Kampagnen-Kickoffs", "error": str(exc)}
    return {"type": "kampagnen_kickoffs", "title": "Kampagnen-Kickoffs", "items": items}


def _scan_dir(vault_path: str) -> Path:
    """Wissens-Ordner zum Scannen: bevorzugt wiki/ (schließt raw/inbox/journal als
    Geschwister aus), sonst der aufgelöste Content-Ordner (flache Vaults)."""
    wiki = Path(vault_path) / "wiki"
    if wiki.exists():
        return wiki
    return wiki_reader.resolve_dir(vault_path)


def _mtime_days_ago(p: Path) -> tuple[str, int]:
    mt = datetime.fromtimestamp(p.stat().st_mtime)
    return mt.date().isoformat(), (datetime.now() - mt).days


def _page_title(p: Path, fm: dict) -> str:
    return str(fm.get("titel") or fm.get("title") or p.stem)


def _build_recent_videos(ctx: BriefingCtx) -> dict:
    """Letzte Videos — erkennt sie per frontmatter typ:video ODER Dateiname video-*
    (deckt beide Vault-Konventionen ab). Datum aus zuletzt/date, sonst Datei-mtime."""
    limit = int(ctx.params.get("limit") or 5)
    scan = _scan_dir(ctx.vault_path)
    found: list[dict] = []
    try:
        for md in scan.rglob("*.md"):
            if any(part in wiki_reader.IGNORED_NAMES or part.startswith(".") for part in md.parts):
                continue
            is_video = md.stem.startswith("video-")
            try:
                fm = _parse_frontmatter(md.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not is_video and str(fm.get("typ", "")).lower() != "video":
                continue
            raw = fm.get("zuletzt") or fm.get("date")
            d = None
            if raw:
                try:
                    d = date.fromisoformat(str(raw))
                except ValueError:
                    d = None
            if d is not None:
                sort_ts = datetime(d.year, d.month, d.day).timestamp()
                last_iso, days_ago = d.isoformat(), (date.today() - d).days
            else:
                sort_ts = md.stat().st_mtime
                last_iso, days_ago = _mtime_days_ago(md)
            found.append({
                "title": _page_title(md, fm),
                "url": str(fm.get("quelle_url") or fm.get("url") or ""),
                "last_date": last_iso,
                "days_ago": days_ago,
                "_sort": sort_ts,
            })
    except Exception as exc:
        return {"type": "recent_videos", "title": "Neueste Videos", "items": [], "error": str(exc)}
    found.sort(key=lambda x: x.pop("_sort"), reverse=True)
    return {"type": "recent_videos", "title": "Neueste Videos", "items": found[:limit], "error": None}


def _build_recent_pages(ctx: BriefingCtx) -> dict:
    limit = int(ctx.params.get("limit") or 5)
    bucket = str(ctx.params.get("bucket") or "").strip().strip("/")
    scan = _scan_dir(ctx.vault_path)
    found: list[dict] = []
    try:
        for md in scan.rglob("*.md"):
            if any(part in wiki_reader.IGNORED_NAMES or part.startswith(".") for part in md.parts):
                continue
            try:
                rel = md.relative_to(scan).as_posix()
            except ValueError:
                rel = md.name
            if bucket and not rel.startswith(bucket + "/"):
                continue
            try:
                fm = _parse_frontmatter(md.read_text(encoding="utf-8"))
            except Exception:
                fm = {}
            mtime_iso, days_ago = _mtime_days_ago(md)
            found.append({
                "title": _page_title(md, fm),
                "file": rel,
                "mtime_iso": mtime_iso,
                "days_ago": days_ago,
                "_sort": md.stat().st_mtime,
            })
    except Exception as exc:
        return {"type": "recent_pages", "title": "Zuletzt geändert", "items": [], "error": str(exc)}
    found.sort(key=lambda x: x.pop("_sort"), reverse=True)
    return {"type": "recent_pages", "title": "Zuletzt geändert", "items": found[:limit], "error": None}


def _build_active_projects(ctx: BriefingCtx) -> dict:
    limit = int(ctx.params.get("limit") or 5)
    wiki = Path(ctx.vault_path) / "wiki" / "projects"
    if not wiki.exists():
        wiki = wiki_reader.resolve_dir(ctx.vault_path) / "projects"
    if not wiki.exists():
        return {"type": "active_projects", "title": "Aktive Projekte", "items": [], "error": None}
    found: list[dict] = []
    try:
        for md in wiki.rglob("*.md"):
            if md.name == "index.md" or any(part.startswith(".") for part in md.parts):
                continue
            try:
                fm = _parse_frontmatter(md.read_text(encoding="utf-8"))
            except Exception:
                fm = {}
            status = str(fm.get("status", "")).lower()
            is_active = status in ("aktiv", "active") or not status
            mtime_iso, days_ago = _mtime_days_ago(md)
            found.append({
                "title": _page_title(md, fm),
                "file": md.relative_to(Path(ctx.vault_path)).as_posix(),
                "status": status or "—",
                "days_ago": days_ago,
                "_active": is_active,
                "_sort": md.stat().st_mtime,
            })
    except Exception as exc:
        return {"type": "active_projects", "title": "Aktive Projekte", "items": [], "error": str(exc)}
    # Aktive zuerst, dann nach mtime desc.
    found.sort(key=lambda x: (x.pop("_active"), x.pop("_sort")), reverse=True)
    return {"type": "active_projects", "title": "Aktive Projekte", "items": found[:limit], "error": None}


def _build_scratchpad(ctx: BriefingCtx) -> dict:
    """Auszug aus dem Scratchpad als Markdown-Block (Originalformatierung erhalten,
    wird im UI gerendert) — die letzten `limit` nicht-leeren Zeilen samt Kontext."""
    limit = int(ctx.params.get("limit") or 10)
    try:
        data = notes_file.read_scratchpad(vault_id=ctx.vault_id)
        content = data.get("content") or ""
    except Exception as exc:
        return {"type": "scratchpad", "title": "Scratchpad", "markdown": "", "items": [], "error": str(exc)}
    lines = content.splitlines()
    non_empty = [i for i, ln in enumerate(lines) if ln.strip()]
    if non_empty:
        start = non_empty[max(0, len(non_empty) - limit)]
        markdown = "\n".join(lines[start:]).strip()
    else:
        markdown = ""
    return {"type": "scratchpad", "title": "Scratchpad", "markdown": markdown, "items": [], "error": None}


def _build_last_journal(ctx: BriefingCtx) -> dict:
    base = Path(ctx.vault_path) / "journal"
    if not base.exists():
        return {"type": "last_journal", "title": "Letztes Journal", "items": [], "error": None}
    today = date.today()
    for i in range(1, 31):  # ab gestern rückwärts, heutiges Briefing-Journal überspringen
        d = today - timedelta(days=i)
        f = base / f"{d.isoformat()}.md"
        if not f.exists():
            continue
        try:
            text = f.read_text(encoding="utf-8")
        except Exception:
            continue
        body = text
        if body.startswith("---"):
            end = body.find("\n---", 3)
            if end != -1:
                body = body[end + 4:]
        preview = body.strip()[:600]
        return {"type": "last_journal", "title": "Letztes Journal",
                "items": [{"date": d.isoformat(), "preview": preview}], "error": None}
    return {"type": "last_journal", "title": "Letztes Journal", "items": [], "error": None}


def _rel(md: Path, vault_path: str) -> str:
    try:
        return str(md.relative_to(Path(vault_path))).replace("\\", "/")
    except ValueError:
        return md.name


def _iter_wiki_md(vault_path: str):
    scan = _scan_dir(vault_path)
    for md in scan.rglob("*.md"):
        if any(part in wiki_reader.IGNORED_NAMES or part.startswith(".") for part in md.parts):
            continue
        yield md


_WORKSHOP_DATE_FIELDS = ("termin", "datum", "start", "datum_von", "workshop")


def _build_workshops(ctx: BriefingCtx) -> dict:
    """Anstehende Workshops/Events (typ:workshop|event) mit Datum im Fenster."""
    within = int(ctx.params.get("within") or 60)
    today = date.today()
    items = []
    try:
        for md in _iter_wiki_md(ctx.vault_path):
            try:
                fm = _parse_frontmatter(md.read_text(encoding="utf-8"))
            except Exception:
                continue
            if str(fm.get("typ", "")).lower() not in ("workshop", "event"):
                continue
            d = None
            for f in _WORKSHOP_DATE_FIELDS:
                v = fm.get(f)
                if v:
                    try:
                        d = date.fromisoformat(str(v))
                        break
                    except ValueError:
                        continue
            if d is None:
                continue
            days_left = (d - today).days
            if 0 <= days_left <= within:
                items.append({"title": _page_title(md, fm), "date": d.isoformat(),
                              "days_left": days_left, "file": _rel(md, ctx.vault_path)})
    except Exception as exc:
        return {"type": "workshops", "title": "Workshops", "items": [], "error": str(exc)}
    items.sort(key=lambda x: x["date"])
    return {"type": "workshops", "title": "Workshops", "items": items, "error": None}


_ANNIVERSARY_FIELDS = ("jahrestag", "anniversary", "kunde_seit", "gegruendet", "geburtstag")


def _next_anniversary(d0: date, today: date) -> date:
    """Nächstes jährliches Vorkommen von d0 (Monat/Tag) ab heute. 29.2.→28.2."""
    def _on(year: int) -> date:
        try:
            return d0.replace(year=year)
        except ValueError:
            return d0.replace(year=year, day=28)
    nxt = _on(today.year)
    if nxt < today:
        nxt = _on(today.year + 1)
    return nxt


def _build_anniversaries(ctx: BriefingCtx) -> dict:
    """Jährliche Jahrestage (kunde_seit/gegruendet/geburtstag/jahrestag) im Fenster."""
    within = int(ctx.params.get("within") or 30)
    today = date.today()
    items = []
    try:
        for md in _iter_wiki_md(ctx.vault_path):
            try:
                fm = _parse_frontmatter(md.read_text(encoding="utf-8"))
            except Exception:
                continue
            d0 = None
            for f in _ANNIVERSARY_FIELDS:
                v = fm.get(f)
                if v:
                    try:
                        d0 = date.fromisoformat(str(v))
                        break
                    except ValueError:
                        continue
            if d0 is None:
                continue
            nxt = _next_anniversary(d0, today)
            days_left = (nxt - today).days
            if 0 <= days_left <= within:
                years = nxt.year - d0.year
                title = _page_title(md, fm)
                if years > 0:
                    title = f"{title} ({years}. Jahrestag)"
                items.append({"title": title, "date": nxt.isoformat(),
                              "days_left": days_left, "file": _rel(md, ctx.vault_path)})
    except Exception as exc:
        return {"type": "anniversaries", "title": "Jahrestage", "items": [], "error": str(exc)}
    items.sort(key=lambda x: x["days_left"])
    return {"type": "anniversaries", "title": "Jahrestage", "items": items, "error": None}


# Source-Registry: key -> {fn, async, needs_vault, title}. Reihenfolge im Profil
# (sources-Liste) bestimmt die Render-Reihenfolge.
SOURCE_REGISTRY: dict[str, dict] = {
    "wetter":             {"fn": _build_wetter,             "async": True,  "needs_vault": False, "title": "Wetter"},
    "todos":              {"fn": _build_todos,              "async": False, "needs_vault": False, "title": "Offene Todos"},
    "fristen":            {"fn": _build_fristen,            "async": False, "needs_vault": True,  "title": "Fristen & Deadlines"},
    "lernstreak":         {"fn": _build_lernstreak,         "async": False, "needs_vault": True,  "title": "Lernstreak"},
    "recent_videos":      {"fn": _build_recent_videos,      "async": False, "needs_vault": True,  "title": "Neueste Videos"},
    "recent_pages":       {"fn": _build_recent_pages,       "async": False, "needs_vault": True,  "title": "Zuletzt geändert"},
    "active_projects":    {"fn": _build_active_projects,    "async": False, "needs_vault": True,  "title": "Aktive Projekte"},
    "scratchpad":         {"fn": _build_scratchpad,         "async": False, "needs_vault": False, "title": "Scratchpad"},
    "last_journal":       {"fn": _build_last_journal,       "async": False, "needs_vault": True,  "title": "Letztes Journal"},
    "youtube_trending":   {"fn": _build_youtube_trending,   "async": True,  "needs_vault": False, "title": "YouTube Trending"},
    "competitor_videos":  {"fn": _build_competitor_videos,  "async": True,  "needs_vault": False, "title": "Competitor Videos"},
    "playlist_trending":  {"fn": _build_playlist_trending,  "async": True,  "needs_vault": True,  "title": "Playlist Trending"},
    "recommendations":    {"fn": _build_recommendations,    "async": True,  "needs_vault": True,  "title": "Empfehlungen"},
    "vertrags_fristen":   {"fn": _build_vertrags_fristen,   "async": False, "needs_vault": True,  "title": "Vertrags-Fristen"},
    "kampagnen_kickoffs": {"fn": _build_kampagnen_kickoffs, "async": False, "needs_vault": True,  "title": "Kampagnen-Kickoffs"},
    "workshops":          {"fn": _build_workshops,          "async": False, "needs_vault": True,  "title": "Workshops"},
    "anniversaries":      {"fn": _build_anniversaries,      "async": False, "needs_vault": True,  "title": "Jahrestage"},
}


def _first_vault_path() -> str | None:
    vaults = settings.get_vaults()
    if vaults:
        return vaults[0].get("path")
    return None


# --- Markdown-Rendering & Journal-Archiv ---------------------------------

def _render_section_md(section: dict) -> str:
    stype = section.get("type", "")
    title = section.get("title", stype)
    out = [f"## {title}", ""]
    if section.get("error"):
        out.append(f"_Fehler: {section['error']}_")
        return "\n".join(out)

    if stype == "wetter":
        for it in section.get("items") or []:
            if it.get("error"):
                out.append(f"- {it.get('stadt', '?')}: Fehler — {it['error']}")
            else:
                out.append(
                    f"- {it['stadt']}: {it['temp_c']} Grad C, {it['beschreibung']} "
                    f"(Feuchte {it['luftfeuchtigkeit']}%, Wind {it['windgeschwindigkeit']} km/h)"
                )
    elif stype == "todos":
        for it in section.get("items") or []:
            due = it.get("due") or "ohne Frist"
            out.append(f"- [ ] {it.get('text', '')} ({due})")
    elif stype in ("fristen", "vertrags_fristen", "kampagnen_kickoffs", "workshops", "anniversaries"):
        for it in section.get("items") or []:
            out.append(f"- {it['date']} ({it['days_left']} Tage): {it['title']} — `{it.get('file', '')}`")
    elif stype == "lernstreak":
        if section.get("last_video_title"):
            out.append(f"- Letztes Video: {section['last_video_title']} — vor {section['days_ago']} Tagen")
        else:
            out.append("- Noch kein Video-Eintrag im Vault.")
    elif stype in ("youtube_trending", "competitor_videos", "playlist_trending"):
        for it in section.get("items") or []:
            views = it.get("views", 0)
            out.append(f"- [{it['title']}]({it['url']}) — {it.get('channel_title', '')} ({views:,} Views)")
    elif stype == "recent_videos":
        for it in section.get("items") or []:
            ago = f"vor {it['days_ago']} Tagen" if it.get("days_ago") is not None else "—"
            title = it.get("title", "")
            out.append(f"- [{title}]({it['url']}) — {ago}" if it.get("url") else f"- {title} — {ago}")
    elif stype in ("recent_pages", "active_projects"):
        for it in section.get("items") or []:
            ago = f"{it['days_ago']}d" if it.get("days_ago") is not None else "—"
            extra = f" ({it['status']})" if it.get("status") and it["status"] != "—" else ""
            out.append(f"- {it.get('title', '')}{extra} — vor {ago} — `{it.get('file', '')}`")
    elif stype == "scratchpad":
        out.append(section.get("markdown") or "_(leer)_")
    elif stype == "last_journal":
        for it in section.get("items") or []:
            out.append(f"**{it.get('date', '')}**")
            out.append("")
            out.append(it.get("preview", ""))
    elif stype == "recommendations":
        for it in section.get("items") or []:
            out.append(f"- **{it['kind']}**: {it['text']}")
    else:
        out.append(f"_(unbekannter Section-Typ: {stype})_")
    return "\n".join(out)


def _archive_journal(vault_path: str, profile_name: str, sections: list[dict]) -> None:
    journal_dir = Path(vault_path) / "journal"
    journal_dir.mkdir(parents=True, exist_ok=True)
    journal_file = journal_dir / f"{date.today().isoformat()}.md"
    if journal_file.exists():
        print(f"[briefing] Journal {journal_file.name} existiert — kein Ueberschreiben.")
        return

    frontmatter = yaml.safe_dump(
        {
            "typ": "briefing-journal",
            "datum": date.today().isoformat(),
            "profil": profile_name,
            "generiert_von": "ewtosbrain",
        },
        sort_keys=False,
        allow_unicode=True,
    )
    body_parts = [f"---\n{frontmatter}---", ""]
    for sec in sections:
        body_parts.append(_render_section_md(sec))
        body_parts.append("")

    tmp = journal_file.with_suffix(".md.tmp")
    tmp.write_text("\n".join(body_parts), encoding="utf-8")
    tmp.replace(journal_file)


def read_journal_lookback(vault_path: str, days_ago: int) -> dict:
    target = date.today() - timedelta(days=days_ago)
    f = Path(vault_path) / "journal" / f"{target.isoformat()}.md"
    if not f.exists():
        return {"ok": False, "error": f"Datei existiert nicht: {f.name}", "date": target.isoformat()}
    try:
        return {"ok": True, "date": target.isoformat(), "markdown": f.read_text(encoding="utf-8")}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "date": target.isoformat()}


# --- Main entry point -----------------------------------------------------

async def get_briefing(
    profile_id: str = "default",
    vault_id: str | None = None,
    archive: bool = True,
) -> dict:
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
    sections: list[dict[str, Any]] = []

    for source in sources:
        spec = SOURCE_REGISTRY.get(source)
        if not spec:
            continue
        title = spec.get("title", source)
        if spec["needs_vault"] and not vault_path:
            sections.append({"type": source, "title": title, "error": "Kein Vault konfiguriert"})
            continue
        ctx = BriefingCtx(vault_path=vault_path, vault_id=vault_id, params=_params_for(profile, source))
        try:
            sec = await spec["fn"](ctx) if spec["async"] else spec["fn"](ctx)
        except Exception as exc:
            sec = {"type": source, "title": title, "error": str(exc)}
        sections.append(sec)

    if archive and vault_path:
        try:
            _archive_journal(vault_path, profile.get("name", "Briefing"), sections)
        except Exception as exc:
            print(f"[briefing] Journal-Archiv fehlgeschlagen: {exc}")

    return {
        "profile": {"id": profile.get("id", "default"), "name": profile.get("name", "Morgen-Briefing")},
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "sections": sections,
    }
