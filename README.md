# EwtosBrain

Unified Chrome Extension + Python Server. Produktivitäts-Assistent mit Vault-Wissen, Browser-Tools und Claude-Code-Integration.

## Schnellstart

### 1. Server starten

**Doppelklick auf `start-server.bat`** im Projekt-Ordner.

Beim ersten Mal legt das Skript automatisch ein Python-venv im Projekt-Root an (`.venv\`) und installiert die Dependencies. Danach startet der Server auf `http://127.0.0.1:9988`.

> Voraussetzung: Python 3.11+ ist installiert (von [python.org/downloads](https://python.org/downloads)).

**Anthropic-API-Key:** wird aus `server/.env` geladen. Vor dem ersten Start anlegen:

```
copy server\.env.example server\.env
```

Dann in `server/.env` den Key eintragen: `ANTHROPIC_API_KEY=sk-ant-...`

Wenn die Datei fehlt, warnt `start-server.bat` beim Start; der Server läuft trotzdem, aber Chat-Funktionen funktionieren nicht.

**Server beenden:** Konsole-Fenster schließen.

### 2. Server beim Windows-Start automatisch laden (optional)

**Doppelklick auf `enable-autostart.bat`** — legt eine Verknüpfung im Windows-Autostart an. Server läuft ab Boot minimiert mit.

Deaktivieren: `disable-autostart.bat`.

### 3. Extension in Chrome laden

1. `chrome://extensions/` öffnen
2. Entwicklermodus aktivieren (oben rechts)
3. **"Entpackte Erweiterung laden"** → Ordner `extension/` wählen
4. Extension-Icon an die Toolbar pinnen (Puzzle-Icon → EwtosBrain pinnen)

### 4. Side-Panel öffnen + konfigurieren

- Klick aufs Extension-Icon → Side-Panel öffnet sich
- Status-Punkt sollte grün sein (Server verbunden). Falls rot: Banner zeigt was zu tun ist
- Für **Chat mit Vault**: API-Key liegt bereits in `server/.env` (siehe Schritt 1). Die Einstellungen-UI in der Extension setzt nur Fallback-Werte in `server/settings.json` — `.env` hat immer Vorrang.

## Features

- **Note-Taker** — Globaler Scratchpad, autosave, exportierbar
- **Todos** — Klickbare Liste mit Due-Dates (`@2026-05-04 14:00`-Syntax)
- **Chat mit Vault** — Karpathy-Navigation: LLM liest `wiki/index.md` und navigiert iterativ
- **YouTube-Transcript** — Transkript aus aktivem YouTube-Tab

## Architektur

Siehe [CLAUDE.md](CLAUDE.md) für Architektur, Sprint-Plan und Design-Entscheidungen.

## Trouble-Shooting

**Server startet nicht / Python nicht gefunden** → Python von [python.org](https://python.org/downloads) installieren, beim Setup "Add to PATH" anhaken.

**`Activate.ps1`-Fehler** → unwichtig, das Skript verwendet `.venv\Scripts\python.exe` direkt, kein `Activate` nötig.

**Port 9988 belegt** → in [server/config.py](server/config.py) `PORT` ändern. Extension-Settings nachziehen (`ws://localhost:<neuer-port>/ws`).

**Side-Panel zeigt offline-Banner** → `start-server.bat` doppelklicken, dann "Erneut verbinden" im Banner klicken.
