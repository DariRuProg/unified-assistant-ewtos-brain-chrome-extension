"""Image-Generator via Google Gemini "Nano Banana" Models.

Single endpoint deckt alle Use Cases ab:
- Text -> Bild         (kein input_image)
- Komposition          (mehrere input_images)
- Editing              (1 input_image + Anweisung)
- Character-Consistency (Output-Bild des Vorgaengers als Input des naechsten Calls)

Speichert jedes Output unter server/generated_images/<YYYY-MM-DD>/<unix>-<slug>.png
"""
from __future__ import annotations

import base64
import binascii
import json
import os
import re
import subprocess
import sys
import threading
import time
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import httpx

import paths
import settings

GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

ALLOWED_MODELS = {
    "gemini-2.5-flash-image",
    "gemini-3.1-flash-image-preview",
    "gemini-3-pro-image-preview",
}
DEFAULT_MODEL = "gemini-2.5-flash-image"

OUTPUT_ROOT = paths.generated_images_dir()
INDEX_FILE = OUTPUT_ROOT / "index.json"
TRASH_DIR = OUTPUT_ROOT / "_papierkorb"
SLUG_RE = re.compile(r"[^a-z0-9]+")
HTTP_TIMEOUT = 180.0
_INDEX_LOCK = threading.RLock()


def _slugify(text: str, max_len: int = 40) -> str:
    s = SLUG_RE.sub("-", text.strip().lower()).strip("-")
    return (s[:max_len] or "bild").rstrip("-") or "bild"


def _resolve_model(model: str | None) -> str:
    if not model:
        return settings.get("image_gen_model") or DEFAULT_MODEL
    if model not in ALLOWED_MODELS:
        raise ValueError(
            f"Modell '{model}' nicht erlaubt. Erlaubt: {', '.join(sorted(ALLOWED_MODELS))}"
        )
    return model


def _decode_input(b64: str) -> tuple[bytes, str]:
    """Akzeptiert reinen base64-String ODER data-URL (data:image/...;base64,...).
    Liefert (bytes, mime_type)."""
    raw = b64.strip()
    mime = "image/png"
    if raw.startswith("data:"):
        try:
            header, payload = raw.split(",", 1)
            mime_part = header[5:].split(";", 1)[0]
            if mime_part:
                mime = mime_part
            raw = payload
        except ValueError:
            raise ValueError("Ungueltige data-URL fuer Input-Bild")
    try:
        data = base64.b64decode(raw, validate=False)
    except (binascii.Error, ValueError) as e:
        raise ValueError(f"Input-Bild konnte nicht base64-dekodiert werden: {e}")
    if not data:
        raise ValueError("Input-Bild ist leer")
    return data, mime


def _save_output(b64: str, prompt: str) -> Path:
    today = date.today().isoformat()
    day_dir = OUTPUT_ROOT / today
    day_dir.mkdir(parents=True, exist_ok=True)
    slug = _slugify(prompt)
    fname = f"{int(time.time())}-{slug}.png"
    target = day_dir / fname
    tmp = target.with_suffix(".png.tmp")
    tmp.write_bytes(base64.b64decode(b64))
    tmp.replace(target)
    return target


# --- Index ---------------------------------------------------------------

def _load_index_raw() -> list[dict[str, Any]]:
    if not INDEX_FILE.exists():
        return []
    try:
        data = json.loads(INDEX_FILE.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return data
    except (json.JSONDecodeError, OSError):
        pass
    return []


def _write_index_raw(entries: list[dict[str, Any]]) -> None:
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    tmp = INDEX_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(entries, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(INDEX_FILE)


def _append_index_entry(entry: dict[str, Any]) -> None:
    with _INDEX_LOCK:
        entries = _load_index_raw()
        entries.append(entry)
        _write_index_raw(entries)


def _sync_index_with_disk() -> list[dict[str, Any]]:
    """Sync: ergaenzt Index-Eintraege fuer existierende Dateien ohne Eintrag,
    entfernt Eintraege fuer fehlende Dateien. Gibt aktualisierte Liste zurueck.
    """
    entries = _load_index_raw()
    known_files = {e.get("file") for e in entries}

    on_disk: list[Path] = []
    trash_resolved = TRASH_DIR.resolve() if TRASH_DIR.exists() else None
    if OUTPUT_ROOT.exists():
        for p in OUTPUT_ROOT.rglob("*.png"):
            if not p.is_file() or p.name.endswith(".png.tmp"):
                continue
            # Papierkorb taucht nicht in der Galerie auf
            if trash_resolved is not None:
                try:
                    p.resolve().relative_to(trash_resolved)
                    continue
                except ValueError:
                    pass
            on_disk.append(p)

    disk_rels: set[str] = set()
    additions: list[dict[str, Any]] = []
    for p in on_disk:
        rel = p.relative_to(OUTPUT_ROOT).as_posix()
        disk_rels.add(rel)
        if rel in known_files:
            continue
        try:
            mtime = datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc)
        except OSError:
            mtime = datetime.now(timezone.utc)
        additions.append({
            "file": rel,
            "prompt": "",
            "model": "",
            "created": mtime.isoformat(timespec="seconds"),
            "input_count": 0,
            "mime": "image/png",
        })

    pruned = [e for e in entries if e.get("file") in disk_rels]
    if additions or len(pruned) != len(entries):
        # Sortiere nach 'created' damit die Reihenfolge sinnvoll bleibt
        merged = pruned + additions
        merged.sort(key=lambda e: e.get("created") or "")
        _write_index_raw(merged)
        return merged
    return entries


def list_index() -> list[dict[str, Any]]:
    """Liste aller bekannten Bilder, neuestes zuerst. Sync mit Disk."""
    with _INDEX_LOCK:
        entries = _sync_index_with_disk()
    return list(reversed(entries))


def _safe_rel_path(rel_path: str) -> Path:
    rel = (rel_path or "").strip().replace("\\", "/").lstrip("/")
    if not rel or ".." in rel.split("/"):
        raise ValueError("Ungueltiger Pfad")
    target = (OUTPUT_ROOT / rel).resolve()
    try:
        target.relative_to(OUTPUT_ROOT.resolve())
    except ValueError:
        raise ValueError("Pfad liegt ausserhalb von generated_images/")
    return target


def _unique_trash_target(orig_name: str) -> Path:
    """Findet einen freien Pfad im Papierkorb, haengt -2/-3 etc. an wenn noetig."""
    base = TRASH_DIR / orig_name
    if not base.exists():
        return base
    stem = base.stem
    suffix = base.suffix
    n = 2
    while True:
        candidate = TRASH_DIR / f"{stem}-{n}{suffix}"
        if not candidate.exists():
            return candidate
        n += 1


def delete_entry(rel_path: str) -> dict[str, Any]:
    """Verschiebt Datei in den Papierkorb + entfernt Index-Eintrag.
    Idempotent — fehlende Datei fuehrt nur zum Index-Cleanup."""
    target = _safe_rel_path(rel_path)
    norm = target.relative_to(OUTPUT_ROOT.resolve()).as_posix()
    moved_to: str | None = None
    if target.is_file():
        TRASH_DIR.mkdir(parents=True, exist_ok=True)
        # Originalname behalten, falls Konflikt: -2, -3, ...
        trash_path = _unique_trash_target(target.name)
        target.replace(trash_path)
        moved_to = trash_path.relative_to(OUTPUT_ROOT.resolve()).as_posix()
    with _INDEX_LOCK:
        entries = _load_index_raw()
        new_entries = [e for e in entries if e.get("file") != norm]
        if len(new_entries) != len(entries):
            _write_index_raw(new_entries)
    return {"deleted": moved_to is not None, "file": norm, "trash_path": moved_to}


def open_output_folder() -> dict[str, Any]:
    """Oeffnet den Bilder-Ordner im OS-Datei-Manager."""
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    path = str(OUTPUT_ROOT)
    if sys.platform == "win32":
        os.startfile(path)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])
    return {"opened": True, "path": path}


def _extract_image(payload: dict) -> tuple[str, str] | None:
    candidates = payload.get("candidates") or []
    for cand in candidates:
        parts = (cand.get("content") or {}).get("parts") or []
        for part in parts:
            inline = part.get("inline_data") or part.get("inlineData")
            if inline and inline.get("data"):
                return inline["data"], inline.get("mime_type") or inline.get("mimeType") or "image/png"
    return None


def _extract_text(payload: dict) -> str:
    out = []
    for cand in payload.get("candidates") or []:
        for part in (cand.get("content") or {}).get("parts") or []:
            if isinstance(part.get("text"), str):
                out.append(part["text"])
    return "\n".join(t for t in out if t).strip()


def _format_api_error(resp: httpx.Response) -> str:
    try:
        data = resp.json()
        err = data.get("error") or {}
        msg = err.get("message") or resp.text
        status = err.get("status") or resp.status_code
        return f"Gemini {status}: {msg}"
    except Exception:
        return f"Gemini HTTP {resp.status_code}: {resp.text[:300]}"


def generate_image(
    prompt: str,
    input_images: list[str] | None = None,
    input_files: list[str] | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    """Erzeugt oder bearbeitet ein Bild via Gemini.

    `input_images`: Liste von base64-Strings (oder data-URLs) — fuer frisch
    hochgeladene Bilder aus der UI.
    `input_files`: Liste relativer Pfade unter `generated_images/` — fuer schon
    gespeicherte Bilder (z.B. fuer iteratives Editing).
    """
    if not prompt or not prompt.strip():
        return {"ok": False, "error": "Prompt darf nicht leer sein"}

    api_key = settings.get("gemini_api_key")
    if not api_key:
        return {
            "ok": False,
            "error": "Gemini API-Key fehlt. In Options unter 'External Services' setzen oder GEMINI_API_KEY in server/.env.",
        }

    try:
        resolved_model = _resolve_model(model)
    except ValueError as e:
        return {"ok": False, "error": str(e)}

    parts: list[dict[str, Any]] = [{"text": prompt.strip()}]
    input_count = 0
    for b64 in input_images or []:
        try:
            data, mime = _decode_input(b64)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        parts.append({
            "inline_data": {
                "mime_type": mime,
                "data": base64.b64encode(data).decode("ascii"),
            }
        })
        input_count += 1

    for rel in input_files or []:
        try:
            target = _safe_rel_path(rel)
            if not target.is_file():
                return {"ok": False, "error": f"Input-Datei nicht gefunden: {rel}"}
            data = target.read_bytes()
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        parts.append({
            "inline_data": {
                "mime_type": "image/png",
                "data": base64.b64encode(data).decode("ascii"),
            }
        })
        input_count += 1

    body = {
        "contents": [{"parts": parts}],
        "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]},
    }

    url = GEMINI_ENDPOINT.format(model=resolved_model)
    try:
        with httpx.Client(timeout=HTTP_TIMEOUT) as client:
            resp = client.post(
                url,
                headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
                json=body,
            )
    except httpx.HTTPError as e:
        return {"ok": False, "error": f"Verbindung zu Gemini fehlgeschlagen: {e}"}

    if resp.status_code != 200:
        return {"ok": False, "error": _format_api_error(resp)}

    try:
        payload = resp.json()
    except ValueError:
        return {"ok": False, "error": "Gemini lieferte kein JSON zurueck"}

    image = _extract_image(payload)
    if not image:
        text = _extract_text(payload) or "Kein Bild in der Antwort (evtl. Safety-Block)"
        return {"ok": False, "error": text}

    image_b64, mime = image
    saved_path = _save_output(image_b64, prompt)
    rel_path = saved_path.relative_to(OUTPUT_ROOT).as_posix()

    entry = {
        "file": rel_path,
        "prompt": prompt.strip(),
        "model": resolved_model,
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "input_count": input_count,
        "mime": mime,
    }
    _append_index_entry(entry)

    return {
        "ok": True,
        "image_base64": image_b64,
        "mime_type": mime,
        "image_path": rel_path,
        "model": resolved_model,
        "prompt": prompt.strip(),
        "input_count": input_count,
        "text": _extract_text(payload),
        "entry": entry,
    }


def read_generated_file(rel_path: str) -> tuple[bytes, str]:
    """Lese ein zuvor generiertes Bild fuer den Re-Serve-Endpoint.

    Pfad-Whitelisting: nur Dateien unterhalb von OUTPUT_ROOT, kein Traversal.
    """
    rel = (rel_path or "").strip().replace("\\", "/").lstrip("/")
    if not rel or ".." in rel.split("/"):
        raise ValueError("Ungueltiger Pfad")
    target = (OUTPUT_ROOT / rel).resolve()
    try:
        target.relative_to(OUTPUT_ROOT.resolve())
    except ValueError:
        raise ValueError("Pfad liegt ausserhalb von generated_images/")
    if not target.is_file():
        raise FileNotFoundError(f"Bild nicht gefunden: {rel}")
    return target.read_bytes(), "image/png"
