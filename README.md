# EwtosBrain

Unified Chrome Extension + Python Server. Produktivitäts-Assistent mit Vault-Wissen, Browser-Tools und Claude-Code-Integration.

## Schnellstart (Sprint 1)

### 1. Server starten

```powershell
cd server
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python main.py
```

Server läuft auf `http://localhost:9988`.

### 2. Extension laden

1. Chrome → `chrome://extensions/`
2. Entwicklermodus aktivieren
3. "Entpackte Erweiterung laden" → `extension/`-Ordner wählen
4. Sidepanel öffnen via Extension-Icon

Extension verbindet sich automatisch zum Server.

### 3. Tool testen

```powershell
curl -X POST http://localhost:9988/tools/youtube_transcript `
  -H "Content-Type: application/json" `
  -d '{\"url\":\"https://www.youtube.com/watch?v=...\"}'
```

## Status

Sprint 1 in Arbeit — siehe [CLAUDE.md](CLAUDE.md) für Architektur und Roadmap.
