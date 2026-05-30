# @author Dario | ewtos.com
"""Render Vault-Blueprint base-entries to Obsidian .base YAML files."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Iterable

SLUG_RE = re.compile(r"[^a-z0-9]+")

_OP_MAP = {
    "eq": "==",
    "ne": "!=",
    "lt": "<",
    "gt": ">",
    "lte": "<=",
    "gte": ">=",
}


def _quote(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    s = str(value).replace('\\', '\\\\').replace('"', '\\"')
    return f'"{s}"'


def _slug(text: str, max_len: int = 30) -> str:
    s = SLUG_RE.sub("_", str(text).strip().lower()).strip("_")
    return (s[:max_len] or "formula").rstrip("_")


def _render_filter(f: dict) -> str:
    field = f["field"]
    op = f["op"]
    value = f.get("value")

    if op in _OP_MAP:
        return f"{field} {_OP_MAP[op]} {_quote(value)}"
    if op == "in":
        if not isinstance(value, (list, tuple)):
            raise ValueError(f"filter op 'in' braucht Liste, bekam: {value!r}")
        parts = ", ".join(_quote(v) for v in value)
        return f"{field}.in({parts})"
    if op == "contains":
        return f"{field}.contains({_quote(value)})"
    raise ValueError(f"Unbekannter filter op: {op!r}")


def _render_source_filter(source: dict) -> str:
    folder = source["folder"]
    recursive = source.get("recursive", True)
    fn = "file.inFolder" if recursive else "file.inDirectFolder"
    return f'{fn}("{folder}")'


def _build_filters_block(source: dict, filters: list[dict] | None) -> list[str]:
    block: list[str] = [_render_source_filter(source)]
    for f in filters or []:
        block.append(_render_filter(f))
    return block


def _indent(lines: Iterable[str], spaces: int) -> list[str]:
    pad = " " * spaces
    return [f"{pad}{line}" for line in lines]


def _render_and_block(items: list[str], indent: int) -> list[str]:
    pad = " " * indent
    out = [f"{pad}and:"]
    for item in items:
        out.append(f"{pad}  - {item}")
    return out


def _collect_formulas(columns: list[dict]) -> dict[str, tuple[str, str]]:
    """Returns {slug: (formula_expr, label)} preserving column order."""
    out: dict[str, tuple[str, str]] = {}
    for col in columns or []:
        if "formula" in col:
            label = col.get("label") or "formula"
            slug = _slug(label)
            base_slug = slug
            i = 2
            while slug in out:
                slug = f"{base_slug}_{i}"
                i += 1
            out[slug] = (col["formula"], label)
    return out


def _order_keys(columns: list[dict], formula_slugs: dict[str, tuple[str, str]]) -> list[str]:
    out: list[str] = []
    formula_iter = iter(formula_slugs.keys())
    for col in columns or []:
        if "formula" in col:
            out.append(f"formula.{next(formula_iter)}")
        else:
            field = col.get("field")
            if field:
                out.append(field)
    return out


def _properties_block(columns: list[dict]) -> dict[str, str]:
    """Returns {field: displayName} for columns that carry a label."""
    out: dict[str, str] = {}
    for col in columns or []:
        if "formula" in col:
            continue
        label = col.get("label")
        if not label:
            continue
        field = col.get("field")
        if not field or field in out:
            continue
        out[field] = label
    return out


def _yaml_string(value: str) -> str:
    """Quote a string for YAML scalar output."""
    s = value.replace('\\', '\\\\').replace('"', '\\"')
    return f'"{s}"'


def _render_view(view: dict, default_order: list[str]) -> list[str]:
    vtype = view.get("type", "table")
    name = view.get("name", "View")
    lines = [f"  - type: {vtype}"]
    lines.append(f"    name: {_yaml_string(name)}")

    if vtype == "cards":
        lines.append("    cardSize: 200")

    group_by = view.get("group_by")
    if group_by:
        lines.append(f"    groupBy: {group_by}")

    if default_order:
        lines.append("    order:")
        for key in default_order:
            lines.append(f"      - {key}")

    sort_list = view.get("sort") or []
    if sort_list:
        lines.append("    sort:")
        for s in sort_list:
            direction = str(s.get("dir", "asc")).upper()
            lines.append(f"      - column: {s['field']}")
            lines.append(f"        direction: {direction}")

    vfilter = view.get("filter")
    if vfilter:
        rendered = _render_filter(vfilter)
        lines.append("    filters:")
        lines.extend(_indent(_render_and_block([rendered], 0), 6))

    return lines


def render(base_def: dict) -> str:
    """Rendert einen Blueprint-bases[]-Eintrag in Obsidian-.base-YAML."""
    source = base_def["source"]
    filters = base_def.get("filters") or []
    columns = base_def.get("columns") or []
    views = base_def.get("views") or []

    out: list[str] = []

    filter_items = _build_filters_block(source, filters)
    out.append("filters:")
    out.extend(_render_and_block(filter_items, 2))

    formulas = _collect_formulas(columns)
    if formulas:
        out.append("formulas:")
        for slug, (expr, _label) in formulas.items():
            out.append(f"  {slug}: {_yaml_string(expr)}")

    props = _properties_block(columns)
    if props:
        out.append("properties:")
        for field, label in props.items():
            out.append(f"  {field}:")
            out.append(f"    displayName: {label}")

    if views:
        out.append("views:")
        order = _order_keys(columns, formulas)
        for view in views:
            out.extend(_render_view(view, order))

    return "\n".join(out) + "\n"


def would_create(base_def: dict, vault_path: Path) -> bool:
    target = Path(vault_path) / base_def["path"]
    return not target.exists()


def render_to_file(base_def: dict, vault_path: Path) -> Path:
    """Schreibt die .base-Datei nach <vault_path>/<base_def['path']>.

    Idempotent: ueberschreibt nicht wenn Datei existiert. Returns geschriebenen
    Pfad. Skipped: gibt trotzdem Pfad zurueck, callsite entscheidet.
    """
    target = Path(vault_path) / base_def["path"]
    if target.exists():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(render(base_def), encoding="utf-8")
    return target


if __name__ == "__main__":
    sample = {
        "path": "wiki/areas/kunden/kunden.base",
        "title": "Kundenstamm",
        "source": {"folder": "wiki/areas/kunden", "recursive": False},
        "filters": [
            {"field": "typ", "op": "eq", "value": "kunde"},
            {"field": "status", "op": "in", "value": ["aktiv", "wartend"]},
        ],
        "columns": [
            {"field": "file.name", "label": "Kunde"},
            {"field": "branche", "label": "Branche"},
            {"field": "vertrag_bis", "label": "Vertrag bis"},
            {
                "formula": "if(date(vertrag_bis) - today() < 60, '⚠️', '✓')",
                "label": "Status",
            },
        ],
        "views": [
            {
                "type": "table",
                "name": "Aktive Kunden",
                "filter": {"field": "status", "op": "eq", "value": "aktiv"},
                "sort": [{"field": "vertrag_bis", "dir": "asc"}],
            },
            {
                "type": "cards",
                "name": "Uebersicht",
                "group_by": "branche",
            },
        ],
    }
    print(render(sample))
