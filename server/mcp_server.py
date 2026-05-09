"""EwtosBrain MCP-Server (Stdio).

Stellt einen kuratierten Subset der EwtosBrain-Tools als MCP-Server bereit,
damit Claude Code (oder andere MCP-Clients) den Vault navigieren, Notes/Todos
schreiben, Playlists verwalten und Transcripts via WS-Bridge pullen kann.

Prozess-Modell: eigener Stdio-Prozess. Vault-Filesystem-Zugriffe rufen die
gleichen `tools/*.py`-Funktionen wie die FastAPI-REST-Endpoints (Single
Source). Nur das WS-Bridge-Tool (Browser-DOM nötig) geht per httpx an den
laufenden FastAPI-Server.
"""
from __future__ import annotations

from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

import httpx
from mcp.server.fastmcp import FastMCP

import config
import settings
from tools import (
    bookmarks,
    notes_file,
    playlists,
    raw_promoter,
    transcript_writer,
    videos,
    wiki_reader,
)

mcp = FastMCP("ewtosbrain")


# --- Vault-Discovery -------------------------------------------------------

@mcp.tool()
def list_vaults() -> list[dict]:
    """Liste aller konfigurierten Vaults mit ihren IDs.

    Rückgabe pro Vault: id, name, path, permissions. Nutze die `id` für alle
    Tools, die einen `vault_id`-Parameter erwarten.
    """
    return [
        {
            "id": v.get("id"),
            "name": v.get("name"),
            "path": v.get("path"),
            "permissions": v.get("permissions") or {},
        }
        for v in settings.get_vaults()
    ]


# --- Vault-Read (read-only) ------------------------------------------------

def _vault_path(vault_id: str) -> str:
    v = settings.get_vault(vault_id)
    if not v:
        raise ValueError(f"Vault {vault_id} nicht gefunden")
    return v["path"]


@mcp.tool()
def list_folder(vault_id: str, rel_path: str = "") -> dict:
    """Listet .md-Dateien und Unterordner in einem Vault-Ordner.

    `rel_path` ist relativ zum Vault-Root (leer = Root). Hidden-Folder
    (.obsidian, .git, etc.) werden gefiltert.
    """
    return wiki_reader.list_folder(_vault_path(vault_id), rel_path)


@mcp.tool()
def read_file(vault_id: str, rel_path: str) -> str:
    """Liest eine .md-Datei aus dem Vault. `rel_path` relativ zum Vault-Root."""
    return wiki_reader.read_file(_vault_path(vault_id), rel_path)


# --- Notes & Todos (vault-unabhängig, liegen in notes/) --------------------

@mcp.tool()
def list_todos() -> list[dict]:
    """Listet alle Todos aus notes/todos.md mit Status (done/offen) und Due-Date."""
    return notes_file.list_todos()


@mcp.tool()
def add_todo(text: str, due: str | None = None) -> dict:
    """Fügt ein neues Todo in notes/todos.md hinzu.

    `due` als ISO-Datum 'YYYY-MM-DD' oder 'YYYY-MM-DD HH:MM' (optional).
    """
    return notes_file.add_todo(text, due)


@mcp.tool()
def update_todo(match_text: str, action: str) -> dict:
    """Aktualisiert ein Todo per Substring-Match auf den Text.

    `action`: 'complete' (abhaken), 'uncomplete' (aushaken), 'delete' (löschen).
    Bei mehrdeutigem Match wird ein Fehler mit Vorschlägen geworfen — dann
    präziser matchen.
    """
    return notes_file.update_todo(match_text, action)


@mcp.tool()
def read_scratchpad() -> dict:
    """Liest den kompletten Scratchpad (notes/scratchpad.md) inkl. started-Date."""
    return notes_file.read_scratchpad()


@mcp.tool()
def append_scratchpad(text: str) -> dict:
    """Hängt einen neuen Block an den Scratchpad — automatisch mit '## YYYY-MM-DD'-Header."""
    return notes_file.append_scratchpad(text)


# --- Bookmarks (notes/bookmarks.md) ---------------------------------------

@mcp.tool()
def list_bookmarks() -> list[dict]:
    """Listet alle Bookmarks aus notes/bookmarks.md."""
    return bookmarks.list_bookmarks()


@mcp.tool()
def add_bookmark(
    url: str,
    title: str | None = None,
    note: str | None = None,
    source: str = "mcp",
) -> dict:
    """Fügt einen Bookmark hinzu. URL ist Pflicht. `source` defaultet auf 'mcp'."""
    return bookmarks.add_bookmark(url, title=title, note=note, source=source)


@mcp.tool()
def delete_bookmark(match: str) -> dict:
    """Löscht einen Bookmark per Substring-Match (Titel oder URL).

    Bei Mehrdeutigkeit wird ein Fehler geworfen — dann präziser matchen.
    """
    return bookmarks.delete_bookmark(match)


# --- Playlists (wiki/ki/playlists/) ---------------------------------------

@mcp.tool()
def list_playlists(vault_id: str) -> list[dict]:
    """Listet alle Playlists eines Vaults mit Item-Count."""
    return playlists.list_playlists(vault_id)


@mcp.tool()
def get_playlist(vault_id: str, name: str) -> dict:
    """Gibt eine Playlist mit allen Items (Titel, Channel, URL, Page-Link) zurück."""
    return playlists.get_playlist(vault_id, name)


@mcp.tool()
def create_playlist(vault_id: str, name: str, thema: str | None = None) -> dict:
    """Legt eine neue Playlist an. `thema` optional (z.B. 'ki', 'fitness')."""
    return playlists.create_playlist(vault_id, name, thema=thema)


@mcp.tool()
def add_to_playlist(
    vault_id: str,
    name: str,
    url: str,
    title: str | None = None,
    youtuber: str | None = None,
    dauer: str | None = None,
) -> dict:
    """Fügt ein Video zu einer Playlist hinzu (legt Master-Video-Page in
    wiki/ki/videos/ an oder erweitert die playlists-Liste, falls existiert)."""
    return playlists.add_to_playlist(
        vault_id,
        name,
        url,
        title=title,
        youtuber=youtuber,
        dauer=dauer,
    )


@mcp.tool()
def remove_from_playlist(vault_id: str, name: str, match: str) -> dict:
    """Entfernt ein Item aus einer Playlist per Substring-Match (Titel oder URL)."""
    return playlists.remove_from_playlist(vault_id, name, match)


# --- Videos (wiki/ki/videos/) ---------------------------------------------

@mcp.tool()
def get_video(vault_id: str, slug: str) -> dict | None:
    """Lädt eine Video-Page (Frontmatter + Body) per Slug. None wenn nicht gefunden."""
    return videos.get_video(vault_id, slug)


@mcp.tool()
def upsert_video(
    vault_id: str,
    title: str,
    url: str,
    youtuber: str | None = None,
    dauer: str | None = None,
    playlist_slug: str | None = None,
) -> dict:
    """Legt eine Video-Page an oder ergänzt sie (idempotent per URL/Slug)."""
    return videos.upsert_video(
        vault_id,
        title,
        url,
        youtuber=youtuber,
        dauer=dauer,
        playlist_slug=playlist_slug,
    )


# --- Raw-Promote (notes -> vault/raw/) ------------------------------------

@mcp.tool()
def promote_to_raw(
    vault_id: str,
    source: str,
    identifier: str,
    target_subfolder: str,
    title: str | None = None,
    description: str | None = None,
    filename_slug: str | None = None,
) -> dict:
    """Promote einen Scratchpad-Block oder ein Todo nach vault/raw/<subfolder>/.

    `source`: 'scratchpad' oder 'todos'.
    `identifier`: Datum 'YYYY-MM-DD' (scratchpad) oder Substring (beide).
    `target_subfolder`: muss mit 'artikel', 'eigene-notizen', 'kunden-input',
      oder 'chat-archive' beginnen. Braucht `write_raw`-Permission im Vault.
    """
    return raw_promoter.promote_to_raw(
        vault_id,
        source,
        identifier,
        target_subfolder,
        title=title,
        description=description,
        filename_slug=filename_slug,
    )


# --- Transcripts ----------------------------------------------------------

@mcp.tool()
def save_transcript(
    vault_id: str,
    video_slug: str,
    transcript_text: str,
    with_timestamps: bool = False,
) -> dict:
    """Speichert ein bereits geholtes Transcript in raw/transcripts/<datum>-<slug>.md
    und verlinkt es in der Master-Video-Page.

    Nutze diesen Tool, wenn du den Transcript-Text bereits hast (z.B. aus
    einer anderen Quelle). Für YouTube-Pull aus dem Browser:
    `pull_transcript_via_extension`.
    """
    return transcript_writer.save_transcript(
        vault_id,
        video_slug,
        transcript_text,
        with_timestamps=with_timestamps,
    )


@mcp.tool()
def pull_transcript_via_extension(url: str) -> dict:
    """Triggert das YouTube-Transcript-Tool in der Chrome-Extension via WS-Bridge.

    Erfordert: (1) der EwtosBrain-FastAPI-Server läuft, (2) die Chrome-
    Extension ist verbunden. Bei fehlender Bridge wird ein klarer Fehler
    zurückgegeben — dann den User bitten, die Extension zu öffnen.

    Returns: {ok: bool, data: {segments: [...]}, error?: str}
    """
    target = f"http://{config.HOST}:{config.PORT}/tools/youtube_transcript"
    try:
        r = httpx.post(target, json={"url": url}, timeout=120)
        if r.status_code == 503:
            return {
                "ok": False,
                "error": "EwtosBrain-Extension nicht verbunden — bitte Chrome-Extension öffnen.",
            }
        r.raise_for_status()
        return r.json()
    except httpx.ConnectError:
        return {
            "ok": False,
            "error": (
                f"FastAPI-Server nicht erreichbar auf {config.HOST}:{config.PORT}. "
                f"Bitte start-server.bat starten."
            ),
        }
    except httpx.HTTPStatusError as e:
        return {"ok": False, "error": f"HTTP {e.response.status_code}: {e.response.text[:200]}"}


if __name__ == "__main__":
    mcp.run()
