"""Vault-Migration: Karpathy + PARA-in-wiki.

Einmaliges Skript zur Umstrukturierung eines bestehenden EwtosBrain-Vaults
in das hybride Karpathy+PARA-Schema. Standardmäßig Dry-Run; explicit
--apply nötig zum Schreiben. Legt vorher ein ZIP-Backup neben den Vault.

Ziel-Struktur:

    vault/
    ├─ agents.md           (Karpathy-Konvention, ersetzt CLAUDE.md inhaltlich)
    ├─ index.md            (Home-MOC)
    ├─ log.md
    ├─ inbox/              (ersetzt notes/)
    │   ├─ scratchpad.md
    │   └─ todos.md
    ├─ raw/                (immutable Quellen — bleibt wie ist)
    │   ├─ youtube/...
    │   ├─ transcripts/... (neu, falls Save-Pfad geändert wird)
    │   ├─ artikel/...
    │   ├─ eigene-notizen/...
    │   ├─ kunden-input/<kunde>/...
    │   └─ chat-archive/...
    ├─ wiki/               (LLM-kuratiert, PARA)
    │   ├─ index.md
    │   ├─ projects/
    │   ├─ areas/
    │   │   └─ trending.md (von wiki/trending.md verschoben)
    │   ├─ resources/
    │   │   ├─ creators/   (von wiki/creator-*.md)
    │   │   ├─ videos/     (von wiki/video-*.md)
    │   │   └─ playlists/  (von wiki/playlists/ falls vorhanden)
    │   └─ archive/
    └─ journal/            (optional, leer)

Bedienung:

    .venv\\Scripts\\python.exe tools\\migrate_vault.py "<vault-pfad>" [--apply]

Ohne --apply: zeigt nur Plan + simuliert Wikilink-Rewrites.
Mit --apply: legt Backup-ZIP an, verschiebt Dateien, rewriteet Wikilinks.

@author Dario | ewtos.com
"""
from __future__ import annotations

import argparse
import re
import shutil
import sys
import zipfile
from datetime import datetime
from pathlib import Path


SKIP_DIRS = {".git", ".obsidian", ".claude", "node_modules", ".venv"}


def make_backup(vault_path: Path) -> Path:
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = vault_path.parent / f"{vault_path.name}-backup-{ts}.zip"
    print(f"[backup] creating {backup_path} ...")
    with zipfile.ZipFile(backup_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in vault_path.rglob("*"):
            if any(part in SKIP_DIRS for part in p.parts):
                continue
            if p.is_file():
                zf.write(p, p.relative_to(vault_path.parent))
    print(f"[backup] done: {backup_path.stat().st_size // 1024} KB")
    return backup_path


def plan_moves(vault: Path) -> list[tuple[Path, Path]]:
    moves: list[tuple[Path, Path]] = []
    wiki = vault / "wiki"

    # creator-*.md -> wiki/resources/creators/
    for p in wiki.glob("creator-*.md"):
        moves.append((p, wiki / "resources" / "creators" / p.name))

    # video-*.md -> wiki/resources/videos/
    for p in wiki.glob("video-*.md"):
        moves.append((p, wiki / "resources" / "videos" / p.name))

    # wiki/playlists/* (falls vorhanden) -> wiki/resources/playlists/
    pl = wiki / "playlists"
    if pl.is_dir():
        for p in pl.iterdir():
            if p.is_file():
                moves.append((p, wiki / "resources" / "playlists" / p.name))

    # wiki/trending.md -> wiki/areas/trending.md
    trending = wiki / "trending.md"
    if trending.exists():
        moves.append((trending, wiki / "areas" / "trending.md"))

    # notes/ -> inbox/
    notes = vault / "notes"
    if notes.is_dir():
        for p in notes.rglob("*"):
            if p.is_file():
                rel = p.relative_to(notes)
                moves.append((p, vault / "inbox" / rel))

    return moves


def build_link_rewrite_map(moves: list[tuple[Path, Path]], vault: Path) -> dict[str, str]:
    """Map old-stem → new-relative-path-without-extension (Obsidian Wikilinks use stems or rel paths)."""
    mapping: dict[str, str] = {}
    for src, dst in moves:
        if src.suffix != ".md":
            continue
        stem = src.stem
        new_rel = str(dst.relative_to(vault).with_suffix("")).replace("\\", "/")
        mapping[stem] = new_rel
    return mapping


WIKILINK_RE = re.compile(r"\[\[([^\]\|#]+)((?:#[^\]\|]+)?)(?:\|([^\]]+))?\]\]")
EMBED_RE = re.compile(r"!\[\[([^\]\|#]+)((?:#[^\]\|]+)?)(?:\|([^\]]+))?\]\]")


def rewrite_links_in_text(text: str, link_map: dict[str, str]) -> tuple[str, int]:
    """Replace [[old-stem]] with [[new/rel/path]] keeping aliases and headings."""
    count = 0

    def replace_link(prefix: str):
        def fn(m):
            nonlocal count
            target = m.group(1).strip()
            anchor = m.group(2) or ""
            alias = m.group(3)
            stem = target.split("/")[-1]
            if stem in link_map:
                count += 1
                new_target = link_map[stem]
                alias_part = f"|{alias}" if alias else ""
                return f"{prefix}[[{new_target}{anchor}{alias_part}]]"
            return m.group(0)
        return fn

    text = EMBED_RE.sub(replace_link("!"), text)
    text = WIKILINK_RE.sub(replace_link(""), text)
    return text, count


def perform_moves(moves: list[tuple[Path, Path]], dry_run: bool) -> None:
    for src, dst in moves:
        if not src.exists():
            print(f"[skip] (gone) {src}")
            continue
        if dst.exists():
            print(f"[skip] (target exists) {dst}")
            continue
        if dry_run:
            print(f"[plan] move {src.relative_to(src.parents[1])} -> {dst.relative_to(dst.parents[2])}")
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dst))
            print(f"[move] {src} -> {dst}")


def rewrite_wikilinks(vault: Path, link_map: dict[str, str], dry_run: bool) -> None:
    total_changes = 0
    total_files = 0
    for md in vault.rglob("*.md"):
        if any(part in SKIP_DIRS for part in md.parts):
            continue
        try:
            text = md.read_text(encoding="utf-8")
        except Exception as e:
            print(f"[warn] cannot read {md}: {e}")
            continue
        new_text, n = rewrite_links_in_text(text, link_map)
        if n > 0:
            total_changes += n
            total_files += 1
            if dry_run:
                print(f"[plan] rewrite {n} wikilinks in {md.relative_to(vault)}")
            else:
                md.write_text(new_text, encoding="utf-8")
                print(f"[rewrite] {n} wikilinks in {md.relative_to(vault)}")
    print(f"[summary] {total_changes} wikilinks in {total_files} files {'planned' if dry_run else 'rewritten'}")


def ensure_skeleton_dirs(vault: Path, dry_run: bool) -> None:
    """Create empty target dirs + placeholder index.md so Obsidian shows them."""
    dirs = [
        "inbox",
        "wiki/projects",
        "wiki/areas",
        "wiki/resources/creators",
        "wiki/resources/videos",
        "wiki/resources/playlists",
        "wiki/archive",
        "journal",
    ]
    for rel in dirs:
        target = vault / rel
        if target.exists():
            continue
        if dry_run:
            print(f"[plan] mkdir {rel}")
        else:
            target.mkdir(parents=True, exist_ok=True)
            print(f"[mkdir] {target}")


def main() -> int:
    parser = argparse.ArgumentParser(description="EwtosBrain Vault-Migration (Karpathy + PARA)")
    parser.add_argument("vault", type=Path, help="Pfad zum Vault-Verzeichnis")
    parser.add_argument("--apply", action="store_true", help="Tatsaechlich anwenden (sonst Dry-Run)")
    parser.add_argument("--no-backup", action="store_true", help="ZIP-Backup ueberspringen (NICHT empfohlen)")
    args = parser.parse_args()

    vault = args.vault.resolve()
    if not vault.is_dir():
        print(f"[error] vault dir nicht gefunden: {vault}", file=sys.stderr)
        return 2

    print(f"[vault] {vault}")
    print(f"[mode]  {'APPLY' if args.apply else 'DRY-RUN'}")

    if args.apply and not args.no_backup:
        make_backup(vault)

    moves = plan_moves(vault)
    print(f"[plan] {len(moves)} Datei-Verschiebungen")

    link_map = build_link_rewrite_map(moves, vault)
    print(f"[plan] {len(link_map)} Wikilink-Stems neu zu mappen")

    ensure_skeleton_dirs(vault, dry_run=not args.apply)
    perform_moves(moves, dry_run=not args.apply)
    rewrite_wikilinks(vault, link_map, dry_run=not args.apply)

    if not args.apply:
        print("\n[hint] kein --apply gegeben — nichts wurde geschrieben.")
        print("[hint] Wenn der Plan stimmt: dasselbe Kommando mit --apply ausfuehren.")
    else:
        print("\n[done] Migration abgeschlossen.")
        print("[hint] Naechste Schritte:")
        print("  1. Vault in Obsidian oeffnen und Stichproben pruefen")
        print("  2. agents.md im Vault-Root pruefen (separat anlegen wenn nicht da)")
        print("  3. EwtosBrain-Server neu starten und neue Pfade pruefen")
    return 0


if __name__ == "__main__":
    sys.exit(main())
