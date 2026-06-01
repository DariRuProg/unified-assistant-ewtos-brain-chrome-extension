# EwtosBrain

Unified Chrome Extension + Python Server. Produktivitäts-Assistent mit Vault-Wissen, Browser-Tools und Claude-Code-Integration.

EwtosBrain besteht aus **zwei Teilen**, die getrennt ausgeliefert werden:

1. **Chrome-Extension** — die Oberfläche (Side-Panel, Tools, Chat).
2. **Server-App** — das Gehirn (Vault-Zugriff, LLM-Calls). Läuft lokal als Tray-App; eine Chrome-Extension kann selbst keinen Server enthalten.

---

## Für Endnutzer (installierte Version)

### 1. Server-App installieren

`EwtosBrain-Setup-<version>.exe` ausführen. Installiert nach `%LOCALAPPDATA%\Programs\EwtosBrain` (kein Admin nötig), optional Autostart beim Login. Nach der Installation läuft EwtosBrain als **Tray-Icon** (Systemleiste) auf `http://127.0.0.1:9988`.

Tray-Menü: Logs öffnen · Datenordner öffnen · Neu starten · Beenden.

Alle Daten (Einstellungen, API-Keys, Chats) liegen in `%LOCALAPPDATA%\EwtosBrain` — getrennt vom Programm, überstehen Updates.

### 2. Extension installieren

Aus dem Chrome Web Store (Link vom Owner) oder als entpacktes ZIP via `chrome://extensions/` → Entwicklermodus → „Entpackte Erweiterung laden".

### 3. Einrichten

Side-Panel öffnen → der **Setup-Wizard** führt durch Server-Verbindung, LLM-Provider, API-Key und Vault-Pfad. Der API-Key landet in `%LOCALAPPDATA%\EwtosBrain\settings.json` — keine Datei-Bastelei nötig.

---

## Für Entwickler (aus dem Source starten)

### Server

**Doppelklick auf `start-server.bat`.** Legt beim ersten Mal ein venv im Projekt-Root an (`.venv\`), installiert Dependencies, startet den Server auf `http://127.0.0.1:9988`.

> Voraussetzung: Python 3.11+ ([python.org](https://python.org/downloads), „Add to PATH" anhaken).

**API-Key:** Wird aus `%LOCALAPPDATA%\EwtosBrain\.env` geladen. Ein vorhandenes `server/.env` wird beim ersten Start automatisch dorthin migriert. Vorlage:

```
copy server\.env.example server\.env
```

Dann `ANTHROPIC_API_KEY=sk-ant-...` eintragen. (Alternativ Key direkt über den Setup-Wizard setzen.)

### Extension

`chrome://extensions/` → Entwicklermodus → „Entpackte Erweiterung laden" → Ordner `extension/`.

### Server-App bauen (.exe + Installer)

```
build.bat                     REM PyInstaller -> dist\EwtosBrain\EwtosBrain.exe
ISCC installer\ewtosbrain.iss REM Inno Setup 6 -> dist\EwtosBrain-Setup-<version>.exe
```

Extension-Icons neu generieren (bei Brand-Änderung): `python extension\images\make_icons.py`.

---

## Features

- **Chat mit Vault** — Karpathy-Navigation: LLM liest `wiki/index.md` und navigiert iterativ; Multi-LLM-Provider (Anthropic, OpenAI, Ollama, Mistral) per Setting umschaltbar
- **Vault-Explorer** — Ordner/Dateien durchsuchen, Volltextsuche, Markdown-Editor, In-Datei-Suche (Strg+F, gelbe Treffer)
- **Vault-Gesundheit** — Audit (Orphans, kaputte Wikilinks, Frontmatter, Struktur-Drift) mit Auto-Repair für sichere Fälle
- **Setup-Wizard + Blueprints** — geführtes Vault-Onboarding; Reverse-Blueprint leitet bei bestehenden Fremd-Vaults die Struktur ab statt sie zu überschreiben
- **Briefing „Guten Morgen"** — Tagesbriefing mit Wetter, Todos, Fristen, Lernstreak (profil-konfigurierbar)
- **Note-Taker & Todos** — Globaler Scratchpad (autosave, exportierbar), klickbare Todos mit Due-Dates (`@2026-05-04 14:00`); Inbox-Inhalte nach `raw/` promotebar
- **Bookmarks & Playlists** — Quellen sammeln, YouTube-Playlists pflegen (Auto-Index)
- **Browser-Tools** — YouTube-Transcript, Page-Scrape, SEO-Check, Screenshot, Color-Picker, Image-Analyse
- **Claude-Code-Integration** — MCP-Server exponiert Vault-/Notes-/Audit-Tools für Claude Code

## Architektur

Siehe [CLAUDE.md](CLAUDE.md) für Architektur, Sprint-Plan und Design-Entscheidungen.

## Trouble-Shooting

**Side-Panel zeigt Offline-Banner** → Server-App (Tray) starten bzw. `start-server.bat`, dann „Erneut verbinden".

**Version-Konflikt im Banner** → Extension und Server-App haben inkompatible Versionen (major.minor). Beide auf denselben Stand bringen.

**Port 9988 belegt** → `EWTOS_PORT` als Umgebungsvariable setzen. Extension-Settings nachziehen (`ws://localhost:<port>/ws`).

**Python nicht gefunden (Dev)** → Python von [python.org](https://python.org/downloads) installieren, „Add to PATH" anhaken.
