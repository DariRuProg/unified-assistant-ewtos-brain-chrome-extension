# EwtosBrain

Unified Chrome Extension + Python Server. KI-Assistent für tägliche Mitarbeiter-Arbeit, mit Vault-Wissen (Karpathy-Methode) und Claude-Code-Integration.

**Owner:** ewtos.com (Webprogrammierer in Werbeagentur, baut WordPress-Plugins, Automationen, KI-Lösungen — Ziel: KI-fähiger Web- & Automatisierungsberater).
**Sprache:** Deutsch in der UI und Doku, Tags/Code-Identifier englisch.

## Coding-Regeln

Beim Coden gilt **zuerst der globale Skill `coding-discipline`** (Modularität / keine Monolithen). Die Architektur-Entscheidungen weiter unten **ergänzen** ihn, heben ihn nicht auf. Insbesondere: Frontend (CSS/JS/HTML) gehört nicht als Rawstring in Python-Router. `server/routers/demo.py` ist bekannter Modularitäts-Schuld (CSS/JS im `_PAGE`-String) und wird in einem eigenen Task ausgelagert — **nicht** als „gewollte Architektur" führen.

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
2. **Sprint 2 ✅:** Note-Taker → `raw/`, Chat mit Vault (Karpathy), MCP-Layer für Claude Code (`server/mcp_server.py`, Stdio)
3. **Phase 6 ✅ (cross-cutting):** Multi-LLM-Backend — Anthropic, OpenAI, Ollama, Mistral. Provider-Dropdown in Options-UI. `server/llm_providers/`, `server/llm_client.py`. `chat_model` legacy; aktiver Stack: `llm_provider` + `llm_model`.
4. **Sprint 3:** Restliche Browser-Tools (Page-Scrape, SEO, Image-Analyse, Color-Picker, Screenshot+Annotation)
5. **Phase 7 ✅ (Produktionsreife, intern):** Server als PyInstaller-Tray-App + Inno-Installer, User-Datenverzeichnis (`%LOCALAPPDATA%\EwtosBrain`), bundle-aware Pfade (`server/paths.py`), `/health` + WS-Version-Handshake, Extension Store-Prep (Icons, host_permissions, Reconnect-Backoff). Auslieferbar als Setup.exe + Extension.
6. **Sprint 4 (SaaS):** REST-API-Auth, `wss`/Cloud-Deployment (Railway/Render), Stripe, Vault-Abstraktion (`VaultFS`)

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
- **Dual-Rolle: Eigenständige App + MCP-Tool-Box** *seit 2026-05-09* — *Why:* EwtosBrain soll gleichzeitig (a) als eigene Mitarbeiter-App mit eigener LLM-Intelligenz arbeiten **und** (b) für Power-User in Claude Code als „Hände+Füße" dienen, ohne dass Tool-Logik dupliziert wird. *Apply:* Zweiter Eintrypoint `server/mcp_server.py` (Stdio-MCP) lebt **neben** `main.py`, importiert die identischen `tools/*.py`-Funktionen. Whitelist exposed: Vault-Read, Notes/Todos, Bookmarks, Playlists, Videos, Promote, Save-Transcript + WS-Bridge-Wrapper `pull_transcript_via_extension`. **Nicht** exposed (Iteration 1): `summary_writer.generate_summary` (Claude Code schreibt Summaries auf eigener Subscription, keine doppelten LLM-Kosten), Vault-CRUD/Settings (UI-only). Browser-DOM-Tools (YouTube-Pull) gehen aus dem MCP-Prozess via `httpx` an den FastAPI-Endpoint, nicht direkt an die WS-Bridge — Process-Trennung sauber. Permission-Modell bleibt vault-zentriert: dieselben `vault_permission`-Checks greifen auch für MCP-Aufrufe.
- **`settings._flush` atomar via `tmp.replace`** *seit 2026-05-09* — *Why:* Mit Phase 5 läuft ein zweiter Prozess (MCP-Server) parallel zu FastAPI; beide lesen `settings.json`. Direktes `write_text` kann eine halb-geschriebene Datei zurücklassen wenn ein Reader im falschen Moment liest. *Apply:* Schreibe in `settings.json.tmp`, dann atomarer `tmp.replace(SETTINGS_FILE)` (Windows-`MoveFileEx` / POSIX-`rename`). Reader sehen entweder die alte oder die neue Datei, nie eine Mischung.
- **Multi-LLM-Backend (Phase 6)** *seit 2026-05-12* — *Why:* DSGVO-Pfad (Ollama lokal), Kosten-Flexibilität (OpenAI/Mistral), kein Lock-in auf Anthropic. *Apply:* `server/llm_providers/` mit `base.py` (LLMBackend-Interface), `anthropic_backend.py`, `openai_backend.py` (auch für Mistral via `base_url`), `ollama_backend.py`. Factory: `llm_client.get_backend()` + `effective_llm_config()`. Backward-Compat: altes `chat_model` wird als Fallback für `llm_model` gelesen. UI: Provider-Dropdown + bedingte Key/URL-Felder in Options. Secrets: `.env` hat Vorrang (alle Provider-Keys in `server/.env.example`). Ollama: OpenAI-Compat-API, intern non-streaming wegen Ollama-Bug.
- **MCP-Setup für Claude Code** *seit 2026-05-09* — User-scope, Stdio-Transport. Konfig (einmal):
  ```bash
  claude mcp add --scope user --transport stdio ewtosbrain ^
    "E:\Coding_Kurse\Chrome-Extensions\unified-assistant\.venv\Scripts\python.exe" ^
    "E:\Coding_Kurse\Chrome-Extensions\unified-assistant\server\mcp_server.py"
  ```
  Nach Restart von Claude Code: `/mcp` zeigt `ewtosbrain` als verbunden, Tools sind unter `mcp__ewtosbrain__*` verfügbar. WS-Bridge-Tool (`pull_transcript_via_extension`) erfordert zusätzlich, dass `start-server.bat` läuft + Chrome-Extension geöffnet ist.
- **Zentrales Datenverzeichnis `%LOCALAPPDATA%\EwtosBrain` via `server/paths.py`** *seit 2026-05-29* — *Why:* Eine in Program Files installierte `.exe` darf nicht neben sich schreiben (Admin-Rechte). Schreibpfade müssen vom Code/Bundle getrennt sein. *Apply:* `paths.py` ist die einzige Pfad-Quelle. `data_dir()` (Schreibpfade: `settings.json`, `.env`, `chat-*.json`, `setup_sessions/`, `generated_images/`, `logs/`), `bundle_dir()` (read-only Assets: `blueprint_schemas/`, `blueprint_templates/`, `blueprint_trusted_keys.json`) — bundle-aware via `sys._MEIPASS`/`sys.frozen`. `migrate_legacy_data()` kopiert alte Dateien aus `server/` beim ersten Start. **Neue Schreib-/Asset-Pfade IMMER über `paths.py`**, nie `Path(__file__)`-relativ. `config.py` hat keinen Hardcoded-Vault mehr — Vaults kommen aus `settings.json` (Setup-Wizard).
- **Packaging: PyInstaller-Tray-App + Inno-Installer (per-User)** *seit 2026-05-29* — *Why:* Server muss als eigenständige Desktop-App auslieferbar sein (Endnutzer ohne Python). *Apply:* Entrypoint `server/tray.py` (pystray, uvicorn im Daemon-Thread, Datei-Logging). Build: `build.bat` → `server/ewtosbrain.spec` → `dist\EwtosBrain\`. Installer: `installer\ewtosbrain.iss` (Inno Setup 6) → per-User-Install nach `%LOCALAPPDATA%\Programs\EwtosBrain`, kein Admin, optional Autostart (HKCU Run). `uvicorn.run(app, ...)` nutzt das App-Objekt (nicht `"main:app"`-String — bricht im Bundle).
- **Version-Handshake Extension↔Server** *seit 2026-05-29* — *Why:* Inkompatible Versionen sollen sichtbar sein, nicht still failen. *Apply:* WS-`hello` → Server antwortet `hello_ack` mit `compatible` (major.minor-Abgleich zwischen `server/bridge.py` `SERVER_VERSION` und Extension-Version). Extension liest eigene Version aus `chrome.runtime.getManifest()`, zeigt bei Mismatch ein Konflikt-Banner. `/health`-Endpoint für REST-Checks (Setup-Wizard).
- **Version-Single-Source: `VERSION`-Datei im Repo-Root** *seit 2026-07-01* — *Why:* Vor Store-Launch stand die Versionsnummer an drei unabhängigen Stellen (`extension/manifest.json`, `server/bridge.py` `SERVER_VERSION`, `installer/ewtosbrain.iss` `AppVersion`) ohne dokumentierten Referenzpunkt — Drift-Risiko bei künftigen Releases, v.a. weil der WS-Handshake major.minor zwischen Extension und Server vergleicht. *Apply:* `VERSION` (Repo-Root, reiner Versionsstring) ist die Quelle der Wahrheit. Kein Build-Tooling, das sie automatisch injiziert — bei jedem Release müssen `VERSION`, `extension/manifest.json`, `server/bridge.py` und `installer/ewtosbrain.iss` manuell synchron gehalten werden (Kommentare an allen vier Stellen verweisen aufeinander).
- **Extension Store-Prep** *seit 2026-05-29* — Icons in `extension/images/` (16/48/128, generiert via `make_icons.py`). `host_permissions` = `http://*/*` + `https://*/*` statt `<all_urls>` (engerer Scope, Page-Tools laufen weiter). Reconnect mit Exponential-Backoff (1s→30s). Store-Listing muss den Web-Zugriff der Page-Tools begründen.
- **Kontext-Profil als Vault-Basis, Karpathy-Farming als Erweiterung** *seit 2026-06-15* — *Why:* Das Onboarding baute nur die Karpathy-Farming-Pipeline (raw → wiki/resources/creators|videos|playlists), passend für den Owner-Use-Case (10-Channel-Wiki), aber nicht für generische Mitarbeiter. Es fehlte die laut Second-Brain-Best-Practice (`wissen-ueber-obsidian/`) wertvollste Schicht: ein **Kontext-Profil**, das der KI sagt, *wer der Nutzer ist*. Außerdem wurden keine Claude-Code-Skills in den Vault ausgeliefert. „Blueprint vs. Interview" war eine falsche Gegenüberstellung — der Setup-Agent interviewt bereits; die Engine ist richtig (reproduzierbar, non-destruktiv upgradebar, lieferbar an Nicht-Claude-Code-Nutzer). *Apply:* Neues Basis-Blueprint **`kontext-base`** (neuer `DEFAULT_BLUEPRINT_ID`) scaffoldet `kontext/` (ueber-mich, zielgruppe, angebot, schreibstil, branding) + PARA-Buckets + eine CLAUDE.md-Section `kontext-profil`, die jeden Agenten anweist, `kontext/*` vor inhaltlichen Aufgaben zu lesen. **`karpathy-para-base extends ["kontext-base"]`** und enthält nur noch den Farming-Teil (`researcher`/`karpathy-lerner` erben den Kontext-Layer transitiv mit). Neues optionales Blueprint-Feld **`skills: []`** (Set-Union-Merge, Schema in `blueprint_schemas/v1.json`): `blueprint.commit()` kopiert gebündelte Skill-Trees aus `server/tools/blueprint_templates/_skills/` (kepano obsidian-skills) nach `<vault>/.claude/skills/<name>/` (skip_if_exists) — Wert v.a. für den Claude-Code-Pfad, den der Server-Chat nicht abdeckt. Setup-Agent (`setup_agent.py`) interviewt im Fresh-Mode (Default `kontext-base`) entlang der 9-Phasen-Logik und füllt die `kontext/`-Dateien via `set_var`; dafür gehen top-level `vars` jetzt in den Jinja-Render-Context (war im Schema dokumentiert, fehlte im Code). Marketplace/Signatur (`blueprint_trusted_keys.json`) bleibt bewusst Stub (kein Overengineering).

- **Öffentliche Marke „Ewtos Office-Brain", Code bleibt `EwtosBrain`; Produkt-Heimat `ewtos.com/office-brain`** *seit 2026-07-01* — *Why:* Vor dem Store-Launch drei Schreibweisen im Repo (Manifest `Ewtos Office-Brain`, Doku `EwtosBrain`, informell `office-brain`). Store-Titel, Datenschutz-Überschrift, Produkt-URL und Download-Link müssen einen Namen führen. *Apply:* Öffentliches Gesicht = **Ewtos Office-Brain** (Store-Listing, `docs/legal/privacy-policy.md`, Landing-Header). Interne Bezeichner/Code/diese CLAUDE.md bleiben `EwtosBrain` (kein Massen-Rename im Code). Produkt-Heimat = **Subpath** `ewtos.com/office-brain` (Landing + `/datenschutz` + `.exe`-Download) — bewusst kein Subdomain (kein DNS/TLS-Setup, static-Ordner ins bestehende Hosting); `extension/lib/constants.js` `DOWNLOAD_URL` zeigt darauf. **Legal:** Die App braucht eine *eigene* Datenschutzerklärung (self-hosted/BYOK-Datenpraxis ≠ generische Website-Policy `ewtos.com/datenschutzerklaerung-eu/`, zusätzlich Chrome-Store-Pflicht) → publiziert als eigene Seite unter `ewtos.com/office-brain/datenschutz` (getrennt von der Website-Policy, kein Konflikt), Inhalt aus `docs/legal/privacy-policy.md`, ausgeliefert als `landing/datenschutz.html`. **Impressum** wird NICHT dupliziert — Verweis auf bestehendes `ewtos.com/impressum` (gleiche juristische Person). Demo bleibt Subdomain `demo.ewtos.com` (Coolify). AGB/Widerrufsrecht erst mit Monetarisierung (Meilenstein B, Lemon Squeezy als Merchant of Record).
- **Eine Vault-Logik: PARA flach + `thema`-Frontmatter (Säulen-System entfernt)** *seit 2026-06-25* — *Why:* Zwei parallele Realitäten waren entstanden: die Tools (Playlist/Video/Transcript) hatten ein altes **Säulen-Ordnersystem** (`tools/saeulen.py`: `knowledge-library/ai`, `marketing`, …) hartcodiert, während der Blueprint `karpathy-para-base` **PARA flach** scaffoldet (`wiki/resources/videos|playlists|creators`). Folge: Waisen-Ordner (`wiki/knowledge-library/ai/` beim Playlist-Anlegen, `raw/transcripts/` statt `raw/youtube/`) + 4 divergierende Video-Frontmatter-Schemas. *Apply:* Säulen-Ordnersystem **ersatzlos entfernt**. Videos/Playlists/Creators liegen flach unter `wiki/resources/`; Roh-Videos unter `raw/youtube/`. Die Themen-Achse ist das **freie Frontmatter-Feld `thema`** (z.B. `ai`, `marketing`) — **kein Code-Whitelist** (genau die `saeulen.py`-Sync-Pflicht war die Fehlerquelle), nur in der Vault-CLAUDE.md (Blueprint-Templates `intro.md.j2`/`agents.md.j2`) dokumentiert. `tools/saeulen.py` ist auf Pfad-Konstanten + `safe_raw_subpath` reduziert. Video-Master-Schema vereinheitlicht auf `templates/video.md.j2` (`thumbnail_url`, `video_id`, `kanal`, Body `## Beschreibung`/`## Zusammenfassung`/`## Transkript`). `saeule`-Parameter aus allen Tools/Routern/MCP/chat + der Extension-UI (Playlist-/Briefing-Renderer) entfernt; `auto_tagger` schlägt jetzt `thema` statt `saeule` vor. Bestehende Vaults: Migration `raw/transcripts/`→`raw/youtube/`, `wiki/knowledge-library/ai/`→`wiki/resources/` mit `thema: ai`.

- **Monetarisierung & Positionierung: Trial → Feature-gated Free → Pro-Lizenz (LemonSqueezy), kein Credits/OAuth** *seit 2026-07-01* — *Why:* Konkurrenz-Analyse (Sider: Cloud, Account-Zwang, LLM-Weiterverkauf mit Marge, Incogni-„HIGH RISK") zeigte, dass Office-Brains self-hosted/BYOK-USP das Gegenteil ist — Siders Modell ist nicht kopierbar, ohne den eigenen Verkaufspunkt zu zerstören. BYOK bedeutet *null variable Kosten pro Nutzer* → ein Einmalkauf ist profitabel und passt zu lokaler Software; ein Credits-/Zeit-Ablauf-Modell wäre self-sabotierend und trivial umgehbar. *Apply:* Positionierung = „DSGVO-konforme Alternative für deutsche KMU/Agenturen" (Community-frei als Reichweite, B2B als Umsatz). Preis-Stufen: **Trial 28 Tage** (BYOK macht langes Trial gratis) → **Free** (Kern-Loop: Vault-Chat, Notizen/Todos/Bookmarks, Basis-Browser-Tools) → **Pro** (~49–59 € Einmalkauf + optionales Update-Abo: Web-Clipping, YouTube, Playlists/Video-Brain, SEO/Image-Analyse, Multi-Device) → **Business** (Seats + Setup + Support). Umsetzung: `server/licensing.py` (dynamischer `tier()` trial|free|pro, `is_pro()`, LemonSqueezy activate/validate mit 14-Tage-Offline-Grace), `settings.set_licensing()` + erweitertes `DEFAULT_LICENSING`. Feature-Gating via `Depends(licensing.require_pro)` (HTTP 402) NUR auf den wertschöpfenden Pro-Aktionen: `web_tools` youtube_transcript/page_scrape/scrape_url/seo_check/image_analyse, `playlists` pull_pending, `videos` summary — Lese-/CRUD-Endpoints bleiben frei (kein UI-Bruch). Gating greift **bewusst auch im Open-Mode** (sonst umgehbar). `video_brain` bleibt unangetastet (eigener Lizenz-Check). Options-UI: Pro-Sektion (`extension/options/`, Status + Trial-Restlaufzeit + Key-Aktivierung), `constants.js` `CHECKOUT_URL`. Store/Distribution: Repo **privat** → `.exe` über ewtos.com-Hosting (unsigniert, SmartScreen-Hinweis), `package-extension.bat` + `docs/store-submission.md`. **Offen:** Owner-/Dev-Bypass (z.B. Env-Var), damit die lokale Owner-Nutzung nach Trial-Ablauf nicht selbst gegatet wird.

## Bestehende Code-Quellen (zum Referenzieren)

- `..\OfficeBrain-Extension-Youtube-Transcript-Getter\` — YouTube-Scraping-Logik (DOM-Click + Segments-Parser). Bereits portiert nach `extension/tools/youtube_transcript.js`.
- `..\SriptHubHackSite\` — Markdown-Extractor + SEO-Daten-Extraktion + Gemini/OpenRouter-Routing. Wird in Sprint 3 portiert.

## Verbundener Vault (für Chat & Note-Taker)

- **Pfad:** `E:\Coding_Kurse\Obsidian\Self-Feeding-Wiki-nach-Karpathy-Brad-Bonanno`
- **Repo:** Karpathy-Style Self-Feeding Wiki über 10 KI/Automation/n8n YouTube-Channels
- **Struktur:** `raw/` (Quellen, immutable) + `wiki/` (LLM-kuratiert: `index.md`, `log.md`, `creator-*.md`, `video-*.md`, `trending.md`)
- **Slash-Commands im Vault:** `/farm`, `/farm-seed`, `/build-wiki ingest|lint|query`
- Note-Taker (Sprint 2) schreibt nach `raw/` im selben Format wie der `farm`-Workflow.
