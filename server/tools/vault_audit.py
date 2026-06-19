# @author Dario | ewtos.com
"""Vault-Audit: read-only Health-Check eines Vaults.

Findet Orphans (Pages nicht im Parent-Index), un-ingestete raw-Dateien, kaputte Wikilinks,
fehlende Pflicht-Frontmatter, Struktur-Drift gegen das Blueprint und veraltete verwaltete
CLAUDE.md-Sektionen.

Rein lesend — schreibt nie. Wiederverwendet wiki_reader (Navigation/Suche), briefing-style
Frontmatter-Parsing und blueprint (Soll-Struktur + CLAUDE.md-Upgrade-Preview).
"""
from __future__ import annotations

import re
from datetime import date
from pathlib import Path

import yaml

import settings
from tools import blueprint, wiki_reader

IGNORED_NAMES = wiki_reader.IGNORED_NAMES
REQUIRED_FRONTMATTER = ("typ", "titel", "status", "zuletzt")
WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")
FENCE_RE = re.compile(r"```.*?```", re.DOTALL)
INLINE_CODE_RE = re.compile(r"`[^`\n]*`")


def _parse_frontmatter(text: str) -> dict:
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end == -1:
        return {}
    try:
        return yaml.safe_load(text[3:end]) or {}
    except Exception:
        return {}


def _finding(category: str, severity: str, path: str, message: str, recommendation: str) -> dict:
    return {
        "category": category,
        "severity": severity,
        "path": path,
        "message": message,
        "recommendation": recommendation,
    }


def _link_basename(link: str) -> str:
    """Normalisiert einen Wikilink-Target auf den Slug: ohne Alias, Heading, Pfad, .md."""
    target = link.split("|", 1)[0].split("#", 1)[0].strip().replace("\\", "/")
    if target.endswith(".md"):
        target = target[:-3]
    return target.rsplit("/", 1)[-1].lower()


def _read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8")
    except Exception:
        return ""


def _md_files(root: Path) -> list[Path]:
    return [
        p for p in root.rglob("*.md")
        if not any(part in IGNORED_NAMES or part.startswith(".") for part in p.relative_to(root).parts)
    ]


def _check_orphans(root: Path) -> list[dict]:
    """In jedem Ordner mit index.md + '## Pages': Sibling-Pages die nicht verlinkt sind."""
    out: list[dict] = []
    for idx in root.rglob("index.md"):
        rel_parts = idx.relative_to(root).parts
        if any(part in IGNORED_NAMES or part.startswith(".") for part in rel_parts):
            continue
        content = _read(idx)
        if "## Pages" not in content:
            continue  # Kein Link-Register (z.B. Dataview/Grep-Index) → kein Orphan-Check
        linked = {_link_basename(m) for m in WIKILINK_RE.findall(content)}
        for sib in idx.parent.glob("*.md"):
            if sib.name == "index.md":
                continue
            if sib.stem.lower() not in linked:
                rel = sib.relative_to(root).as_posix()
                out.append(_finding(
                    "orphan_index", "warn", rel,
                    f"Page nicht im Index '{idx.relative_to(root).as_posix()}' verlinkt.",
                    f"Eintrag '- [[{sib.with_suffix('').relative_to(root).as_posix()}]] — <titel>' "
                    f"unter '## Pages' ergänzen.",
                ))
    return out


def _check_raw_uningested(root: Path, md_files: list[Path]) -> list[dict]:
    """Farming-only: prueft raw/ auf noch nicht ins Wiki ueberfuehrte Quellen.
    Nur relevant fuer Vaults mit raw/ (karpathy-para-base/researcher). Ein reiner
    kontext-base-Vault hat kein raw/ → return [] (kein Finding, korrekt)."""
    raw_dir = root / "raw"
    if not raw_dir.exists():
        return []
    wiki_blob = "\n".join(
        _read(p).lower() for p in md_files
        if p.relative_to(root).parts and p.relative_to(root).parts[0] == "wiki"
    )
    out: list[dict] = []
    for p in raw_dir.rglob("*.md"):
        if any(part in IGNORED_NAMES or part.startswith(".") for part in p.parts):
            continue
        stem = p.stem.lower()
        if stem and stem not in wiki_blob:
            rel = p.relative_to(root).as_posix()
            out.append(_finding(
                "raw_uningested", "info", rel,
                "Raw-Datei wird in keiner Wiki-Page referenziert (vermutlich noch nicht ingested).",
                "Ingesten: Wiki-Page anlegen, Quelle in 'quellen' verlinken, Parent-Index + log.md updaten.",
            ))
    return out


def _check_broken_links(root: Path, md_files: list[Path]) -> list[dict]:
    # Auflösbare Ziele: alle Dateien (auch .base), mit + ohne Endung, voller Pfad + Basename.
    known: set[str] = set()
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        rel_parts = p.relative_to(root).parts
        if any(part in IGNORED_NAMES or part.startswith(".") for part in rel_parts):
            continue
        rel = p.relative_to(root).as_posix().lower()
        known.add(rel)
        known.add(p.name.lower())
        known.add(p.stem.lower())
        if "." in p.name:
            known.add(rel.rsplit(".", 1)[0])

    out: list[dict] = []
    for p in md_files:
        if p.relative_to(root).parts[0] != "wiki":
            continue
        content = INLINE_CODE_RE.sub("", FENCE_RE.sub("", _read(p)))  # Code-Beispiele ignorieren
        seen: set[str] = set()
        for raw_link in WIKILINK_RE.findall(content):
            target = raw_link.replace("\\|", "|").split("|", 1)[0].split("#", 1)[0].strip().replace("\\", "/")
            # Platzhalter, Ordner-Links und Leere überspringen
            if not target or target.endswith("/") or "..." in target or target in seen:
                continue
            seen.add(target)
            t = target.lower()
            base = t.rsplit("/", 1)[-1]
            cands = {t, base}
            if "." in base:
                cands.add(t.rsplit(".", 1)[0])
                cands.add(base.rsplit(".", 1)[0])
            if not (cands & known):
                out.append(_finding(
                    "broken_wikilink", "error", p.relative_to(root).as_posix(),
                    f"Wikilink [[{raw_link}]] zeigt auf keine existierende Datei.",
                    "Linkziel korrigieren oder die fehlende Page anlegen.",
                ))
    return out


def _check_frontmatter(root: Path, md_files: list[Path], bp: dict | None) -> list[dict]:
    # Fremd-Vault ohne EwtosBrain-Blueprint: eigene Frontmatter-Konvention nicht
    # erzwingen — sonst False Positives bei abweichenden (z.B. englischen) Keys.
    if not bp:
        return []
    # Pflichtkeys aus dem Blueprint (vom extend-Modus aus der echten Struktur
    # abgeleitet), sonst der PARA-Default.
    required = (bp.get("vars") or {}).get("frontmatter_required") or list(REQUIRED_FRONTMATTER)
    if not required:
        return []
    out: list[dict] = []
    for p in md_files:
        if p.relative_to(root).parts[0] != "wiki" or p.name == "index.md":
            continue
        fm = _parse_frontmatter(_read(p))
        missing = [k for k in required if not fm.get(k)]
        if missing:
            out.append(_finding(
                "missing_frontmatter", "warn", p.relative_to(root).as_posix(),
                f"Pflicht-Frontmatter fehlt: {', '.join(missing)}.",
                f"Felder ergänzen: {', '.join(missing)}.",
            ))
    return out


def _check_structure(vault_id: str, root: Path) -> list[dict]:
    """Prueft nur die im Blueprint EXPLIZIT gelisteten folders[]. Automatisch
    erzeugte Index-Hubs (wiki/<bucket>, wiki/<bucket>/<thema>) sind nicht in
    folders[] — die deckt der separate `missing_hub`-Check ab."""
    bp = blueprint.export_vault_blueprint(vault_id)
    if not bp:
        return [_finding(
            "structure_drift", "info", "",
            "Vault ohne EwtosBrain-Blueprint — Struktur-Soll-Abgleich übersprungen.",
            "Optional: Vault per Setup-Wizard mit einem Blueprint verbinden.",
        )]
    out: list[dict] = []
    for folder in bp.get("folders") or []:
        rel = folder.get("path")
        if rel and not (root / rel).exists():
            out.append(_finding(
                "structure_drift", "warn", rel + "/",
                "Vom Blueprint erwarteter Ordner fehlt.",
                f"Ordner '{rel}/' anlegen.",
            ))
    return out


def _check_claude_md(vault_id: str) -> list[dict]:
    # Fremd-Vault (kein Blueprint-Snapshot, keine ewtosbrain-Marker): KEIN Apply
    # anbieten — das Default-Blueprint passt i.d.R. nicht und würde widersprüchliche
    # Sektionen reinmergen. Nur eine Empfehlung (extend-Mode liest die echte Struktur).
    vault = settings.get_vault(vault_id)
    existing = ""
    if vault:
        cm = Path(vault["path"]) / "CLAUDE.md"
        if cm.exists():
            existing = _read(cm)
    managed = (
        blueprint.export_vault_blueprint(vault_id) is not None
        or "ewtosbrain:section" in existing
    )
    if not managed:
        return [_finding(
            "claude_md_advice", "info", "CLAUDE.md",
            "Fremd-Vault ohne EwtosBrain-Blueprint — kein automatischer CLAUDE.md-Abgleich.",
            "Optional: im Setup-Wizard 'Bestehenden verbinden' (extend-Modus) wählen — "
            "der Setup-Agent liest die vorhandene Struktur und erweitert sie passend, "
            "statt das Standard-Blueprint aufzudrücken.",
        )]
    try:
        prev = blueprint.preview_claude_md_upgrade(vault_id)
    except Exception as e:
        return [_finding("audit_error", "info", "CLAUDE.md",
                         f"CLAUDE.md-Abgleich fehlgeschlagen: {e}", "")]
    if not prev.get("changed"):
        return []
    return [_finding(
        "claude_md_drift", "warn", "CLAUDE.md",
        "Verwaltete CLAUDE.md-Sektionen sind veraltet oder fehlen.",
        "Upgrade verfügbar — Diff prüfen und 'CLAUDE.md aktualisieren' (non-destruktiv).",
    )]


# --- Auto-Repair (nur sicher-deterministische Kategorien) -----------------
# Bewusst eng: nur orphan_index (Index-Zeile ergänzen) + structure_drift
# (fehlenden Ordner anlegen). broken_wikilink/raw_uningested/missing_frontmatter
# brauchen menschliches Urteil und bleiben reiner Bericht. Jeder Repair wird vom
# Aufrufer per-Finding bestätigt (UI/MCP), genau wie der CLAUDE.md-Apply.

def _check_missing_hubs(root: Path) -> list[dict]:
    """wiki/-Ordner MIT Inhalt aber ohne index.md-Hub: Buckets (Ebene 1) und
    Themen-Ordner (Ebene 2). Leere Ordner brauchen keinen Hub; tiefer (≥3) wird
    bewusst nicht indexiert (flache MOC)."""
    wiki = root / "wiki"
    if not wiki.is_dir():
        return []
    out: list[dict] = []
    for d in wiki.rglob("*"):
        if not d.is_dir() or any(part.startswith(".") for part in d.relative_to(root).parts):
            continue
        depth = len(d.relative_to(wiki).parts)
        if depth in (1, 2) and blueprint._folder_has_content(d):
            if not (d / "index.md").exists():
                rel = d.relative_to(root).as_posix()
                out.append(_finding(
                    "missing_hub", "warn", rel + "/",
                    f"Ordner mit Inhalt ohne index.md-Hub: {rel}/",
                    "'Indexe neu aufbauen' — legt fehlende Hubs an und pflegt alle ## Pages (non-destruktiv).",
                ))
    return out


REPAIRABLE_CATEGORIES = ("orphan_index", "structure_drift", "missing_hub", "missing_frontmatter")


def _page_title(page: Path) -> str:
    fm = _parse_frontmatter(_read(page))
    title = fm.get("titel")
    return str(title).strip() if title else page.stem


def _insert_under_pages(content: str, new_line: str) -> str | None:
    """Fügt new_line ans Ende der Liste unter '## Pages' ein. None wenn keine Sektion."""
    lines = content.splitlines()
    heading = next((i for i, l in enumerate(lines) if l.strip().lower() == "## pages"), None)
    if heading is None:
        return None
    insert_at = heading + 1
    j = heading + 1
    while j < len(lines):
        s = lines[j].strip()
        if s.startswith(("-", "*")):
            insert_at = j + 1
            j += 1
        elif s == "":
            j += 1
        else:
            break
    lines.insert(insert_at, new_line)
    return "\n".join(lines) + ("\n" if content.endswith("\n") else "")


def _repair_orphan(root: Path, rel_path: str) -> dict:
    page = root / rel_path
    if not page.exists():
        return {"repaired": False, "reason": f"Page existiert nicht mehr: {rel_path}"}
    index = page.parent / "index.md"
    if not index.exists():
        return {"repaired": False, "reason": f"Kein index.md neben {rel_path} — manueller Eingriff nötig."}
    content = _read(index)
    linked = {_link_basename(m) for m in WIKILINK_RE.findall(content)}
    if page.stem.lower() in linked:
        return {"repaired": False, "reason": "Page ist bereits im Index verlinkt."}
    slug = page.with_suffix("").relative_to(root).as_posix()
    new_line = f"- [[{slug}]] — {_page_title(page)}"
    merged = _insert_under_pages(content, new_line)
    if merged is None:
        return {"repaired": False, "reason": f"Kein '## Pages'-Abschnitt in {index.relative_to(root).as_posix()}."}
    index.write_text(merged, encoding="utf-8")
    return {
        "repaired": True,
        "action": "index_entry_added",
        "path": index.relative_to(root).as_posix(),
        "line": new_line,
    }


def _repair_structure(root: Path, rel_path: str) -> dict:
    rel = rel_path.rstrip("/")
    if not rel:
        return {"repaired": False, "reason": "Kein Ordnerpfad im Finding."}
    folder = root / rel
    if folder.exists():
        return {"repaired": False, "reason": f"Ordner existiert bereits: {rel}/"}
    folder.mkdir(parents=True, exist_ok=True)
    return {"repaired": True, "action": "folder_created", "path": rel + "/"}


_TYP_BY_BUCKET = {"projects": "project", "areas": "area", "resources": "wissen", "archive": "archiv"}


def _yaml_val(v: str) -> str:
    if v == "" or v != v.strip() or re.search(r'[:#\[\]{}|>&*!,]', v):
        return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return v


def _default_fm_value(key: str, page: Path, root: Path) -> str:
    if key in ("zuletzt", "aktualisiert", "datum"):
        return date.today().isoformat()
    if key == "status":
        return "aktiv"
    if key == "titel":
        m = re.search(r"^#\s+(.+?)\s*$", _read(page), re.MULTILINE)
        return m.group(1).strip() if m else page.stem.replace("-", " ").replace("_", " ").title()
    if key == "typ":
        parts = page.relative_to(root).parts
        bucket = parts[1] if len(parts) > 1 and parts[0] == "wiki" else ""
        return _TYP_BY_BUCKET.get(bucket, "wissen")
    return "tbd"


def _repair_frontmatter(root: Path, rel_path: str, required: list[str]) -> dict:
    """Ergaenzt fehlende Pflicht-Frontmatter-Keys mit deterministischen Defaults
    (typ aus Bucket, titel aus # Ueberschrift/Dateiname, status=aktiv, zuletzt=heute).
    Bestehende Keys + Body bleiben unangetastet."""
    page = root / rel_path
    if not page.exists():
        return {"repaired": False, "reason": f"Datei existiert nicht: {rel_path}"}
    text = _read(page)
    fm = _parse_frontmatter(text)
    missing = [k for k in required if not fm.get(k)]
    if not missing:
        return {"repaired": False, "reason": "Frontmatter bereits vollstaendig."}
    add_lines = [f"{k}: {_yaml_val(_default_fm_value(k, page, root))}" for k in missing]
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            new_text = text[:end] + "\n" + "\n".join(add_lines) + text[end:]
        else:  # kaputter/offener Block → davor neuen setzen
            new_text = "---\n" + "\n".join(add_lines) + "\n---\n\n" + text
    else:
        new_text = "---\n" + "\n".join(add_lines) + "\n---\n\n" + text
    page.write_text(new_text, encoding="utf-8")
    return {"repaired": True, "action": "frontmatter_added",
            "path": rel_path, "added": missing}


def repair_finding(vault_id: str, category: str, path: str) -> dict:
    """Repariert ein einzelnes Audit-Finding. Re-validiert gegen den Live-Vault
    (idempotent: bereits behoben -> repaired False mit Grund). Schreibt nur für
    REPAIRABLE_CATEGORIES, sonst ValueError."""
    vault = settings.get_vault(vault_id)
    if not vault:
        raise LookupError(f"Vault {vault_id} nicht gefunden")
    root = Path(vault["path"])
    if not root.exists():
        raise FileNotFoundError(f"Vault-Pfad existiert nicht: {root}")
    if category == "orphan_index":
        return _repair_orphan(root, path)
    if category == "structure_drift":
        return _repair_structure(root, path)
    if category == "missing_hub":
        res = blueprint.rebuild_vault_indexes(vault_id)
        return {"repaired": True, "action": "indexes_rebuilt",
                "created_hubs": res.get("created_hubs", []), "mocs_updated": res.get("mocs_updated", [])}
    if category == "missing_frontmatter":
        bp = blueprint.export_vault_blueprint(vault_id)
        required = ((bp or {}).get("vars") or {}).get("frontmatter_required") or list(REQUIRED_FRONTMATTER)
        return _repair_frontmatter(root, path, required)
    raise ValueError(
        f"Kategorie '{category}' ist nicht automatisch reparierbar "
        f"(nur: {', '.join(REPAIRABLE_CATEGORIES)})."
    )


def audit_vault(vault_id: str) -> dict:
    """Read-only Health-Check. Liefert {vault_id, findings, summary}."""
    vault = settings.get_vault(vault_id)
    if not vault:
        raise LookupError(f"Vault {vault_id} nicht gefunden")
    root = Path(vault["path"])
    if not root.exists():
        raise FileNotFoundError(f"Vault-Pfad existiert nicht: {root}")

    md_files = _md_files(root)
    bp_snapshot = blueprint.export_vault_blueprint(vault_id)
    findings: list[dict] = []
    for check in (
        lambda: _check_orphans(root),
        lambda: _check_missing_hubs(root),
        lambda: _check_raw_uningested(root, md_files),
        lambda: _check_broken_links(root, md_files),
        lambda: _check_frontmatter(root, md_files, bp_snapshot),
        lambda: _check_structure(vault_id, root),
        lambda: _check_claude_md(vault_id),
    ):
        try:
            findings.extend(check())
        except Exception as e:
            findings.append(_finding("audit_error", "info", "", f"Check fehlgeschlagen: {e}", ""))

    by_severity = {"error": 0, "warn": 0, "info": 0}
    by_category: dict[str, int] = {}
    for f in findings:
        f["repairable"] = f["category"] in REPAIRABLE_CATEGORIES and bool(f["path"])
        by_severity[f["severity"]] = by_severity.get(f["severity"], 0) + 1
        by_category[f["category"]] = by_category.get(f["category"], 0) + 1

    return {
        "vault_id": vault_id,
        "vault_name": vault.get("name"),
        "findings": findings,
        "summary": {
            "total": len(findings),
            "files_scanned": len(md_files),
            "by_severity": by_severity,
            "by_category": by_category,
        },
    }
