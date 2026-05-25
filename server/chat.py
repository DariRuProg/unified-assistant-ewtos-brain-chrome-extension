"""Chat with Vault — Karpathy-style. LLM navigates a vault's wiki via tool use.

Per-vault:
- Conversation history file: chat-<vault_id>.json
- System prompt comes from the vault's settings entry (user-edited or generated)
"""
from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from datetime import date, datetime
from pathlib import Path

import settings
from llm_client import effective_llm_config, get_backend
from tools import bookmarks, notes_file, playlists, raw_promoter, videos, wiki_reader

log = logging.getLogger("ewtosbrain.chat")

CHAT_DIR = Path(__file__).parent
DEFAULT_MODEL = "claude-opus-4-7"
DEFAULT_MAX_TURNS = 20
MAX_TOOL_ITERATIONS = 15
MAX_TOKENS_RESPONSE = 16000

BASE_SYSTEM_PROMPT = """Du bist ein Assistent für einen Markdown-Vault. Du hilfst dem Owner Informationen aus seinem Vault zu finden — du bist NICHT der Owner.

## Vault-Lese-Tools
- `list_folder(path)` — listet .md-Dateien und Unterordner. Pfad relativ zum Vault-Root. Leer = Vault-Root.
- `read_file(path)` — liest eine .md-Datei. Pfad relativ zum Vault-Root.

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

**Playlists** (`wiki/<saeule>/playlists/<slug>.md` im aktiven Vault, z.B. `wiki/knowledge-library/ai/playlists/...`) — themen-kuratierte Sammlungen. Erfordert `write_playlists`-Recht auf dem aktiven Vault. Bei Permission-Fehler den Fehler 1:1 weitergeben:
- `list_playlists(saeule?)` — Playlists eines Vaults zeigen. Ohne `saeule` über alle erlaubten Säulen, mit z.B. `saeule="knowledge-library/ai"` nur eine. Jeder Eintrag enthält ein `saeule`-Feld.
- `create_playlist(name, thema?, saeule?)` — neue Playlist anlegen unter `wiki/<saeule>/playlists/<slug>.md`. `saeule` defaultet auf `knowledge-library/ai`. `thema` ist ein freier Frontmatter-String.
- `add_to_playlist(name, url, title?, dauer?, saeule?)` — Eintrag hinzufügen. Master-Video-Page wird in derselben Säule angelegt. `saeule` defaultet auf `knowledge-library/ai` und MUSS zur Playlist passen.
- `remove_from_playlist(name, match, saeule?)` — Eintrag per Substring-Match löschen. `saeule` defaultet auf `knowledge-library/ai`.

**Säulen-Hinweis:** Wenn der Nutzer ein Thema klar außerhalb von `knowledge-library/ai` nennt (Health, Marketing, Spirituality, Industries, Work/Crafts, ...), frage gezielt nach der Säule oder schlage eine vor. Erlaubte Säulen sind in `tools/saeulen.py` whitelisted; neue Säulen erfordern erst eine Schema-Erweiterung in der Vault-CLAUDE.md.

Nutze die Tools wenn der Nutzer sagt: „leg playlist X an", „füg [URL] zu meiner [name]-Playlist hinzu", „zeig meine playlists", „nimm das aus der playlist raus".

**Promote zu raw** (`promote_to_raw`) — verschiebt einen Scratchpad-Block oder Todo in `vault/raw/<subfolder>/`. Nutze wenn der Nutzer sagt „schick X nach raw", „mach daraus eine Quelle", „das ist wichtig genug für den Vault", „promote nach raw". Datum wird automatisch gesetzt. Frag den Nutzer nach Titel + Beschreibung wenn nicht klar — beides optional, aber empfohlen. Subfolder muss eines sein: `artikel`, `eigene-notizen`, `kunden-input/<kunde>`, `chat-archive`. Erfordert das `write_raw`-Recht auf dem aktiven Vault — ohne Recht meldet das Tool einen Permission-Fehler, den du dem Nutzer 1:1 weitergibst (NICHT Erfolg behaupten, NICHT umschreiben). Wiki-Ingest passiert NICHT automatisch — am Schluss den Nutzer auf den ingest-Hint hinweisen den das Tool zurückgibt.

WICHTIG: Notiz-Tools schreiben in einer GLOBALEN Notiz-Datei, nicht im Vault. Wenn unklar ist, ob der Nutzer eine Vault-Page oder den Scratchpad meint, frage kurz nach. Default bei vagen „notiere"-Anfragen: Scratchpad.

## Vault-Navigation
Halte dich strikt an die Vault-Konventionen unten — sie kommen aus der CLAUDE.md des Vaults und beschreiben Struktur, Routinen, Schreibstil. Wenn dort steht "lies erst index.md" → tu das. Wenn dort eine Routine beschrieben ist → folge ihr. Wikilinks `[[seitenname]]` heißen `read_file('<pfad>/seitenname.md')` (Pfad ergibt sich aus dem Kontext).

Quellen zitieren mit "Quelle: <pfad>".
Wenn du im Vault keine Antwort findest, sag das ehrlich — erfinde nichts. Wenn ein Todo-/Scratchpad-Tool fehlschlägt, melde den Fehler — bestätige NIEMALS Operationen die nicht ausgeführt wurden."""

DEFAULT_TAIL = """\n\n(Kein CLAUDE.md im Vault gefunden — navigiere bestmöglich anhand der Datei- und Ordnernamen. Beginne mit `list_folder('')` um die oberste Struktur zu sehen.)"""


PROMPT_GENERATOR_INSTRUCTION = """Du bekommst gleich die CLAUDE.md eines Vaults (typischerweise ein Obsidian-Vault, oft nach Karpathy-Methode aufgebaut). Deine Aufgabe: schreib einen System-Prompt für einen anderen Assistenten (auch ein LLM), der diesen Vault als Wissensquelle nutzen soll, um Fragen seines Owners zu beantworten.

Der Assistent hat zwei Tools:
- `list_folder(path)` — listet .md-Dateien und Unterordner an einem Pfad (leer = Vault-Root)
- `read_file(path)` — liest eine .md-Datei (Pfad relativ zum Vault-Root)

Der System-Prompt soll dem Assistenten klar machen:
1. Was im Vault liegt (Themen, Struktur, Konventionen, eventuelle Tagging-Logik)
2. Wo er einsteigt (z.B. index.md falls vorhanden, oder ein Logbuch)
3. Welchen Schreibstil/Tonfall der Owner pflegt (Sprache, formell/informell, siezen/duzen, Fluff vs. knapp etc.)
4. Wie er Quellen zitiert (z.B. "Quelle: <pfad>")
5. Dass er ehrlich ist wenn er etwas im Vault nicht findet — nichts erfinden
6. WICHTIG: der Assistent ist NICHT der Vault-Owner. Er hilft dem Owner, Informationen aus dem Vault zu finden. Er soll nicht denken er sei selbst die Person die im Vault beschrieben wird.

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
        "description": "Listet Playlists des aktiven Vaults pro Säule. Ohne saeule-Parameter werden Playlists aus ALLEN erlaubten Säulen aufgelistet — der Eintrag enthält ein `saeule`-Feld zur Identifikation. Mit saeule (z.B. 'knowledge-library/ai') wird gefiltert. Erfordert write_playlists-Recht.",
        "input_schema": {
            "type": "object",
            "properties": {
                "saeule": {"type": "string", "description": "Optional. Wiki-Säule (z.B. 'knowledge-library/ai', 'work/crafts/web-development/skills/wordpress'). Ohne Param: alle Säulen."},
            },
        },
    },
    {
        "name": "create_playlist",
        "description": "Legt eine neue Playlist an unter wiki/<saeule>/playlists/<slug>.md mit Frontmatter (typ, status:aktiv, optional thema). Bei doppeltem Namen in derselben Säule Fehler.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Lesbarer Name, z.B. 'KI Tutorials'"},
                "thema": {"type": "string", "description": "Optional. Frontmatter-Property (frei, z.B. 'ki', 'health', 'seo')."},
                "saeule": {"type": "string", "description": "Optional. Wiki-Säule. Default 'knowledge-library/ai'."},
            },
            "required": ["name"],
        },
    },
    {
        "name": "add_to_playlist",
        "description": "Fügt ein Video zu einer Playlist hinzu. Erzeugt SOFORT die Master-Video-Page in wiki/<saeule>/videos/<slug>.md (Frontmatter mit URL, Channel, Dauer; Body als Skeleton mit pending Summary/Transcript), und schreibt einen Referenz-Block in die Playlist. WICHTIG: Wenn der Nutzer sagt 'füg X zur playlist Y hinzu' — RUFE DIESES TOOL. Bestätige NIEMALS Erfolg ohne den Tool-Aufruf. Bei Erfolg melde den Inhalt der Tool-Antwort. Duplikat-Check per URL. saeule muss zur Playlist passen.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Lesbarer Playlist-Name (wie bei create_playlist)"},
                "url": {"type": "string", "description": "URL des Videos"},
                "title": {"type": "string", "description": "Sichtbarer Titel des Videos"},
                "youtuber": {"type": "string", "description": "Optional. Channel-Name / YouTuber."},
                "dauer": {"type": "string", "description": "Optional. Format HH:MM oder MM:SS."},
                "saeule": {"type": "string", "description": "Optional. Wiki-Säule. Default 'knowledge-library/ai'."},
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
                "saeule": {"type": "string", "description": "Optional. Wiki-Säule. Default 'knowledge-library/ai'."},
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
]


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


def _execute_tool(name: str, tool_input: dict, vault_path: str, vault_id: str) -> tuple[str, bool]:
    log.info("Tool: %s input=%s", name, {k: (str(v)[:60] if isinstance(v, str) else v) for k, v in tool_input.items()})
    try:
        if name == "list_folder":
            rel = tool_input.get("path", "") or ""
            return _format_folder_listing(wiki_reader.list_folder(vault_path, rel)), False
        if name == "read_file":
            path = tool_input.get("path", "")
            return wiki_reader.read_file(vault_path, path), False
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
            return f"Scratchpad ersetzt ({res['length']} Zeichen)", False
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
            pls = playlists.list_playlists(vault_id, saeule=tool_input.get("saeule"))
            if not pls:
                return "(keine Playlists im aktiven Vault)", False
            lines = [f"- [{p['saeule']}] {p['name']} ({p['item_count']} Items) → {p['path']}" for p in pls]
            return "\n".join(lines), False
        if name == "create_playlist":
            res = playlists.create_playlist(
                vault_id,
                tool_input.get("name", ""),
                tool_input.get("thema"),
                saeule=tool_input.get("saeule"),
            )
            return f"Playlist '{res['name']}' angelegt in Säule '{res['saeule']}' → {res['path']}", False
        if name == "add_to_playlist":
            res = playlists.add_to_playlist(
                vault_id,
                tool_input.get("name", ""),
                tool_input.get("url", ""),
                title=tool_input.get("title"),
                dauer=tool_input.get("dauer"),
                youtuber=tool_input.get("youtuber"),
                saeule=tool_input.get("saeule"),
            )
            if not res.get("added"):
                return f"Bereits in Playlist (Duplikat): {res.get('title') or res.get('url')}", False
            note = " — Video-Page neu angelegt" if res.get("video_created") else " — Video-Page existierte schon, Playlist-Liste erweitert"
            return f"Hinzugefügt zu '{res['name']}' (Säule {res['saeule']}): {res['title']} → {res['video_page']}{note}", False
        if name == "remove_from_playlist":
            res = playlists.remove_from_playlist(
                vault_id,
                tool_input.get("name", ""),
                tool_input.get("match", ""),
                saeule=tool_input.get("saeule"),
            )
            return f"Entfernt: {res['title']} (Säule {res['saeule']})", False
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


def send(vault_id: str, user_message: str, page_context: str | None = None) -> dict:
    vault = settings.get_vault(vault_id)
    if not vault:
        raise LookupError(f"Vault {vault_id} nicht gefunden")

    user_message = (user_message or "").strip()
    if not user_message:
        raise ValueError("Leere Nachricht")

    _, model = effective_llm_config()
    model = model or DEFAULT_MODEL
    max_turns = int(settings.get("max_user_turns") or DEFAULT_MAX_TURNS)
    system_prompt, _ = _build_system_prompt(vault)
    if page_context:
        system_prompt += "\n\n---\n\n## Aktuell geöffnete Seite im Browser\n\n" + page_context[:8000]
    vault_path = vault["path"]

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
            tools=TOOL_DEFS,
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
                    content, is_error = _execute_tool(block.name, block.input, vault_path, vault_id)
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
      - "video":      source_ref = {"vault_id": str, "slug": str, "saeule"?: str}
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
        saeule = source_ref.get("saeule")
        if not vault_id or not slug:
            raise ValueError("video-Quelle braucht vault_id und slug")
        vault = settings.get_vault(vault_id)
        if not vault:
            raise ValueError(f"Vault {vault_id} nicht gefunden")
        video = videos.get_video(vault_id, slug, saeule)
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
) -> Iterator[str]:
    """SSE stream: chat about a single source (page / transcript / video) — no vault tools, no persistence."""
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

        system_prompt = (
            f"Du beantwortest Fragen zu folgendem {source_label}: „{title}“.\n"
            + knowledge_instruction + "\n\n"
            "---\n\n" + content_text[:80000]
        )
        messages = list(history) + [{"role": "user", "content": user_message}]

        backend = get_backend()
        accumulated: list[str] = []
        usage = {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}

        stream = backend.stream_complete(
            model=model,
            max_tokens=MAX_TOKENS_RESPONSE,
            system=[{"type": "text", "text": system_prompt}],
            tools=[],
            messages=messages,
        )
        for chunk in stream:
            accumulated.append(chunk)
            yield _sse("text_delta", {"text": chunk})

        final = stream.get_final_result()
        usage["input_tokens"] = final.usage.input_tokens
        usage["output_tokens"] = final.usage.output_tokens
        usage["cache_read_input_tokens"] = getattr(final.usage, "cache_read_input_tokens", 0) or 0

        final_text = "".join(accumulated).strip() or "(keine Textantwort)"
        new_history = list(history) + [
            {"role": "user", "content": user_message},
            {"role": "assistant", "content": final_text},
        ]
        yield _sse("done", {"messages": new_history, "consulted": [], "usage": usage, "source_title": title})
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


def send_stream(vault_id: str, user_message: str, page_context: str | None = None) -> Iterator[str]:
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
        system_prompt, _ = _build_system_prompt(vault)
        if page_context:
            system_prompt += "\n\n---\n\n## Aktuell geöffnete Seite im Browser\n\n" + page_context[:8000]
        vault_path = vault["path"]

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
                tools=TOOL_DEFS,
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
