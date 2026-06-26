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

from dotenv import load_dotenv

import paths

paths.migrate_legacy_data()
load_dotenv(paths.env_file())

import httpx
from mcp.server.fastmcp import FastMCP

import config
import settings
from tools import (
    blueprint,
    bookmarks,
    notes_file,
    playlists,
    raw_promoter,
    transcript_writer,
    vault_audit,
    videos,
    web_scraper,
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


# --- Vault-Audit & CLAUDE.md-Upgrade ---------------------------------------

@mcp.tool()
def audit_vault(vault_id: str) -> dict:
    """Read-only Health-Check eines Vaults.

    Findet Orphans (Pages nicht im Parent-Index), un-ingestete raw-Dateien,
    kaputte Wikilinks, fehlende Pflicht-Frontmatter, Struktur-Drift gegen das
    Blueprint und veraltete verwaltete CLAUDE.md-Sektionen. Liefert
    {vault_id, findings[], summary}. Schreibt nichts.
    """
    return vault_audit.audit_vault(vault_id)


@mcp.tool()
def claude_md_upgrade_preview(vault_id: str) -> dict:
    """Diff-Vorschau für das verwaltete CLAUDE.md (read-only, kein Write).

    Liefert {existing, merged, changed, sections}. `changed=False` = bereits aktuell.
    Der Merge ist non-destruktiv: nur Marker-Sektionen werden ersetzt, User-Text
    außerhalb bleibt erhalten.
    """
    return blueprint.preview_claude_md_upgrade(vault_id)


@mcp.tool()
def claude_md_upgrade_apply(vault_id: str) -> dict:
    """Schreibt das gemergte CLAUDE.md (non-destruktiv). Idempotent.

    Vorher `claude_md_upgrade_preview` zeigen lassen. Liefert {written, sections}.
    """
    return blueprint.apply_claude_md_upgrade(vault_id)


@mcp.tool()
def repair_finding(vault_id: str, category: str, path: str) -> dict:
    """Repariert ein einzelnes Audit-Finding (nur 'orphan_index' + 'structure_drift').

    `category` und `path` aus dem jeweiligen Finding von `audit_vault` übernehmen.
    orphan_index → ergänzt die Page-Zeile im Parent-index.md; structure_drift →
    legt den fehlenden Ordner an. Idempotent (bereits behoben → repaired False mit
    Grund). Andere Kategorien sind nicht automatisch reparierbar (ValueError).
    """
    return vault_audit.repair_finding(vault_id, category, path)


# --- Notes & Todos (vault-unabhängig, liegen in notes/) --------------------

@mcp.tool()
def list_todos(vault_id: str | None = None) -> list[dict]:
    """Listet alle Todos aus notes/todos.md mit Status (done/offen) und Due-Date.

    `vault_id` optional: bei vault.use_local_notes=True schreibt/liest pro Vault
    (`<vault.path>/notes/`), sonst globaler Pfad.
    """
    return notes_file.list_todos(vault_id=vault_id)


@mcp.tool()
def add_todo(text: str, due: str | None = None, vault_id: str | None = None) -> dict:
    """Fügt ein neues Todo in notes/todos.md hinzu.

    `due` als ISO-Datum 'YYYY-MM-DD' oder 'YYYY-MM-DD HH:MM' (optional).
    `vault_id` optional (Vault-scoped wenn use_local_notes=True).
    """
    return notes_file.add_todo(text, due, vault_id=vault_id)


@mcp.tool()
def update_todo(match_text: str, action: str, vault_id: str | None = None) -> dict:
    """Aktualisiert ein Todo per Substring-Match auf den Text.

    `action`: 'complete' (abhaken), 'uncomplete' (aushaken), 'delete' (löschen).
    Bei mehrdeutigem Match wird ein Fehler mit Vorschlägen geworfen — dann
    präziser matchen. `vault_id` optional (Vault-scoped wenn use_local_notes=True).
    """
    return notes_file.update_todo(match_text, action, vault_id=vault_id)


@mcp.tool()
def read_scratchpad(vault_id: str | None = None) -> dict:
    """Liest den kompletten Scratchpad (notes/scratchpad.md) inkl. started-Date.

    `vault_id` optional (Vault-scoped wenn use_local_notes=True).
    """
    return notes_file.read_scratchpad(vault_id=vault_id)


@mcp.tool()
def append_scratchpad(text: str, vault_id: str | None = None) -> dict:
    """Hängt einen neuen Block an den Scratchpad — automatisch mit '## YYYY-MM-DD'-Header.

    `vault_id` optional (Vault-scoped wenn use_local_notes=True).
    """
    return notes_file.append_scratchpad(text, vault_id=vault_id)


# --- Bookmarks (notes/bookmarks.md) ---------------------------------------

@mcp.tool()
def list_bookmarks(vault_id: str | None = None) -> list[dict]:
    """Listet alle Bookmarks aus notes/bookmarks.md.

    `vault_id` optional (Vault-scoped wenn use_local_notes=True).
    """
    return bookmarks.list_bookmarks(vault_id=vault_id)


@mcp.tool()
def add_bookmark(
    url: str,
    title: str | None = None,
    note: str | None = None,
    source: str = "mcp",
    vault_id: str | None = None,
) -> dict:
    """Fügt einen Bookmark hinzu. URL ist Pflicht. `source` defaultet auf 'mcp'.

    `vault_id` optional (Vault-scoped wenn use_local_notes=True).
    """
    return bookmarks.add_bookmark(url, title=title, note=note, source=source, vault_id=vault_id)


@mcp.tool()
def delete_bookmark(match: str, vault_id: str | None = None) -> dict:
    """Löscht einen Bookmark per Substring-Match (Titel oder URL).

    Bei Mehrdeutigkeit wird ein Fehler geworfen — dann präziser matchen.
    `vault_id` optional (Vault-scoped wenn use_local_notes=True).
    """
    return bookmarks.delete_bookmark(match, vault_id=vault_id)


# --- Playlists (wiki/resources/playlists/) --------------------------------

@mcp.tool()
def list_playlists(vault_id: str) -> list[dict]:
    """Listet alle Playlists eines Vaults (wiki/resources/playlists/) mit Item-Count.

    Jeder Eintrag enthält `name`, `slug`, `thema`, `path`, `item_count`.
    """
    return playlists.list_playlists(vault_id)


@mcp.tool()
def get_playlist(vault_id: str, name: str) -> dict:
    """Gibt eine Playlist mit allen Items (Titel, Channel, URL, Page-Link) zurück."""
    return playlists.get_playlist(vault_id, name)


@mcp.tool()
def create_playlist(
    vault_id: str,
    name: str,
    thema: str | None = None,
) -> dict:
    """Legt eine neue Playlist unter wiki/resources/playlists/<slug>.md an.

    `thema` optional (freies Frontmatter-Feld, z.B. 'ai', 'health', 'marketing').
    """
    return playlists.create_playlist(vault_id, name, thema=thema)


@mcp.tool()
def add_to_playlist(
    vault_id: str,
    name: str,
    url: str,
    title: str | None = None,
    youtuber: str | None = None,
    dauer: str | None = None,
    thema: str | None = None,
) -> dict:
    """Fügt ein Video zu einer Playlist hinzu (legt Master-Video-Page in
    wiki/resources/videos/ an oder erweitert die playlists-Liste, falls existiert).

    `thema` optional (freies Frontmatter-Feld); wird sonst aus der Playlist geerbt.
    """
    return playlists.add_to_playlist(
        vault_id,
        name,
        url,
        title=title,
        youtuber=youtuber,
        dauer=dauer,
        thema=thema,
    )


@mcp.tool()
def remove_from_playlist(
    vault_id: str,
    name: str,
    match: str,
) -> dict:
    """Entfernt ein Item aus einer Playlist per Substring-Match (Titel oder URL)."""
    return playlists.remove_from_playlist(vault_id, name, match)


# --- Videos (wiki/resources/videos/) --------------------------------------

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
    thema: str | None = None,
) -> dict:
    """Legt eine Video-Page (wiki/resources/videos/) an oder ergänzt sie
    (idempotent per URL/Slug). `thema` ist ein freies Frontmatter-Feld."""
    return videos.upsert_video(
        vault_id,
        title,
        url,
        youtuber=youtuber,
        dauer=dauer,
        playlist_slug=playlist_slug,
        thema=thema,
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
    """Speichert ein bereits geholtes Transcript in raw/youtube/<datum>-<slug>.md
    und verlinkt es in der Master-Video-Page (wiki/resources/videos/).

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
def pull_pending_transcripts(
    vault_id: str,
    playlist_name: str,
    with_timestamps: bool = False,
) -> dict:
    """Bulk-Pull aller pending Transcripts einer Playlist (Multi-Video-Orchestrator).

    Iteriert seriell über die Playlist-Items, prüft pro Video ob bereits ein
    Transcript existiert, triggert sonst die Chrome-Extension via WS-Bridge,
    speichert das Transcript und verlinkt es in der Master-Video-Page.

    Long-running: pro Item ~10-15s, deshalb httpx-Timeout 900s (15 Min).

    `summarize` ist absichtlich NICHT exposed — Claude Code soll Summaries
    selbst auf eigener Subscription schreiben.

    Returns: Statistik {total, transcribed, skipped_already_done, failed: [...],
    aborted, abort_reason}.
    """
    target = f"http://{config.HOST}:{config.PORT}/tools/playlists/{vault_id}/{playlist_name}/pull_pending"
    try:
        r = httpx.post(
            target,
            json={"with_timestamps": with_timestamps, "summarize": False},
            timeout=900,
        )
        if r.status_code == 503:
            return {"ok": False, "error": "Extension nicht verbunden — bitte Chrome-Extension öffnen."}
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
        return {"ok": False, "error": f"HTTP {e.response.status_code}: {e.response.text[:300]}"}


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


# --- Web-Scrape (Playwright, server-seitig — keine WS-Bridge nötig) --------

@mcp.tool()
async def scrape_url(url: str, mode: str = "content") -> dict:
    """Scrapt eine öffentliche URL via Playwright (System-Chrome) zu Markdown.

    Rendert JavaScript voll und klickt Accordeons/FAQs nativ auf — erfasst auch
    lazy-rendered Inhalte (Radix/React), die der Browser-Extension-Scraper nicht
    lesen kann. Läuft komplett im Server-Prozess, braucht keine Chrome-Extension.

    `mode`: 'content' (Hauptinhalt, Navigation/Footer gestrippt) oder 'full'.
    Returns: {ok: bool, data: {markdown, url, title, wordCount, mode}, error?: str}
    """
    return await web_scraper.scrape_url(url, mode)


if __name__ == "__main__":
    mcp.run()
