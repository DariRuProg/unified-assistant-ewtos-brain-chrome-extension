# EwtosBrain

Unified Chrome Extension + Python Server. KI-Assistent für tägliche Mitarbeiter-Arbeit, mit Vault-Wissen (Karpathy-Methode) und Claude-Code-Integration.

**Owner:** ewtos.com (Webprogrammierer in Werbeagentur, baut WordPress-Plugins, Automationen, KI-Lösungen — Ziel: KI-fähiger Web- & Automatisierungsberater).
**Sprache:** Deutsch in der UI und Doku, Tags/Code-Identifier englisch.

## Vision

Eine Chrome-Extension als täglicher KI-Assistent für Mitarbeiter eines Unternehmens. Eigenständig nutzbar (Tools, Chat, Note-Taker), aber auch von Claude Code/Desktop aus steuerbar — Server hält Sessions zentral, damit der Owner Mitarbeiter-Chats übernehmen kann.

Brand-Logik: erweitert das bestehende ewtos-Konzept "Zweites Gehirn" zu einem Produkt das Mitarbeiter-Wissen in einem Karpathy-Style-Vault sammelt.

## Architektur

```
Chrome Extension (MV3)  ←WebSocket→  Python Server (FastAPI)
  • Tool-UI (sidepanel)                ├─ MCP-Server   → Claude Code
  • Chat                               ├─ WebSocket    → Extension
  • Note-Taker                         └─ REST API     → externe Devs
                                       ↓
                               Obsidian Vault (raw/, wiki/)
```

**Server = Gehirn, Extension = Gesicht.** Chats, Tool-Definitionen und Vault-Logik leben am Server, damit Claude Code dieselben Sessions übernehmen kann.

## Verzeichnisse

```
extension/         Chrome Extension (MV3)
  manifest.json
  background.js    Service Worker — WS-Client + Tool-Dispatcher
  sidepanel/       Tool-Liste, Chat, Note-Taker
  options/         Settings (Server-URL, Vault-Pfad, LLM-Provider)
  tools/           Browser-seitige Tool-Implementierungen

server/            Python FastAPI
  main.py          App + WS-Endpoint + Tool-HTTP-Endpoints (lädt .env)
  config.py        Statische Settings (Host, Port, Vault-Default, Tool-Timeout)
  settings.py      Runtime-Settings (vaults, chat_model, max_user_turns) — .env hat Vorrang für SECRET_KEYS
  settings.json    persistierte Runtime-Settings (NICHT versioniert, .gitignore)
  .env             Anthropic-API-Key + Geheimnisse (NICHT versioniert)
  .env.example     Vorlage für .env
  tools/           Server-seitige Tool-Implementierungen
  requirements.txt

.venv/             Python-venv (Projekt-Root, NICHT versioniert)
start-server.bat   Setup + Start (legt venv an wenn nötig, lädt .env)
```

## WebSocket-Protokoll (Server ↔ Extension)

Hello (Extension → Server beim Connect):
```json
{"type": "hello", "client": "extension", "version": "0.1"}
```

Tool-Call (Server → Extension):
```json
{"type": "tool_call", "request_id": "<uuid>", "tool": "youtube_transcript", "params": {"url": "..."}}
```

Tool-Result (Extension → Server):
```json
{"type": "tool_result", "request_id": "<uuid>", "ok": true, "data": {...}}
{"type": "tool_result", "request_id": "<uuid>", "ok": false, "error": "..."}
```

## Tool-Konventionen

- **Browser-Tools** (DOM-Zugriff nötig): laufen in Extension, getriggert per WS vom Server
- **Server-Tools** (rein Python): laufen direkt im Server (z.B. Vault-Read, LLM-Calls)
- Jeder Tool-Aufruf hat einheitliches Schema: `{ok, data?, error?}`

## Tool-Gruppen (Roadmap)

**Gruppe 1 — Wissen & Vault (Karpathy-Methode)**
- Chat mit Vault — LLM liest kuratierte `wiki/`-Seiten direkt
- Note-Taker — Roh-Input (Text/Audio/Link) → schreibt in `raw/` des Vaults
- Todos-Visualizer (später)

**Gruppe 2 — Browser & Web Tools**
- YouTube-Transcript ✅ (Sprint 1, Pipeline-Test)
- Page-Scrape (Markdown-Export, ohne nav/footer/cookies)
- SEO-Check (h1-h6-Struktur, meta description, canonical, title)
- Image-Analyse (alt-Text, title, dimensions, file-size)
- Image-Download (einzeln + bulk)
- Color-Picker (Farbpipette aus DOM)
- Screenshot + Annotation (Canvas-Drawing: Pfeile, Formen, Markierungen)

**Gruppe 3 — Code-Helper** (Details werden in Sprint 3 definiert)

## Sprint-Plan

1. **Sprint 1 ✅:** Server-Skeleton, Extension-Shell, YouTube-Transcript end-to-end
2. **Sprint 2:** Note-Taker → `raw/`, Chat mit Vault (Karpathy), MCP-Layer für Claude Code
3. **Sprint 3:** Restliche Browser-Tools (Page-Scrape, SEO, Image-Analyse, Color-Picker, Screenshot+Annotation)
4. **Sprint 4:** REST-API-Auth, Cloud-Deployment (Railway/Render), Stripe-Integration

## Backlog (geplant, ungeplant)

- **Briefing-Tool / „Guten Morgen"** *(geplant 2026-05-06)* — eigenständiger Tagesbriefing-Trigger in der Extension. Inhalte: Datum, Wetter (Multi-City Default Paderborn + Kavala), pending Workshops, Vertrags-Fristen ≤60 Tage, Anniversaries ≤30 Tage, letzte Daily Note, Tages-Fokus. **Dies wird die erste externe Web-Verbindung** der App (Wetter-API). Daraus folgt: Settings-UI braucht eine „External Services"-Sektion mit Provider-Konfiguration, API-Keys, Standort-Liste — von Anfang an konsistent strukturieren, damit spätere Integrationen (Kalender, Mail, weitere APIs) dort sauber landen. Pendant ist `/guten-morgen` in Claude Code, der dieselbe Logik via Glob/Grep + WebFetch macht.

## Wichtige Entscheidungen (mit Begründung)

- **Karpathy-Methode statt RAG** — *Why:* Vault ist bereits durch LLM-kuratierte Wiki-Seiten organisiert. Vector-DB wäre nur Aufwand ohne Mehrwert. *Apply:* Chat-Tool liest `wiki/index.md` als Einstieg, navigiert zu relevanten Pages und liest direkt — wie ein Mensch im Wiki.
- **Server = Gehirn, Extension = Gesicht** — *Why:* Mitarbeiter-Chat muss von Claude Code übernehmbar sein. Wenn Chat in Extension lebt, gibt es zwei getrennte Realitäten. *Apply:* Chat-State, Tool-Registry, Vault-Logik immer am Server. Extension nur UI + Browser-only-Tools (DOM-Zugriff).
- **Hybrid-Hosting** — *Why:* User will jetzt lokal entwickeln, später Firmen-Server. *Apply:* Server muss von Anfang an konfigurierbar sein (Server-URL in Extension-Settings), keine Hardcodes auf `localhost`.
- **API-Keys von Anfang an** — *Why:* Endziel ist Verkauf der API an externe Devs. *Apply:* Auth-Middleware-Stub in `server/` einplanen, auch wenn jetzt noch alle Calls offen sind.
- **Server entscheidet LLM, UI kann switchen** — *Why:* Default-Verhalten kommt vom Server, Power-User können in Extension umstellen.
- **Vault-Pfad konfigurierbar** — Default für Owner: `E:\Coding_Kurse\Obsidian\Self-Feeding-Wiki-nach-Karpathy-Brad-Bonanno`, aber per Settings änderbar (für Firmen-Einsatz).
- **Anthropic-API-Key in `server/.env` (python-dotenv)** *seit 2026-05-06* — *Why:* Zuvor lag der Key im Klartext in `server/settings.json`. Risiko bei Backup/Sync/Screenshots, auch wenn die Datei in `.gitignore` steht. *Apply:* `main.py` lädt `.env` ganz oben via `load_dotenv(Path(__file__).parent / ".env")`. `settings.get("anthropic_api_key")` priorisiert Env-Variable über `SECRET_ENV_MAP`. UI darf weiterhin in `settings.json` schreiben (Convenience), aber `.env` gewinnt. Vorlage: `server/.env.example`.
- **venv liegt im Projekt-Root, nicht in `server/`** *seit 2026-05-06* — *Why:* Python-Standard, ein venv für das ganze Projekt (server/ + spätere Test- und Tool-Skripte). *Apply:* `start-server.bat` erstellt + nutzt `.venv\` im Projekt-Root, ruft `.venv\Scripts\python.exe server\main.py`. Wer manuell startet: `cd unified-assistant && .venv\Scripts\activate && python server\main.py`.
- **Notes-Tools für Chat-Agent: granular statt generisch** *seit 2026-05-06* — *Why:* Der Chat-Agent hatte vorher nur `list_folder` + `read_file` (read-only auf Vault) und halluzinierte Erfolg, wenn Nutzer „hak Todo X ab" sagten. Eine generische `save_notes(content)`-API wäre einfach gewesen, aber jede Halluzination des Agenten hätte die ganze Datei wegputzen können. *Apply:* In `chat.py` registriert: `list_todos`, `add_todo`, `update_todo` (action: complete/uncomplete/delete, mit Substring-Match + Mehrdeutigkeits-Fehler), `read_scratchpad`, `append_scratchpad` (mit Datums-Header), `replace_scratchpad` (nur auf explizite User-Anfrage). Implementierung in `tools/notes_file.py`. System-Prompt zwingt den Agenten, vor `update_todo` erst `list_todos` zu rufen, und Fehler explizit zu melden statt Erfolg zu behaupten. Tools sind in JEDEM Vault-Chat verfügbar (Notes sind global, nicht vault-spezifisch).
- **Promote-to-raw mit Vault-Permission-Modell** *seit 2026-05-06* — *Why:* Karpathy-Loop schließen (Inbox → Quelle → Wiki). Mini-Inputs aus `notes/scratchpad.md` oder `notes/todos.md` sollen sich gezielt in `vault/raw/<subfolder>/` „graduieren" lassen. Ingest in `wiki/` bleibt bewusst getrennt — das ist Claude-Code-Operation (`/ingeste`-Workflow), nicht EwtosBrain-Aufgabe. *Apply:* Tool `promote_to_raw` in `chat.py` + `tools/raw_promoter.py`. Datum wird automatisch gesetzt, optional: `title`, `description`, `filename_slug`. Source-side wird der Ursprungsblock markiert (`[PROMOTED → ...]`), nicht gelöscht — Historie bleibt im Scratchpad. Permission-Modell: `vault.permissions.write_raw` (Default `False`) wird vor jedem Schreibzugriff geprüft; Tool wirft `PermissionError` wenn nicht aktiv. Permission ist **per-Vault** (jeder Vault einzeln freischalten), wird in der Vault-Edit-UI in `extension/options/options.js` als Checkbox angezeigt. Erlaubte `target_subfolder`-Prefixe sind aktuell hartcodiert: `artikel`, `eigene-notizen`, `kunden-input/<kunde>`, `chat-archive`. Erweiterung der Liste = explizite Code-Änderung.
- **Vault-Permission-Modell als Architektur-Pattern** *seit 2026-05-06* — *Why:* Schreib-Operationen außerhalb von `notes/` (App-eigener Bereich) brauchen explizite Erlaubnis vom User pro Vault, damit EwtosBrain nicht versehentlich in fremde Vault-Bereiche schreibt. Setzt den Standard für künftige Tools (z.B. „Wiki-Page anlegen", „Daily Note schreiben"). *Apply:* `settings.DEFAULT_VAULT_PERMISSIONS` als Schema-Quelle, `settings.vault_permission(vault_id, key)` als Lookup-Helper. Jedes neue Schreib-Tool registriert seinen Permission-Key in `DEFAULT_VAULT_PERMISSIONS` (Default `False`) und checkt vor Schreibzugriff. UI in `options.js` listet alle Permissions pro Vault als Checkbox.

## Bestehende Code-Quellen (zum Referenzieren)

- `..\OfficeBrain-Extension-Youtube-Transcript-Getter\` — YouTube-Scraping-Logik (DOM-Click + Segments-Parser). Bereits portiert nach `extension/tools/youtube_transcript.js`.
- `..\SriptHubHackSite\` — Markdown-Extractor + SEO-Daten-Extraktion + Gemini/OpenRouter-Routing. Wird in Sprint 3 portiert.

## Verbundener Vault (für Chat & Note-Taker)

- **Pfad:** `E:\Coding_Kurse\Obsidian\Self-Feeding-Wiki-nach-Karpathy-Brad-Bonanno`
- **Repo:** Karpathy-Style Self-Feeding Wiki über 10 KI/Automation/n8n YouTube-Channels
- **Struktur:** `raw/` (Quellen, immutable) + `wiki/` (LLM-kuratiert: `index.md`, `log.md`, `creator-*.md`, `video-*.md`, `trending.md`)
- **Slash-Commands im Vault:** `/farm`, `/farm-seed`, `/build-wiki ingest|lint|query`
- Note-Taker (Sprint 2) schreibt nach `raw/` im selben Format wie der `farm`-Workflow.
