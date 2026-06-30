"""Chat with Vault — Karpathy-style. LLM navigates a vault's wiki via tool use.

Per-vault:
- Conversation history file: chat-<vault_id>.json
- System prompt comes from the vault's settings entry (user-edited or generated)
"""
from __future__ import annotations

import base64
import json
import logging
import re
import time
from collections.abc import Iterator
from datetime import date, datetime
from pathlib import Path

import httpx

import config
import i18n
import paths
import settings
from llm_client import active_allowed_for_sensitive, effective_llm_config, get_backend, get_backend_for
from tools import blueprint, bookmarks, notes_file, playlists, raw_promoter, sensitive, vault_audit, videos, wiki_reader

log = logging.getLogger("ewtosbrain.chat")

CHAT_DIR = paths.chat_dir()
DEFAULT_MODEL = "claude-opus-4-7"
DEFAULT_MAX_TURNS = 20
MAX_TOOL_ITERATIONS = 15
MAX_TOKENS_RESPONSE = 16000

BASE_SYSTEM_PROMPT = """You are an assistant for a Markdown vault. You help the owner find information in their vault — you are NOT the owner.

Your tools are described in the tool list (read/search vault, notes/todos/bookmarks, playlists, YouTube farming / writing wiki pages, web/media like scrape/SEO/image). When a tool applies is stated in its own description — follow it. Only some tools may be available; use only what is actually present.

The topic axis in the vault is the free frontmatter field `thema` (e.g. `ai`, `marketing`) — no topic folders, no whitelist. Videos/playlists live flat under `wiki/resources/`.

HONESTY (HARD): Only perform actions via tools. If a tool fails or a tool is missing (e.g. because it is not loaded in the current mode), say so clearly — **NEVER claim you created a file / farmed a video / saved something when no tool call actually did it.** No invented paths, titles, transcripts or numbers.

IMPORTANT: Note tools (todos/scratchpad/bookmarks) write to a GLOBAL inbox, not into the vault. For vague "note this / remember this" requests without a clearly intended vault file, the default is the scratchpad (`append_scratchpad`); if unclear, ask briefly.

SURGICAL EDITING: For small, targeted changes to existing files (changing or deleting a sentence/a line) use `edit_file` (exact find/replace, with automatic backup) — do NOT rewrite the whole file via `write_wiki_page`. Use `write_wiki_page` only for entirely new pages or full rewrites.

## Vault navigation
Strictly follow the vault conventions below — they come from the vault's CLAUDE.md and describe structure, routines, writing style. If it says "read index.md first" → do that. If a routine is described → follow it. Wikilinks `[[pagename]]` mean `read_file('<path>/pagename.md')` (the path follows from context).

Cite sources with "Source: <path>".
If you cannot find an answer in the vault, say so honestly — invent nothing. If a tool fails, report the error — NEVER confirm operations that were not carried out."""

DEFAULT_TAIL = """\n\n(No CLAUDE.md found in the vault — navigate as best you can using file and folder names. Start with `list_folder('')` to see the top-level structure.)"""


PROMPT_GENERATOR_INSTRUCTION = """Du bekommst gleich die CLAUDE.md eines Vaults (typischerweise ein Obsidian-Vault, oft nach Karpathy-Methode aufgebaut). Deine Aufgabe: schreib einen System-Prompt für einen anderen Assistenten (auch ein LLM), der diesen Vault als Wissensquelle nutzen soll, um Fragen seines Owners zu beantworten.

Der Assistent hat drei Tools:
- `list_folder(path)` — listet .md-Dateien und Unterordner an einem Pfad (leer = Vault-Root)
- `read_file(path)` — liest eine .md-Datei (Pfad relativ zum Vault-Root)
- `search_vault(q)` — case-insensitive Volltextsuche über alle .md-Dateien inkl. raw/

Der System-Prompt soll dem Assistenten klar machen:
1. Was im Vault liegt (Themen, Struktur, Konventionen, eventuelle Tagging-Logik)
2. Wo er einsteigt (z.B. index.md falls vorhanden, oder ein Logbuch)
3. Welchen Schreibstil/Tonfall der Owner pflegt (Sprache, formell/informell, siezen/duzen, Fluff vs. knapp etc.)
4. Wie er Quellen zitiert (z.B. "Quelle: <pfad>")
5. Dass er ehrlich ist wenn er etwas im Vault nicht findet — nichts erfinden
6. Bei konkreten Stichwort-/Themen-Fragen ZUERST `search_vault` aufrufen, dann Treffer mit `read_file` lesen. Index-Navigation bleibt für Überblicks-Fragen. Wenn die Vault-CLAUDE.md "Grep" erwähnt → `search_vault` ist dieses Grep.
7. WICHTIG: der Assistent ist NICHT der Vault-Owner. Er hilft dem Owner, Informationen aus dem Vault zu finden. Er soll nicht denken er sei selbst die Person die im Vault beschrieben wird.

Antworte ausschließlich mit dem fertigen System-Prompt — kein Drumherum, keine Erklärung, kein "Hier ist der Prompt:".

CLAUDE.md des Vaults:
---
{claude_md}
---"""


def _chat_file(vault_id: str) -> Path:
    return CHAT_DIR / f"chat-{vault_id}.json"


def _load_history(vault_id: str) -> list[dict]:
    f = _chat_file(vault_id)
    if not f.exists():
        return []
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
        return data.get("messages", [])
    except Exception:
        return []


def _save_history(vault_id: str, messages: list[dict]) -> None:
    _chat_file(vault_id).write_text(
        json.dumps({"started": date.today().isoformat(), "messages": messages}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _trim_history(messages: list[dict], max_turns: int) -> list[dict]:
    pairs = []
    current_pair = []
    for m in messages:
        current_pair.append(m)
        if m.get("role") == "assistant":
            pairs.append(current_pair)
            current_pair = []
    if current_pair:
        pairs.append(current_pair)
    if len(pairs) <= max_turns:
        return list(messages)
    kept = pairs[-max_turns:]
    return [m for pair in kept for m in pair]


SEARCH_TOOL_DEF = {
    "name": "search_vault",
    "description": "Case-insensitive full-text search across all .md files of the vault (incl. raw/). Returns matching paths + context snippets. Then read the relevant files fully with read_file.",
    "input_schema": {
        "type": "object",
        "properties": {
            "q": {"type": "string", "description": "Search term (matched case-insensitively)"},
            "max_results": {"type": "integer", "description": "Maximum number of matches (default: 30)"},
        },
        "required": ["q"],
    },
}

SEARCH_INSTRUCTION = """\n\n## Search strategy
For concrete keyword or topic questions ("what does X do", "find Y", "is there anything on Z", "explain Z") FIRST call `search_vault`, then read the matching files fully with `read_file`, then answer. Index/wikilink navigation stays for overview questions ("which topics", "what do you have"). If the vault's CLAUDE.md mentions "Grep" — `search_vault` is that Grep."""

TOOL_DEFS = [
    {
        "name": "list_folder",
        "description": "Lists .md files and subfolders at a path within the vault. Path is relative to the vault root. Empty or omitted path = vault root.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the folder relative to the vault root. Empty for root.",
                },
            },
        },
    },
    {
        "name": "read_file",
        "description": "Reads a .md file from the vault. Path is relative to the vault root.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path relative to the vault root"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "audit_vault",
        "description": "Read-only health check of the vault: finds orphans (pages not in the index), un-ingested raw files, broken wikilinks, missing required frontmatter and outdated CLAUDE.md sections. Use for 'check/lint my vault', 'is my vault clean', 'what's wrong'.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_todos",
        "description": "Shows all todos from the global todos list. Call BEFORE every update_todo to find the unique match.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "add_todo",
        "description": "Appends a new todo at the end of the list. Optionally with a due date.",
        "input_schema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "Todo text"},
                "due": {"type": "string", "description": "Optional. Format YYYY-MM-DD or YYYY-MM-DD HH:MM"},
            },
            "required": ["text"],
        },
    },
    {
        "name": "update_todo",
        "description": "Modifies an existing todo. action=complete/uncomplete/delete. match_text is matched as a substring (case-insensitive) against the todo texts. On an ambiguous match the tool raises an error — then ask the user.",
        "input_schema": {
            "type": "object",
            "properties": {
                "match_text": {"type": "string", "description": "Unique substring of the todo text"},
                "action": {"type": "string", "enum": ["complete", "uncomplete", "delete"]},
            },
            "required": ["match_text", "action"],
        },
    },
    {
        "name": "read_scratchpad",
        "description": "Reads the central free-form note file (scratchpad). Use this tool when the user asks 'what did I note', 'show my notes', 'what's in the scratchpad'.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "append_scratchpad",
        "description": "Appends a new note to the bottom of the central note file (scratchpad), with ## YYYY-MM-DD as a heading. DEFAULT TOOL for free-form notes — use it when the user says: 'note', 'remember', 'write down', 'jot this', 'keep this', 'save this', 'memo'. Never just confirm these requests with text without calling the tool.",
        "input_schema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "Content of the new note (without date header — the tool adds it)"},
            },
            "required": ["text"],
        },
    },
    {
        "name": "replace_scratchpad",
        "description": "Overwrites the ENTIRE scratchpad content. Only use when the user explicitly wants it ('delete everything', 'replace the scratchpad with ...'). For normal 'note' requests → append_scratchpad.",
        "input_schema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "New complete content"},
            },
            "required": ["content"],
        },
    },
    {
        "name": "list_bookmarks",
        "description": "Shows all saved bookmarks from notes/bookmarks.md. Use when the user asks 'what did I save', 'show my bookmarks', 'which urls did I save'.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "add_bookmark",
        "description": "Adds a URL to the bookmarks inbox. Use when the user says 'save URL X', 'bookmark this page', 'save the link X'. The date is set automatically.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "The URL (with http:// or https://)"},
                "title": {"type": "string", "description": "Optional. Title or description. Default = URL."},
                "note": {"type": "string", "description": "Optional. A short note."},
                "source": {"type": "string", "description": "Optional. Default 'manual'. Examples: chrome-tab, context-menu, multi-tab."},
            },
            "required": ["url"],
        },
    },
    {
        "name": "delete_bookmark",
        "description": "Deletes a bookmark by substring match on title or URL. On ambiguity raises an error — then ask the user.",
        "input_schema": {
            "type": "object",
            "properties": {
                "match": {"type": "string", "description": "Substring of title or URL"},
            },
            "required": ["match"],
        },
    },
    {
        "name": "list_playlists",
        "description": "Lists all playlists of the active vault (wiki/resources/playlists/). Each entry contains `name`, `slug`, `thema`, `path`, `item_count`. Requires write_playlists permission.",
        "input_schema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "create_playlist",
        "description": "Creates a new playlist at wiki/resources/playlists/<slug>.md with frontmatter (typ:playlist, titel, optional thema). On a duplicate name raises an error.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Readable name, e.g. 'AI Tutorials'"},
                "thema": {"type": "string", "description": "Optional. Free frontmatter field (e.g. 'ai', 'health', 'marketing')."},
            },
            "required": ["name"],
        },
    },
    {
        "name": "add_to_playlist",
        "description": "Adds a video to a playlist. IMMEDIATELY creates the master video page at wiki/resources/videos/<slug>.md (frontmatter with URL, channel, duration, thumbnail; body as a skeleton with pending summary/transcript), and writes a reference block into the playlist. IMPORTANT: When the user says 'add X to playlist Y' — CALL THIS TOOL. NEVER confirm success without the tool call. On success, report the content of the tool response. Duplicate check by URL.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Readable playlist name (as in create_playlist)"},
                "url": {"type": "string", "description": "URL of the video"},
                "title": {"type": "string", "description": "Visible title of the video"},
                "youtuber": {"type": "string", "description": "Optional. Channel name / YouTuber."},
                "dauer": {"type": "string", "description": "Optional. Format HH:MM or MM:SS."},
                "thema": {"type": "string", "description": "Optional. Free frontmatter field; otherwise inherited from the playlist."},
            },
            "required": ["name", "url", "title"],
        },
    },
    {
        "name": "remove_from_playlist",
        "description": "Removes an item by substring match (title or URL). On ambiguity raises an error.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Playlist name"},
                "match": {"type": "string", "description": "Substring of title or URL"},
            },
            "required": ["name", "match"],
        },
    },
    {
        "name": "promote_to_raw",
        "description": "Moves a scratchpad block or todo to vault/raw/<subfolder>/. Use for 'send X to raw', 'this is important for the vault', 'turn this into a source'. The date is set automatically. REQUIRES the write_raw permission on the active vault. On PermissionError pass the error through to the user verbatim.",
        "input_schema": {
            "type": "object",
            "properties": {
                "source": {"type": "string", "enum": ["scratchpad", "todos"]},
                "identifier": {
                    "type": "string",
                    "description": "For scratchpad: date YYYY-MM-DD or substring of the content. For todos: substring of the todo text.",
                },
                "target_subfolder": {
                    "type": "string",
                    "description": "Path under raw/, starting with: artikel, eigene-notizen, kunden-input/<kunde>, chat-archive",
                },
                "filename_slug": {
                    "type": "string",
                    "description": "Optional. Kebab-case slug without date. Otherwise generated from title or content.",
                },
                "title": {"type": "string", "description": "Optional. Title in frontmatter and H1."},
                "description": {"type": "string", "description": "Optional. Description in frontmatter and lead paragraph."},
            },
            "required": ["source", "identifier", "target_subfolder"],
        },
    },
    {
        "name": "pull_youtube",
        "description": "Pulls the transcript of a YouTube video (server API or Chrome extension) and creates a raw file under raw/youtube/. Use for '/farm <url>', 'farm this video', 'pull the transcript'. REQUIRES write_raw. Invent NO metadata — only what actually comes back.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "YouTube video URL."},
                "title": {"type": "string", "description": "Optional. Title if known, otherwise from the URL/ID."},
                "with_timestamps": {"type": "boolean", "description": "Optional, default false."},
            },
            "required": ["url"],
        },
    },
    {
        "name": "write_wiki_page",
        "description": "Writes/updates a .md file in the vault (e.g. wiki/resources/videos/<slug>.md). For ingest/curation: first read_file the raw source, then write the curated page here. REQUIRES write_files. On PermissionError pass the error through verbatim.",
        "input_schema": {
            "type": "object",
            "properties": {
                "rel_path": {"type": "string", "description": "Path relative to the vault root, ending in .md."},
                "content": {"type": "string", "description": "Full file content (frontmatter + markdown)."},
                "overwrite": {"type": "boolean", "description": "Optional. true = overwrite existing file. Default false (create new only)."},
            },
            "required": ["rel_path", "content"],
        },
    },
    {
        "name": "save_to_raw",
        "description": "Saves arbitrary content (article, note) to raw/<subfolder>/<date>-<slug>.md. REQUIRES write_raw. Subfolder: artikel, eigene-notizen, kunden-input/<kunde>, chat-archive.",
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "content": {"type": "string"},
                "target_subfolder": {"type": "string", "description": "artikel | eigene-notizen | kunden-input/<kunde> | chat-archive"},
                "description": {"type": "string", "description": "Optional."},
            },
            "required": ["title", "content", "target_subfolder"],
        },
    },
    {
        "name": "rebuild_indexes",
        "description": "Creates missing index.md hubs and rebuilds the ## Pages lists (mechanical, no LLM). Use for '/rebuild-index', 'clean up / rebuild indexes'. REQUIRES write_files.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "scrape_url",
        "description": "Loads ANY public URL server-side (Playwright, JS rendering) and returns it as clean markdown. Needs NO extension. Use this when the user names a concrete URL; for the page already open in the browser use page_scrape instead.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Full URL (with https://)."},
                "mode": {"type": "string", "description": "Optional. 'content' (default) = main content."},
            },
            "required": ["url"],
        },
    },
    {
        "name": "page_scrape",
        "description": "Scrapes the page CURRENTLY open in the browser (active tab) as clean markdown (without nav/footer/cookies), incl. FAQ. Requires the connected Chrome extension. For ANY URL use scrape_url instead.",
        "input_schema": {
            "type": "object",
            "properties": {
                "mode": {"type": "string", "description": "Optional. 'content' (default) = main content."},
            },
        },
    },
    {
        "name": "seo_check",
        "description": "SEO audit of the page CURRENTLY open in the browser (active tab): title, meta description, H1-H3 structure, canonical, OG/Twitter tags, viewport, robots. Requires the connected Chrome extension. For ANY URL use scrape_url instead.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "url_extractor",
        "description": "Extracts all link URLs of the page CURRENTLY open in the browser (active tab). Requires the connected Chrome extension.",
        "input_schema": {
            "type": "object",
            "properties": {
                "filter_domain": {"type": "boolean", "description": "Optional. true (default) = only links of the current domain."},
            },
        },
    },
    {
        "name": "image_analyse",
        "description": "Lists all images of the page CURRENTLY open in the browser (active tab) with alt-text check (missing alt attributes, dimensions). Requires the connected Chrome extension.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "color_picker",
        "description": "Pulls the color scheme of the page CURRENTLY open in the browser (active tab): CSS custom properties and computed key colors. Requires the connected Chrome extension.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "screenshot",
        "description": "Takes a screenshot of the visible area of the page CURRENTLY open in the browser (active tab). The image appears in the UI — you only get a confirmation, no image content. Requires the connected Chrome extension.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "generate_image",
        "description": "Generates an image from a text prompt (Gemini) and saves it as an asset in the vault (default folder 'assets/'). Returns the vault-relative path + the ready embed markdown line ![…](assets/…), which you can write into the open file e.g. with insert_into_open_file. REQUIRES write_files. Needs NO extension.",
        "input_schema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "Image description."},
                "model": {"type": "string", "description": "Optional. Default from settings."},
                "asset_subfolder": {"type": "string", "description": "Optional. Vault-root-relative target folder. Default 'assets'."},
            },
            "required": ["prompt"],
        },
    },
    {
        "name": "insert_into_open_file",
        "description": "Inserts text into the CURRENTLY open/pinned file (append at the end or after a heading). Use this for 'write this in here', 'insert the transcript/image into this file'. No rel_path — the target is always the pinned file. REQUIRES write_files and a file chat ('chat with this file').",
        "input_schema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "Markdown text to insert."},
                "position": {"type": "string", "enum": ["append", "after_heading"], "description": "Default append."},
                "after_heading": {"type": "string", "description": "For after_heading: exact heading text without #."},
            },
            "required": ["content"],
        },
    },
    {
        "name": "edit_file",
        "description": "Surgical change: replaces ONE exact text segment in a vault file with another — or deletes it (leave replace empty). USE THIS for small targeted changes ('delete this sentence', 'change this line') instead of rewriting the whole file via write_wiki_page. 'find' must occur EXACTLY and UNIQUELY (otherwise an error — then provide more context). rel_path optional, default is the pinned file. REQUIRES write_files.",
        "input_schema": {
            "type": "object",
            "properties": {
                "find": {"type": "string", "description": "Exact existing text incl. enough context (also line breaks) to be unique."},
                "replace": {"type": "string", "description": "New text. Empty = delete."},
                "rel_path": {"type": "string", "description": "Optional: path relative to the vault root. Default: pinned file."},
            },
            "required": ["find"],
        },
    },
]


# Read-only-Teilmenge: Navigation + (separat) Volltextsuche. search_vault über search_on.
_READONLY_TOOL_NAMES = {"list_folder", "read_file", "audit_vault"}
READONLY_TOOL_DEFS = [t for t in TOOL_DEFS if t["name"] in _READONLY_TOOL_NAMES]

# Notiz-Tools (global, kein Vault nötig) — in Vault- und File-Chat immer dabei.
_NOTES_TOOL_NAMES = {"list_todos", "add_todo", "update_todo", "read_scratchpad",
                     "append_scratchpad", "replace_scratchpad",
                     "list_bookmarks", "add_bookmark", "delete_bookmark"}
NOTES_TOOL_DEFS = [t for t in TOOL_DEFS if t["name"] in _NOTES_TOOL_NAMES]

# Bearbeiten der OFFENEN Datei (File-Chat mit Tools) — kein Farming/SEO/Media.
_FILE_EDIT_TOOL_NAMES = {"edit_file", "insert_into_open_file"}
FILE_EDIT_TOOL_DEFS = [t for t in TOOL_DEFS if t["name"] in _FILE_EDIT_TOOL_NAMES]

# Page-Chat „festhalten": Konversation in raw/ speichern (bestehendes Tool, kein Duplikat).
SAVE_RAW_DEF = next(t for t in TOOL_DEFS if t["name"] == "save_to_raw")

TOOL_LEVELS = ("none", "knowledge", "full")


# Demo-Modus: nur reine Lese-Tools (kein Schreiben, keine Browser-Bridge, keine
# kostenpflichtigen Media-/Image-Tools) — passend für eine öffentliche read-only-Instanz.
_DEMO_ALLOWED_TOOL_NAMES = {
    "list_folder", "read_file", "audit_vault", "search_vault",
    "list_todos", "read_scratchpad", "list_bookmarks", "list_playlists",
}


def _active_tools(mode: str, tool_level: str, search_on: bool) -> list[dict]:
    """Modus-bewusster Tool-Satz. mode: 'vault' | 'file' | 'page'.
    tool_level vom UI-Schalter: 'none' (kein Tool), 'knowledge' (modus-spezifischer
    Schlank-Satz), 'full' ('alle Tools' → volles Arsenal). 'full' gilt für Vault-
    UND Datei-Chat: nur so sind Wiki-Schreiben (write_wiki_page) und die Bild-/Web-
    Tools auch beim Arbeiten an einer Datei verfügbar."""
    if tool_level == "none":
        return []
    if config.DEMO_MODE:
        seen: set[str] = set()
        out: list[dict] = []
        for t in TOOL_DEFS + [SEARCH_TOOL_DEF]:
            if t["name"] in _DEMO_ALLOWED_TOOL_NAMES and t["name"] not in seen:
                seen.add(t["name"])
                out.append(t)
        return out
    search = [SEARCH_TOOL_DEF] if search_on else []
    expanded = tool_level == "full"
    # 'Alle Tools' = komplettes Arsenal, unabhängig davon ob Vault- oder Datei-Chat.
    if expanded and mode in ("vault", "file"):
        return TOOL_DEFS + search
    if mode == "page":
        # 'merken'-Modus: Notizen + Konversation in raw/ festhalten. Keine Vault-Navigation.
        return NOTES_TOOL_DEFS + [SAVE_RAW_DEF]
    if mode == "file":
        # Datei-Chat (Schlank-Satz): lesen, suchen, Notizen, die OFFENE Datei bearbeiten.
        return READONLY_TOOL_DEFS + NOTES_TOOL_DEFS + FILE_EDIT_TOOL_DEFS + search
    # vault (Schlank-Satz): lesen + suchen + Notizen.
    return READONLY_TOOL_DEFS + NOTES_TOOL_DEFS + search


def _norm_tool_level(value: str | None, default: str = "full") -> str:
    v = (value or "").strip().lower()
    return v if v in TOOL_LEVELS else default


_TOOL_GROUPS = [
    ("Vault lesen", ["list_folder", "read_file", "search_vault", "audit_vault"]),
    ("Notizen & Todos", ["list_todos", "add_todo", "update_todo", "read_scratchpad",
                         "append_scratchpad", "replace_scratchpad", "list_bookmarks",
                         "add_bookmark", "delete_bookmark"]),
    ("Playlists & Videos", ["list_playlists", "create_playlist", "add_to_playlist",
                            "remove_from_playlist"]),
    ("Schreiben & Farming", ["pull_youtube", "write_wiki_page", "edit_file", "save_to_raw",
                             "promote_to_raw", "rebuild_indexes", "insert_into_open_file"]),
    ("Web & Media", ["scrape_url", "page_scrape", "seo_check", "url_extractor", "image_analyse",
                     "color_picker", "screenshot", "generate_image"]),
]


def _tools_overview() -> str:
    """Markdown-Übersicht aller Chat-Tools, gruppiert. Wird aus TOOL_DEFS generiert,
    bleibt also automatisch synchron."""
    by_name = {t["name"]: t for t in TOOL_DEFS + [SEARCH_TOOL_DEF]}

    def _short(name: str) -> str:
        d = by_name[name]["description"].split(". ")[0].strip().rstrip(".")
        return d if len(d) <= 130 else d[:127].rstrip() + "…"

    seen: set[str] = set()
    lines = ["**Verfügbare Tools im Chat:**", ""]
    for title, names in _TOOL_GROUPS:
        group_lines = []
        for n in names:
            if n not in by_name:
                continue
            seen.add(n)
            group_lines.append(f"- `{n}` — {_short(n)}")
        if group_lines:
            lines.append(f"**{title}**")
            lines.extend(group_lines)
            lines.append("")
    rest = [n for n in by_name if n not in seen]
    if rest:
        lines.append("**Sonstige**")
        lines.extend(f"- `{n}` — {_short(n)}" for n in rest)
        lines.append("")
    lines.append("_Browser-Tools (page_scrape, seo_check, url_extractor, image_analyse, "
                 "color_picker, screenshot) brauchen die verbundene Chrome-Extension. "
                 "Schreib-Tools brauchen die jeweilige Vault-Berechtigung._")
    return "\n".join(lines)


def _format_folder_listing(result: dict) -> str:
    path_label = result["path"] or "(vault root)"
    lines = [f"Path: {path_label}"]
    if result["folders"]:
        lines.append("Subfolders:")
        lines.extend(f"  - {f}" for f in result["folders"])
    if result["files"]:
        lines.append("Files:")
        lines.extend(f"  - {f}" for f in result["files"])
    if not result["folders"] and not result["files"]:
        lines.append("(folder is empty)")
    return "\n".join(lines)


def _date_suffix() -> str:
    """Volatiler Zeitstempel — bewusst als ALLERLETZTES an den System-Prompt gehängt
    (nach allen stabilen Blöcken), damit der teure, cachebare Prefix (Base + CLAUDE.md
    + Tools + Suchanweisung) über alle Turns einer Session byte-identisch bleibt."""
    return f"\n\nCurrent date and time: {datetime.now().strftime('%Y-%m-%d %H:%M')}"


def _build_system_prompt(vault: dict, include_claude_md: bool = True) -> tuple[str, str]:
    """Return (prompt, source) where source is one of:
      - 'override'   — user-edited per-vault prompt is used (and replaces CLAUDE.md)
      - 'claude_md'  — vault has CLAUDE.md, base prompt + CLAUDE.md is used
      - 'default'    — no override, no CLAUDE.md → just base prompt + hint

    Der Zeitstempel wird hier NICHT angehängt — das macht der Aufrufer via _date_suffix()
    als letzten Schritt (Cache-Prefix stabil halten, siehe _date_suffix)."""
    lang_directive = (
        f"\n\nRespond to the user in {i18n.lang_name()} by default."
        f" Only respond in a different language if the user explicitly requests it."
    )
    override = (vault.get("system_prompt") or "").strip()
    if override:
        return override + lang_directive, "override"
    if include_claude_md:
        claude_md = wiki_reader.find_claude_md(vault["path"])
        if claude_md:
            return f"{BASE_SYSTEM_PROMPT}\n\n---\n\n# Vault conventions (from CLAUDE.md)\n\n{claude_md}" + lang_directive, "claude_md"
    return BASE_SYSTEM_PROMPT + DEFAULT_TAIL + lang_directive, "default"


def debug_context(vault_id: str, tool_level: str = "full", pinned_rel: str = "") -> dict:
    """Token-Breakdown für Debug-UI: System-Prompt, Tool-Defs, History."""
    vault = settings.get_vault(vault_id)
    if vault is None:
        raise LookupError(vault_id)

    has_pinned = bool((pinned_rel or "").strip())
    include_claude_md = not has_pinned
    system_prompt, prompt_src = _build_system_prompt(vault, include_claude_md=include_claude_md)
    norm_level = _norm_tool_level(tool_level, "full")
    search_on = settings.vault_permission(vault_id, "search_vault") is not False
    mode = "file" if has_pinned else "vault"
    tools = _active_tools(mode, norm_level, search_on)
    history = _load_history(vault_id)

    def _msg_chars(m: dict) -> int:
        c = m.get("content", "")
        if isinstance(c, list):
            return sum(len(str(p.get("text") or p.get("content") or "")) for p in c if isinstance(p, dict))
        return len(str(c or ""))

    tool_defs_str = json.dumps(tools, ensure_ascii=False)
    hist_chars = sum(_msg_chars(m) for m in history)
    est = lambda n: max(1, n // 4)

    full_system_prompt = system_prompt + _date_suffix()
    _, model = effective_llm_config()

    return {
        "vault_id": vault_id,
        "prompt_source": prompt_src,
        "tool_level": norm_level,
        "pinned_rel": pinned_rel or None,
        "system_prompt": system_prompt,
        "system_prompt_chars": len(system_prompt),
        "system_prompt_tokens_est": est(len(system_prompt)),
        "tool_count": len(tools),
        "tool_defs_chars": len(tool_defs_str),
        "tool_defs_tokens_est": est(len(tool_defs_str)),
        "history_messages": len(history),
        "history_chars": hist_chars,
        "history_tokens_est": est(hist_chars),
        "api_payload": {
            "model": model or DEFAULT_MODEL,
            "max_tokens": MAX_TOKENS_RESPONSE,
            "system": [{"type": "text", "text": full_system_prompt, "cache_control": {"type": "ephemeral"}}],
            "tools": tools,
            "messages": history,
            "_note": "Datei-Inhalt (bei Datei-Chat) + aktuelle Nutzernachricht werden beim echten Request zusätzlich an 'messages' angehängt.",
        },
    }


def _block_to_input(block) -> dict:
    """Convert a response content block to a dict safe for the next API call.

    The anthropic SDK's response models contain fields like `parsed_output` and
    `caller` that the input API rejects as 'extra inputs are not permitted'.
    We map each block type to the minimal input shape.
    """
    t = block.type
    if t == "text":
        out = {"type": "text", "text": block.text}
        cit = getattr(block, "citations", None)
        if cit:
            out["citations"] = cit
        return out
    if t == "tool_use":
        return {
            "type": "tool_use",
            "id": block.id,
            "name": block.name,
            "input": block.input,
        }
    if t == "thinking":
        out = {"type": "thinking", "thinking": block.thinking}
        sig = getattr(block, "signature", None)
        if sig:
            out["signature"] = sig
        return out
    if t == "redacted_thinking":
        return {"type": "redacted_thinking", "data": block.data}
    # Fallback: dump and strip response-only fields
    d = block.model_dump()
    for key in ("parsed_output", "caller"):
        d.pop(key, None)
    return d


def _format_todos(items: list[dict]) -> str:
    if not items:
        return "(no todos)"
    lines = []
    for it in items:
        check = "[x]" if it["done"] else "[ ]"
        due = f" @{it['due']}" if it["due"] else ""
        lines.append(f"- {check} {it['text']}{due}")
    return "\n".join(lines)


_SEVERITY_ICON = {"error": "🔴", "warn": "🟡", "info": "🔵"}


def _format_audit(report: dict) -> str:
    s = report.get("summary", {})
    sev = s.get("by_severity", {})
    lines = [
        f"**Vault audit:** {s.get('total', 0)} findings "
        f"({sev.get('error', 0)} 🔴, {sev.get('warn', 0)} 🟡, {sev.get('info', 0)} 🔵) "
        f"— {s.get('files_scanned', 0)} files scanned.",
    ]
    findings = report.get("findings", [])
    if not findings:
        return "Vault audit: no findings — all clean."
    for f in findings:
        icon = _SEVERITY_ICON.get(f["severity"], "•")
        path = f" `{f['path']}`" if f.get("path") else ""
        lines.append(f"- {icon} [{f['category']}]{path}: {f['message']} → {f['recommendation']}")
    has_claude = any(f["category"] == "claude_md_drift" for f in findings)
    if has_claude:
        lines.append("\n_A CLAUDE.md upgrade is available — the user can apply it in the sidepanel "
                     "('Vault health' → update CLAUDE.md) with a diff preview._")
    return "\n".join(lines)


def _call_server_tool(path: str, payload: dict, *, needs_browser: bool,
                      timeout: float = 90.0) -> tuple[dict | None, str | None]:
    """POST an den eigenen FastAPI-Endpoint (gleiches Muster wie pull_youtube).
    Returns (data, error_msg). timeout > config.TOOL_TIMEOUT_SECONDS, damit der
    Bridge-Timeout zuerst greift und der Client nicht vorher abbricht."""
    try:
        resp = httpx.post(f"http://{config.HOST}:{config.PORT}{path}", json=payload, timeout=timeout)
    except Exception as e:
        return None, f"Server tool not reachable (is the server running?): {e}"
    if resp.status_code == 503:
        if needs_browser:
            return None, ("Browser tool needs the connected Chrome extension. "
                          "Open the side panel / the extension and try again.")
        return None, f"Tool not available (HTTP 503): {resp.text[:200]}"
    if resp.status_code != 200:
        return None, f"Tool error HTTP {resp.status_code}: {resp.text[:200]}"
    try:
        return resp.json(), None
    except Exception:
        return None, "Tool returned no JSON"


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify_simple(text: str, max_len: int = 40) -> str:
    s = _SLUG_RE.sub("-", (text or "").strip().lower()).strip("-")
    return (s[:max_len].strip("-") or "image")


def _format_seo(d: dict) -> str:
    lines = ["SEO audit (active page):"]
    for label, key in (("URL", "url"), ("Title", "title"), ("Description", "description"),
                       ("Canonical", "canonical"), ("Viewport", "viewport"), ("Robots", "robots")):
        if d.get(key):
            lines.append(f"- {label}: {d[key]}")
    for key, label in (("h1", "H1"), ("h2", "H2"), ("h3", "H3")):
        v = d.get(key)
        if not v:
            continue
        if isinstance(v, list):
            lines.append(f"- {label}: " + " | ".join(str(x) for x in v[:10]))
        else:
            lines.append(f"- {label}: {v}")
    for label, key in (("OG-Title", "og_title"), ("OG-Description", "og_description"),
                       ("OG-Image", "og_image"), ("Twitter-Card", "twitter_card")):
        if d.get(key):
            lines.append(f"- {label}: {d[key]}")
    return "\n".join(lines)


def _insert_after_heading(text: str, heading: str, addition: str) -> tuple[str, bool]:
    """Fügt addition nach der Sektion der gegebenen Überschrift ein (vor der nächsten
    gleich- oder höherrangigen Überschrift). Returns (new_text, found)."""
    lines = text.splitlines()
    target = heading.strip().lstrip("#").strip().lower()
    h_idx, h_level = -1, 0
    for i, ln in enumerate(lines):
        m = re.match(r"^(#{1,6})\s+(.*)$", ln)
        if m and m.group(2).strip().lower() == target:
            h_idx, h_level = i, len(m.group(1))
            break
    if h_idx < 0:
        return text, False
    end = len(lines)
    for j in range(h_idx + 1, len(lines)):
        m = re.match(r"^(#{1,6})\s+", lines[j])
        if m and len(m.group(1)) <= h_level:
            end = j
            break
    new_lines = lines[:end] + ["", addition.strip(), ""] + lines[end:]
    return "\n".join(new_lines), True


def _execute_tool(name: str, tool_input: dict, vault_path: str, vault_id: str,
                  pinned_rel: str | None = None) -> tuple[str, bool]:
    log.info("Tool: %s input=%s", name, {k: (str(v)[:60] if isinstance(v, str) else v) for k, v in tool_input.items()})
    try:
        if name == "list_folder":
            rel = tool_input.get("path", "") or ""
            return _format_folder_listing(wiki_reader.list_folder(vault_path, rel)), False
        if name == "read_file":
            path = tool_input.get("path", "")
            content = wiki_reader.read_file(vault_path, path)
            blocked = sensitive.guard_text(content, vault_id=vault_id, rel_path=path)
            if blocked:
                return blocked, True
            return content, False
        if name == "search_vault":
            q = tool_input.get("q", "")
            hits = wiki_reader.search_files(vault_path, q, tool_input.get("max_results", 30))
            if not hits:
                return f"No matches for '{q}'.", False
            # DSGVO: Snippets sensibler Dateien nur ausgeben, wenn das aktive LLM dafür
            # freigegeben ist — sonst Pfad zeigen, Inhalt zurückhalten.
            allow_sensitive = active_allowed_for_sensitive()
            lines = []
            for h in hits:
                if not allow_sensitive and sensitive.is_file_sensitive(vault_path, h["rel_path"], vault_id):
                    lines.append(f"- {h['rel_path']}: {i18n.t('chat.search_hit_sensitive')}")
                else:
                    lines.append(f"- {h['rel_path']}: …{h['snippet']}…")
            return "\n".join(lines), False
        if name == "audit_vault":
            report = vault_audit.audit_vault(vault_id)
            return _format_audit(report), False
        if name == "list_todos":
            return _format_todos(notes_file.list_todos(vault_id=vault_id)), False
        if name == "add_todo":
            res = notes_file.add_todo(
                tool_input.get("text", ""), tool_input.get("due"), vault_id=vault_id,
            )
            due_str = f" (due {res['due']})" if res["due"] else ""
            return f"Todo added: {res['added']}{due_str}", False
        if name == "update_todo":
            res = notes_file.update_todo(
                tool_input.get("match_text", ""),
                tool_input.get("action", ""),
                vault_id=vault_id,
            )
            return f"{res['action']}: {res['todo']}", False
        if name == "read_scratchpad":
            data = notes_file.read_scratchpad(vault_id=vault_id)
            return data["content"] or "(scratchpad is empty)", False
        if name == "append_scratchpad":
            res = notes_file.append_scratchpad(tool_input.get("text", ""), vault_id=vault_id)
            return f"Scratchpad appended under date {res['date']}", False
        if name == "replace_scratchpad":
            res = notes_file.replace_scratchpad(tool_input.get("content", ""), vault_id=vault_id)
            note = " (previous version backed up)" if res.get("backup") else ""
            return f"Scratchpad replaced ({res['length']} chars){note}", False
        if name == "list_bookmarks":
            items = bookmarks.list_bookmarks(vault_id=vault_id)
            if not items:
                return "(no bookmarks saved)", False
            lines = []
            for it in items:
                line = f"- [{it['date']}] [{it['title']}]({it['url']})"
                if it["note"]:
                    line += f" — {it['note']}"
                if it["source"]:
                    line += f" (source: {it['source']})"
                lines.append(line)
            return "\n".join(lines), False
        if name == "add_bookmark":
            res = bookmarks.add_bookmark(
                tool_input.get("url", ""),
                tool_input.get("title"),
                tool_input.get("note"),
                tool_input.get("source") or "manual",
                vault_id=vault_id,
            )
            return f"Bookmark added: {res['added']} ({res['url']})", False
        if name == "delete_bookmark":
            res = bookmarks.delete_bookmark(tool_input.get("match", ""), vault_id=vault_id)
            return f"Bookmark deleted: {res['deleted']}", False
        if name == "list_playlists":
            pls = playlists.list_playlists(vault_id)
            if not pls:
                return "(no playlists in the active vault)", False
            lines = [
                f"- {p['name']}{' [' + p['thema'] + ']' if p.get('thema') else ''} ({p['item_count']} Items) → {p['path']}"
                for p in pls
            ]
            return "\n".join(lines), False
        if name == "create_playlist":
            res = playlists.create_playlist(
                vault_id,
                tool_input.get("name", ""),
                tool_input.get("thema"),
            )
            return f"Playlist '{res['name']}' created → {res['path']}", False
        if name == "add_to_playlist":
            res = playlists.add_to_playlist(
                vault_id,
                tool_input.get("name", ""),
                tool_input.get("url", ""),
                title=tool_input.get("title"),
                dauer=tool_input.get("dauer"),
                youtuber=tool_input.get("youtuber"),
                thema=tool_input.get("thema"),
            )
            if not res.get("added"):
                return f"Already in playlist (duplicate): {res.get('title') or res.get('url')}", False
            note = " — video page newly created" if res.get("video_created") else " — video page already existed, playlist list extended"
            return f"Added to '{res['name']}': {res['title']} → {res['video_page']}{note}", False
        if name == "remove_from_playlist":
            res = playlists.remove_from_playlist(
                vault_id,
                tool_input.get("name", ""),
                tool_input.get("match", ""),
            )
            return f"Removed: {res['title']}", False
        if name == "promote_to_raw":
            res = raw_promoter.promote_to_raw(
                vault_id=vault_id,
                source=tool_input.get("source", ""),
                identifier=tool_input.get("identifier", ""),
                target_subfolder=tool_input.get("target_subfolder", ""),
                filename_slug=tool_input.get("filename_slug"),
                title=tool_input.get("title"),
                description=tool_input.get("description"),
            )
            return (
                f"Promoted to {res['raw_path']}. {res['ingest_hint']}",
                False,
            )

        if name == "pull_youtube":
            url = (tool_input.get("url") or "").strip()
            if not url:
                return "url missing", True
            with_ts = bool(tool_input.get("with_timestamps"))
            try:
                resp = httpx.post(
                    f"http://{config.HOST}:{config.PORT}/tools/youtube_transcript",
                    json={"url": url, "with_timestamps": with_ts}, timeout=130,
                )
            except Exception as e:
                return f"YouTube pull not possible (is the server running, is the extension connected?): {e}", True
            if resp.status_code == 503:
                return ("No transcript: server API returned nothing and the Chrome extension "
                        "is not connected (browser fallback missing). Open the extension and try again."), True
            if resp.status_code != 200:
                return f"Transcript error HTTP {resp.status_code}: {resp.text[:200]}", True
            data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
            transcript = (data.get("transcript") or "").strip()
            if not transcript:
                return f"No transcript received: {str(data)[:200]}", True
            res = raw_promoter.save_video_to_raw(
                vault_id=vault_id, url=url,
                title=(data.get("title") or tool_input.get("title") or "").strip(),
                transcript=transcript, playlist_name="",
                channel=data.get("channel"), duration=data.get("duration"),
                views=data.get("views"), likes=data.get("likes"),
                upload_date=data.get("upload_date"), thumbnail_url=data.get("thumbnail_url"),
                description=data.get("description"),
            )
            meta_note = "incl. metadata" if data.get("channel") or data.get("views") is not None else "without metadata (yt-dlp/key?)"
            return (f"Transcript pulled ({len(transcript)} chars, {meta_note}) and saved: {res['raw_path']}. "
                    f"For the wiki page: use write_wiki_page (or /ingest in Claude Code).", False)

        if name == "write_wiki_page":
            if not settings.vault_permission(vault_id, "write_files"):
                return ("No write permission for files in this vault. Enable it in settings: "
                        "'EwtosBrain may edit and create .md files'."), True
            rel = (tool_input.get("rel_path") or "").strip()
            if not rel:
                return "rel_path missing", True
            if not rel.endswith(".md"):
                rel += ".md"
            content = tool_input.get("content") or ""
            try:
                wiki_reader.create_file(vault_path, rel, content)
                return f"Page created: {rel}", False
            except FileExistsError:
                if not tool_input.get("overwrite"):
                    return f"File already exists: {rel}. Set overwrite=true to overwrite.", True
                backup = wiki_reader.backup_file(vault_path, rel)
                wiki_reader.write_file(vault_path, rel, content)
                note = f" (previous version backed up: {backup})" if backup else ""
                return f"Page updated: {rel}{note}", False

        if name == "save_to_raw":
            res = raw_promoter.save_raw_content(
                vault_id=vault_id, title=tool_input.get("title", ""),
                content=tool_input.get("content", ""),
                target_subfolder=tool_input.get("target_subfolder", ""),
                description=tool_input.get("description"),
            )
            return f"Saved: {res['raw_path']}. {res['ingest_hint']}", False

        if name == "rebuild_indexes":
            if not settings.vault_permission(vault_id, "write_files"):
                return "No write permission (write_files) — enable it in settings to rebuild indexes.", True
            res = blueprint.rebuild_vault_indexes(vault_id)
            return (f"Indexes rebuilt: {len(res.get('created_hubs', []))} new hubs, "
                    f"{len(res.get('mocs_updated', []))} MOCs updated.", False)

        if name == "scrape_url":
            url = (tool_input.get("url") or "").strip()
            if not url:
                return "url missing", True
            data, err = _call_server_tool(
                "/tools/scrape_url", {"url": url, "mode": tool_input.get("mode", "content")},
                needs_browser=False, timeout=130,
            )
            if err:
                return err, True
            md = (data.get("markdown") or data.get("content") or "").strip()
            return (md[:12000] or "(no content detected)"), False

        if name == "page_scrape":
            data, err = _call_server_tool(
                "/tools/page_scrape", {"mode": tool_input.get("mode", "content")}, needs_browser=True,
            )
            if err:
                return err, True
            md = (data.get("markdown") or data.get("content") or "").strip()
            return (md[:12000] or "(no content detected)"), False

        if name == "seo_check":
            data, err = _call_server_tool("/tools/seo_check", {}, needs_browser=True)
            if err:
                return err, True
            return _format_seo(data), False

        if name == "url_extractor":
            data, err = _call_server_tool(
                "/tools/url_extractor", {"filter_domain": bool(tool_input.get("filter_domain", True))},
                needs_browser=True,
            )
            if err:
                return err, True
            urls = data.get("urls") or []
            if not urls:
                return "No links found.", False
            head = f"{data.get('count', len(urls))} links (base {data.get('base_url', '?')}):\n"
            return head + "\n".join(f"- {u}" for u in urls[:200]), False

        if name == "image_analyse":
            data, err = _call_server_tool("/tools/image_analyse", {}, needs_browser=True)
            if err:
                return err, True
            imgs = data.get("images") or []
            lines = [f"{data.get('total', len(imgs))} images, {data.get('missing_alt', 0)} without alt text:"]
            for im in imgs[:80]:
                alt = im.get("alt") or "(no alt)"
                lines.append(f"- {im.get('width', '?')}x{im.get('height', '?')} {alt} — {im.get('src', '')}")
            return "\n".join(lines), False

        if name == "color_picker":
            data, err = _call_server_tool("/tools/color_picker", {}, needs_browser=True)
            if err:
                return err, True
            return json.dumps(data, ensure_ascii=False, indent=2)[:3000], False

        if name == "screenshot":
            data, err = _call_server_tool("/tools/screenshot", {}, needs_browser=True)
            if err:
                return err, True
            return (f"Screenshot created ({data.get('format', 'png')}). "
                    "It is available in the UI — I cannot embed it as text."), False

        if name == "generate_image":
            if not settings.vault_permission(vault_id, "write_files"):
                return ("No write permission (write_files) — enable it in settings to save "
                        "generated images in the vault."), True
            prompt = (tool_input.get("prompt") or "").strip()
            if not prompt:
                return "prompt missing", True
            data, err = _call_server_tool(
                "/tools/image_generate", {"prompt": prompt, "model": tool_input.get("model")},
                needs_browser=False, timeout=200,
            )
            if err:
                return err, True
            if not data.get("ok"):
                return f"Image generation failed: {data.get('error')}", True
            try:
                raw = base64.b64decode(data["image_base64"])
            except Exception as e:
                return f"Image data invalid: {e}", True
            subfolder = (tool_input.get("asset_subfolder") or "assets").strip("/") or "assets"
            rel = f"{subfolder}/{int(time.time())}-{_slugify_simple(prompt)}.png"
            saved = wiki_reader.write_asset(vault_path, rel, raw)
            return (f"Image generated and saved at `{saved}` (relative to the vault root).\n"
                    f"SHOW the user the image by copying EXACTLY this markdown line unchanged into "
                    f"your answer (it renders inline in the chat):\n"
                    f"![{prompt[:80]}]({saved})"), False

        if name == "insert_into_open_file":
            if not settings.vault_permission(vault_id, "write_files"):
                return "No write permission (write_files) — enable it in settings.", True
            if not pinned_rel:
                return ("No file pinned — this tool only works in file chat "
                        "('chat with this file'). For other paths use write_wiki_page."), True
            add = tool_input.get("content") or ""
            if not add.strip():
                return "content missing", True
            existing = wiki_reader.read_file(vault_path, pinned_rel)
            heading = (tool_input.get("after_heading") or "").strip()
            if tool_input.get("position") == "after_heading" and heading:
                new, found = _insert_after_heading(existing, heading, add)
                if not found:
                    return f"Heading '{heading}' not found in {pinned_rel}.", True
            else:
                new = existing.rstrip() + "\n\n" + add.strip() + "\n"
            wiki_reader.write_file(vault_path, pinned_rel, new)
            return f"Inserted into {pinned_rel} ({len(add)} chars).", False

        if name == "edit_file":
            if not settings.vault_permission(vault_id, "write_files"):
                return "No write permission (write_files) — enable it in settings.", True
            rel = (tool_input.get("rel_path") or "").strip() or pinned_rel
            if not rel:
                return "No file specified (rel_path missing and no file chat active).", True
            find = tool_input.get("find") or ""
            if not find:
                return "find missing.", True
            replace = tool_input.get("replace") or ""
            existing = wiki_reader.read_file(vault_path, rel)
            count = existing.count(find)
            if count == 0:
                return f"Text not found in {rel} — nothing changed. Check the exact wording.", True
            if count > 1:
                return f"Text occurs {count}× in {rel} — not unique. Provide more surrounding context.", True
            new = existing.replace(find, replace)
            wiki_reader.write_file(vault_path, rel, new)
            action = "Deleted" if not replace.strip() else "Replaced"
            return f"{action} in {rel} ({len(find)} → {len(replace)} chars).", False

        return f"Unknown tool: {name}", True
    except PermissionError as e:
        return str(e), True
    except FileNotFoundError as e:
        return str(e), True
    except ValueError as e:
        return str(e), True
    except Exception as e:
        log.exception("Tool error")
        return f"Tool error: {e}", True


# --- Public API ------------------------------------------------------------

def load(vault_id: str) -> dict:
    vault = settings.get_vault(vault_id)
    if not vault:
        raise LookupError(f"Vault {vault_id} not found")
    _, source = _build_system_prompt(vault)
    return {
        "vault": vault,
        "messages": _load_history(vault_id),
        "model": effective_llm_config()[1] or DEFAULT_MODEL,
        "max_user_turns": settings.get("max_user_turns") or DEFAULT_MAX_TURNS,
        "prompt_source": source,
    }


def clear(vault_id: str) -> dict:
    vault = settings.get_vault(vault_id)
    if not vault:
        raise LookupError(f"Vault {vault_id} not found")
    f = _chat_file(vault_id)
    if f.exists():
        f.unlink()
    return {"cleared": True, "vault_id": vault_id}


_KNOWN_COMMANDS = {
    "farm": "The user called `/farm <url>`. Call the `pull_youtube` tool with the URL (pulls the transcript + creates a raw/youtube/ file), then briefly state the path + next step. Invent nothing.",
    "ingest": "The user called `/ingest <path>`. Read the named raw file with `read_file`, curate it (frontmatter typ/titel/status/zuletzt + sections like in templates/) and write the wiki page with `write_wiki_page` (e.g. wiki/resources/videos/<slug>.md).",
    "query": "The user called `/query <question>`. Answer FROM the wiki: start at wiki/index.md, navigate with read_file to relevant pages and back it up with [[wikilinks]]. Invent nothing.",
    "lint": "The user called `/lint`. Call `audit_vault` and report the findings grouped. For index/MOC fixes: offer `rebuild_indexes`.",
    "audit": "The user called `/audit`. Call `audit_vault` (read-only) and report the findings.",
    "rebuild-index": "The user called `/rebuild-index`. Call the `rebuild_indexes` tool and report the result.",
}


def _slash_route(message: str) -> dict | None:
    """None = kein Slash-Command. {'directive': ...} = bekanntes Kommando (an den LLM
    weiterreichen). {'reply': ...} = unbekannt → fester Reply, kein LLM-Call (keine Halluzination)."""
    if not message.startswith("/"):
        return None
    cmd = message[1:].split(None, 1)[0].lower().strip()
    if not cmd:
        return None
    if cmd in ("tools", "help"):
        return {"reply": _tools_overview()}
    if cmd in _KNOWN_COMMANDS:
        return {"directive": _KNOWN_COMMANDS[cmd]}
    return {"reply": (f"`/{cmd}` ist kein bekannter Befehl in diesem Chat. Verfügbar: "
                      "/tools (alle Tools), /farm <url>, /ingest <raw-pfad>, /query <frage>, "
                      "/lint, /audit, /rebuild-index. "
                      "Für freie Anfragen schreib einfach normal (ohne /).")}


def _cost_clause() -> str:
    """Im Hinweis-Modus: bittet den Chat, vor teurer LLM-Kuratierung auf API-Kosten +
    Claude-Code-Alternative hinzuweisen. Im Vollmodus leer."""
    if (settings.get("chat_heavy_ops_mode") or "full") == "hint":
        return ("\n\n## Cost-hint mode\n"
                "Before doing expensive LLM curation (ingest = writing a wiki page from a long transcript, "
                "summaries): remind the user ONCE briefly that this runs via the LLM configured here (API costs) "
                "and would be cheaper via Claude Code on the subscription — then continue if they want. "
                "Just execute mechanical work (pulling a transcript, writing a raw/ file, indexes, playlists).")
    return ""


def _zero_usage() -> dict:
    return {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}


def _pinned_section(vault_path: str, pinned_rel: str) -> str:
    """System-Prompt-Block, der die angeheftete Datei (Datei-Chat) bekanntmacht —
    analog zur page_context-Injektion."""
    try:
        content = wiki_reader.read_file(vault_path, pinned_rel)
    except Exception:
        content = ""
    return (
        "\n\n---\n\n## Currently open file\n"
        f"Path: `{pinned_rel}`\n"
        "When the user means 'in here', 'into this file', 'insert this' or similar, write with "
        "`insert_into_open_file` EXACTLY into this file (no rel_path needed). For a full rewrite "
        "use `write_wiki_page` with this path.\n\n"
        "Current content:\n```markdown\n" + content[:8000] + "\n```"
    )


def send(vault_id: str, user_message: str, page_context: str | None = None,
         pinned_file: dict | None = None, tool_level: str = "full") -> dict:
    vault = settings.get_vault(vault_id)
    if not vault:
        raise LookupError(f"Vault {vault_id} not found")

    user_message = (user_message or "").strip()
    if not user_message:
        raise ValueError("Empty message")

    _, model = effective_llm_config()
    model = model or DEFAULT_MODEL
    max_turns = int(settings.get("max_user_turns") or DEFAULT_MAX_TURNS)
    search_on = bool(settings.get("vault_search_enabled", True))
    pinned_rel = ((pinned_file or {}).get("rel_path") or "").strip() or None
    system_prompt, _ = _build_system_prompt(vault, include_claude_md=not bool(pinned_rel))
    if search_on:
        system_prompt += SEARCH_INSTRUCTION
    if page_context:
        system_prompt += "\n\n---\n\n## Currently open page in the browser\n\n" + page_context[:8000]
    if pinned_rel:
        blocked = sensitive.guard_file(vault["path"], pinned_rel, vault_id=vault.get("id"))
        if blocked:
            raise ValueError(blocked)
        system_prompt += _pinned_section(vault["path"], pinned_rel)

    route = _slash_route(user_message)
    if route and route.get("reply"):
        history = _load_history(vault_id)
        history.append({"role": "user", "content": user_message})
        history.append({"role": "assistant", "content": route["reply"]})
        _save_history(vault_id, history)
        return {"reply": route["reply"], "consulted": [], "messages": history, "usage": _zero_usage()}
    if route and route.get("directive"):
        system_prompt += "\n\n## Current command\n" + route["directive"]
    system_prompt += _cost_clause()
    system_prompt += _date_suffix()

    vault_path = vault["path"]
    mode = "file" if pinned_rel else "vault"
    active_tools = _active_tools(mode, _norm_tool_level(tool_level), search_on)

    history = _load_history(vault_id)
    history.append({"role": "user", "content": user_message})

    api_messages = [dict(m) for m in _trim_history(history, max_turns)]

    backend = get_backend()
    tool_iterations = 0
    consulted_files: list[str] = []

    while True:
        if tool_iterations >= MAX_TOOL_ITERATIONS:
            raise RuntimeError(f"Tool loop reached the iteration limit ({MAX_TOOL_ITERATIONS})")

        response = backend.complete(
            model=model,
            max_tokens=MAX_TOKENS_RESPONSE,
            system=[
                {"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}
            ],
            tools=active_tools,
            messages=api_messages,
        )

        api_messages.append({"role": "assistant", "content": [_block_to_input(b) for b in response.content]})

        if response.stop_reason == "tool_use":
            tool_iterations += 1
            tool_results = []
            for block in response.content:
                if block.type == "tool_use":
                    if block.name == "read_file":
                        consulted_files.append(block.input.get("path", "?"))
                    content, is_error = _execute_tool(block.name, block.input, vault_path, vault_id, pinned_rel=pinned_rel)
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": content,
                        "is_error": is_error,
                    })
            api_messages.append({"role": "user", "content": tool_results})
            continue

        final_text = "".join(b.text for b in response.content if b.type == "text").strip()
        if not final_text:
            final_text = "(keine Textantwort)"

        if settings.get("chat_show_sources", True) and consulted_files:
            unique = list(dict.fromkeys(consulted_files))
            refs = "\n".join(f"- `{f}`" for f in unique)
            final_text += f"\n\n---\n**Quellen:**\n{refs}"

        history.append({"role": "assistant", "content": final_text})
        _save_history(vault_id, history)

        return {
            "reply": final_text,
            "consulted": consulted_files,
            "messages": history,
            "usage": {
                "input_tokens": response.usage.input_tokens,
                "output_tokens": response.usage.output_tokens,
                "cache_read_input_tokens": getattr(response.usage, "cache_read_input_tokens", 0),
                "cache_creation_input_tokens": getattr(response.usage, "cache_creation_input_tokens", 0),
            },
        }


# --- Prompt generator ------------------------------------------------------

def generator_instruction(claude_md: str) -> str:
    """Return the full prompt-generator instruction with CLAUDE.md filled in.
    Useful for copying out and using with any external LLM."""
    return PROMPT_GENERATOR_INSTRUCTION.format(claude_md=claude_md)


def preview_claude_md(vault_path: str) -> str | None:
    return wiki_reader.find_claude_md(vault_path)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def resolve_source(source_type: str, source_ref: dict) -> tuple[str, str]:
    """Returns (title, content_text) for a chat source.

    source_type:
      - "page":       source_ref = {"content": str, "title"?: str}
      - "transcript": source_ref = {"vault_id": str, "rel_path": str}
      - "vault_file": source_ref = {"vault_id": str, "rel_path": str}
                     → einzelne .md-Datei aus dem Vault als Chat-Quelle.
      - "video":      source_ref = {"vault_id": str, "slug": str}
                     → Master-Page + verlinktes Transcript zusammengeführt.
    """
    if source_type == "page":
        return (source_ref.get("title") or "Seite", source_ref.get("content") or "")

    if source_type in ("transcript", "vault_file"):
        vault_id = source_ref.get("vault_id")
        rel_path = source_ref.get("rel_path")
        if not vault_id or not rel_path:
            raise ValueError(f"{source_type}-Quelle braucht vault_id und rel_path")
        vault = settings.get_vault(vault_id)
        if not vault:
            raise ValueError(f"Vault {vault_id} not found")
        text = wiki_reader.read_file(vault["path"], rel_path)
        title = rel_path if source_type == "vault_file" else Path(rel_path).stem
        return (title, text)

    if source_type == "video":
        vault_id = source_ref.get("vault_id")
        slug = source_ref.get("slug")
        if not vault_id or not slug:
            raise ValueError("video-Quelle braucht vault_id und slug")
        vault = settings.get_vault(vault_id)
        if not vault:
            raise ValueError(f"Vault {vault_id} not found")
        video = videos.get_video(vault_id, slug)
        if not video:
            raise ValueError(f"Video {slug} not found")
        blocked = sensitive.guard_meta(video["frontmatter"], vault_id=vault_id, rel_path=video.get("rel_path"))
        if blocked:
            raise ValueError(blocked)
        title = video["frontmatter"].get("titel") or slug
        master_body = video.get("body") or ""
        transcript_rel = str(video["frontmatter"].get("transcript") or "").strip()
        parts = [f"# {title}", "", "## Master-Page", "", master_body]
        if transcript_rel and transcript_rel.lower() != "pending":
            try:
                transcript_text = wiki_reader.read_file(vault["path"], transcript_rel)
                parts.extend(["", "## Transcript", "", transcript_text])
            except Exception as err:
                parts.extend(["", f"_(Transcript {transcript_rel} konnte nicht geladen werden: {err})_"])
        return (title, "\n".join(parts))

    raise ValueError(f"Unbekannter source_type: {source_type}")


# ---------------------------------------------------------------------------
# Text-emittierte Tool-Calls (Modelle ohne sauberes natives Function-Calling)
# ---------------------------------------------------------------------------
# Manche Backends (OpenRouter/Ollama/Mistral oder GPT-Modelle) schreiben Tool-Calls
# als XML in den Text-Stream statt ins native tool_calls-Feld. Wir fangen das ab,
# damit kein Roh-XML in der Antwort leakt und die Tools trotzdem ausgeführt werden.

_TOOL_MARKERS = ("<function_calls", "<invoke")
_INVOKE_RE = re.compile(r'<invoke\s+name="([^"]+)"\s*>(.*?)</invoke>', re.DOTALL)
_PARAM_RE = re.compile(r'<parameter\s+name="([^"]+)"\s*>(.*?)</parameter>', re.DOTALL)


def _extract_text_tool_calls(text: str) -> list[dict]:
    """Parst <invoke name="X"><parameter name="p">v</parameter></invoke>-Blöcke.
    Liefert [{"name", "input"}]. Parameter-Werte werden als JSON interpretiert
    (Zahlen/Booleans), sonst als String belassen."""
    calls: list[dict] = []
    for m in _INVOKE_RE.finditer(text):
        params: dict = {}
        for pm in _PARAM_RE.finditer(m.group(2)):
            raw = pm.group(2).strip()
            try:
                val = json.loads(raw)
            except Exception:
                val = raw
            params[pm.group(1).strip()] = val
        calls.append({"name": m.group(1).strip(), "input": params})
    return calls


def _first_marker_index(s: str) -> int:
    found = [i for i in (s.find(m) for m in _TOOL_MARKERS) if i != -1]
    return min(found) if found else -1


def _longest_partial_marker_suffix(s: str) -> int:
    """Länge des Endstücks von s, das Präfix eines Tool-Markers sein könnte —
    damit ein über Chunk-Grenzen zerrissener Marker nicht sichtbar durchrutscht."""
    best = 0
    for marker in _TOOL_MARKERS:
        for k in range(min(len(s), len(marker) - 1), 0, -1):
            if s.endswith(marker[:k]):
                best = max(best, k)
                break
    return best


class _ToolTextFilter:
    """Hält Tool-Call-XML aus dem sichtbaren Text-Stream zurück. Sobald ein Marker
    auftaucht, landet ab da alles im Capture-Puffer (für die Auswertung am Ende)."""

    def __init__(self):
        self._pending = ""
        self._captured: list[str] = []
        self._capturing = False

    def feed(self, chunk: str) -> str:
        if self._capturing:
            self._captured.append(chunk)
            return ""
        self._pending += chunk
        idx = _first_marker_index(self._pending)
        if idx != -1:
            safe = self._pending[:idx]
            self._captured.append(self._pending[idx:])
            self._pending = ""
            self._capturing = True
            return safe
        hold = _longest_partial_marker_suffix(self._pending)
        if hold:
            safe, self._pending = self._pending[:-hold], self._pending[-hold:]
        else:
            safe, self._pending = self._pending, ""
        return safe

    def flush(self) -> str:
        safe, self._pending = self._pending, ""
        return safe

    @property
    def captured_text(self) -> str:
        return "".join(self._captured)


def send_source_stream(
    source_type: str,
    source_ref: dict,
    user_message: str,
    history: list[dict],
    strict_source: bool = True,
    include_tools: bool = False,
    vault_id: str | None = None,
    tool_level: str | None = None,
) -> Iterator[str]:
    """SSE stream: chat about a single source (page / transcript / video).

    Ephemer — keine Persistenz, Historie kommt vom Client. Mit include_tools + vault_id
    steht der volle Tool-Satz zur Verfügung (z.B. Seiten-Chat: SEO/Scrape/Bild + Vault),
    die Quelle bleibt dabei System-Kontext (kein Vault-Verlauf wird vermischt)."""
    try:
        user_message = (user_message or "").strip()
        if not user_message:
            yield _sse("error", {"message": "Empty message"})
            return

        title, content_text = resolve_source(source_type, source_ref)

        blocked = sensitive.guard_text(
            content_text,
            vault_id=(source_ref or {}).get("vault_id"),
            rel_path=(source_ref or {}).get("rel_path"),
        )
        if blocked:
            yield _sse("error", {"message": blocked})
            return

        _, model = effective_llm_config()
        model = model or DEFAULT_MODEL

        if strict_source:
            knowledge_instruction = (
                "Answer based solely on this content.\n"
                "If the answer is not in the content, say so clearly — do not add external knowledge."
            )
        else:
            knowledge_instruction = (
                "Use the provided content as your primary source. You may add general knowledge\n"
                "to explain context — but make clear when you go beyond the content."
            )

        source_label = {
            "page": "page content",
            "transcript": "transcript",
            "vault_file": "vault file",
            "video": "video (master page + transcript)",
        }.get(source_type, "content")

        # Tool-Satz aus tool_level. Backward-compat: legacy include_tools → none/full.
        level = _norm_tool_level(tool_level, "full" if include_tools else "none")
        need_vault = level in ("knowledge", "full") and bool(vault_id)
        vault = settings.get_vault(vault_id) if need_vault else None
        vault_path = vault["path"] if vault else None
        search_on = bool(settings.get("vault_search_enabled", True))
        active_tools = _active_tools("page", level, search_on) if vault else []
        tools_note = (
            "\n\nYou also have tools to take notes (scratchpad/todos) and to save this "
            "conversation to the vault's raw/ folder. Use them only when the user asks to "
            "remember or keep something — the focus stays on the source shown above. "
            "Do not invent tool results; report errors honestly."
        ) if active_tools else ""

        system_prompt = (
            f'You answer questions about the following {source_label}: "{title}".\n'
            + knowledge_instruction + tools_note + "\n\n"
            "---\n\n" + content_text[:80000]
            + f"\n\nRespond to the user in {i18n.lang_name()} by default."
            " Only respond in a different language if the user explicitly requests it."
        )
        api_messages = list(history) + [{"role": "user", "content": user_message}]

        backend = get_backend()
        accumulated: list[str] = []
        usage = {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
        tool_iterations = 0

        while True:
            if tool_iterations >= MAX_TOOL_ITERATIONS:
                yield _sse("error", {"message": f"Tool loop reached the iteration limit ({MAX_TOOL_ITERATIONS})"})
                return

            stream = backend.stream_complete(
                model=model,
                max_tokens=MAX_TOKENS_RESPONSE,
                system=[{"type": "text", "text": system_prompt}],
                tools=active_tools,
                messages=api_messages,
            )
            tf = _ToolTextFilter()
            round_parts: list[str] = []
            for chunk in stream:
                safe = tf.feed(chunk)
                if safe:
                    round_parts.append(safe)
                    accumulated.append(safe)
                    yield _sse("text_delta", {"text": safe})
            safe = tf.flush()
            if safe:
                round_parts.append(safe)
                accumulated.append(safe)
                yield _sse("text_delta", {"text": safe})

            final = stream.get_final_result()
            usage["input_tokens"] += final.usage.input_tokens
            usage["output_tokens"] += final.usage.output_tokens
            usage["cache_read_input_tokens"] += getattr(final.usage, "cache_read_input_tokens", 0) or 0
            usage["cache_creation_input_tokens"] += getattr(final.usage, "cache_creation_input_tokens", 0) or 0

            # Text-emittierte Tool-Calls (nur, wenn die Tools auch aktiv sind)
            active_names = {t["name"] for t in active_tools}
            text_calls = (
                [c for c in _extract_text_tool_calls(tf.captured_text) if c["name"] in active_names]
                if (active_names and tf.captured_text and final.stop_reason != "tool_use")
                else []
            )

            if final.stop_reason != "tool_use" and not text_calls:
                final_text = "".join(accumulated).strip() or "(keine Textantwort)"
                new_history = list(history) + [
                    {"role": "user", "content": user_message},
                    {"role": "assistant", "content": final_text},
                ]
                yield _sse("done", {"messages": new_history, "consulted": [], "usage": usage, "source_title": title})
                return

            tool_iterations += 1
            tool_results = []
            if text_calls:
                assistant_blocks: list[dict] = []
                round_text = "".join(round_parts).strip()
                if round_text:
                    assistant_blocks.append({"type": "text", "text": round_text})
                for i, call in enumerate(text_calls):
                    tuid = f"texttool_{tool_iterations}_{i}"
                    assistant_blocks.append({"type": "tool_use", "id": tuid, "name": call["name"], "input": call["input"]})
                    yield _sse("tool_start", {"tool": call["name"], "input": call["input"]})
                    content, is_error = _execute_tool(call["name"], call["input"], vault_path, vault_id)
                    yield _sse("tool_end", {"tool": call["name"], "ok": not is_error})
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tuid,
                        "content": content,
                        "is_error": is_error,
                    })
                api_messages.append({"role": "assistant", "content": assistant_blocks})
                api_messages.append({"role": "user", "content": tool_results})
                continue

            api_messages.append({"role": "assistant", "content": [_block_to_input(b) for b in final.content]})
            for block in final.content:
                if block.type == "tool_use":
                    yield _sse("tool_start", {"tool": block.name, "input": block.input})
                    content, is_error = _execute_tool(block.name, block.input, vault_path, vault_id)
                    yield _sse("tool_end", {"tool": block.name, "ok": not is_error})
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": content,
                        "is_error": is_error,
                    })
            api_messages.append({"role": "user", "content": tool_results})
    except Exception as e:
        log.exception("Source chat streaming error")
        yield _sse("error", {"message": str(e)})


def send_page_stream(page_content: str, user_message: str, history: list[dict], strict_page: bool = True) -> Iterator[str]:
    """Backwards-compat wrapper. Use send_source_stream with source_type='page'."""
    yield from send_source_stream(
        "page",
        {"content": page_content},
        user_message,
        history,
        strict_source=strict_page,
    )


def send_general_stream(
    user_message: str,
    history: list[dict],
    provider: str | None = None,
    model: str | None = None,
) -> Iterator[str]:
    """SSE stream: vault-freier Allgemein-Chat.

    Ephemer (keine Persistenz), History kommt vom Client.
    provider/model: optionaler per-Request-Override; ohne Override → aktive Settings.
    """
    try:
        user_message = (user_message or "").strip()
        if not user_message:
            yield _sse("error", {"message": "Empty message"})
            return

        if provider:
            try:
                backend = get_backend_for(provider)
            except ValueError as e:
                yield _sse("error", {"message": str(e)})
                return
            use_model = (model or "").strip() or DEFAULT_MODEL
        else:
            backend = get_backend()
            _, cfg_model = effective_llm_config()
            use_model = (model or cfg_model or "").strip() or DEFAULT_MODEL

        system_prompt = (
            f"You are a helpful AI assistant."
            f"\n\nRespond to the user in {i18n.lang_name()} by default."
            " Only respond in a different language if the user explicitly requests it."
            + _date_suffix()
        )

        api_messages = list(history) + [{"role": "user", "content": user_message}]
        accumulated: list[str] = []
        usage = {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        }

        stream = backend.stream_complete(
            model=use_model,
            max_tokens=MAX_TOKENS_RESPONSE,
            system=[{"type": "text", "text": system_prompt}],
            tools=[],
            messages=api_messages,
        )
        for chunk in stream:
            accumulated.append(chunk)
            yield _sse("text_delta", {"text": chunk})

        final_message = stream.get_final_result()
        usage["input_tokens"] = final_message.usage.input_tokens
        usage["output_tokens"] = final_message.usage.output_tokens
        usage["cache_read_input_tokens"] = getattr(final_message.usage, "cache_read_input_tokens", 0) or 0

        final_text = "".join(accumulated).strip() or "(keine Textantwort)"
        new_history = list(history) + [
            {"role": "user", "content": user_message},
            {"role": "assistant", "content": final_text},
        ]
        yield _sse("done", {"messages": new_history, "usage": usage})

    except Exception as e:
        log.exception("General chat error")
        yield _sse("error", {"message": str(e)})


def send_stream(vault_id: str, user_message: str, page_context: str | None = None,
                pinned_file: dict | None = None, tool_level: str = "full") -> Iterator[str]:
    """SSE generator. Yields strings ready for StreamingResponse.

    Event types:
      - tool_start: {"tool": "...", "input": {...}}
      - tool_end:   {"tool": "...", "ok": bool}
      - text_delta: {"text": "..."}
      - done:       {"messages": [...], "consulted": [...], "usage": {...}}
      - error:      {"message": "..."}
    """
    try:
        vault = settings.get_vault(vault_id)
        if not vault:
            yield _sse("error", {"message": f"Vault {vault_id} not found"})
            return
        user_message = (user_message or "").strip()
        if not user_message:
            yield _sse("error", {"message": "Empty message"})
            return

        _, model = effective_llm_config()
        model = model or DEFAULT_MODEL
        max_turns = int(settings.get("max_user_turns") or DEFAULT_MAX_TURNS)
        search_on = bool(settings.get("vault_search_enabled", True))
        pinned_rel = ((pinned_file or {}).get("rel_path") or "").strip() or None
        system_prompt, _ = _build_system_prompt(vault, include_claude_md=not bool(pinned_rel))
        if search_on:
            system_prompt += SEARCH_INSTRUCTION
        if page_context:
            system_prompt += "\n\n---\n\n## Currently open page in the browser\n\n" + page_context[:8000]
        if pinned_rel:
            blocked = sensitive.guard_file(vault["path"], pinned_rel, vault_id=vault.get("id"))
            if blocked:
                yield _sse("error", {"message": blocked})
                return
            system_prompt += _pinned_section(vault["path"], pinned_rel)

        route = _slash_route(user_message)
        if route and route.get("reply"):
            history = _load_history(vault_id)
            history.append({"role": "user", "content": user_message})
            history.append({"role": "assistant", "content": route["reply"]})
            _save_history(vault_id, history)
            yield _sse("text_delta", {"text": route["reply"]})
            yield _sse("done", {"messages": history, "consulted": [], "usage": _zero_usage(), "vault": vault})
            return
        if route and route.get("directive"):
            system_prompt += "\n\n## Current command\n" + route["directive"]
        system_prompt += _cost_clause()
        system_prompt += _date_suffix()

        vault_path = vault["path"]
        mode = "file" if pinned_rel else "vault"
        active_tools = _active_tools(mode, _norm_tool_level(tool_level), search_on)

        history = _load_history(vault_id)
        history.append({"role": "user", "content": user_message})
        api_messages = [dict(m) for m in _trim_history(history, max_turns)]

        backend = get_backend()
        tool_iterations = 0
        consulted: list[str] = []
        accumulated_text: list[str] = []
        usage_total = {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        }

        while True:
            if tool_iterations >= MAX_TOOL_ITERATIONS:
                yield _sse("error", {"message": f"Tool loop reached the iteration limit ({MAX_TOOL_ITERATIONS})"})
                return

            stream = backend.stream_complete(
                model=model,
                max_tokens=MAX_TOKENS_RESPONSE,
                system=[{"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}],
                tools=active_tools,
                messages=api_messages,
            )
            tf = _ToolTextFilter()
            round_parts: list[str] = []
            for chunk in stream:
                safe = tf.feed(chunk)
                if safe:
                    round_parts.append(safe)
                    accumulated_text.append(safe)
                    yield _sse("text_delta", {"text": safe})
            safe = tf.flush()
            if safe:
                round_parts.append(safe)
                accumulated_text.append(safe)
                yield _sse("text_delta", {"text": safe})

            final_message = stream.get_final_result()

            usage_total["input_tokens"] += final_message.usage.input_tokens
            usage_total["output_tokens"] += final_message.usage.output_tokens
            usage_total["cache_read_input_tokens"] += getattr(final_message.usage, "cache_read_input_tokens", 0) or 0
            usage_total["cache_creation_input_tokens"] += getattr(final_message.usage, "cache_creation_input_tokens", 0) or 0

            # Text-emittierte Tool-Calls (Modelle ohne natives Function-Calling)
            active_names = {t["name"] for t in active_tools}
            text_calls = (
                [c for c in _extract_text_tool_calls(tf.captured_text) if c["name"] in active_names]
                if (active_names and tf.captured_text and final_message.stop_reason != "tool_use")
                else []
            )

            if final_message.stop_reason != "tool_use" and not text_calls:
                # End of conversation turn — persist and signal done
                final_text = "".join(accumulated_text).strip() or "(keine Textantwort)"

                if settings.get("chat_show_sources", True) and consulted:
                    unique = list(dict.fromkeys(consulted))
                    refs = "\n".join(f"- `{f}`" for f in unique)
                    final_text += f"\n\n---\n**Quellen:**\n{refs}"

                history.append({"role": "assistant", "content": final_text})
                _save_history(vault_id, history)
                yield _sse("done", {
                    "messages": history,
                    "consulted": consulted,
                    "usage": usage_total,
                    "vault": vault,
                })
                return

            # Execute tool calls and emit tool_start/tool_end events
            tool_iterations += 1
            tool_results = []
            if text_calls:
                assistant_blocks: list[dict] = []
                round_text = "".join(round_parts).strip()
                if round_text:
                    assistant_blocks.append({"type": "text", "text": round_text})
                for i, call in enumerate(text_calls):
                    tuid = f"texttool_{tool_iterations}_{i}"
                    if call["name"] == "read_file":
                        consulted.append(call["input"].get("path", "?"))
                    assistant_blocks.append({"type": "tool_use", "id": tuid, "name": call["name"], "input": call["input"]})
                    yield _sse("tool_start", {"tool": call["name"], "input": call["input"]})
                    content, is_error = _execute_tool(call["name"], call["input"], vault_path, vault_id, pinned_rel=pinned_rel)
                    yield _sse("tool_end", {"tool": call["name"], "ok": not is_error})
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tuid,
                        "content": content,
                        "is_error": is_error,
                    })
                api_messages.append({"role": "assistant", "content": assistant_blocks})
                api_messages.append({"role": "user", "content": tool_results})
                continue

            api_messages.append({"role": "assistant", "content": [_block_to_input(b) for b in final_message.content]})
            for block in final_message.content:
                if block.type == "tool_use":
                    if block.name == "read_file":
                        consulted.append(block.input.get("path", "?"))
                    yield _sse("tool_start", {"tool": block.name, "input": block.input})
                    content, is_error = _execute_tool(block.name, block.input, vault_path, vault_id, pinned_rel=pinned_rel)
                    yield _sse("tool_end", {"tool": block.name, "ok": not is_error})
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": content,
                        "is_error": is_error,
                    })
            api_messages.append({"role": "user", "content": tool_results})
    except Exception as e:
        log.exception("Streaming chat error")
        yield _sse("error", {"message": str(e)})


def generate_system_prompt(vault_path: str) -> dict:
    """Read CLAUDE.md from the vault and ask the LLM to generate a system prompt."""
    claude_md = wiki_reader.find_claude_md(vault_path)
    if not claude_md:
        raise FileNotFoundError(f"Keine CLAUDE.md im Vault-Pfad oder dessen Parent gefunden: {vault_path}")

    _, model = effective_llm_config()
    model = model or DEFAULT_MODEL
    backend = get_backend()
    response = backend.complete(
        model=model,
        max_tokens=4000,
        messages=[{"role": "user", "content": generator_instruction(claude_md)}],
    )
    text = "".join(b.text for b in response.content if b.type == "text").strip()
    return {
        "prompt": text,
        "claude_md_preview": claude_md[:1000],
        "claude_md_length": len(claude_md),
        "model": model,
    }
