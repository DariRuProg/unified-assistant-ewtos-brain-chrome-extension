# @author Dario | ewtos.com
"""CSV-Import für das CRM: jede Zeile einer Kundenliste wird zu einer Kundenkarte
(`crm/kunden/<slug>.md`) im selben Schema wie `crm/templates/kunde.md`.

Die CSV ist nur das Saatgut — nach dem Import ist `kundenstamm.base` / die
Sidepanel-Tabelle die Lookup-Oberfläche. Sensible Daten (DSGVO) lassen sich beim
Import mit `sensitive=True` markieren (`sensibel: true` → nur freigegebenes LLM).
"""
from __future__ import annotations

import csv
import io
import re
from datetime import date
from pathlib import Path
from typing import Any

import settings
from tools import wiki_reader

SLUG_RE = re.compile(r"[^a-z0-9]+")

# Ziel-Felder der Kundenkarte → Default-Reihenfolge im Frontmatter.
CARD_FIELDS = ["titel", "firma", "branche", "status", "vertrag_bis", "kontakt", "email", "telefon", "website"]

# Heuristik für die Auto-Zuordnung: Ziel-Feld → Substrings, die im CSV-Header vorkommen können.
_AUTO_HINTS = {
    "titel": ["name", "kunde", "titel"],
    "firma": ["firma", "company", "unternehmen"],
    "branche": ["branche", "industry", "kategorie"],
    "status": ["status"],
    "vertrag_bis": ["vertrag", "contract", "bis"],
    "kontakt": ["kontakt", "ansprech", "contact"],
    "email": ["email", "e-mail", "mail"],
    "telefon": ["telefon", "phone", "tel", "mobil"],
    "website": ["website", "web", "url", "homepage"],
}


def _slugify(text: str) -> str:
    s = SLUG_RE.sub("-", (text or "").strip().lower()).strip("-")
    return s[:60] or "kunde"


def detect_delimiter(text: str) -> str:
    """; wenn die Kopfzeile mehr Semikolons als Kommas hat (deutsches Excel), sonst ,."""
    first = (text.splitlines() or [""])[0]
    return ";" if first.count(";") > first.count(",") else ","


def parse_csv(text: str) -> tuple[list[str], list[dict[str, str]]]:
    """Parst CSV-Text robust. Returns (headers, rows) — rows als {header: wert}."""
    text = text.lstrip("﻿")  # BOM von Excel entfernen
    delim = detect_delimiter(text)
    reader = csv.reader(io.StringIO(text), delimiter=delim)
    all_rows = [r for r in reader if any((c or "").strip() for c in r)]
    if not all_rows:
        return [], []
    headers = [h.strip() for h in all_rows[0]]
    rows: list[dict[str, str]] = []
    for raw in all_rows[1:]:
        row = {headers[i]: (raw[i].strip() if i < len(raw) else "") for i in range(len(headers))}
        rows.append(row)
    return headers, rows


def suggest_mapping(headers: list[str]) -> dict[str, str]:
    """Schlägt {ziel_feld: header} vor anhand von Header-Namen. Erste Übereinstimmung gewinnt."""
    mapping: dict[str, str] = {}
    used: set[str] = set()
    for field, hints in _AUTO_HINTS.items():
        for h in headers:
            if h in used:
                continue
            hl = h.lower()
            if any(hint in hl for hint in hints):
                mapping[field] = h
                used.add(h)
                break
    return mapping


def preview(text: str, sample: int = 3) -> dict[str, Any]:
    headers, rows = parse_csv(text)
    return {
        "headers": headers,
        "total": len(rows),
        "sample": rows[:sample],
        "suggested_mapping": suggest_mapping(headers),
    }


def _build_card(values: dict[str, str], unmapped: dict[str, str], sensitive: bool, today: str) -> str:
    titel = values.get("titel") or values.get("firma") or "Kunde"
    fm = ["---", "typ: kunde", f"titel: {titel}"]
    if sensitive:
        fm.append("sensibel: true")
    for field in CARD_FIELDS:
        if field == "titel":
            continue
        val = values.get(field, "")
        if val:
            fm.append(f"{field}: {val}")
    if "status" not in values or not values.get("status"):
        fm.append("status: aktiv")
    fm.append("tags: [kunde]")
    fm.append(f"zuletzt: {today}")
    fm.append("---")

    notizen = ""
    extras = {k: v for k, v in unmapped.items() if v}
    if extras:
        notizen = "\n".join(f"- {k}: {v}" for k, v in extras.items())

    body = (
        f"# {titel}\n\n"
        "## Überblick\n\n\n"
        "## Projekte\n\n\n"
        "## Aktivitäts-Log\n\n\n"
        "## Notizen\n"
        + (notizen + "\n" if notizen else "")
    )
    return "\n".join(fm) + "\n\n" + body


def import_customers(vault_id: str, csv_text: str, mapping: dict[str, str],
                     sensitive: bool = False) -> dict[str, Any]:
    """Erzeugt je CSV-Zeile eine Kundenkarte unter crm/kunden/. Erfordert write_files.
    `mapping`: {ziel_feld: csv_header}. Bereits existierende Slugs werden übersprungen
    (kein Überschreiben). Returns {created, skipped, total, files}."""
    vault = settings.get_vault(vault_id)
    if not vault:
        raise ValueError(f"Vault {vault_id} nicht gefunden")
    if not settings.vault_permission(vault_id, "write_files"):
        raise PermissionError(
            f"Kein write_files-Recht im Vault '{vault['name']}'. "
            f"In den Einstellungen für diesen Vault aktivieren."
        )

    headers, rows = parse_csv(csv_text)
    if not rows:
        raise ValueError("CSV enthält keine Datenzeilen.")

    mapped_headers = {h for h in mapping.values() if h}
    today = date.today().isoformat()
    vault_root = vault["path"]

    created: list[str] = []
    skipped: list[str] = []
    used_slugs: set[str] = set()

    for row in rows:
        values = {field: row.get(header, "") for field, header in mapping.items() if header}
        unmapped = {h: row.get(h, "") for h in headers if h not in mapped_headers}

        base_slug = _slugify(values.get("firma") or values.get("titel") or "kunde")
        slug = base_slug
        n = 2
        while slug in used_slugs:
            slug = f"{base_slug}-{n}"
            n += 1
        used_slugs.add(slug)

        rel = f"crm/kunden/{slug}.md"
        content = _build_card(values, unmapped, sensitive, today)
        try:
            wiki_reader.create_file(vault_root, rel, content)
            created.append(rel)
        except FileExistsError:
            skipped.append(rel)

    return {"created": len(created), "skipped": len(skipped), "total": len(rows), "files": created}
