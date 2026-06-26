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
import paths
import settings
from llm_client import effective_llm_config, get_backend
from tools import blueprint, bookmarks, notes_file, playlists, raw_promoter, vault_audit, videos, wiki_reader

log = logging.getLogger("ewtosbrain.chat")

CHAT_DIR = paths.chat_dir()
DEFAULT_MODEL = "claude-opus-4-7"
DEFAULT_MAX_TURNS = 20
MAX_TOOL_ITERATIONS = 15
MAX_TOKENS_RESPONSE = 16000

BASE_SYSTEM_PROMPT = """Du bist ein Assistent für einen Markdown-Vault. Du hilfst dem Owner Informationen aus seinem Vault zu finden — du bist NICHT der Owner.

## Vault-Lese-Tools
- `list_folder(path)` — listet .md-Dateien und Unterordner. Pfad relativ zum Vault-Root. Leer = Vault-Root.
- `read_file(path)` — liest eine .md-Datei. Pfad relativ zum Vault-Root.
- `search_vault(q)` — case-insensitive Volltextsuche über alle .md-Dateien (inkl. raw/). Gibt Treffer-Pfade + Snippets zurück. Danach gezielt mit `read_file` die relevanten Treffer lesen.
- `audit_vault()` — read-only Health-Check: Orphans, un-ingestete raw-Dateien, kaputte Wikilinks, fehlende Frontmatter, CLAUDE.md-Drift. Nutze bei „prüf/checke/lint meinen Vault". Du führst KEINE Reparaturen selbst aus — du berichtest die Befunde und empfiehlst den CLAUDE.md-Upgrade-Button im Sidepanel.

## Notiz-Tools (vault-übergreifend, eine zentrale Inbox)

**Todos** (`notes/todos.md`) — strukturierte Aufgabenliste:
- `list_todos()` — alle Todos mit done-Status und Due-Date.
- `add_todo(text, due?)` — neuen Todo am Ende anhängen. Due-Format: `YYYY-MM-DD` oder `YYYY-MM-DD HH:MM`.
- `update_todo(match_text, action)` — Todo abhaken (`complete`), Haken weg (`uncomplete`) oder löschen (`delete`). VOR jedem update_todo erst `list_todos` rufen. Bei mehrdeutigem Match Nutzer fragen — nicht raten.

**Scratchpad** (`notes/scratchpad.md`) — freier Notiz-Bereich. Nutze diese Tools wenn der Nutzer sagt: „**notiere**", „**merk dir das**", „**schreib auf**", „**leg eine Notiz ab**", „**halt fest**", „**Note**", „**Memo**", „**speicher das**" — solange er NICHT explizit eine Vault-Datei meint:
- `read_scratchpad()` — den Inhalt lesen.
- `append_scratchpad(text)` — neue Notiz unten anhängen, mit `## YYYY-MM-DD`-Überschrift. **Default-Tool** für „notiere/merk dir".
- `replace_scratchpad(content)` — GANZEN Inhalt überschreiben. Nur wenn Nutzer „lösch alles im Scratchpad", „ersetze den Scratchpad" o.ä. explizit fordert.

**Bookmarks** (`notes/bookmarks.md`) — schnelle URL-Inbox. Nutze diese Tools wenn der Nutzer sagt: „**merk URL**", „**bookmark**", „**speicher den link**", „**diese seite merken**", „**diese URL festhalten**":
- `list_bookmarks()` — alle gespeicherten Bookmarks zeigen.
- `add_bookmark(url, title?, note?, source?)` — neuen Bookmark anhängen, Datum automatisch.
- `delete_bookmark(match)` — Substring-Match auf Titel oder URL. Bei Mehrdeutigkeit Fehler — dann Nutzer fragen.

**Playlists** (`wiki/resources/playlists/<slug>.md` im aktiven Vault) — themen-kuratierte Sammlungen. Erfordert `write_playlists`-Recht auf dem aktiven Vault. Bei Permission-Fehler den Fehler 1:1 weitergeben:
- `list_playlists()` — alle Playlists des Vaults zeigen. Jeder Eintrag enthält ein `thema`-Feld.
- `create_playlist(name, thema?)` — neue Playlist anlegen unter `wiki/resources/playlists/<slug>.md`. `thema` ist ein freier Frontmatter-String (z.B. `ai`, `marketing`, `health`).
- `add_to_playlist(name, url, title?, dauer?, thema?)` — Eintrag hinzufügen. Master-Video-Page wird unter `wiki/resources/videos/` angelegt. `thema` wird sonst aus der Playlist geerbt.
- `remove_from_playlist(name, match)` — Eintrag per Substring-Match löschen.

**Themen-Hinweis:** Die Ordnerstruktur ist flach (PARA): Videos/Playlists liegen immer unter `wiki/resources/`. Die Themen-Achse ist das freie Frontmatter-Feld `thema` — keine Ordner, keine Whitelist. Wenn der Nutzer ein klares Thema nennt (z.B. Health, Marketing, Web-Development), setze es als `thema`.

Nutze die Tools wenn der Nutzer sagt: „leg playlist X an", „füg [URL] zu meiner [name]-Playlist hinzu", „zeig meine playlists", „nimm das aus der playlist raus".

**Promote zu raw** (`promote_to_raw`) — verschiebt einen Scratchpad-Block oder Todo in `vault/raw/<subfolder>/`. Nutze wenn der Nutzer sagt „schick X nach raw", „mach daraus eine Quelle", „das ist wichtig genug für den Vault", „promote nach raw". Datum wird automatisch gesetzt. Frag den Nutzer nach Titel + Beschreibung wenn nicht klar — beides optional, aber empfohlen. Subfolder muss eines sein: `artikel`, `eigene-notizen`, `kunden-input/<kunde>`, `chat-archive`. Erfordert das `write_raw`-Recht auf dem aktiven Vault — ohne Recht meldet das Tool einen Permission-Fehler, den du dem Nutzer 1:1 weitergibst (NICHT Erfolg behaupten, NICHT umschreiben). Wiki-Ingest passiert NICHT automatisch — am Schluss den Nutzer auf den ingest-Hint hinweisen den das Tool zurückgibt.

## Farming & Aufbau-Tools (führen ECHTE Aktionen aus — niemals nur so tun als ob)
- `pull_youtube(url)` — zieht das Transkript eines YouTube-Videos (über Server-API bzw. die Chrome-Extension) und legt eine Roh-Datei unter `raw/youtube/` an. Nutze bei „farm dieses Video", „/farm <url>", „zieh das Transkript". Erfordert `write_raw`. Metadaten wie Aufrufe/Likes nur wenn ein YouTube-API-Key gesetzt ist — sonst lass sie ehrlich offen, erfinde KEINE Zahlen/Titel.
- `write_wiki_page(rel_path, content, overwrite?)` — schreibt/aktualisiert eine `.md` im Vault (z.B. `wiki/resources/videos/<slug>.md`). So überführst du eine `raw/`-Quelle ins Wiki (Ingest/Kuratierung): erst `read_file` der raw-Datei, dann kuratierte Seite mit `write_wiki_page` schreiben. Erfordert `write_files`.
- `save_to_raw(title, content, target_subfolder, description?)` — beliebige Quelle (Artikel/Notiz) nach `raw/<subfolder>/` schreiben. Erfordert `write_raw`.
- `rebuild_indexes()` — legt fehlende `index.md`-Hubs an und baut die `## Pages`-Listen neu auf (mechanisch, kein LLM). Nutze bei „/rebuild-index" / „Indexe aufräumen". Erfordert `write_files`.

## Web/Media-Tools
- `scrape_url(url)` — lädt eine BELIEBIGE öffentliche URL server-seitig (Playwright, JS-Rendering) als Markdown. Braucht KEINE Extension. Nutze dies wenn der Nutzer eine konkrete URL nennt.
- `page_scrape(mode?)`, `seo_check()`, `url_extractor(filter_domain?)`, `image_analyse()`, `color_picker()`, `screenshot()` — arbeiten auf der AKTUELL im Browser geöffneten Seite (aktiver Tab) und brauchen die verbundene Chrome-Extension. Meldet ein Tool, die Extension sei nicht verbunden, gib das dem Nutzer 1:1 weiter — behaupte NICHT, du hättest die Seite analysiert.
- `generate_image(prompt)` — erzeugt ein Bild (Gemini), speichert es als Vault-Asset und liefert die fertige `![…](assets/…)`-Embed-Zeile zurück (z.B. mit `insert_into_open_file` in die offene Datei schreiben). Erfordert `write_files`. Braucht KEINE Extension.
- `insert_into_open_file(content, position?)` — fügt Text in die GERADE GEÖFFNETE/angeheftete Datei ein (Append oder nach einer Überschrift). Nutze dies für „schreib das hier rein", „füg das Transkript/Bild in diese Datei ein". Nur im Datei-Chat verfügbar. Erfordert `write_files`.

EHRLICHKEIT (HART): Führe Aktionen NUR über diese Tools aus. Wenn ein Tool fehlschlägt oder dir ein Tool fehlt, sag das klar — **behaupte NIEMALS, du hättest eine Datei angelegt/ein Video gefarmt/etwas gespeichert, wenn kein Tool-Call das wirklich getan hat.** Keine erfundenen Pfade, Titel, Transkripte oder Zahlen.

WICHTIG: Notiz-Tools schreiben in einer GLOBALEN Notiz-Datei, nicht im Vault. Wenn unklar ist, ob der Nutzer eine Vault-Page oder den Scratchpad meint, frage kurz nach. Default bei vagen „notiere"-Anfragen: Scratchpad.

## Vault-Navigation
Halte dich strikt an die Vault-Konventionen unten — sie kommen aus der CLAUDE.md des Vaults und beschreiben Struktur, Routinen, Schreibstil. Wenn dort steht "lies erst index.md" → tu das. Wenn dort eine Routine beschrieben ist → folge ihr. Wikilinks `[[seitenname]]` heißen `read_file('<pfad>/seitenname.md')` (Pfad ergibt sich aus dem Kontext).

Quellen zitieren mit "Quelle: <pfad>".
Wenn du im Vault keine Antwort findest, sag das ehrlich — erfinde nichts. Wenn ein Todo-/Scratchpad-Tool fehlschlägt, melde den Fehler — bestätige NIEMALS Operationen die nicht ausgeführt wurden."""

DEFAULT_TAIL = """\n\n(Kein CLAUDE.md im Vault gefunden — navigiere bestmöglich anhand der Datei- und Ordnernamen. Beginne mit `list_folder('')` um die oberste Struktur zu sehen.)"""


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
    "description": "Case-insensitive Volltextsuche über alle .md-Dateien des Vaults (inkl. raw/). Gibt Treffer-Pfade + Kontext-Snippets zurück. Danach gezielt mit read_file die relevanten Dateien vollständig lesen.",
    "input_schema": {
        "type": "object",
        "properties": {
            "q": {"type": "string", "description": "Suchbegriff (wird case-insensitive gematcht)"},
            "max_results": {"type": "integer", "description": "Maximale Treffer-Anzahl (Default: 30)"},
        },
        "required": ["q"],
    },
}

SEARCH_INSTRUCTION = """\n\n## Such-Strategie
Bei konkreten Stichwort- oder Themen-Fragen ("was macht X", "finde Y", "gibt es was zu Z", "erkläre mir Z") ZUERST `search_vault` aufrufen, dann die Treffer-Dateien mit `read_file` vollständig lesen und dann antworten. Index-/Wikilink-Navigation bleibt für Überblicks-Fragen ("welche Themen", "was hast du alles"). Wenn die Vault-CLAUDE.md "Grep" erwähnt — `search_vault` ist dieses Grep."""

TOOL_DEFS = [
    {
        "name": "list_folder",
        "description": "Listet .md-Dateien und Unterordner an einem Pfad innerhalb des Vaults. Pfad ist relativ zum Vault-Root. Leerer Pfad oder ausgelassen = Vault-Root.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Pfad zum Ordner relativ zum Vault-Root. Leer für Root.",
                },
            },
        },
    },
    {
        "name": "read_file",
        "description": "Liest eine .md-Datei aus dem Vault. Pfad ist relativ zum Vault-Root.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Pfad relativ zum Vault-Root"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "audit_vault",
        "description": "Read-only Health-Check des Vaults: findet Orphans (Pages nicht im Index), un-ingestete raw-Dateien, kaputte Wikilinks, fehlende Pflicht-Frontmatter und veraltete CLAUDE.md-Sektionen. Nutze bei 'prüf/checke/lint meinen Vault', 'ist mein Vault sauber', 'was stimmt nicht'.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_todos",
        "description": "Zeigt alle Todos aus der globalen Todos-Liste. VOR jedem update_todo aufrufen, um den eindeutigen Treffer zu finden.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "add_todo",
        "description": "Hängt einen neuen Todo am Ende der Liste an. Optional mit Fälligkeitsdatum.",
        "input_schema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "Todo-Text"},
                "due": {"type": "string", "description": "Optional. Format YYYY-MM-DD oder YYYY-MM-DD HH:MM"},
            },
            "required": ["text"],
        },
    },
    {
        "name": "update_todo",
        "description": "Verändert ein bestehendes Todo. action=complete/uncomplete/delete. match_text wird per Substring (case-insensitive) gegen die Todo-Texte gematcht. Bei mehrdeutigem Match wirft das Tool einen Fehler — dann Nutzer fragen.",
        "input_schema": {
            "type": "object",
            "properties": {
                "match_text": {"type": "string", "description": "Eindeutiger Substring des Todo-Texts"},
                "action": {"type": "string", "enum": ["complete", "uncomplete", "delete"]},
            },
            "required": ["match_text", "action"],
        },
    },
    {
        "name": "read_scratchpad",
        "description": "Liest die zentrale freie Notiz-Datei (Scratchpad). Nutze dieses Tool wenn der Nutzer fragt 'was hab ich notiert', 'zeig meine notizen', 'was steht im scratchpad'.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "append_scratchpad",
        "description": "Hängt eine neue Notiz unten an die zentrale Notiz-Datei (Scratchpad), mit ## YYYY-MM-DD als Überschrift. DEFAULT-TOOL für freie Notizen — nutze es wenn der Nutzer sagt: 'notiere', 'merk dir', 'schreib auf', 'leg eine note ab', 'halt fest', 'speicher das', 'memo', 'note'. Niemals diese Anfragen einfach mit Text bestätigen ohne das Tool zu rufen.",
        "input_schema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "Inhalt der neuen Notiz (ohne Datums-Header — das macht das Tool)"},
            },
            "required": ["text"],
        },
    },
    {
        "name": "replace_scratchpad",
        "description": "Überschreibt den GANZEN Scratchpad-Inhalt. Nur nutzen wenn der Nutzer das explizit will ('lösch alles', 'ersetze den scratchpad mit ...'). Bei normalen 'notiere'-Anfragen → append_scratchpad.",
        "input_schema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "Neuer kompletter Inhalt"},
            },
            "required": ["content"],
        },
    },
    {
        "name": "list_bookmarks",
        "description": "Zeigt alle gespeicherten Bookmarks aus notes/bookmarks.md. Nutze wenn der Nutzer fragt 'was hab ich gemerkt', 'zeig meine bookmarks', 'welche urls hab ich gespeichert'.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "add_bookmark",
        "description": "Fügt eine URL zur Bookmarks-Inbox hinzu. Nutze wenn der Nutzer sagt 'merk URL X', 'bookmark diese seite', 'speicher den link X'. Datum wird automatisch gesetzt.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Die URL (mit http:// oder https://)"},
                "title": {"type": "string", "description": "Optional. Titel oder Beschreibung. Default = URL."},
                "note": {"type": "string", "description": "Optional. Eine kurze Notiz."},
                "source": {"type": "string", "description": "Optional. Default 'manual'. Beispiele: chrome-tab, context-menu, multi-tab."},
            },
            "required": ["url"],
        },
    },
    {
        "name": "delete_bookmark",
        "description": "Löscht einen Bookmark per Substring-Match auf Titel oder URL. Bei Mehrdeutigkeit Fehler — dann Nutzer fragen.",
        "input_schema": {
            "type": "object",
            "properties": {
                "match": {"type": "string", "description": "Substring von Titel oder URL"},
            },
            "required": ["match"],
        },
    },
    {
        "name": "list_playlists",
        "description": "Listet alle Playlists des aktiven Vaults (wiki/resources/playlists/). Jeder Eintrag enthält `name`, `slug`, `thema`, `path`, `item_count`. Erfordert write_playlists-Recht.",
        "input_schema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "create_playlist",
        "description": "Legt eine neue Playlist an unter wiki/resources/playlists/<slug>.md mit Frontmatter (typ:playlist, titel, optional thema). Bei doppeltem Namen Fehler.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Lesbarer Name, z.B. 'KI Tutorials'"},
                "thema": {"type": "string", "description": "Optional. Freies Frontmatter-Feld (z.B. 'ai', 'health', 'marketing')."},
            },
            "required": ["name"],
        },
    },
    {
        "name": "add_to_playlist",
        "description": "Fügt ein Video zu einer Playlist hinzu. Erzeugt SOFORT die Master-Video-Page in wiki/resources/videos/<slug>.md (Frontmatter mit URL, Kanal, Dauer, Thumbnail; Body als Skeleton mit pending Summary/Transkript), und schreibt einen Referenz-Block in die Playlist. WICHTIG: Wenn der Nutzer sagt 'füg X zur playlist Y hinzu' — RUFE DIESES TOOL. Bestätige NIEMALS Erfolg ohne den Tool-Aufruf. Bei Erfolg melde den Inhalt der Tool-Antwort. Duplikat-Check per URL.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Lesbarer Playlist-Name (wie bei create_playlist)"},
                "url": {"type": "string", "description": "URL des Videos"},
                "title": {"type": "string", "description": "Sichtbarer Titel des Videos"},
                "youtuber": {"type": "string", "description": "Optional. Channel-Name / YouTuber."},
                "dauer": {"type": "string", "description": "Optional. Format HH:MM oder MM:SS."},
                "thema": {"type": "string", "description": "Optional. Freies Frontmatter-Feld; wird sonst aus der Playlist geerbt."},
            },
            "required": ["name", "url", "title"],
        },
    },
    {
        "name": "remove_from_playlist",
        "description": "Entfernt ein Item per Substring-Match (Titel oder URL). Bei Mehrdeutigkeit Fehler.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Playlist-Name"},
                "match": {"type": "string", "description": "Substring von Titel oder URL"},
            },
            "required": ["name", "match"],
        },
    },
    {
        "name": "promote_to_raw",
        "description": "Bewegt einen Scratchpad-Block oder Todo nach vault/raw/<subfolder>/. Nutze für 'schick X nach raw', 'das ist wichtig für den Vault', 'mach daraus eine Quelle'. Datum wird automatisch gesetzt. ERFORDERT das write_raw-Recht auf dem aktiven Vault. Bei PermissionError den Fehler 1:1 an den Nutzer weitergeben.",
        "input_schema": {
            "type": "object",
            "properties": {
                "source": {"type": "string", "enum": ["scratchpad", "todos"]},
                "identifier": {
                    "type": "string",
                    "description": "Bei scratchpad: Datum YYYY-MM-DD oder Substring des Inhalts. Bei todos: Substring des Todo-Texts.",
                },
                "target_subfolder": {
                    "type": "string",
                    "description": "Pfad unter raw/, beginnend mit: artikel, eigene-notizen, kunden-input/<kunde>, chat-archive",
                },
                "filename_slug": {
                    "type": "string",
                    "description": "Optional. Kebab-case Slug ohne Datum. Wird sonst aus title oder Inhalt generiert.",
                },
                "title": {"type": "string", "description": "Optional. Titel im Frontmatter und H1."},
                "description": {"type": "string", "description": "Optional. Beschreibung im Frontmatter und Lead-Absatz."},
            },
            "required": ["source", "identifier", "target_subfolder"],
        },
    },
    {
        "name": "pull_youtube",
        "description": "Zieht das Transkript eines YouTube-Videos (Server-API oder Chrome-Extension) und legt eine Roh-Datei unter raw/youtube/ an. Nutze für '/farm <url>', 'farm dieses Video', 'zieh das Transkript'. ERFORDERT write_raw. Erfinde KEINE Metadaten — nur was wirklich kommt.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "YouTube-Video-URL."},
                "title": {"type": "string", "description": "Optional. Titel falls bekannt, sonst aus der URL/ID."},
                "with_timestamps": {"type": "boolean", "description": "Optional, Default false."},
            },
            "required": ["url"],
        },
    },
    {
        "name": "write_wiki_page",
        "description": "Schreibt/aktualisiert eine .md-Datei im Vault (z.B. wiki/resources/videos/<slug>.md). Für Ingest/Kuratierung: erst read_file der raw-Quelle, dann kuratierte Seite hier schreiben. ERFORDERT write_files. Bei PermissionError den Fehler 1:1 weitergeben.",
        "input_schema": {
            "type": "object",
            "properties": {
                "rel_path": {"type": "string", "description": "Pfad relativ zum Vault-Root, endet auf .md."},
                "content": {"type": "string", "description": "Vollständiger Datei-Inhalt (Frontmatter + Markdown)."},
                "overwrite": {"type": "boolean", "description": "Optional. true = bestehende Datei überschreiben. Default false (nur neu anlegen)."},
            },
            "required": ["rel_path", "content"],
        },
    },
    {
        "name": "save_to_raw",
        "description": "Speichert beliebigen Inhalt (Artikel, Notiz) nach raw/<subfolder>/<datum>-<slug>.md. ERFORDERT write_raw. Subfolder: artikel, eigene-notizen, kunden-input/<kunde>, chat-archive.",
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
        "description": "Legt fehlende index.md-Hubs an und baut die ## Pages-Listen neu auf (mechanisch, kein LLM). Nutze für '/rebuild-index', 'Indexe aufräumen/neu aufbauen'. ERFORDERT write_files.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "scrape_url",
        "description": "Lädt eine BELIEBIGE öffentliche URL server-seitig (Playwright, JS-Rendering) und gibt sie als sauberes Markdown zurück. Braucht KEINE Extension. Nutze dies wenn der Nutzer eine konkrete URL nennt; für die schon im Browser offene Seite stattdessen page_scrape.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Vollständige URL (mit https://)."},
                "mode": {"type": "string", "description": "Optional. 'content' (Default) = Hauptinhalt."},
            },
            "required": ["url"],
        },
    },
    {
        "name": "page_scrape",
        "description": "Scrapt die AKTUELL im Browser geöffnete Seite (aktiver Tab) als sauberes Markdown (ohne Nav/Footer/Cookies), inkl. FAQ. Erfordert die verbundene Chrome-Extension. Für eine BELIEBIGE URL stattdessen scrape_url nutzen.",
        "input_schema": {
            "type": "object",
            "properties": {
                "mode": {"type": "string", "description": "Optional. 'content' (Default) = Hauptinhalt."},
            },
        },
    },
    {
        "name": "seo_check",
        "description": "SEO-Audit der AKTUELL im Browser geöffneten Seite (aktiver Tab): Title, Meta-Description, H1-H3-Struktur, Canonical, OG/Twitter-Tags, Viewport, Robots. Erfordert die verbundene Chrome-Extension. Für eine BELIEBIGE URL stattdessen scrape_url nutzen.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "url_extractor",
        "description": "Extrahiert alle Link-URLs der AKTUELL im Browser geöffneten Seite (aktiver Tab). Erfordert die verbundene Chrome-Extension.",
        "input_schema": {
            "type": "object",
            "properties": {
                "filter_domain": {"type": "boolean", "description": "Optional. true (Default) = nur Links der aktuellen Domain."},
            },
        },
    },
    {
        "name": "image_analyse",
        "description": "Listet alle Bilder der AKTUELL im Browser geöffneten Seite (aktiver Tab) mit Alt-Text-Check (fehlende alt-Attribute, Dimensionen). Erfordert die verbundene Chrome-Extension.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "color_picker",
        "description": "Zieht das Farbschema der AKTUELL im Browser geöffneten Seite (aktiver Tab): CSS-Custom-Properties und berechnete Schlüsselfarben. Erfordert die verbundene Chrome-Extension.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "screenshot",
        "description": "Macht einen Screenshot des sichtbaren Bereichs der AKTUELL im Browser geöffneten Seite (aktiver Tab). Das Bild erscheint im UI — du bekommst nur eine Bestätigung, keinen Bildinhalt. Erfordert die verbundene Chrome-Extension.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "generate_image",
        "description": "Erzeugt ein Bild aus einem Text-Prompt (Gemini) und speichert es als Asset im Vault (Default-Ordner 'assets/'). Gibt den vault-relativen Pfad + die fertige Embed-Markdown-Zeile ![…](assets/…) zurück, die du z.B. mit insert_into_open_file in die offene Datei schreiben kannst. ERFORDERT write_files. Braucht KEINE Extension.",
        "input_schema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "Bildbeschreibung."},
                "model": {"type": "string", "description": "Optional. Default aus den Einstellungen."},
                "asset_subfolder": {"type": "string", "description": "Optional. Vault-root-relativer Zielordner. Default 'assets'."},
            },
            "required": ["prompt"],
        },
    },
    {
        "name": "insert_into_open_file",
        "description": "Fügt Text in die GERADE GEÖFFNETE/angeheftete Datei ein (Append ans Ende oder nach einer Überschrift). Nutze dies für 'schreib das hier rein', 'füg das Transkript/Bild in diese Datei ein'. Kein rel_path — Ziel ist immer die angeheftete Datei. ERFORDERT write_files und einen Datei-Chat ('Mit dieser Datei chatten').",
        "input_schema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "Einzufügender Markdown-Text."},
                "position": {"type": "string", "enum": ["append", "after_heading"], "description": "Default append."},
                "after_heading": {"type": "string", "description": "Bei after_heading: exakter Überschriften-Text ohne #."},
            },
            "required": ["content"],
        },
    },
]


_TOOL_GROUPS = [
    ("Vault lesen", ["list_folder", "read_file", "search_vault", "audit_vault"]),
    ("Notizen & Todos", ["list_todos", "add_todo", "update_todo", "read_scratchpad",
                         "append_scratchpad", "replace_scratchpad", "list_bookmarks",
                         "add_bookmark", "delete_bookmark"]),
    ("Playlists & Videos", ["list_playlists", "create_playlist", "add_to_playlist",
                            "remove_from_playlist"]),
    ("Schreiben & Farming", ["pull_youtube", "write_wiki_page", "save_to_raw", "promote_to_raw",
                             "rebuild_indexes", "insert_into_open_file"]),
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
    path_label = result["path"] or "(Vault-Root)"
    lines = [f"Pfad: {path_label}"]
    if result["folders"]:
        lines.append("Unterordner:")
        lines.extend(f"  - {f}" for f in result["folders"])
    if result["files"]:
        lines.append("Dateien:")
        lines.extend(f"  - {f}" for f in result["files"])
    if not result["folders"] and not result["files"]:
        lines.append("(Ordner ist leer)")
    return "\n".join(lines)


def _build_system_prompt(vault: dict) -> tuple[str, str]:
    """Return (prompt, source) where source is one of:
      - 'override'   — user-edited per-vault prompt is used (and replaces CLAUDE.md)
      - 'claude_md'  — vault has CLAUDE.md, base prompt + CLAUDE.md is used
      - 'default'    — no override, no CLAUDE.md → just base prompt + hint
    """
    date_line = f"Aktuelles Datum und Uhrzeit: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n\n"
    override = (vault.get("system_prompt") or "").strip()
    if override:
        return date_line + override, "override"
    claude_md = wiki_reader.find_claude_md(vault["path"])
    if claude_md:
        return date_line + f"{BASE_SYSTEM_PROMPT}\n\n---\n\n# Vault-Konventionen (aus CLAUDE.md)\n\n{claude_md}", "claude_md"
    return date_line + BASE_SYSTEM_PROMPT + DEFAULT_TAIL, "default"


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
        return "(keine Todos)"
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
        f"**Vault-Audit:** {s.get('total', 0)} Befunde "
        f"({sev.get('error', 0)} 🔴, {sev.get('warn', 0)} 🟡, {sev.get('info', 0)} 🔵) "
        f"— {s.get('files_scanned', 0)} Dateien gescannt.",
    ]
    findings = report.get("findings", [])
    if not findings:
        return "Vault-Audit: keine Befunde — alles sauber."
    for f in findings:
        icon = _SEVERITY_ICON.get(f["severity"], "•")
        path = f" `{f['path']}`" if f.get("path") else ""
        lines.append(f"- {icon} [{f['category']}]{path}: {f['message']} → {f['recommendation']}")
    has_claude = any(f["category"] == "claude_md_drift" for f in findings)
    if has_claude:
        lines.append("\n_CLAUDE.md-Upgrade ist verfügbar — der Nutzer kann es im Sidepanel "
                     "('Vault-Gesundheit' → CLAUDE.md aktualisieren) mit Diff-Vorschau anwenden._")
    return "\n".join(lines)


def _call_server_tool(path: str, payload: dict, *, needs_browser: bool,
                      timeout: float = 90.0) -> tuple[dict | None, str | None]:
    """POST an den eigenen FastAPI-Endpoint (gleiches Muster wie pull_youtube).
    Returns (data, error_msg). timeout > config.TOOL_TIMEOUT_SECONDS, damit der
    Bridge-Timeout zuerst greift und der Client nicht vorher abbricht."""
    try:
        resp = httpx.post(f"http://{config.HOST}:{config.PORT}{path}", json=payload, timeout=timeout)
    except Exception as e:
        return None, f"Server-Tool nicht erreichbar (läuft der Server?): {e}"
    if resp.status_code == 503:
        if needs_browser:
            return None, ("Browser-Tool braucht die verbundene Chrome-Extension. "
                          "Öffne das Side-Panel/die Extension und versuch es erneut.")
        return None, f"Tool nicht verfügbar (HTTP 503): {resp.text[:200]}"
    if resp.status_code != 200:
        return None, f"Tool-Fehler HTTP {resp.status_code}: {resp.text[:200]}"
    try:
        return resp.json(), None
    except Exception:
        return None, "Tool lieferte kein JSON"


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify_simple(text: str, max_len: int = 40) -> str:
    s = _SLUG_RE.sub("-", (text or "").strip().lower()).strip("-")
    return (s[:max_len].strip("-") or "bild")


def _format_seo(d: dict) -> str:
    lines = ["SEO-Audit (aktive Seite):"]
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
            return wiki_reader.read_file(vault_path, path), False
        if name == "search_vault":
            q = tool_input.get("q", "")
            hits = wiki_reader.search_files(vault_path, q, tool_input.get("max_results", 30))
            if not hits:
                return f"Keine Treffer für '{q}'.", False
            return "\n".join(f"- {h['rel_path']}: …{h['snippet']}…" for h in hits), False
        if name == "audit_vault":
            report = vault_audit.audit_vault(vault_id)
            return _format_audit(report), False
        if name == "list_todos":
            return _format_todos(notes_file.list_todos(vault_id=vault_id)), False
        if name == "add_todo":
            res = notes_file.add_todo(
                tool_input.get("text", ""), tool_input.get("due"), vault_id=vault_id,
            )
            due_str = f" (fällig {res['due']})" if res["due"] else ""
            return f"Todo hinzugefügt: {res['added']}{due_str}", False
        if name == "update_todo":
            res = notes_file.update_todo(
                tool_input.get("match_text", ""),
                tool_input.get("action", ""),
                vault_id=vault_id,
            )
            return f"{res['action']}: {res['todo']}", False
        if name == "read_scratchpad":
            data = notes_file.read_scratchpad(vault_id=vault_id)
            return data["content"] or "(Scratchpad ist leer)", False
        if name == "append_scratchpad":
            res = notes_file.append_scratchpad(tool_input.get("text", ""), vault_id=vault_id)
            return f"Scratchpad ergänzt unter Datum {res['date']}", False
        if name == "replace_scratchpad":
            res = notes_file.replace_scratchpad(tool_input.get("content", ""), vault_id=vault_id)
            note = " (vorherige Version gesichert)" if res.get("backup") else ""
            return f"Scratchpad ersetzt ({res['length']} Zeichen){note}", False
        if name == "list_bookmarks":
            items = bookmarks.list_bookmarks(vault_id=vault_id)
            if not items:
                return "(keine Bookmarks gespeichert)", False
            lines = []
            for it in items:
                line = f"- [{it['date']}] [{it['title']}]({it['url']})"
                if it["note"]:
                    line += f" — {it['note']}"
                if it["source"]:
                    line += f" (quelle: {it['source']})"
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
            return f"Bookmark hinzugefügt: {res['added']} ({res['url']})", False
        if name == "delete_bookmark":
            res = bookmarks.delete_bookmark(tool_input.get("match", ""), vault_id=vault_id)
            return f"Bookmark gelöscht: {res['deleted']}", False
        if name == "list_playlists":
            pls = playlists.list_playlists(vault_id)
            if not pls:
                return "(keine Playlists im aktiven Vault)", False
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
            return f"Playlist '{res['name']}' angelegt → {res['path']}", False
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
                return f"Bereits in Playlist (Duplikat): {res.get('title') or res.get('url')}", False
            note = " — Video-Page neu angelegt" if res.get("video_created") else " — Video-Page existierte schon, Playlist-Liste erweitert"
            return f"Hinzugefügt zu '{res['name']}': {res['title']} → {res['video_page']}{note}", False
        if name == "remove_from_playlist":
            res = playlists.remove_from_playlist(
                vault_id,
                tool_input.get("name", ""),
                tool_input.get("match", ""),
            )
            return f"Entfernt: {res['title']}", False
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
                f"Promotet nach {res['raw_path']}. {res['ingest_hint']}",
                False,
            )

        if name == "pull_youtube":
            url = (tool_input.get("url") or "").strip()
            if not url:
                return "url fehlt", True
            with_ts = bool(tool_input.get("with_timestamps"))
            try:
                resp = httpx.post(
                    f"http://{config.HOST}:{config.PORT}/tools/youtube_transcript",
                    json={"url": url, "with_timestamps": with_ts}, timeout=130,
                )
            except Exception as e:
                return f"YouTube-Pull nicht möglich (läuft der Server, ist die Extension verbunden?): {e}", True
            if resp.status_code == 503:
                return ("Kein Transkript: Server-API hat nichts geliefert und die Chrome-Extension "
                        "ist nicht verbunden (Browser-Fallback fehlt). Extension öffnen und erneut versuchen."), True
            if resp.status_code != 200:
                return f"Transkript-Fehler HTTP {resp.status_code}: {resp.text[:200]}", True
            data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
            transcript = (data.get("transcript") or "").strip()
            if not transcript:
                return f"Kein Transkript erhalten: {str(data)[:200]}", True
            res = raw_promoter.save_video_to_raw(
                vault_id=vault_id, url=url,
                title=(data.get("title") or tool_input.get("title") or "").strip(),
                transcript=transcript, playlist_name="",
                channel=data.get("channel"), duration=data.get("duration"),
                views=data.get("views"), likes=data.get("likes"),
                upload_date=data.get("upload_date"), thumbnail_url=data.get("thumbnail_url"),
                description=data.get("description"),
            )
            meta_note = "inkl. Metadaten" if data.get("channel") or data.get("views") is not None else "ohne Metadaten (yt-dlp/Key?)"
            return (f"Transkript gezogen ({len(transcript)} Zeichen, {meta_note}) und gespeichert: {res['raw_path']}. "
                    f"Für die Wiki-Seite: write_wiki_page nutzen (oder /ingest in Claude Code).", False)

        if name == "write_wiki_page":
            if not settings.vault_permission(vault_id, "write_files"):
                return ("Kein Schreibrecht auf Dateien in diesem Vault. In den Einstellungen aktivieren: "
                        "'EwtosBrain darf .md-Dateien bearbeiten und neue anlegen'."), True
            rel = (tool_input.get("rel_path") or "").strip()
            if not rel:
                return "rel_path fehlt", True
            if not rel.endswith(".md"):
                rel += ".md"
            content = tool_input.get("content") or ""
            try:
                wiki_reader.create_file(vault_path, rel, content)
                return f"Seite angelegt: {rel}", False
            except FileExistsError:
                if not tool_input.get("overwrite"):
                    return f"Datei existiert bereits: {rel}. Setze overwrite=true zum Überschreiben.", True
                backup = wiki_reader.backup_file(vault_path, rel)
                wiki_reader.write_file(vault_path, rel, content)
                note = f" (vorherige Version gesichert: {backup})" if backup else ""
                return f"Seite aktualisiert: {rel}{note}", False

        if name == "save_to_raw":
            res = raw_promoter.save_raw_content(
                vault_id=vault_id, title=tool_input.get("title", ""),
                content=tool_input.get("content", ""),
                target_subfolder=tool_input.get("target_subfolder", ""),
                description=tool_input.get("description"),
            )
            return f"Gespeichert: {res['raw_path']}. {res['ingest_hint']}", False

        if name == "rebuild_indexes":
            if not settings.vault_permission(vault_id, "write_files"):
                return "Kein Schreibrecht (write_files) — für den Index-Aufbau in den Einstellungen aktivieren.", True
            res = blueprint.rebuild_vault_indexes(vault_id)
            return (f"Indexe aufgebaut: {len(res.get('created_hubs', []))} neue Hubs, "
                    f"{len(res.get('mocs_updated', []))} MOCs aktualisiert.", False)

        if name == "scrape_url":
            url = (tool_input.get("url") or "").strip()
            if not url:
                return "url fehlt", True
            data, err = _call_server_tool(
                "/tools/scrape_url", {"url": url, "mode": tool_input.get("mode", "content")},
                needs_browser=False, timeout=130,
            )
            if err:
                return err, True
            md = (data.get("markdown") or data.get("content") or "").strip()
            return (md[:12000] or "(kein Inhalt erkannt)"), False

        if name == "page_scrape":
            data, err = _call_server_tool(
                "/tools/page_scrape", {"mode": tool_input.get("mode", "content")}, needs_browser=True,
            )
            if err:
                return err, True
            md = (data.get("markdown") or data.get("content") or "").strip()
            return (md[:12000] or "(kein Inhalt erkannt)"), False

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
                return "Keine Links gefunden.", False
            head = f"{data.get('count', len(urls))} Links (Basis {data.get('base_url', '?')}):\n"
            return head + "\n".join(f"- {u}" for u in urls[:200]), False

        if name == "image_analyse":
            data, err = _call_server_tool("/tools/image_analyse", {}, needs_browser=True)
            if err:
                return err, True
            imgs = data.get("images") or []
            lines = [f"{data.get('total', len(imgs))} Bilder, {data.get('missing_alt', 0)} ohne alt-Text:"]
            for im in imgs[:80]:
                alt = im.get("alt") or "(kein alt)"
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
            return (f"Screenshot erstellt ({data.get('format', 'png')}). "
                    "Er ist im UI verfügbar — als Text kann ich ihn nicht einbetten."), False

        if name == "generate_image":
            if not settings.vault_permission(vault_id, "write_files"):
                return ("Kein Schreibrecht (write_files) — zum Speichern generierter Bilder im Vault "
                        "in den Einstellungen aktivieren."), True
            prompt = (tool_input.get("prompt") or "").strip()
            if not prompt:
                return "prompt fehlt", True
            data, err = _call_server_tool(
                "/tools/image_generate", {"prompt": prompt, "model": tool_input.get("model")},
                needs_browser=False, timeout=200,
            )
            if err:
                return err, True
            if not data.get("ok"):
                return f"Bild-Generierung fehlgeschlagen: {data.get('error')}", True
            try:
                raw = base64.b64decode(data["image_base64"])
            except Exception as e:
                return f"Bild-Daten ungültig: {e}", True
            subfolder = (tool_input.get("asset_subfolder") or "assets").strip("/") or "assets"
            rel = f"{subfolder}/{int(time.time())}-{_slugify_simple(prompt)}.png"
            saved = wiki_reader.write_asset(vault_path, rel, raw)
            return (f"Bild generiert und gespeichert unter `{saved}` (relativ zum Vault-Root).\n"
                    f"ZEIGE dem Nutzer das Bild, indem du GENAU diese Markdown-Zeile unverändert in "
                    f"deine Antwort übernimmst (sie rendert inline im Chat):\n"
                    f"![{prompt[:80]}]({saved})"), False

        if name == "insert_into_open_file":
            if not settings.vault_permission(vault_id, "write_files"):
                return "Kein Schreibrecht (write_files) — in den Einstellungen aktivieren.", True
            if not pinned_rel:
                return ("Keine Datei angeheftet — dieses Tool funktioniert nur im Datei-Chat "
                        "('Mit dieser Datei chatten'). Für andere Pfade write_wiki_page nutzen."), True
            add = tool_input.get("content") or ""
            if not add.strip():
                return "content fehlt", True
            existing = wiki_reader.read_file(vault_path, pinned_rel)
            heading = (tool_input.get("after_heading") or "").strip()
            if tool_input.get("position") == "after_heading" and heading:
                new, found = _insert_after_heading(existing, heading, add)
                if not found:
                    return f"Überschrift '{heading}' nicht gefunden in {pinned_rel}.", True
            else:
                new = existing.rstrip() + "\n\n" + add.strip() + "\n"
            wiki_reader.write_file(vault_path, pinned_rel, new)
            return f"In {pinned_rel} eingefügt ({len(add)} Zeichen).", False

        return f"Unbekanntes Tool: {name}", True
    except PermissionError as e:
        return str(e), True
    except FileNotFoundError as e:
        return str(e), True
    except ValueError as e:
        return str(e), True
    except Exception as e:
        log.exception("Tool error")
        return f"Tool-Fehler: {e}", True


# --- Public API ------------------------------------------------------------

def load(vault_id: str) -> dict:
    vault = settings.get_vault(vault_id)
    if not vault:
        raise LookupError(f"Vault {vault_id} nicht gefunden")
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
        raise LookupError(f"Vault {vault_id} nicht gefunden")
    f = _chat_file(vault_id)
    if f.exists():
        f.unlink()
    return {"cleared": True, "vault_id": vault_id}


_KNOWN_COMMANDS = {
    "farm": "Der Nutzer hat `/farm <url>` aufgerufen. Rufe das Tool `pull_youtube` mit der URL auf (zieht Transkript + legt raw/youtube/-Datei an), dann nenne kurz Pfad + nächsten Schritt. Erfinde nichts.",
    "ingest": "Der Nutzer hat `/ingest <pfad>` aufgerufen. Lies die genannte raw-Datei mit `read_file`, kuratiere sie (Frontmatter typ/titel/status/zuletzt + Sektionen wie in templates/) und schreibe die Wiki-Seite mit `write_wiki_page` (z.B. wiki/resources/videos/<slug>.md).",
    "query": "Der Nutzer hat `/query <frage>` aufgerufen. Beantworte AUS dem Wiki: starte bei wiki/index.md, navigiere mit read_file zu relevanten Seiten und belege mit [[Wikilinks]]. Nichts erfinden.",
    "lint": "Der Nutzer hat `/lint` aufgerufen. Rufe `audit_vault` und berichte die Befunde gruppiert. Für Index/MOC-Fixes: `rebuild_indexes` anbieten.",
    "audit": "Der Nutzer hat `/audit` aufgerufen. Rufe `audit_vault` (read-only) und berichte die Befunde.",
    "rebuild-index": "Der Nutzer hat `/rebuild-index` aufgerufen. Rufe das Tool `rebuild_indexes` auf und berichte das Ergebnis.",
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
        return ("\n\n## Kosten-Hinweis-Modus\n"
                "Bevor du teure LLM-Kuratierung machst (Ingest = Wiki-Seite aus langem Transkript schreiben, "
                "Zusammenfassungen): weise den Nutzer EINMAL kurz darauf hin, dass das über den hier konfigurierten "
                "LLM läuft (API-Kosten) und via Claude Code auf der Subscription günstiger wäre — dann mach weiter, "
                "wenn er will. Mechanisches (Transkript ziehen, raw/Datei schreiben, Indexe, Playlists) einfach ausführen.")
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
        "\n\n---\n\n## Aktuell geöffnete Datei\n"
        f"Pfad: `{pinned_rel}`\n"
        "Wenn der Nutzer 'hier rein', 'in diese Datei', 'füg das ein' o.ä. meint, schreibe mit "
        "`insert_into_open_file` GENAU in diese Datei (kein rel_path nötig). Für eine komplette "
        "Neufassung `write_wiki_page` mit diesem Pfad.\n\n"
        "Aktueller Inhalt:\n```markdown\n" + content[:8000] + "\n```"
    )


def send(vault_id: str, user_message: str, page_context: str | None = None,
         pinned_file: dict | None = None) -> dict:
    vault = settings.get_vault(vault_id)
    if not vault:
        raise LookupError(f"Vault {vault_id} nicht gefunden")

    user_message = (user_message or "").strip()
    if not user_message:
        raise ValueError("Leere Nachricht")

    _, model = effective_llm_config()
    model = model or DEFAULT_MODEL
    max_turns = int(settings.get("max_user_turns") or DEFAULT_MAX_TURNS)
    search_on = bool(settings.get("vault_search_enabled", True))
    system_prompt, _ = _build_system_prompt(vault)
    if search_on:
        system_prompt += SEARCH_INSTRUCTION
    if page_context:
        system_prompt += "\n\n---\n\n## Aktuell geöffnete Seite im Browser\n\n" + page_context[:8000]
    pinned_rel = ((pinned_file or {}).get("rel_path") or "").strip() or None
    if pinned_rel:
        system_prompt += _pinned_section(vault["path"], pinned_rel)

    route = _slash_route(user_message)
    if route and route.get("reply"):
        history = _load_history(vault_id)
        history.append({"role": "user", "content": user_message})
        history.append({"role": "assistant", "content": route["reply"]})
        _save_history(vault_id, history)
        return {"reply": route["reply"], "consulted": [], "messages": history, "usage": _zero_usage()}
    if route and route.get("directive"):
        system_prompt += "\n\n## Aktueller Befehl\n" + route["directive"]
    system_prompt += _cost_clause()

    vault_path = vault["path"]
    active_tools = TOOL_DEFS + ([SEARCH_TOOL_DEF] if search_on else [])

    history = _load_history(vault_id)
    history.append({"role": "user", "content": user_message})

    api_messages = [dict(m) for m in _trim_history(history, max_turns)]

    backend = get_backend()
    tool_iterations = 0
    consulted_files: list[str] = []

    while True:
        if tool_iterations >= MAX_TOOL_ITERATIONS:
            raise RuntimeError(f"Tool-Loop hat das Iterations-Limit ({MAX_TOOL_ITERATIONS}) erreicht")

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
            raise ValueError(f"Vault {vault_id} nicht gefunden")
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
            raise ValueError(f"Vault {vault_id} nicht gefunden")
        video = videos.get_video(vault_id, slug)
        if not video:
            raise ValueError(f"Video {slug} nicht gefunden")
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


def send_source_stream(
    source_type: str,
    source_ref: dict,
    user_message: str,
    history: list[dict],
    strict_source: bool = True,
    include_tools: bool = False,
    vault_id: str | None = None,
) -> Iterator[str]:
    """SSE stream: chat about a single source (page / transcript / video).

    Ephemer — keine Persistenz, Historie kommt vom Client. Mit include_tools + vault_id
    steht der volle Tool-Satz zur Verfügung (z.B. Seiten-Chat: SEO/Scrape/Bild + Vault),
    die Quelle bleibt dabei System-Kontext (kein Vault-Verlauf wird vermischt)."""
    try:
        user_message = (user_message or "").strip()
        if not user_message:
            yield _sse("error", {"message": "Leere Nachricht"})
            return

        title, content_text = resolve_source(source_type, source_ref)

        _, model = effective_llm_config()
        model = model or DEFAULT_MODEL

        if strict_source:
            knowledge_instruction = (
                "Antworte ausschließlich basierend auf diesem Inhalt.\n"
                "Wenn die Antwort nicht im Inhalt steht, sag das klar — füge kein externes Wissen hinzu."
            )
        else:
            knowledge_instruction = (
                "Nutze primär den bereitgestellten Inhalt als Quelle. Du darfst allgemeines Wissen ergänzend einsetzen,\n"
                "um Zusammenhänge zu erklären — mach aber deutlich wenn du über den Inhalt hinausgehst."
            )

        source_label = {
            "page": "Seiteninhalt",
            "transcript": "Transcript",
            "vault_file": "Vault-Datei",
            "video": "Video (Master-Page + Transcript)",
        }.get(source_type, "Inhalt")

        # Tools nur wenn gewünscht UND ein Vault vorhanden ist (Tools brauchen vault_path/vault_id).
        vault = settings.get_vault(vault_id) if (include_tools and vault_id) else None
        vault_path = vault["path"] if vault else None
        active_tools = (
            TOOL_DEFS + ([SEARCH_TOOL_DEF] if settings.get("vault_search_enabled", True) else [])
        ) if vault else []
        tools_note = (
            "\n\nDu hast Tools (Web/Media wie SEO/Scrape/Bild-Generierung, Vault lesen/schreiben, "
            "Notizen/Bookmarks). Nutze sie, wenn die Aufgabe es erfordert — der Fokus bleibt aber die "
            "oben gezeigte Quelle. Erfinde keine Tool-Ergebnisse; melde Fehler ehrlich."
        ) if vault else ""

        system_prompt = (
            f"Du beantwortest Fragen zu folgendem {source_label}: „{title}“.\n"
            + knowledge_instruction + tools_note + "\n\n"
            "---\n\n" + content_text[:80000]
        )
        api_messages = list(history) + [{"role": "user", "content": user_message}]

        backend = get_backend()
        accumulated: list[str] = []
        usage = {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
        tool_iterations = 0

        while True:
            if tool_iterations >= MAX_TOOL_ITERATIONS:
                yield _sse("error", {"message": f"Tool-Loop hat das Iterations-Limit ({MAX_TOOL_ITERATIONS}) erreicht"})
                return

            stream = backend.stream_complete(
                model=model,
                max_tokens=MAX_TOKENS_RESPONSE,
                system=[{"type": "text", "text": system_prompt}],
                tools=active_tools,
                messages=api_messages,
            )
            for chunk in stream:
                accumulated.append(chunk)
                yield _sse("text_delta", {"text": chunk})

            final = stream.get_final_result()
            usage["input_tokens"] += final.usage.input_tokens
            usage["output_tokens"] += final.usage.output_tokens
            usage["cache_read_input_tokens"] += getattr(final.usage, "cache_read_input_tokens", 0) or 0
            usage["cache_creation_input_tokens"] += getattr(final.usage, "cache_creation_input_tokens", 0) or 0

            api_messages.append({"role": "assistant", "content": [_block_to_input(b) for b in final.content]})

            if final.stop_reason != "tool_use":
                final_text = "".join(accumulated).strip() or "(keine Textantwort)"
                new_history = list(history) + [
                    {"role": "user", "content": user_message},
                    {"role": "assistant", "content": final_text},
                ]
                yield _sse("done", {"messages": new_history, "consulted": [], "usage": usage, "source_title": title})
                return

            tool_iterations += 1
            tool_results = []
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


def send_stream(vault_id: str, user_message: str, page_context: str | None = None,
                pinned_file: dict | None = None) -> Iterator[str]:
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
            yield _sse("error", {"message": f"Vault {vault_id} nicht gefunden"})
            return
        user_message = (user_message or "").strip()
        if not user_message:
            yield _sse("error", {"message": "Leere Nachricht"})
            return

        _, model = effective_llm_config()
        model = model or DEFAULT_MODEL
        max_turns = int(settings.get("max_user_turns") or DEFAULT_MAX_TURNS)
        search_on = bool(settings.get("vault_search_enabled", True))
        system_prompt, _ = _build_system_prompt(vault)
        if search_on:
            system_prompt += SEARCH_INSTRUCTION
        if page_context:
            system_prompt += "\n\n---\n\n## Aktuell geöffnete Seite im Browser\n\n" + page_context[:8000]
        pinned_rel = ((pinned_file or {}).get("rel_path") or "").strip() or None
        if pinned_rel:
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
            system_prompt += "\n\n## Aktueller Befehl\n" + route["directive"]
        system_prompt += _cost_clause()

        vault_path = vault["path"]
        active_tools = TOOL_DEFS + ([SEARCH_TOOL_DEF] if search_on else [])

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
                yield _sse("error", {"message": f"Tool-Loop hat das Iterations-Limit ({MAX_TOOL_ITERATIONS}) erreicht"})
                return

            stream = backend.stream_complete(
                model=model,
                max_tokens=MAX_TOKENS_RESPONSE,
                system=[{"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}],
                tools=active_tools,
                messages=api_messages,
            )
            for chunk in stream:
                accumulated_text.append(chunk)
                yield _sse("text_delta", {"text": chunk})

            final_message = stream.get_final_result()

            usage_total["input_tokens"] += final_message.usage.input_tokens
            usage_total["output_tokens"] += final_message.usage.output_tokens
            usage_total["cache_read_input_tokens"] += getattr(final_message.usage, "cache_read_input_tokens", 0) or 0
            usage_total["cache_creation_input_tokens"] += getattr(final_message.usage, "cache_creation_input_tokens", 0) or 0

            api_messages.append({"role": "assistant", "content": [_block_to_input(b) for b in final_message.content]})

            if final_message.stop_reason != "tool_use":
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
