from pathlib import Path
import os

HOST = os.getenv("EWTOS_HOST", "127.0.0.1")
PORT = int(os.getenv("EWTOS_PORT", "9988"))

VAULT_PATH = os.getenv(
    "EWTOS_VAULT_PATH",
    str(Path(r"E:\Coding_Kurse\Obsidian\Self-Feeding-Wiki-nach-Karpathy-Brad-Bonanno")),
)

NOTES_PATH = os.getenv("EWTOS_NOTES_PATH", str(Path(VAULT_PATH) / "notes"))

TOOL_TIMEOUT_SECONDS = 60
