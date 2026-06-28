# @author Dario | ewtos.com
"""Wertet Obsidian `.base`-Dateien serverseitig zu strukturierten Tabellen aus.

Liest eine `.base` (YAML), wertet globale + view-Filter und Formel-Spalten gegen
die Notes im Quell-Ordner aus und liefert pro View fertige Spalten/Zeilen/Gruppen
— damit die Extension Bases als echte Tabellen rendern kann (Server = Gehirn).

Bewusst ein fokussierter Interpreter fuer die Obsidian-Bases-Ausdruckssyntax,
nicht der komplette Obsidian-Funktionsumfang. Fehlerhafte/unbekannte Ausdruecke
werten tolerant zu leer/False aus (wie Obsidian), statt die Tabelle zu sprengen.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import yaml

from . import frontmatter as _frontmatter
from . import wiki_reader

IGNORED_NAMES = wiki_reader.IGNORED_NAMES


# --------------------------------------------------------------------------- #
# Tokenizer
# --------------------------------------------------------------------------- #

_TOKEN_RE = re.compile(
    r"""
      \s+
    | (?P<num>\d+(?:\.\d+)?)
    | (?P<str>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')
    | (?P<op>==|!=|<=|>=|&&|\|\||[<>+\-*/!().,])
    | (?P<ident>[A-Za-z_][A-Za-z0-9_]*)
    """,
    re.VERBOSE,
)


def _tokenize(expr: str) -> list[tuple[str, Any]]:
    tokens: list[tuple[str, Any]] = []
    pos = 0
    n = len(expr)
    while pos < n:
        m = _TOKEN_RE.match(expr, pos)
        if not m or m.end() == pos:
            raise ValueError(f"Unerwartetes Zeichen bei {pos}: {expr[pos:pos+12]!r}")
        pos = m.end()
        if m.lastgroup is None:
            continue  # whitespace
        kind = m.lastgroup
        val = m.group()
        if kind == "num":
            tokens.append(("num", float(val)))
        elif kind == "str":
            tokens.append(("str", _unescape(val[1:-1])))
        elif kind == "op":
            tokens.append(("op", val))
        else:
            tokens.append(("ident", val))
    tokens.append(("eof", None))
    return tokens


def _unescape(s: str) -> str:
    return s.replace('\\"', '"').replace("\\'", "'").replace("\\\\", "\\")


# --------------------------------------------------------------------------- #
# Parser -> AST (tuples)
# --------------------------------------------------------------------------- #
# AST-Knoten:
#   ("lit", value)
#   ("name", ident)
#   ("member", obj, name)
#   ("call", callee_ast_or_name, [args])
#   ("unary", op, expr)
#   ("binary", op, left, right)

class _Parser:
    def __init__(self, tokens: list[tuple[str, Any]]):
        self.toks = tokens
        self.i = 0

    def peek(self):
        return self.toks[self.i]

    def next(self):
        t = self.toks[self.i]
        self.i += 1
        return t

    def expect_op(self, op: str):
        t = self.next()
        if t != ("op", op):
            raise ValueError(f"Erwartete {op!r}, bekam {t!r}")

    def parse(self):
        node = self.parse_or()
        if self.peek()[0] != "eof":
            raise ValueError(f"Unerwartetes Token: {self.peek()!r}")
        return node

    def parse_or(self):
        left = self.parse_and()
        while self.peek() == ("op", "||"):
            self.next()
            left = ("binary", "||", left, self.parse_and())
        return left

    def parse_and(self):
        left = self.parse_equality()
        while self.peek() == ("op", "&&"):
            self.next()
            left = ("binary", "&&", left, self.parse_equality())
        return left

    def parse_equality(self):
        left = self.parse_comparison()
        while self.peek()[0] == "op" and self.peek()[1] in ("==", "!="):
            op = self.next()[1]
            left = ("binary", op, left, self.parse_comparison())
        return left

    def parse_comparison(self):
        left = self.parse_add()
        while self.peek()[0] == "op" and self.peek()[1] in ("<", ">", "<=", ">="):
            op = self.next()[1]
            left = ("binary", op, left, self.parse_add())
        return left

    def parse_add(self):
        left = self.parse_mul()
        while self.peek()[0] == "op" and self.peek()[1] in ("+", "-"):
            op = self.next()[1]
            left = ("binary", op, left, self.parse_mul())
        return left

    def parse_mul(self):
        left = self.parse_unary()
        while self.peek()[0] == "op" and self.peek()[1] in ("*", "/"):
            op = self.next()[1]
            left = ("binary", op, left, self.parse_unary())
        return left

    def parse_unary(self):
        if self.peek()[0] == "op" and self.peek()[1] in ("!", "-"):
            op = self.next()[1]
            return ("unary", op, self.parse_unary())
        return self.parse_postfix()

    def parse_postfix(self):
        node = self.parse_primary()
        while True:
            t = self.peek()
            if t == ("op", "."):
                self.next()
                name_tok = self.next()
                if name_tok[0] != "ident":
                    raise ValueError(f"Erwartete Name nach '.', bekam {name_tok!r}")
                name = name_tok[1]
                if self.peek() == ("op", "("):
                    args = self.parse_args()
                    node = ("call", ("member", node, name), args)
                else:
                    node = ("member", node, name)
            elif t == ("op", "(") and node[0] == "name":
                args = self.parse_args()
                node = ("call", node, args)
            else:
                break
        return node

    def parse_args(self):
        self.expect_op("(")
        args = []
        if self.peek() != ("op", ")"):
            args.append(self.parse_or())
            while self.peek() == ("op", ","):
                self.next()
                args.append(self.parse_or())
        self.expect_op(")")
        return args

    def parse_primary(self):
        t = self.next()
        if t[0] == "num":
            return ("lit", t[1])
        if t[0] == "str":
            return ("lit", t[1])
        if t == ("op", "("):
            node = self.parse_or()
            self.expect_op(")")
            return node
        if t[0] == "ident":
            if t[1] == "true":
                return ("lit", True)
            if t[1] == "false":
                return ("lit", False)
            if t[1] in ("null", "none"):
                return ("lit", None)
            return ("name", t[1])
        raise ValueError(f"Unerwartetes Token: {t!r}")


def _parse_expr(expr: str):
    return _Parser(_tokenize(expr)).parse()


# --------------------------------------------------------------------------- #
# Evaluator
# --------------------------------------------------------------------------- #

class _FileObj:
    """Namespace-Marker fuer `file.*` Zugriffe im Ausdruck."""
    def __init__(self, props: dict):
        self.props = props


class _FormulaNS:
    """Namespace-Marker fuer `formula.*` Zugriffe (lazy, mit Zyklus-Schutz)."""
    def __init__(self, ctx: "_Ctx"):
        self.ctx = ctx


class _Ctx:
    def __init__(self, fields: dict, file_props: dict, formulas: dict[str, Any]):
        self.fields = fields
        self.file = _FileObj(file_props)
        self.formulas = formulas  # slug -> AST
        self._formula_stack: set[str] = set()
        self._formula_cache: dict[str, Any] = {}

    def resolve_formula(self, slug: str):
        if slug in self._formula_cache:
            return self._formula_cache[slug]
        if slug in self._formula_stack or slug not in self.formulas:
            return None
        self._formula_stack.add(slug)
        try:
            val = _eval(self.formulas[slug], self)
        except Exception:
            val = None
        finally:
            self._formula_stack.discard(slug)
        self._formula_cache[slug] = val
        return val


def _truthy(v: Any) -> bool:
    if v is None:
        return False
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    if isinstance(v, str):
        return v.strip() != ""
    if isinstance(v, (list, tuple)):
        return len(v) > 0
    if isinstance(v, timedelta):
        return v.total_seconds() != 0
    return True


def _to_number(v: Any):
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, timedelta):
        return v.total_seconds() / 86400.0
    if isinstance(v, str):
        s = v.strip().replace(",", ".")
        m = re.match(r"^-?\d+(?:\.\d+)?", s)
        if m:
            try:
                return float(m.group())
            except ValueError:
                return None
    return None


def _to_date(v: Any):
    if isinstance(v, datetime):
        return v
    if isinstance(v, date):
        return v
    if isinstance(v, str):
        s = v.strip()
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
            try:
                dt = datetime.strptime(s, fmt)
                return dt if "%H" in fmt else dt.date()
            except ValueError:
                continue
    return None


def _as_comparable(a: Any, b: Any):
    """Bringt zwei Werte fuer Vergleich auf einen gemeinsamen Typ."""
    # Duration vs Zahl -> Tage vergleichen
    if isinstance(a, timedelta) and isinstance(b, (int, float)):
        return a.total_seconds() / 86400.0, float(b)
    if isinstance(b, timedelta) and isinstance(a, (int, float)):
        return float(a), b.total_seconds() / 86400.0
    if isinstance(a, timedelta) and isinstance(b, timedelta):
        return a.total_seconds(), b.total_seconds()
    # Datum (eine Seite Datum -> beide als Datum)
    da, db = _to_date(a), _to_date(b)
    if (isinstance(a, (date, datetime)) or isinstance(b, (date, datetime))) and da and db:
        # auf gleichen Typ normalisieren
        if isinstance(da, datetime) != isinstance(db, datetime):
            da = da.date() if isinstance(da, datetime) else da
            db = db.date() if isinstance(db, datetime) else db
        return da, db
    # Zahlen
    na, nb = _to_number(a), _to_number(b)
    if na is not None and nb is not None:
        return na, nb
    # Fallback: Strings
    return _stringify(a), _stringify(b)


def _eval(node, ctx: _Ctx):
    kind = node[0]
    if kind == "lit":
        return node[1]
    if kind == "name":
        return _eval_name(node[1], ctx)
    if kind == "member":
        return _eval_member(node, ctx)
    if kind == "call":
        return _eval_call(node, ctx)
    if kind == "unary":
        return _eval_unary(node, ctx)
    if kind == "binary":
        return _eval_binary(node, ctx)
    return None


def _eval_name(name: str, ctx: _Ctx):
    if name == "file":
        return ctx.file
    if name == "formula":
        return _FormulaNS(ctx)
    if name in ctx.fields:
        return ctx.fields[name]
    return None


def _eval_member(node, ctx: _Ctx):
    _, obj_node, name = node
    obj = _eval(obj_node, ctx)
    if isinstance(obj, _FileObj):
        return obj.props.get(name)
    if isinstance(obj, _FormulaNS):
        return obj.ctx.resolve_formula(name)
    if isinstance(obj, timedelta):
        if name == "days":
            return obj.total_seconds() / 86400.0
        if name == "hours":
            return obj.total_seconds() / 3600.0
        if name == "minutes":
            return obj.total_seconds() / 60.0
        if name == "seconds":
            return obj.total_seconds()
    if isinstance(obj, (date, datetime)):
        if name == "year":
            return float(obj.year)
        if name == "month":
            return float(obj.month)
        if name == "day":
            return float(obj.day)
        if name == "date":
            return obj.date() if isinstance(obj, datetime) else obj
    if isinstance(obj, str):
        if name == "length":
            return float(len(obj))
    if isinstance(obj, (list, tuple)):
        if name == "length":
            return float(len(obj))
    return None


def _eval_call(node, ctx: _Ctx):
    _, callee, arg_nodes = node
    # Methodenaufruf: callee ist ("member", obj, name)
    if callee[0] == "member":
        obj = _eval(callee[1], ctx)
        method = callee[2]
        args = [_eval(a, ctx) for a in arg_nodes]
        return _eval_method(obj, method, args)
    # Funktionsaufruf: callee ist ("name", fn)
    if callee[0] == "name":
        fn = callee[1]
        return _eval_function(fn, arg_nodes, ctx)
    return None


def _eval_function(fn: str, arg_nodes, ctx: _Ctx):
    if fn == "if":
        cond = _eval(arg_nodes[0], ctx) if arg_nodes else None
        if _truthy(cond):
            return _eval(arg_nodes[1], ctx) if len(arg_nodes) > 1 else None
        return _eval(arg_nodes[2], ctx) if len(arg_nodes) > 2 else None
    args = [_eval(a, ctx) for a in arg_nodes]
    if fn == "today":
        return date.today()
    if fn == "now":
        return datetime.now()
    if fn == "date":
        return _to_date(args[0]) if args else None
    if fn == "number":
        return _to_number(args[0]) if args else None
    if fn == "string":
        return _stringify(args[0]) if args else ""
    if fn == "duration":
        return _parse_duration(args[0]) if args else None
    if fn == "min":
        nums = [_to_number(a) for a in args if _to_number(a) is not None]
        return min(nums) if nums else None
    if fn == "max":
        nums = [_to_number(a) for a in args if _to_number(a) is not None]
        return max(nums) if nums else None
    if fn == "link":
        return args[0] if args else None
    return None


def _eval_method(obj: Any, method: str, args: list):
    if isinstance(obj, _FileObj):
        folder = obj.props.get("folder", "")
        path = obj.props.get("path", "")
        if method in ("inFolder", "inDirectFolder"):
            target = str(args[0]) if args else ""
            if method == "inDirectFolder":
                return folder == target
            return folder == target or folder.startswith(target + "/")
        if method == "hasTag":
            tags = obj.props.get("tags") or []
            return str(args[0]) in [str(x) for x in tags] if args else False
        if method == "hasLink":
            links = obj.props.get("links") or []
            return str(args[0]) in [str(x) for x in links] if args else False
        if method == "hasProperty":
            return bool(args) and str(args[0]) in (obj.props.get("_fields") or {})
        return None
    if method == "in":
        return obj in args
    if method == "contains":
        needle = args[0] if args else None
        if isinstance(obj, (list, tuple)):
            return needle in obj
        if obj is None:
            return False
        return str(needle) in str(obj)
    if isinstance(obj, str):
        if method == "startsWith":
            return obj.startswith(str(args[0])) if args else False
        if method == "endsWith":
            return obj.endswith(str(args[0])) if args else False
        if method in ("lower", "toLowerCase"):
            return obj.lower()
        if method in ("upper", "toUpperCase"):
            return obj.upper()
        if method == "trim":
            return obj.strip()
        if method == "replace":
            return obj.replace(str(args[0]), str(args[1])) if len(args) > 1 else obj
        if method == "toString":
            return obj
    if isinstance(obj, (list, tuple)):
        if method == "join":
            sep = str(args[0]) if args else ", "
            return sep.join(_stringify(x) for x in obj)
    if isinstance(obj, (int, float)) and not isinstance(obj, bool):
        if method == "toFixed":
            n = int(_to_number(args[0]) or 0) if args else 0
            return f"{float(obj):.{n}f}"
        if method == "round":
            n = int(_to_number(args[0]) or 0) if args else 0
            return round(float(obj), n) if n else float(round(float(obj)))
        if method == "toString":
            return _stringify(obj)
    if isinstance(obj, (date, datetime)):
        if method == "format":
            return _format_date(obj, str(args[0]) if args else "YYYY-MM-DD")
    return None


def _eval_unary(node, ctx: _Ctx):
    _, op, expr = node
    v = _eval(expr, ctx)
    if op == "!":
        return not _truthy(v)
    if op == "-":
        n = _to_number(v)
        return -n if n is not None else None
    return None


def _eval_binary(node, ctx: _Ctx):
    _, op, left_node, right_node = node
    if op == "&&":
        return _truthy(_eval(left_node, ctx)) and _truthy(_eval(right_node, ctx))
    if op == "||":
        return _truthy(_eval(left_node, ctx)) or _truthy(_eval(right_node, ctx))
    left = _eval(left_node, ctx)
    right = _eval(right_node, ctx)
    if op in ("==", "!="):
        eq = _values_equal(left, right)
        return eq if op == "==" else not eq
    if op in ("<", ">", "<=", ">="):
        a, b = _as_comparable(left, right)
        try:
            if op == "<":
                return a < b
            if op == ">":
                return a > b
            if op == "<=":
                return a <= b
            return a >= b
        except TypeError:
            return False
    if op == "+":
        if isinstance(left, str) or isinstance(right, str):
            return _stringify(left) + _stringify(right)
        if isinstance(left, (date, datetime)) and isinstance(right, timedelta):
            return left + right
        a, b = _to_number(left), _to_number(right)
        return (a + b) if a is not None and b is not None else None
    if op == "-":
        if isinstance(left, (date, datetime)) and isinstance(right, (date, datetime)):
            return _date_diff(left, right)
        if isinstance(left, (date, datetime)) and isinstance(right, timedelta):
            return left - right
        a, b = _to_number(left), _to_number(right)
        return (a - b) if a is not None and b is not None else None
    if op in ("*", "/"):
        a, b = _to_number(left), _to_number(right)
        if a is None or b is None:
            return None
        if op == "*":
            return a * b
        return a / b if b != 0 else None
    return None


def _date_diff(a, b) -> timedelta:
    if isinstance(a, datetime) != isinstance(b, datetime):
        a = a.date() if isinstance(a, datetime) else a
        b = b.date() if isinstance(b, datetime) else b
    if isinstance(a, date) and not isinstance(a, datetime):
        a = datetime(a.year, a.month, a.day)
    if isinstance(b, date) and not isinstance(b, datetime):
        b = datetime(b.year, b.month, b.day)
    return a - b


def _values_equal(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, bool) or isinstance(b, bool):
        return bool(a) == bool(b)
    na, nb = _to_number(a), _to_number(b)
    if na is not None and nb is not None and not (isinstance(a, str) and isinstance(b, str)):
        return na == nb
    da, db = _to_date(a), _to_date(b)
    if isinstance(a, (date, datetime)) and isinstance(b, (date, datetime)) and da and db:
        return da == db
    return _stringify(a) == _stringify(b)


_DUR_RE = re.compile(r"(-?\d+(?:\.\d+)?)\s*(y|year|years|M|month|months|w|week|weeks|d|day|days|h|hour|hours|m|minute|minutes|s|second|seconds)")


def _parse_duration(s: Any):
    if not isinstance(s, str):
        return None
    total = timedelta()
    for amount, unit in _DUR_RE.findall(s):
        a = float(amount)
        if unit.startswith("y"):
            total += timedelta(days=365 * a)
        elif unit == "M" or unit.startswith("month"):
            total += timedelta(days=30 * a)
        elif unit.startswith("w"):
            total += timedelta(weeks=a)
        elif unit.startswith("d"):
            total += timedelta(days=a)
        elif unit.startswith("h"):
            total += timedelta(hours=a)
        elif unit == "m" or unit.startswith("minute"):
            total += timedelta(minutes=a)
        else:
            total += timedelta(seconds=a)
    return total


def _format_date(d, fmt: str) -> str:
    mapping = [
        ("YYYY", "%Y"), ("MM", "%m"), ("DD", "%d"),
        ("HH", "%H"), ("mm", "%M"), ("ss", "%S"),
        ("dddd", "%A"), ("ddd", "%a"),
    ]
    out = fmt
    for token, code in mapping:
        out = out.replace(token, d.strftime(code))
    return out


def _stringify(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else str(v)
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d %H:%M") if (v.hour or v.minute) else v.strftime("%Y-%m-%d")
    if isinstance(v, date):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, timedelta):
        days = v.total_seconds() / 86400.0
        return str(int(days)) if days.is_integer() else f"{days:.1f}"
    if isinstance(v, (list, tuple)):
        return ", ".join(_stringify(x) for x in v)
    return str(v)


# --------------------------------------------------------------------------- #
# .base laden + auswerten
# --------------------------------------------------------------------------- #

def _parse_note_frontmatter(text: str) -> dict:
    """Frontmatter typisiert parsen (yaml). Fallback: minimaler Parser."""
    fm, _body = _frontmatter.split_frontmatter(text)
    if not fm:
        return {}
    inner = fm.strip()
    if inner.startswith("---"):
        inner = inner[3:]
    if inner.rstrip().endswith("---"):
        inner = inner.rstrip()[:-3]
    try:
        data = yaml.safe_load(inner)
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return _frontmatter.parse_frontmatter(text)


def _file_props(md_file: Path, root: Path, fields: dict) -> dict:
    try:
        rel = str(md_file.relative_to(root)).replace("\\", "/")
    except ValueError:
        rel = md_file.name
    folder = rel.rsplit("/", 1)[0] if "/" in rel else ""
    try:
        st = md_file.stat()
        ctime = datetime.fromtimestamp(st.st_ctime)
        mtime = datetime.fromtimestamp(st.st_mtime)
        size = float(st.st_size)
    except OSError:
        ctime = mtime = None
        size = 0.0
    tags = fields.get("tags") or []
    if isinstance(tags, str):
        tags = [tags]
    return {
        "name": md_file.stem,
        "basename": md_file.stem,
        "path": rel,
        "folder": folder,
        "ext": md_file.suffix.lstrip("."),
        "size": size,
        "ctime": ctime,
        "mtime": mtime,
        "tags": tags,
        "links": [],
        "_fields": fields,
    }


def _scope_folder(filters: Any) -> tuple[str | None, bool]:
    """Sucht im globalen Filter eine Ordner-Einschraenkung, um den Scan zu begrenzen.
    Returns (folder, recursive). (None, True) wenn keine gefunden."""
    found: list[tuple[str, bool]] = []

    def walk(f: Any):
        if isinstance(f, str):
            m = re.search(r'file\.inFolder\(\s*"([^"]+)"\s*\)', f)
            if m:
                found.append((m.group(1), True))
            m = re.search(r'file\.(?:folder|inDirectFolder)\s*(?:==\s*"|\(\s*")([^"]+)"', f)
            if m:
                found.append((m.group(1), False))
        elif isinstance(f, dict):
            for v in f.values():
                walk(v)
        elif isinstance(f, list):
            for item in f:
                walk(item)

    walk(filters)
    if found:
        return found[0]
    return None, True


def _eval_filter(filt: Any, ctx: _Ctx) -> bool:
    """Filter ist String-Ausdruck oder {and|or|not: [...]} Objekt."""
    if filt is None:
        return True
    if isinstance(filt, str):
        try:
            return _truthy(_eval(_parse_expr(filt), ctx))
        except Exception:
            return False
    if isinstance(filt, dict):
        for key, items in filt.items():
            if not isinstance(items, list):
                items = [items]
            results = [_eval_filter(it, ctx) for it in items]
            if key == "and":
                return all(results)
            if key == "or":
                return any(results)
            if key == "not":
                return not any(results)
        return True
    return True


def _compile_formulas(raw: dict) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for slug, expr in (raw or {}).items():
        try:
            out[slug] = _parse_expr(str(expr))
        except Exception:
            out[slug] = ("lit", None)
    return out


def _column_def(col_id: str, properties: dict) -> dict:
    is_formula = col_id.startswith("formula.")
    label = None
    prop = properties.get(col_id)
    if isinstance(prop, dict):
        label = prop.get("displayName")
    if not label:
        if is_formula:
            label = col_id.split(".", 1)[1]
        elif col_id.startswith("file."):
            label = col_id.split(".", 1)[1]
        else:
            label = col_id
    return {"id": col_id, "label": label, "formula": is_formula}


def _cell_value(col_id: str, ctx: _Ctx):
    """Typisierter Wert einer Zelle (fuer Sort), plus String-Form."""
    if col_id.startswith("formula."):
        return ctx.resolve_formula(col_id.split(".", 1)[1])
    if col_id.startswith("file."):
        return ctx.file.props.get(col_id.split(".", 1)[1])
    return ctx.fields.get(col_id)


def _sort_kind(values: list) -> str:
    nums = dates = 0
    seen = 0
    for v in values:
        if v is None or v == "":
            continue
        seen += 1
        if _to_date(v) is not None and not isinstance(v, (int, float)):
            dates += 1
        elif _to_number(v) is not None:
            nums += 1
    if seen == 0:
        return "str"
    if dates >= nums and dates > 0:
        return "date"
    if nums > 0:
        return "num"
    return "str"


def _sort_key_factory(kind: str):
    def key(v):
        empty = v is None or v == ""
        if kind == "num":
            n = _to_number(v)
            return (empty, n if n is not None else 0.0)
        if kind == "date":
            d = _to_date(v)
            ordv = d.toordinal() if isinstance(d, (date, datetime)) else 0
            return (empty, ordv)
        return (empty, _stringify(v).lower())
    return key


def evaluate_base(vault_path: str, rel_path: str) -> dict:
    """Liest die .base und liefert ausgewertete Views (Spalten/Zeilen/Gruppen)."""
    text = wiki_reader.read_file(vault_path, rel_path)
    try:
        spec = yaml.safe_load(text) or {}
    except yaml.YAMLError as e:
        raise ValueError(f"Ungueltiges YAML in {rel_path}: {e}")
    if not isinstance(spec, dict):
        raise ValueError("Base-Datei hat kein Objekt auf oberster Ebene")

    global_filters = spec.get("filters")
    properties = spec.get("properties") or {}
    formulas = _compile_formulas(spec.get("formulas") or {})
    raw_views = spec.get("views") or []

    root = wiki_reader.resolve_dir(vault_path).resolve()
    folder, recursive = _scope_folder(global_filters)
    scan_root = root
    if folder:
        cand = (root / folder).resolve()
        if cand.exists() and cand.is_dir():
            scan_root = cand
    globber = scan_root.rglob("*.md") if (recursive or scan_root == root) else scan_root.glob("*.md")

    contexts: list[_Ctx] = []
    for md_file in sorted(globber):
        if any(part in IGNORED_NAMES for part in md_file.parts):
            continue
        try:
            content = md_file.read_text(encoding="utf-8")
        except Exception:
            continue
        fields = _parse_note_frontmatter(content)
        if not isinstance(fields, dict):
            fields = {}
        fp = _file_props(md_file, root, fields)
        ctx = _Ctx(fields, fp, formulas)
        if _eval_filter(global_filters, ctx):
            contexts.append(ctx)

    views_out = []
    for view in raw_views:
        if not isinstance(view, dict):
            continue
        vtype = view.get("type", "table")
        order = view.get("order") or []
        if not order:
            # Default: file.name + alle properties
            order = ["file.name"] + [k for k in properties.keys() if not k.startswith("formula.")]
        columns = [_column_def(cid, properties) for cid in order]

        rows_ctx = [c for c in contexts if _eval_filter(view.get("filters"), c)]

        # Sortierung
        for s in reversed(view.get("sort") or []):
            field = s.get("property") or s.get("column") or s.get("field")
            if not field:
                continue
            direction = str(s.get("direction", "ASC")).upper()
            vals = [_cell_value(field, c) for c in rows_ctx]
            kind = _sort_kind(vals)
            keyfn = _sort_key_factory(kind)
            rows_ctx.sort(key=lambda c, f=field, k=keyfn: k(_cell_value(f, c)),
                          reverse=(direction == "DESC"))

        limit = view.get("limit")
        if isinstance(limit, int) and limit > 0:
            rows_ctx = rows_ctx[:limit]

        rows = []
        for c in rows_ctx:
            cells = {col["id"]: _stringify(_cell_value(col["id"], c)) for col in columns}
            rows.append({
                "path": c.file.props.get("path"),
                "name": c.file.props.get("name"),
                "cells": cells,
            })

        group_by = view.get("groupBy")
        group_prop = None
        if isinstance(group_by, dict):
            group_prop = group_by.get("property")
        elif isinstance(group_by, str):
            group_prop = group_by
        groups = None
        if group_prop:
            order_keys: list[str] = []
            buckets: dict[str, list[int]] = {}
            for idx, c in enumerate(rows_ctx):
                key = _stringify(_cell_value(group_prop, c)) or "—"
                if key not in buckets:
                    buckets[key] = []
                    order_keys.append(key)
                buckets[key].append(idx)
            groups = [{"key": k, "rows": buckets[k]} for k in sorted(order_keys, key=str.lower)]

        views_out.append({
            "type": vtype,
            "name": view.get("name", "View"),
            "columns": columns,
            "rows": rows,
            "groupBy": group_prop,
            "groups": groups,
        })

    return {
        "rel_path": rel_path,
        "title": spec.get("title") or Path(rel_path).stem,
        "count": len(contexts),
        "views": views_out,
    }
