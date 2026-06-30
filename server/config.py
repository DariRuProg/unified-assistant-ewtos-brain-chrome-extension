import os

import paths

HOST = os.getenv("EWTOS_HOST", "127.0.0.1")
PORT = int(os.getenv("EWTOS_PORT", "9988"))

# Signier-Schlüssel für Login-Tokens (JWT). Leer = settings.py generiert + persistiert
# automatisch einen. Für Firmen-/Cloud-Server eigenen stabilen Wert via .env setzen.
SECRET_KEY = os.getenv("EWTOS_SECRET_KEY", "")

# Demo-Modus: öffentliche „zum Ausprobieren"-Instanz. Lädt einen Beispiel-Vault,
# erzwingt read-only (alle Schreib-Operationen geblockt) und gibt dem Chat-Agenten
# nur Lese-Tools. Aktivieren via EWTOS_DEMO_MODE=1.
DEMO_MODE = os.getenv("EWTOS_DEMO_MODE", "").strip().lower() in ("1", "true", "yes", "on")

# Vault-Pfade kommen aus settings.json (vom Setup-Wizard gesetzt). Hier nur
# optionale Env-Overrides — kein maschinenspezifischer Hardcode.
VAULT_PATH = os.getenv("EWTOS_VAULT_PATH", "")

# Globale Notes (todos/scratchpad) — ohne expliziten Pfad ins User-Datenverzeichnis.
NOTES_PATH = os.getenv("EWTOS_NOTES_PATH", str(paths.data_dir() / "notes"))

TOOL_TIMEOUT_SECONDS = 60
