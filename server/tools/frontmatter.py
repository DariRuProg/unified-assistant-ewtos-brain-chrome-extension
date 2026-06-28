# @author Dario | ewtos.com
"""Minimaler YAML-Frontmatter-Parser fuer flache `key: value` / `[a, b]` Blocks.

Bewusst kein voller YAML-Parser — deckt die flache Frontmatter-Form ab, die die
Vault-Templates erzeugen. Genug, um strukturierte Records aus .md-Dateien zu ziehen
(z.B. die CRM-Kundenliste)."""
from __future__ import annotations

import re

_KV_RE = re.compile(r"^([a-zA-Z_][\w\-]*):\s*(.*)$")


def split_frontmatter(text: str) -> tuple[str, str]:
    """Trennt den fuehrenden ---...--- Block vom Body. Returns (frontmatter, body).
    Ohne Frontmatter: ("", text)."""
    if not text.startswith("---"):
        return "", text
    end = text.find("\n---", 3)
    if end == -1:
        return "", text
    fm_end = end + 4
    if fm_end < len(text) and text[fm_end] == "\n":
        fm_end += 1
    return text[:fm_end], text[fm_end:]


def parse_frontmatter(text: str) -> dict[str, str | list[str]]:
    """Parst flachen YAML-Frontmatter zu einem Dict. Listen `[a, b]` werden zu
    Python-Listen, alles andere zu Strings (umschliessende Quotes entfernt)."""
    fm, _ = split_frontmatter(text)
    meta: dict[str, str | list[str]] = {}
    for line in fm.splitlines():
        if line.strip() in ("---", ""):
            continue
        m = _KV_RE.match(line)
        if not m:
            continue
        key, value = m.group(1), m.group(2).strip()
        if value.startswith("[") and value.endswith("]"):
            inner = value[1:-1]
            meta[key] = [item.strip().strip("\"'") for item in inner.split(",") if item.strip()]
        else:
            meta[key] = value.strip("\"'")
    return meta
