import os

import paths

HOST = os.getenv("EWTOS_HOST", "127.0.0.1")
PORT = int(os.getenv("EWTOS_PORT", "9988"))

# Vault-Pfade kommen aus settings.json (vom Setup-Wizard gesetzt). Hier nur
# optionale Env-Overrides — kein maschinenspezifischer Hardcode.
VAULT_PATH = os.getenv("EWTOS_VAULT_PATH", "")

# Globale Notes (todos/scratchpad) — ohne expliziten Pfad ins User-Datenverzeichnis.
NOTES_PATH = os.getenv("EWTOS_NOTES_PATH", str(paths.data_dir() / "notes"))

TOOL_TIMEOUT_SECONDS = 60
