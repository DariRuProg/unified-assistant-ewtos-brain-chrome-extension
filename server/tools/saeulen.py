"""Säulen-Whitelist für Video/Playlist-Pfade.

EwtosBrain legt Videos und Playlists pro Wiki-Säule ab (`wiki/<saeule>/videos/`,
`wiki/<saeule>/playlists/`). Diese Datei ist die Single Source of Truth für
erlaubte Säulen-Werte.

WICHTIG: Diese Liste muss synchron mit dem Säulen-Schema in der
Vault-CLAUDE.md (Sektion "Die acht Wiki-Säulen") bleiben. Wenn dort eine
neue Säule angelegt wird, hier ergänzen.

Sperrzonen (`privat/*`) sind absichtlich NICHT in der Whitelist — Videos
dort gehören manuell angelegt, nicht via App.
"""
from __future__ import annotations

ALLOWED_SAEULEN: set[str] = {
    "ki",
    "tech",
    "branchen",
    "kunden",
    "kunden-deliverables",
    "projekte",
    "produkte",
}

ALLOWED_SUB_SAEULEN: set[str] = {
    "branchen/medizin",
    "branchen/e-commerce",
    "branchen/handwerk",
    "tech/wordpress",
    "tech/nextjs",
    "tech/n8n",
    "tech/claude-code",
    "tech/chrome-extensions",
    "tech/mcp-api",
}

DEFAULT_SAEULE = "ki"


def validate_saeule(saeule: str | None) -> str:
    """Prüft, ob die angegebene Säule erlaubt ist. Bei None: Default 'ki'.

    Akzeptiert nur Werte aus ALLOWED_SAEULEN oder ALLOWED_SUB_SAEULEN.
    Privat-Bereiche werden mit klarer Fehlermeldung abgelehnt.
    """
    s = (saeule or DEFAULT_SAEULE).strip().strip("/")
    if not s:
        return DEFAULT_SAEULE
    if s.startswith("privat") or s.startswith("privat/"):
        raise ValueError(
            f"Säule '{s}' ist Sperrzone — Videos in wiki/privat/* manuell anlegen, "
            f"EwtosBrain schreibt dort nicht."
        )
    if s in ALLOWED_SAEULEN or s in ALLOWED_SUB_SAEULEN:
        return s
    allowed = sorted(ALLOWED_SAEULEN | ALLOWED_SUB_SAEULEN)
    raise ValueError(
        f"Unbekannte Säule '{s}'. Erlaubt: {', '.join(allowed)}. "
        f"Neue Säulen erst in Vault-CLAUDE.md anlegen, dann hier ergänzen."
    )


def list_allowed() -> list[str]:
    """Sortierte Liste aller erlaubten Säulen-Werte (für UI-Dropdowns oder Doku)."""
    return sorted(ALLOWED_SAEULEN | ALLOWED_SUB_SAEULEN)
