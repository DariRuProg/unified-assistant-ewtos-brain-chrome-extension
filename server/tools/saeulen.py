"""Vault-Pfad-Konstanten + Raw-Subpath-Safety.

Videos, Playlists und Creators leben flach unter `wiki/resources/` (PARA).
Die Themen-Achse ist KEINE Ordner-Ebene mehr, sondern das freie Frontmatter-Feld
`thema` — es wird bewusst NICHT validiert (kein Whitelist), damit keine
Code↔CLAUDE.md-Synchronisationspflicht entsteht. Empfohlenes Vokabular steht
nur in der Vault-CLAUDE.md.

`safe_raw_subpath` bleibt als Traversal-Schutz für die generischen raw/-Tools.
"""
from __future__ import annotations

from pathlib import Path

RESOURCES_REL = Path("wiki") / "resources"
VIDEOS_REL = RESOURCES_REL / "videos"
PLAYLISTS_REL = RESOURCES_REL / "playlists"
CREATORS_REL = RESOURCES_REL / "creators"
RAW_YOUTUBE_REL = Path("raw") / "youtube"


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
