"""Vault navigation tools — read-only filesystem access scoped to a vault.

Two tools form the navigation primitive:
  - list_folder(vault_path, rel)  — list .md files + subfolders at a path
  - read_file(vault_path, rel)    — read a single file

Plus helpers to find the vault's CLAUDE.md (used as the live system prompt).
"""
from __future__ import annotations

from pathlib import Path

# Prefixes/names to ignore when listing (Obsidian internals, hidden, system).
IGNORED_NAMES = {".obsidian", ".trash", ".git", "node_modules", "__pycache__"}


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


def list_folder(vault_path: str, rel_path: str = "") -> dict:
    """List .md files and subfolders inside a folder. Path is relative to
    the vault root. Empty path = vault root."""
    target = _safe_resolve(vault_path, rel_path)
    if not target.exists():
        raise FileNotFoundError(f"Ordner nicht gefunden: {rel_path}")
    if not target.is_dir():
        raise ValueError(f"Kein Ordner: {rel_path}")
    root = resolve_dir(vault_path).resolve()
    folders: list[str] = []
    files: list[str] = []
    for entry in target.iterdir():
        if entry.name.startswith(".") or entry.name in IGNORED_NAMES:
            continue
        try:
            rel = str(entry.relative_to(root)).replace("\\", "/")
        except ValueError:
            continue
        if entry.is_dir():
            folders.append(rel)
        elif entry.is_file() and entry.suffix.lower() == ".md":
            files.append(rel)
    return {"path": rel_path or "", "folders": sorted(folders), "files": sorted(files)}


def read_file(vault_path: str, rel_path: str) -> str:
    p = _safe_resolve(vault_path, rel_path)
    if not p.exists():
        raise FileNotFoundError(f"Datei nicht gefunden: {rel_path}")
    if not p.is_file():
        raise ValueError(f"Kein File: {rel_path}")
    return p.read_text(encoding="utf-8")


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
