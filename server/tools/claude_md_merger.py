# @author Dario | ewtos.com
"""Marker-based merge of CLAUDE.md sections into an existing Vault-CLAUDE.md text.

User-text outside the markers stays untouched. Used by the Blueprint-Core and the
Setup-Agent (re-setup mode). No I/O — the caller reads and writes files.

Marker format:
    <!-- ewtosbrain:section:id=<id> order=<int> -->
    ## Title
    ...content...
    <!-- ewtosbrain:section:end id=<id> -->
"""
from __future__ import annotations

import re
from typing import Any

START_RE = re.compile(
    r"^<!--\s*ewtosbrain:section:id=(?P<id>[a-z0-9][a-z0-9\-]*)\s+order=(?P<order>-?\d+)\s*-->\s*$"
)
END_RE = re.compile(
    r"^<!--\s*ewtosbrain:section:end\s+id=(?P<id>[a-z0-9][a-z0-9\-]*)\s*-->\s*$"
)

VALID_POLICIES = ("replace_if_marker", "skip_if_exists", "overwrite")


def parse_sections(text: str) -> dict[str, dict]:
    """Return map id -> {'order', 'start_line', 'end_line', 'content'}.

    start_line/end_line are 0-based line indices of the marker lines themselves.
    content is the block between the markers, without the marker lines.
    """
    lines = text.splitlines()
    result: dict[str, dict] = {}
    i = 0
    open_section: dict | None = None
    while i < len(lines):
        line = lines[i]
        m_start = START_RE.match(line)
        m_end = END_RE.match(line)

        if m_start:
            if open_section is not None:
                # vorheriger Block hat keinen End-Marker -> Warnung und verwerfen
                print(
                    f"[claude_md_merger] WARN: section '{open_section['id']}' "
                    f"hat keinen End-Marker, wird als unmanaged behandelt."
                )
            open_section = {
                "id": m_start.group("id"),
                "order": int(m_start.group("order")),
                "start_line": i,
                "body_start": i + 1,
            }
        elif m_end and open_section is not None:
            sid = m_end.group("id")
            if sid != open_section["id"]:
                print(
                    f"[claude_md_merger] WARN: End-Marker '{sid}' passt nicht zu "
                    f"Start-Marker '{open_section['id']}' — uebersprungen."
                )
                open_section = None
            else:
                body = lines[open_section["body_start"] : i]
                section = {
                    "order": open_section["order"],
                    "start_line": open_section["start_line"],
                    "end_line": i,
                    "content": "\n".join(body),
                }
                if sid in result:
                    print(
                        f"[claude_md_merger] WARN: doppelte section id '{sid}' — "
                        f"zweites Vorkommen ignoriert."
                    )
                else:
                    result[sid] = section
                open_section = None
        i += 1

    if open_section is not None:
        print(
            f"[claude_md_merger] WARN: section '{open_section['id']}' "
            f"hat keinen End-Marker, wird als unmanaged behandelt."
        )

    return result


def render_section(section: dict) -> str:
    """Render a single managed block. Section schema: id, order, title?, content."""
    sid = section["id"]
    order = int(section.get("order", 100))
    title = section.get("title")
    content = section.get("content", "")

    parts: list[str] = []
    parts.append(f"<!-- ewtosbrain:section:id={sid} order={order} -->")
    parts.append("")
    if title:
        parts.append(f"## {title}")
        parts.append("")
    if content:
        parts.append(content.rstrip("\n"))
        parts.append("")
    parts.append(f"<!-- ewtosbrain:section:end id={sid} -->")
    return "\n".join(parts)


def _split_lines_keep(text: str) -> list[str]:
    return text.splitlines()


def _replace_block(text: str, start_line: int, end_line: int, new_block: str) -> str:
    lines = text.splitlines()
    before = lines[:start_line]
    after = lines[end_line + 1 :]
    new_lines = new_block.splitlines()
    merged = before + new_lines + after
    result = "\n".join(merged)
    # Trailing newline beibehalten falls Original einen hatte
    if text.endswith("\n") and not result.endswith("\n"):
        result += "\n"
    return result


def _insert_before_line(text: str, line_idx: int, new_block: str) -> str:
    lines = text.splitlines()
    before = lines[:line_idx]
    after = lines[line_idx:]
    # Leerzeile zwischen new_block und nachfolgendem managed Section
    new_lines = new_block.splitlines() + [""]
    merged = before + new_lines + after
    result = "\n".join(merged)
    if text.endswith("\n") and not result.endswith("\n"):
        result += "\n"
    return result


def _append_to_end(text: str, new_block: str) -> str:
    if not text or not text.strip():
        return new_block + ("\n" if not new_block.endswith("\n") else "")
    # Trailing-Newlines des Originals merken (max 1 als Separator hinzufuegen)
    had_trailing = text.endswith("\n")
    base = text.rstrip("\n")
    sep = "\n\n"
    result = base + sep + new_block
    if had_trailing:
        result += "\n"
    else:
        result += "\n"
    return result


def merge(existing_text: str, new_sections: list[dict]) -> str:
    """Merge new_sections into existing_text. See module docstring for schema."""
    # Leerer Vault
    if not existing_text or not existing_text.strip():
        sorted_new = sorted(new_sections, key=lambda s: int(s.get("order", 100)))
        parts: list[str] = []
        for sec in sorted_new:
            parts.append(render_section(_normalize_section(sec)))
        out = "\n\n".join(parts)
        if not out.endswith("\n"):
            out += "\n"
        return out

    text = existing_text
    parsed = parse_sections(text)

    to_insert: list[dict] = []

    for raw in new_sections:
        sec = _normalize_section(raw)
        sid = sec["id"]
        policy = sec.get("merge_policy", "replace_if_marker")
        if policy not in VALID_POLICIES:
            print(
                f"[claude_md_merger] WARN: unbekannte merge_policy '{policy}' fuer "
                f"section '{sid}' — verwende 'replace_if_marker'."
            )
            policy = "replace_if_marker"

        if sid in parsed:
            if policy == "skip_if_exists":
                continue
            # replace_if_marker oder overwrite -> Block ersetzen
            existing = parsed[sid]
            new_block = render_section(sec)
            text = _replace_block(text, existing["start_line"], existing["end_line"], new_block)
            parsed = parse_sections(text)
        else:
            to_insert.append(sec)

    # Inserts nach order sortiert anwenden
    to_insert.sort(key=lambda s: int(s.get("order", 100)))
    for sec in to_insert:
        order = int(sec.get("order", 100))
        # next-higher order unter den aktuell managed Sections suchen
        candidates = [(sid, info) for sid, info in parsed.items() if info["order"] > order]
        new_block = render_section(sec)
        if candidates:
            candidates.sort(key=lambda kv: kv[1]["order"])
            target_sid, target_info = candidates[0]
            text = _insert_before_line(text, target_info["start_line"], new_block)
        else:
            text = _append_to_end(text, new_block)
        parsed = parse_sections(text)

    return text


def strip_sections(text: str, ids: list[str]) -> str:
    """Remove managed sections with given ids. Also strips one leading blank line
    immediately before the start-marker and one trailing blank line after the end-marker
    if they exist (to avoid leaving double-blank artefacts).
    """
    if not ids:
        return text

    id_set = set(ids)
    parsed = parse_sections(text)
    # Targets nach start_line absteigend bearbeiten, damit Indizes stabil bleiben
    targets = sorted(
        [info for sid, info in parsed.items() if sid in id_set],
        key=lambda info: info["start_line"],
        reverse=True,
    )

    lines = text.splitlines()
    had_trailing = text.endswith("\n")

    for info in targets:
        s = info["start_line"]
        e = info["end_line"]
        # eine umgebende Leerzeile davor entfernen, falls vorhanden
        if s - 1 >= 0 and lines[s - 1].strip() == "":
            s = s - 1
        # eine umgebende Leerzeile danach entfernen, falls vorhanden
        if e + 1 < len(lines) and lines[e + 1].strip() == "":
            e = e + 1
        del lines[s : e + 1]

    result = "\n".join(lines)
    if had_trailing and not result.endswith("\n"):
        result += "\n"
    return result


def _normalize_section(sec: dict) -> dict:
    """Klone Section-Dict mit defensiven Defaults."""
    out: dict[str, Any] = dict(sec)
    if "order" not in out or out["order"] is None:
        out["order"] = 100
    out["order"] = int(out["order"])
    if "id" not in out or not out["id"]:
        raise ValueError("section missing 'id'")
    return out


if __name__ == "__main__":
    existing = (
        "# Mein Vault\n"
        "\n"
        "Eigene User-Notizen oben — bleiben unangetastet.\n"
        "\n"
        "<!-- ewtosbrain:section:id=intro order=10 -->\n"
        "\n"
        "## Intro\n"
        "\n"
        "Alter Intro-Text.\n"
        "\n"
        "<!-- ewtosbrain:section:end id=intro -->\n"
        "\n"
        "Zwischentext vom User — bleibt auch erhalten.\n"
        "\n"
        "<!-- ewtosbrain:section:id=alt-skip order=50 -->\n"
        "\n"
        "## Alt Skip\n"
        "\n"
        "Diese Section sollte beim skip_if_exists unangetastet bleiben.\n"
        "\n"
        "<!-- ewtosbrain:section:end id=alt-skip -->\n"
        "\n"
        "Footer-Text vom User.\n"
    )

    new_sections = [
        {
            "id": "intro",
            "order": 10,
            "title": "Intro",
            "content": "Neuer Intro-Text — ersetzt den alten.",
            "merge_policy": "replace_if_marker",
        },
        {
            "id": "crm-konventionen",
            "order": 25,
            "title": "CRM-Konventionen",
            "content": "Kunden-Slugs in kebab-case.\nKontakte als wikilinks.",
            "merge_policy": "replace_if_marker",
        },
        {
            "id": "alt-skip",
            "order": 50,
            "title": "Alt Skip",
            "content": "Dieser Inhalt darf NICHT in das Ergebnis kommen.",
            "merge_policy": "skip_if_exists",
        },
    ]

    merged = merge(existing, new_sections)
    print("===== MERGED =====")
    print(merged)
    print("===== END =====")
    print()
    print("===== STRIP crm-konventionen =====")
    print(strip_sections(merged, ["crm-konventionen"]))
    print("===== END =====")
