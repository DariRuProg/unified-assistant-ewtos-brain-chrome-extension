"""Säulen-Whitelist für Video/Playlist-Pfade.

EwtosBrain legt Videos und Playlists pro Wiki-Säule ab (`wiki/<saeule>/videos/`,
`wiki/<saeule>/playlists/`). Diese Datei ist die Single Source of Truth für
erlaubte Säulen-Werte.

WICHTIG: Diese Liste muss synchron mit dem Säulen-Schema in der
Vault-CLAUDE.md (Trennlinien-Sektion) bleiben. Wenn dort eine neue
Säule angelegt wird, hier ergänzen.

Sperrzonen (`personal/*`) sind absichtlich NICHT in der Whitelist —
Videos dort gehören manuell angelegt, nicht via App.
"""
from __future__ import annotations

ALLOWED_SAEULEN: set[str] = {
    "knowledge-library/ai",
    "knowledge-library/industries",
    "knowledge-library/marketing",
    "knowledge-library/health",
    "knowledge-library/spirituality",
}

ALLOWED_SUB_SAEULEN: set[str] = {
    "knowledge-library/industries/medical",
    "knowledge-library/industries/ecommerce",
    "knowledge-library/industries/crafts-trades",
    "knowledge-library/ai/chatbots",
    "knowledge-library/marketing/seo",
    "work/crafts/web-development/skills/wordpress",
    "work/crafts/web-development/skills/nextjs",
    "work/crafts/web-development/skills/automation",
    "work/crafts/web-development/skills/claude-code",
    "work/crafts/web-development/skills/chrome-extensions",
    "work/crafts/web-development/skills/mcp-api",
}

DEFAULT_SAEULE = "knowledge-library/ai"


def validate_saeule(saeule: str | None) -> str:
    """Prüft, ob die angegebene Säule erlaubt ist. Bei None: Default 'knowledge-library/ai'.

    Akzeptiert nur Werte aus ALLOWED_SAEULEN oder ALLOWED_SUB_SAEULEN.
    Personal-Bereiche werden mit klarer Fehlermeldung abgelehnt.
    """
    s = (saeule or DEFAULT_SAEULE).strip().strip("/")
    if not s:
        return DEFAULT_SAEULE
    if s.startswith("personal") or s.startswith("personal/"):
        raise ValueError(
            f"Säule '{s}' ist Sperrzone — Videos in wiki/personal/* manuell anlegen, "
            f"EwtosBrain schreibt dort nicht."
        )
    if s in ALLOWED_SAEULEN or s in ALLOWED_SUB_SAEULEN:
        return s
    allowed = sorted(ALLOWED_SAEULEN | ALLOWED_SUB_SAEULEN)
    raise ValueError(
        f"Unbekannte Säule '{s}'. Erlaubt: {', '.join(allowed)}. "
        f"Neue Säulen erst in Vault-CLAUDE.md anlegen, dann hier ergänzen."
    )


def safe_raw_subpath(folder: str | None) -> str:
    """Akzeptiert jeden relativen Unterordner unter raw/. Blockt nur Unsicheres.
    personal/* bleibt Sperrzone."""
    s = (folder or "").strip().strip("/\\").replace("\\", "/")
    if not s:
        raise ValueError("Ziel-Ordner darf nicht leer sein")
    if ".." in s.split("/"):
        raise ValueError("Ungültiger Ordnerpfad (Traversal)")
    if s.startswith("/") or (len(s) > 1 and s[1] == ":"):
        raise ValueError("Ziel-Ordner muss relativ sein")
    if s == "personal" or s.startswith("personal/"):
        raise ValueError("Ordner 'personal' ist Sperrzone — dort schreibt EwtosBrain nicht")
    return s


def typ_from_saeule(saeule: str) -> str:
    """Leitet den Obsidian-`typ`-Frontmatter-Wert aus der Säule ab.

    work/* → "arbeit", alles andere → "ki" (Default).
    """
    if (saeule or "").startswith("work"):
        return "arbeit"
    return "ki"


def list_allowed() -> list[str]:
    """Sortierte Liste aller erlaubten Säulen-Werte (für UI-Dropdowns oder Doku)."""
    return sorted(ALLOWED_SAEULEN | ALLOWED_SUB_SAEULEN)
