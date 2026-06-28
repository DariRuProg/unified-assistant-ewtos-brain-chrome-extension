# @author Dario | ewtos.com
"""Schutz für sensible Vault-Dateien (DSGVO / Firmengeheimnisse).

Eine Datei mit Frontmatter `sensibel: true` (oder `sensitive: true`) darf nur an die
in den Settings als sicher freigegebene LLM gehen (`sensitive_llm_provider` +
optional `sensitive_llm_model`). Ist eine andere — oder gar keine — LLM aktiv,
liefert `guard_*` eine Blockier-Nachricht zurück, die der Chat dem Nutzer zeigt.

Der Gate sitzt bewusst an der Chat-Grenze (nicht in wiki_reader.read_file), damit
der Explorer sensible Dateien weiterhin lokal anzeigen kann."""
from __future__ import annotations

import llm_client
import settings
from tools import frontmatter, wiki_reader

_TRUE_VALUES = {"true", "yes", "1", "ja"}
_SENSITIVE_KEYS = ("sensibel", "sensitive")


def _norm(rel_path: str) -> str:
    return str(rel_path or "").strip("/").replace("\\", "/")


def folder_sensitive(vault_id: str | None, rel_path: str | None) -> bool:
    """True, wenn rel_path in (oder unter) einem als sensibel markierten Ordner liegt."""
    if not vault_id or not rel_path:
        return False
    rel = _norm(rel_path)
    for folder in settings.vault_sensitive_folders(vault_id):
        f = _norm(folder)
        if f and (rel == f or rel.startswith(f + "/")):
            return True
    return False


def is_sensitive_text(text: str) -> bool:
    """True, wenn der Frontmatter `sensibel: true` (oder `sensitive: true`) trägt."""
    if not text:
        return False
    fm = frontmatter.parse_frontmatter(text)
    for key in _SENSITIVE_KEYS:
        val = fm.get(key)
        if isinstance(val, str) and val.strip().lower() in _TRUE_VALUES:
            return True
    return False


def is_sensitive_meta(meta: dict) -> bool:
    """Wie is_sensitive_text, aber auf einem bereits geparsten Frontmatter-Dict
    (z.B. Video-Master-Page, deren Frontmatter nicht im Chat-Text landet)."""
    for key in _SENSITIVE_KEYS:
        val = meta.get(key)
        if val is True:
            return True
        if isinstance(val, str) and val.strip().lower() in _TRUE_VALUES:
            return True
    return False


def _block_message() -> str:
    s_provider, s_model = llm_client.sensitive_llm_config()
    if not s_provider:
        return (
            "Diese Datei ist als sensibel markiert (Frontmatter `sensibel: true`), aber es ist "
            "kein sicheres LLM für sensible Dateien konfiguriert. Lege es in den Einstellungen "
            "unter „Sensible Dateien“ fest (z.B. lokales Ollama oder ein selbstgehostetes Modell)."
        )
    target = s_provider + (f" / {s_model}" if s_model else "")
    a_provider, a_model = llm_client.effective_llm_config()
    active = a_provider + (f" / {a_model}" if a_model else "")
    return (
        f"Diese Datei ist als sensibel markiert und darf nur mit dem freigegebenen LLM "
        f"verarbeitet werden: {target}. Aktiv ist gerade {active}. Stelle in den Einstellungen "
        f"das LLM auf das freigegebene um, dann erneut senden."
    )


def guard_text(text: str, vault_id: str | None = None, rel_path: str | None = None) -> str | None:
    """Returns eine Blockier-Nachricht, wenn der Inhalt sensibel ist (Frontmatter
    `sensibel: true` ODER Pfad unter einem sensiblen Ordner) und die aktive LLM
    nicht die freigegebene ist. Sonst None (erlaubt)."""
    if not is_sensitive_text(text) and not folder_sensitive(vault_id, rel_path):
        return None
    if llm_client.active_allowed_for_sensitive():
        return None
    return _block_message()


def guard_meta(meta: dict, vault_id: str | None = None, rel_path: str | None = None) -> str | None:
    """Wie guard_text, aber auf einem geparsten Frontmatter-Dict."""
    if not is_sensitive_meta(meta) and not folder_sensitive(vault_id, rel_path):
        return None
    if llm_client.active_allowed_for_sensitive():
        return None
    return _block_message()


def guard_file(vault_path: str, rel_path: str, vault_id: str | None = None) -> str | None:
    """Wie guard_text, liest die Datei aber selbst ein. Nicht lesbar = None (kein Block)."""
    if not rel_path:
        return None
    if folder_sensitive(vault_id, rel_path):
        if llm_client.active_allowed_for_sensitive():
            return None
        return _block_message()
    try:
        text = wiki_reader.read_file(vault_path, rel_path)
    except Exception:
        return None
    return guard_text(text, vault_id=vault_id, rel_path=rel_path)


def is_file_sensitive(vault_path: str, rel_path: str, vault_id: str | None = None) -> bool:
    """True, wenn die Datei per Frontmatter ODER Ordner-Vererbung sensibel ist."""
    if folder_sensitive(vault_id, rel_path):
        return True
    try:
        return is_sensitive_text(wiki_reader.read_file(vault_path, rel_path))
    except Exception:
        return False


def list_sensitive_files(vault_path: str, vault_id: str | None = None) -> list[str]:
    """Alle .md-Dateien mit Frontmatter `sensibel: true` (rel_path). Ordner-Vererbung
    nicht enthalten — die kennt der Client aus der Ordner-Liste."""
    import os

    root = wiki_reader.resolve_dir(vault_path).resolve()
    out: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in wiki_reader.IGNORED_NAMES]
        for fn in filenames:
            if not fn.endswith(".md"):
                continue
            p = os.path.join(dirpath, fn)
            try:
                with open(p, "r", encoding="utf-8") as fh:
                    head = fh.read(2048)
            except Exception:
                continue
            if is_sensitive_text(head):
                rel = os.path.relpath(p, root).replace("\\", "/")
                out.append(rel)
    return out


def set_file_sensitive(vault_path: str, rel_path: str, on: bool) -> bool:
    """Setzt/entfernt `sensibel: true` im Frontmatter der Datei (non-destruktiv).
    Returns den neuen Zustand. Legt einen Frontmatter-Block an, falls keiner da ist."""
    text = wiki_reader.read_file(vault_path, rel_path)
    fm, body = frontmatter.split_frontmatter(text)

    if not fm:
        if on:
            new_text = f"---\nsensibel: true\n---\n\n{text}" if text.strip() else "---\nsensibel: true\n---\n"
            wiki_reader.write_file(vault_path, rel_path, new_text)
        return on

    lines = fm.splitlines()
    # Grenzen des --- ... --- Blocks finden
    start = next((i for i, ln in enumerate(lines) if ln.strip() == "---"), 0)
    end = next((i for i in range(start + 1, len(lines)) if lines[i].strip() == "---"), len(lines) - 1)
    inner = lines[start + 1:end]
    inner = [ln for ln in inner if ln.split(":", 1)[0].strip() not in _SENSITIVE_KEYS]
    if on:
        inner.append("sensibel: true")
    new_fm = "\n".join(lines[:start + 1] + inner + lines[end:])
    if not fm.endswith("\n"):
        new_text = new_fm + body
    else:
        new_text = new_fm + ("\n" if not new_fm.endswith("\n") else "") + body
    wiki_reader.write_file(vault_path, rel_path, new_text)
    return on
