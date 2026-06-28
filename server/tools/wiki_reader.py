"""Vault navigation tools — read-only filesystem access scoped to a vault.

Two tools form the navigation primitive:
  - list_folder(vault_path, rel)  — list .md files + subfolders at a path
  - read_file(vault_path, rel)    — read a single file

Plus helpers to find the vault's CLAUDE.md (used as the live system prompt).
"""
from __future__ import annotations

import shutil
from datetime import datetime
from pathlib import Path

from tools import frontmatter as _frontmatter

# Prefixes/names to ignore when listing (Obsidian internals, hidden, system).
IGNORED_NAMES = {".obsidian", ".trash", ".git", "node_modules", "__pycache__"}

# Versteckter Sicherungs-Ordner für Inhalte, die vor einem Überschreiben gesichert werden.
BACKUP_DIRNAME = ".ewtos-backups"

# Bild-Endungen, die der Explorer inline rendern kann.
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}


def _is_hidden(name: str) -> bool:
    return name.startswith(".") or name in IGNORED_NAMES


def _count_children(dir_path: Path, show_hidden: bool) -> int:
    """Zählt sichtbare Kinder (Ordner + Dateien) eines Verzeichnisses — für die
    (N)-Anzeige im Explorer, ohne den Ordner aufzuklappen."""
    n = 0
    try:
        for entry in dir_path.iterdir():
            if not show_hidden and _is_hidden(entry.name):
                continue
            n += 1
    except OSError:
        return 0
    return n


def resolve_dir(vault_path: str) -> Path:
    """Use the configured path as-is if it contains .md files; otherwise try
    `<path>/wiki` for legacy/standard layouts."""
    base = Path(vault_path)
    if base.exists() and any(base.glob("*.md")):
        return base
    fallback = base / "wiki"
    if fallback.exists():
        return fallback
    return base


def _safe_resolve(vault_path: str, rel_path: str) -> Path:
    root = resolve_dir(vault_path).resolve()
    candidate = (root / rel_path).resolve() if rel_path else root
    if not candidate.is_relative_to(root):
        raise ValueError(f"Pfad ausserhalb des Vaults: {rel_path}")
    return candidate


def list_folder(vault_path: str, rel_path: str = "", show_hidden: bool = False) -> dict:
    """List .md files and subfolders inside a folder. Path is relative to
    the vault root. Empty path = vault root. show_hidden=True zeigt versteckte/
    ignorierte Eintraege (.obsidian, .claude, Dotfiles)."""
    target = _safe_resolve(vault_path, rel_path)
    if not target.exists():
        raise FileNotFoundError(f"Ordner nicht gefunden: {rel_path}")
    if not target.is_dir():
        raise ValueError(f"Kein Ordner: {rel_path}")
    root = resolve_dir(vault_path).resolve()
    folders: list[str] = []
    files: list[str] = []
    images: list[str] = []
    other: list[str] = []
    counts: dict[str, int] = {}
    for entry in target.iterdir():
        if not show_hidden and _is_hidden(entry.name):
            continue
        try:
            rel = str(entry.relative_to(root)).replace("\\", "/")
        except ValueError:
            continue
        if entry.is_dir():
            folders.append(rel)
            counts[rel] = _count_children(entry, show_hidden)
        elif entry.is_file():
            ext = entry.suffix.lower()
            if ext == ".md":
                files.append(rel)
            elif ext in IMAGE_EXTS:
                images.append(rel)
            else:
                other.append(rel)
    return {
        "path": rel_path or "",
        "folders": sorted(folders),
        "files": sorted(files),
        "images": sorted(images),
        "other": sorted(other),
        "counts": counts,
    }


def read_file(vault_path: str, rel_path: str) -> str:
    p = _safe_resolve(vault_path, rel_path)
    if not p.exists():
        raise FileNotFoundError(f"Datei nicht gefunden: {rel_path}")
    if not p.is_file():
        raise ValueError(f"Kein File: {rel_path}")
    return p.read_text(encoding="utf-8")


def search_files(vault_path: str, q: str, max_results: int = 30) -> list[dict]:
    """Case-insensitive Volltextsuche über alle .md-Dateien im Vault."""
    root = resolve_dir(vault_path).resolve()
    results = []
    query = q.lower()
    for md_file in sorted(root.rglob("*.md")):
        if any(part in IGNORED_NAMES for part in md_file.parts):
            continue
        try:
            content = md_file.read_text(encoding="utf-8")
        except Exception:
            continue
        lower = content.lower()
        if query not in lower:
            continue
        pos = lower.find(query)
        start = max(0, pos - 60)
        end = min(len(content), pos + len(q) + 60)
        snippet = content[start:end].replace("\n", " ").strip()
        try:
            rel = str(md_file.relative_to(root)).replace("\\", "/")
        except ValueError:
            continue
        results.append({"rel_path": rel, "snippet": snippet})
        if len(results) >= max_results:
            break
    return results


def query_frontmatter(vault_path: str, folder: str, typ: str | None = None,
                      recursive: bool = False) -> list[dict]:
    """Listet .md-Dateien in `folder` und parst deren Frontmatter zu Records.
    Read-only. Optionaler Filter auf das Frontmatter-Feld `typ`. Returns eine Liste
    von {rel_path, name, frontmatter}, alphabetisch nach Dateiname.
    FileNotFoundError wenn der Ordner fehlt (z.B. Vault ohne CRM-Modul)."""
    target = _safe_resolve(vault_path, folder)
    if not target.exists():
        raise FileNotFoundError(f"Ordner nicht gefunden: {folder}")
    if not target.is_dir():
        raise ValueError(f"Kein Ordner: {folder}")
    root = resolve_dir(vault_path).resolve()
    globber = target.rglob("*.md") if recursive else target.glob("*.md")
    records: list[dict] = []
    for md_file in sorted(globber):
        if any(part in IGNORED_NAMES for part in md_file.parts):
            continue
        try:
            text = md_file.read_text(encoding="utf-8")
        except Exception:
            continue
        meta = _frontmatter.parse_frontmatter(text)
        if typ and str(meta.get("typ", "")).strip() != typ:
            continue
        try:
            rel = str(md_file.relative_to(root)).replace("\\", "/")
        except ValueError:
            continue
        records.append({"rel_path": rel, "name": md_file.stem, "frontmatter": meta})
    return records


def backup_file(vault_path: str, rel_path: str) -> str | None:
    """Sichert eine bestehende, nicht-leere Datei vor dem Überschreiben nach
    <root>/.ewtos-backups/<rel>.<zeitstempel>.bak. Returns den Backup-rel_path oder
    None (Datei fehlt/leer). Traversal-geschützt via _safe_resolve."""
    p = _safe_resolve(vault_path, rel_path)
    if not p.exists() or not p.is_file():
        return None
    try:
        if p.stat().st_size == 0:
            return None
    except OSError:
        return None
    root = resolve_dir(vault_path).resolve()
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_rel = f"{BACKUP_DIRNAME}/{rel_path}.{ts}.bak"
    dest = (root / backup_rel)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(p, dest)
    return backup_rel.replace("\\", "/")


def write_file(vault_path: str, rel_path: str, content: str) -> None:
    """Überschreibt eine bestehende .md-Datei."""
    p = _safe_resolve(vault_path, rel_path)
    if not p.exists():
        raise FileNotFoundError(f"Datei nicht gefunden: {rel_path}")
    if p.suffix.lower() != ".md":
        raise ValueError("Nur .md Dateien erlaubt")
    p.write_text(content, encoding="utf-8")


def create_file(vault_path: str, rel_path: str, content: str = "") -> None:
    """Legt eine neue .md-Datei an — schlägt fehl wenn sie bereits existiert."""
    if not rel_path.endswith(".md"):
        rel_path = rel_path + ".md"
    p = _safe_resolve(vault_path, rel_path)
    if p.exists():
        raise FileExistsError(f"Datei existiert bereits: {rel_path}")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")


def create_folder(vault_path: str, rel_path: str) -> None:
    """Legt einen neuen Ordner an — schlägt fehl wenn er bereits existiert.
    Traversal-geschützt via _safe_resolve."""
    if not rel_path or not rel_path.strip():
        raise ValueError("Kein Ordnername angegeben")
    p = _safe_resolve(vault_path, rel_path)
    if p.exists():
        raise FileExistsError(f"Existiert bereits: {rel_path}")
    p.mkdir(parents=True, exist_ok=False)


_ASSET_MIMES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
}


def read_asset(vault_path: str, rel_path: str) -> tuple[bytes, str]:
    """Liest eine Binär-Asset-Datei (Bild) aus dem Vault. Returns (bytes, mime).
    Pfad-Traversal-geschützt via _safe_resolve; nur Bild-Endungen erlaubt."""
    p = _safe_resolve(vault_path, rel_path)
    ext = p.suffix.lower()
    if ext not in _ASSET_MIMES:
        raise ValueError(f"Dateityp nicht erlaubt: {ext or '(keine)'}")
    if not p.exists() or not p.is_file():
        raise FileNotFoundError(f"Asset nicht gefunden: {rel_path}")
    return p.read_bytes(), _ASSET_MIMES[ext]


def write_asset(vault_path: str, rel_path: str, data: bytes) -> str:
    """Schreibt ein Binär-Asset (Bild) in den Vault. Returns den posix-rel_path.
    Pfad-Traversal-geschützt via _safe_resolve; nur Bild-Endungen erlaubt."""
    p = _safe_resolve(vault_path, rel_path)
    if p.suffix.lower() not in _ASSET_MIMES:
        raise ValueError(f"Dateityp nicht erlaubt: {p.suffix or '(keine)'}")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return rel_path.replace("\\", "/")


def delete_path(vault_path: str, rel_path: str) -> str:
    """Loescht eine Datei oder einen LEEREN Ordner. Schuetzt gegen Parent-Escape
    und gegen Loeschen des Vault-Roots. Returns 'file' oder 'dir'."""
    if not rel_path or not rel_path.strip():
        raise ValueError("Kein Pfad angegeben")
    p = _safe_resolve(vault_path, rel_path)
    root = resolve_dir(vault_path).resolve()
    if p == root:
        raise ValueError("Vault-Root kann nicht geloescht werden")
    if not p.exists():
        raise FileNotFoundError(f"Nicht gefunden: {rel_path}")
    if p.is_file():
        p.unlink()
        return "file"
    if p.is_dir():
        try:
            p.rmdir()  # nur leere Ordner
        except OSError:
            raise ValueError(f"Ordner ist nicht leer: {rel_path}")
        return "dir"
    raise ValueError(f"Weder Datei noch Ordner: {rel_path}")


def find_claude_md(vault_path: str) -> str | None:
    """CLAUDE.md liegt typischerweise im Vault-Root (Eltern des wiki/-Ordners
    bei Karpathy-Layout, oder direkt im resolved dir bei Notiz-Vaults)."""
    root = resolve_dir(vault_path)
    for candidate in (root / "CLAUDE.md", root.parent / "CLAUDE.md"):
        if candidate.exists() and candidate.is_file():
            try:
                return candidate.read_text(encoding="utf-8")
            except Exception:
                continue
    return None
