# @author Dario | ewtos.com
"""Standalone-Demo: oeffentliche Web-Vorschau der App (ohne Extension).

Bildet die echte Extension-Optik nach: Browser-Viewport links (gerendertes Markdown der
Vault-Dateien oder einer real gescrapten Seite), Sidepanel rechts (exakte Replik inkl.
schmaler Nav-Leiste), ziehbarer Trenner. Chat laeuft BYOK gegen den read-only Beispiel-Vault
ODER gegen den gescrapten Seiteninhalt. Keys werden pro Request verwendet und nicht gespeichert.
Keine eigenen Server-LLM-Kosten (rein BYOK).
"""
from __future__ import annotations

import socket
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

import paths
from llm_providers.anthropic_backend import AnthropicBackend
from llm_providers.openai_backend import OpenAIBackend

router = APIRouter()

_GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai/"
_DEFAULT_MODELS = {
    "gemini": "gemini-2.5-flash",
    "openai": "gpt-4o-mini",
    "anthropic": "claude-haiku-4-5-20251001",
}
_MAX_TOKENS = 1024


class DemoChatRequest(BaseModel):
    provider: str = "gemini"
    api_key: str
    model: str | None = None
    message: str
    history: list[dict] = []
    context: str | None = None
    ingested: str | None = None


class DemoScrapeRequest(BaseModel):
    url: str


def _load_demo_context() -> str:
    root = paths.demo_vault_dir()
    parts: list[str] = []
    for p in sorted(root.rglob("*.md")):
        try:
            rel = p.relative_to(root).as_posix()
            parts.append(f"## Datei: {rel}\n\n{p.read_text(encoding='utf-8')}")
        except Exception:
            continue
    return "\n\n---\n\n".join(parts)


def _backend_for(provider: str, api_key: str):
    provider = (provider or "gemini").strip().lower()
    if provider == "gemini":
        return OpenAIBackend(api_key=api_key, base_url=_GEMINI_OPENAI_BASE)
    if provider == "openai":
        return OpenAIBackend(api_key=api_key)
    if provider == "anthropic":
        return AnthropicBackend(api_key=api_key)
    raise HTTPException(400, "Provider muss 'gemini', 'openai' oder 'anthropic' sein.")


_SYSTEM = (
    "Du bist der Demo-Assistent von Ewtos Office-Brain. Beantworte Fragen "
    "AUSSCHLIESSLICH auf Basis des folgenden Beispiel-Wissens (ein kleiner Obsidian-"
    "Vault). Steht etwas nicht drin, sag das ehrlich. Antworte auf Deutsch, freundlich "
    "und knapp. Dies ist eine read-only Demo.\n\n=== Beispiel-Vault ===\n{context}"
)

_SYSTEM_PAGE = (
    "Du bist der Demo-Assistent von Ewtos Office-Brain. Beantworte Fragen "
    "AUSSCHLIESSLICH auf Basis des folgenden Inhalts (eine Datei oder eine gescrapte "
    "Seite). Steht etwas nicht drin, sag das ehrlich. Antworte auf Deutsch und knapp. "
    "Dies ist eine read-only Demo.\n\n=== Inhalt ===\n{context}"
)


def _is_safe_url(url: str) -> bool:
    try:
        host = urlparse(url).hostname
        if not host:
            return False
        ip = socket.gethostbyname(host)
        octets = ip.split(".")
        if len(octets) != 4:
            return False
        a, b = int(octets[0]), int(octets[1])
        if a in (0, 10, 127):
            return False
        if a == 172 and 16 <= b <= 31:
            return False
        if a == 192 and b == 168:
            return False
        if a == 169 and b == 254:
            return False
        if a == 100 and 64 <= b <= 127:
            return False
        return True
    except Exception:
        return False


_MD_SKIP = {
    "script", "style", "noscript", "template", "svg", "canvas",
    "head", "nav", "footer", "aside", "form",
}
_MD_HEADINGS = {"h1": "# ", "h2": "## ", "h3": "### ", "h4": "#### "}
_MD_BLOCK = {"p", "li", "blockquote", "div", "section", "article", "td", "th", "tr", "br"}


class _MDExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.skip_depth = 0
        self.title = ""
        self._in_title = False
        self.blocks: list[str] = []
        self._buf: list[str] = []
        self._prefix = ""

    def _flush(self) -> None:
        text = " ".join("".join(self._buf).split()).strip()
        if text:
            self.blocks.append((self._prefix + text).strip())
        self._buf = []
        self._prefix = ""

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag in _MD_SKIP:
            self.skip_depth += 1
            return
        if self.skip_depth:
            return
        if tag == "title":
            self._in_title = True
            return
        if tag in _MD_HEADINGS:
            self._flush()
            self._prefix = _MD_HEADINGS[tag]
        elif tag == "li":
            self._flush()
            self._prefix = "- "
        elif tag in _MD_BLOCK:
            self._flush()

    def handle_endtag(self, tag: str) -> None:
        if tag in _MD_SKIP:
            if self.skip_depth:
                self.skip_depth -= 1
            return
        if tag == "title":
            self._in_title = False
            return
        if self.skip_depth:
            return
        if tag in _MD_HEADINGS or tag == "li" or tag in _MD_BLOCK:
            self._flush()

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data
            return
        if self.skip_depth:
            return
        self._buf.append(data)

    def close(self) -> None:
        super().close()
        self._flush()


def _extract_md(html_text: str, url: str) -> tuple[str, str]:
    parser = _MDExtractor()
    try:
        parser.feed(html_text)
        parser.close()
    except Exception:
        pass

    blocks = [b for b in parser.blocks if b]
    title = " ".join(parser.title.split()).strip()
    if not title:
        for b in blocks:
            if b.startswith("# "):
                title = b[2:].strip()
                break
    if not title:
        title = urlparse(url).hostname or url

    if len(blocks) > 80:
        blocks = blocks[:80]
        blocks.append("… (gekürzt)")

    return title, "\n\n".join(blocks)


@router.get("/demo/vault/files")
def demo_vault_files() -> dict:
    root = paths.demo_vault_dir()
    files = [p.relative_to(root).as_posix() for p in sorted(root.rglob("*.md"))]
    return {"files": files}


@router.get("/demo/vault/read")
def demo_vault_read(path: str) -> dict:
    root = paths.demo_vault_dir().resolve()
    target = (root / path).resolve()
    if not target.is_relative_to(root):
        raise HTTPException(403, "Ungültiger Pfad.")
    if target.suffix != ".md":
        raise HTTPException(400, "Nur .md-Dateien.")
    if not target.exists():
        raise HTTPException(404, "Datei nicht gefunden.")
    return {"content": target.read_text(encoding="utf-8")}


@router.post("/demo/scrape")
async def demo_scrape(req: DemoScrapeRequest) -> dict[str, Any]:
    url = (req.url or "").strip()
    if not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(400, "URL muss mit http(s):// beginnen.")
    if not _is_safe_url(url):
        raise HTTPException(403, "URL nicht erlaubt (private/lokale Adresse).")
    try:
        async with httpx.AsyncClient(
            timeout=12,
            follow_redirects=True,
            headers={"User-Agent": "Mozilla/5.0 (compatible; EwtosBrain-Demo/1.0)"},
        ) as client:
            resp = await client.get(url)
            resp.raise_for_status()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"Seite konnte nicht geladen werden: {str(e)[:200]}")

    text = resp.text
    if len(text) > 1_500_000:
        text = text[:1_500_000]
    title, md = _extract_md(text, url)
    return {"title": title, "url": str(resp.url), "markdown": md, "wordCount": len(md.split())}


@router.post("/demo/chat")
def demo_chat(req: DemoChatRequest) -> dict[str, Any]:
    if not (req.api_key or "").strip():
        raise HTTPException(400, "Bitte einen eigenen API-Key eintragen.")
    if not (req.message or "").strip():
        raise HTTPException(400, "Leere Nachricht.")
    backend = _backend_for(req.provider, req.api_key.strip())
    model = (req.model or "").strip() or _DEFAULT_MODELS.get(req.provider.strip().lower(), "gemini-2.5-flash")
    if isinstance(req.context, str) and req.context.strip():
        system = _SYSTEM_PAGE.format(context=req.context[:12000])
    else:
        vault_ctx = _load_demo_context()
        if isinstance(req.ingested, str) and req.ingested.strip():
            vault_ctx += "\n\n---\n\n## Datei: " + req.ingested.strip()[:8000]
        system = _SYSTEM.format(context=vault_ctx)
    messages = [
        {"role": m.get("role"), "content": m.get("content")}
        for m in (req.history or [])
        if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)
    ][-8:]
    messages.append({"role": "user", "content": req.message.strip()})
    try:
        result = backend.complete(model=model, messages=messages, system=system, max_tokens=_MAX_TOKENS)
    except Exception as e:
        msg = str(e)
        raise HTTPException(400, f"LLM-Fehler (Key/Modell prüfen): {msg[:300]}")
    answer = "".join(
        getattr(b, "text", "") for b in result.content if getattr(b, "type", "") == "text"
    ).strip()
    return {"answer": answer or "(keine Antwort)"}


@router.get("/demo", response_class=HTMLResponse)
def demo_page() -> str:
    return _PAGE


_PAGE = r"""<!DOCTYPE html>
<html lang="de" data-mode="dark" data-theme="neutral">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ewtos Office-Brain — Live-Demo</title>
<style>
/* Demo-Seite — EwtosBrain Browser-Simulation | ewtos.com */

:root {
  --bg:#fafafa; --bg-card:#ffffff; --bg-subtle:#f3f4f6; --bg-hover:#f9fafb;
  --border:#e5e7eb; --border-input:#d1d5db;
  --text:#1a1a1a; --text-muted:#6b7280; --text-faint:#9ca3af;
  --accent:#1a1a1a; --accent-h:#333; --accent-tx:#fff;
  --hdr-bg:#1a1a1a; --hdr-tx:#ffffff;
}
[data-mode="dark"] {
  --bg:#111827; --bg-card:#1f2937; --bg-subtle:#374151; --bg-hover:#2d3748;
  --border:#374151; --border-input:#4b5563;
  --text:#f9fafb; --text-muted:#9ca3af; --text-faint:#6b7280;
  --accent:#e5e7eb; --accent-h:#d1d5db; --accent-tx:#111827;
  --hdr-bg:#0f172a; --hdr-tx:#f9fafb;
}
[data-theme="ocean"]  { --accent:#1d4ed8; --accent-h:#1e40af; --accent-tx:#fff; --hdr-bg:#1e3a5f; }
[data-theme="forest"] { --accent:#15803d; --accent-h:#166534; --accent-tx:#fff; --hdr-bg:#14532d; }
[data-theme="sunset"] { --accent:#7c3aed; --accent-h:#6d28d9; --accent-tx:#fff; --hdr-bg:#3b0764; }
[data-theme="ember"]  { --accent:#b45309; --accent-h:#92400e; --accent-tx:#fff; --hdr-bg:#451a03; }
[data-mode="dark"][data-theme="ocean"]  { --accent:#60a5fa; --accent-h:#93c5fd; --accent-tx:#0c1a2e; --hdr-bg:#0c1a2e; }
[data-mode="dark"][data-theme="forest"] { --accent:#4ade80; --accent-h:#86efac; --accent-tx:#052e16; --hdr-bg:#052e16; }
[data-mode="dark"][data-theme="sunset"] { --accent:#a78bfa; --accent-h:#c4b5fd; --accent-tx:#1e1b4b; --hdr-bg:#1e1b4b; }
[data-mode="dark"][data-theme="ember"]  { --accent:#fbbf24; --accent-h:#fcd34d; --accent-tx:#1c0a00; --hdr-bg:#1c0a00; }

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  height: 100vh;
  overflow: hidden;
  display: flex;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
  font-size: 14px;
  color: var(--text);
  background: var(--bg);
  transition: background 0.2s, color 0.2s;
}

/* Browser-Shell */
.browser { display: flex; flex-direction: row; width: 100%; height: 100%; }

/* Viewport (links) */
.viewport { flex: 1; min-width: 0; display: flex; flex-direction: column; }

.chrome {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px 0;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border);
}
.winbtns { display: flex; gap: 6px; flex-shrink: 0; padding-bottom: 8px; }
.wb { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
.wb.r { background: #ff5f57; }
.wb.y { background: #febc2e; }
.wb.g { background: #28c840; }

.tab {
  display: flex;
  align-items: center;
  gap: 7px;
  max-width: 240px;
  padding: 7px 14px;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-bottom: none;
  border-radius: 9px 9px 0 0;
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tab #tab-ico { font-size: 13px; line-height: 1; flex-shrink: 0; }
.tab #tab-label { overflow: hidden; text-overflow: ellipsis; }

.urlbar {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 8px;
  padding: 6px 12px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 999px;
  font-family: ui-monospace, "Consolas", monospace;
  font-size: 12px;
  color: var(--text-muted);
}
.urlbar .lock { font-size: 11px; flex-shrink: 0; opacity: 0.7; }
.urlbar #urlbar-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.doc-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--bg);
  padding: 28px 32px 64px;
}
.doc.markdown { max-width: 860px; margin: 0 auto; line-height: 1.7; color: var(--text); }

/* Drag-Handle */
.drag-handle {
  width: 6px;
  flex-shrink: 0;
  height: 100%;
  cursor: col-resize;
  background: var(--border);
  transition: background 0.15s;
}
.drag-handle:hover { background: var(--accent); }

/* Panel (Sidepanel-Replik, rechts) */
.panel {
  width: var(--panel-w, 360px);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
  background: var(--bg);
}

/* Header */
.eb-header {
  height: 46px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  background: var(--hdr-bg);
  color: var(--hdr-tx);
}
.tool-search {
  flex: 1;
  min-width: 0;
  padding: 6px 12px;
  font-size: 13px;
  font-family: inherit;
  color: var(--hdr-tx);
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 999px;
  outline: none;
}
.tool-search::placeholder { color: var(--hdr-tx); opacity: 0.5; }
.tool-search:focus { border-color: rgba(255, 255, 255, 0.4); background: rgba(255, 255, 255, 0.16); }

.header-right { display: flex; align-items: center; gap: 6px; }
.status { display: flex; align-items: center; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; cursor: help; }
.dot.online { background: #22c55e; }
.dot.offline { background: #9ca3af; }

.hbtn {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--hdr-tx);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.12s;
}
.hbtn:hover { background: rgba(255, 255, 255, 0.15); }

/* Workspace + Nav-Rail */
.workspace { flex: 1; min-height: 0; display: flex; }
.work-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }

#content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  background: var(--bg);
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
#content::-webkit-scrollbar { width: 9px; }
#content::-webkit-scrollbar-thumb { background: var(--border); border-radius: 5px; }

.nav-sidebar {
  flex-shrink: 0;
  width: 0;
  overflow-x: hidden;
  overflow-y: auto;
  background: var(--hdr-bg);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 6px 0;
  gap: 3px;
  transition: width 0.18s ease;
}
.nav-sidebar.open { width: 52px; box-shadow: -2px 0 8px rgba(0, 0, 0, 0.12); }

#nav-main { display: flex; flex-direction: column; align-items: center; gap: 3px; }

.nav-item {
  width: 42px;
  height: 42px;
  flex-shrink: 0;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--hdr-tx);
  opacity: 0.65;
  font-size: 19px;
  line-height: 1;
  cursor: pointer;
  font-family: inherit;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.15s, background 0.15s;
}
.nav-item:hover { opacity: 1; background: rgba(255, 255, 255, 0.12); }
.nav-item.active { opacity: 1; background: rgba(255, 255, 255, 0.18); }

.nav-sidebar-foot {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.18);
}

/* Views (#content) */
.view { padding: 13px 14px; }
.view-head { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
.view-sub { font-weight: 400; font-size: 11.5px; color: var(--text-muted); }
.view-note { font-size: 11.5px; color: var(--text-muted); line-height: 1.5; margin-top: 10px; }

/* HOME */
.tools-head {
  font-size: 10px; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase;
  color: var(--text-faint); padding: 2px 0 10px;
}
.tgroup { margin-bottom: 14px; }
.tgroup-label {
  font-size: 10px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase;
  color: var(--text-faint); margin-bottom: 6px;
}
.tiles { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
.tile {
  position: relative;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 4px; padding: 12px 6px; background: var(--bg-subtle); border: 1px solid var(--border);
  border-radius: 10px; color: var(--text); font-size: 18px; line-height: 1; cursor: pointer;
  font-family: inherit; transition: background 0.12s, border-color 0.12s;
}
.tile span { font-size: 11px; font-weight: 600; line-height: 1.2; }
.tile:hover { background: var(--bg-hover); }
.tile:not(.locked) { border-color: var(--accent); }
.tile.locked { opacity: 0.6; cursor: pointer; }
.tile.locked::after {
  content: "Pro"; position: absolute; top: 5px; right: 5px;
  font-size: 8.5px; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase;
  padding: 1px 5px; border-radius: 999px; line-height: 1.4;
  color: var(--accent-tx); background: var(--accent);
}
.tgroup.hidden, .tile.hidden { display: none; }

/* VAULT */
.filelist { list-style: none; }
.f-dir {
  font-size: 10.5px; font-weight: 600; letter-spacing: 0.4px; text-transform: uppercase;
  color: var(--text-faint); padding: 10px 0 4px;
}
.f-item {
  padding: 6px 14px; border-left: 2px solid transparent; font-size: 13px; color: var(--text);
  cursor: pointer; border-radius: 0 4px 4px 0; transition: background 0.1s;
}
.f-item:hover { background: var(--bg-hover); }
.f-item.active { border-left-color: var(--accent); color: var(--accent); background: var(--bg-hover); font-weight: 500; }

/* WEB (Scrape) */
.scrape-row { display: flex; gap: 6px; }
.scrape-row #scrape-url {
  flex: 1; min-width: 0; padding: 8px 10px; font-size: 13px; font-family: inherit;
  color: var(--text); background: var(--bg-card); border: 1px solid var(--border-input);
  border-radius: 8px; outline: none;
}
.scrape-row #scrape-url:focus { border-color: var(--accent); }
.scrape-status { font-size: 11.5px; color: var(--text-muted); padding: 8px 0 0; }
.scrape-status.err { color: #ef4444; }
.scrape-status.ok { color: #22c55e; }

/* Back-Button (Demo-Tool-Views) */
.back-btn {
  display: inline-flex; align-items: center; margin-right: 4px; padding: 2px 8px;
  font-size: 11px; font-weight: 600; font-family: inherit; vertical-align: middle;
  color: var(--text-muted); background: var(--bg-subtle);
  border: 1px solid var(--border); border-radius: 999px; cursor: pointer; transition: background 0.12s;
}
.back-btn:hover { background: var(--bg-hover); color: var(--text); }

/* CRM */
.crm-list { display: flex; flex-direction: column; gap: 8px; }
.crm-card {
  display: flex; align-items: center; gap: 10px; padding: 10px 12px;
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px;
}
.crm-avatar {
  width: 34px; height: 34px; flex-shrink: 0; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; color: var(--accent-tx); background: var(--accent);
}
.crm-body { flex: 1; min-width: 0; }
.crm-name { font-size: 13px; font-weight: 600; color: var(--text); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.crm-meta { font-size: 11.5px; color: var(--text-muted); margin: 1px 0 4px; }
.crm-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.crm-kontakt { flex-shrink: 0; font-size: 10.5px; color: var(--text-faint); white-space: nowrap; align-self: flex-start; }
.crm-status {
  font-size: 9.5px; font-weight: 700; letter-spacing: 0.3px; text-transform: uppercase;
  padding: 1px 7px; border-radius: 999px; line-height: 1.5;
}
.crm-status.aktiv { color: #166534; background: #dcfce7; }
.crm-status.lead { color: #1e40af; background: #dbeafe; }
.crm-status.angebot { color: #92400e; background: #fef3c7; }
.crm-status.pausiert { color: #4b5563; background: #e5e7eb; }
[data-mode="dark"] .crm-status.aktiv { color: #4ade80; background: rgba(34,197,94,0.15); }
[data-mode="dark"] .crm-status.lead { color: #60a5fa; background: rgba(59,130,246,0.15); }
[data-mode="dark"] .crm-status.angebot { color: #fbbf24; background: rgba(245,158,11,0.15); }
[data-mode="dark"] .crm-status.pausiert { color: #9ca3af; background: rgba(156,163,175,0.15); }

/* Todos */
.todo-add { display: flex; gap: 6px; margin-bottom: 10px; }
.todo-add #todo-input {
  flex: 1; min-width: 0; padding: 8px 10px; font-size: 13px; font-family: inherit; color: var(--text);
  background: var(--bg-card); border: 1px solid var(--border-input); border-radius: 8px; outline: none;
}
.todo-add #todo-input:focus { border-color: var(--accent); }
.todo-list { list-style: none; display: flex; flex-direction: column; gap: 4px; }
.todo-item {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px;
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px;
}
.todo-check { border: none; background: transparent; color: var(--accent); font-size: 17px; line-height: 1; cursor: pointer; padding: 0; font-family: inherit; }
.todo-text { flex: 1; min-width: 0; font-size: 13px; color: var(--text); word-break: break-word; }
.todo-item.done .todo-text { text-decoration: line-through; color: var(--text-faint); }
.todo-del { border: none; background: transparent; color: var(--text-faint); font-size: 16px; line-height: 1; cursor: pointer; padding: 0 2px; font-family: inherit; }
.todo-del:hover { color: #ef4444; }
.todo-empty { font-size: 12px; color: var(--text-muted); padding: 8px 2px; }

/* Color Picker */
.cp-result { display: flex; align-items: center; gap: 12px; min-height: 4px; }
.cp-swatch { width: 60px; height: 60px; flex-shrink: 0; border-radius: 10px; border: 1px solid var(--border); }
.cp-info { display: flex; flex-direction: column; gap: 5px; }
.cp-val {
  align-self: flex-start; padding: 3px 9px; font-size: 12.5px; font-family: ui-monospace, "Consolas", monospace;
  color: var(--text); background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 7px; cursor: pointer; transition: background 0.12s;
}
.cp-val:hover { background: var(--bg-hover); }
.cp-status { font-size: 11px; color: var(--text-muted); }
.cp-recent-wrap { margin-top: 14px; }
.cp-recent { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.cp-chip { width: 26px; height: 26px; border-radius: 7px; border: 1px solid var(--border); cursor: pointer; padding: 0; }
.cp-chip:hover { transform: scale(1.1); }

/* PITCH-SEITE (Viewport) */
.pitch-page { max-width: 820px; margin: 0 auto; }
.pp-hero { text-align: center; padding: 8px 0 18px; }
.pp-eyebrow {
  display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase;
  color: var(--accent); background: var(--bg-subtle); border: 1px solid var(--border);
  padding: 3px 11px; border-radius: 999px; margin-bottom: 14px;
}
.pp-title { font-size: 34px; font-weight: 800; line-height: 1.15; margin: 0 0 12px; letter-spacing: -0.5px; }
.pp-sub { font-size: 15px; line-height: 1.6; color: var(--text-muted); max-width: 620px; margin: 0 auto 18px; }
.pp-cta { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
.pp-video { margin: 8px auto 26px; max-width: 640px; }
.pp-video-facade {
  position: relative; aspect-ratio: 16 / 9; border-radius: 14px; overflow: hidden;
  background: linear-gradient(135deg, #1e293b, #0f172a); background-size: cover; background-position: center;
  border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; cursor: pointer;
}
.pp-play {
  width: 64px; height: 64px; border-radius: 50%; border: none; cursor: pointer;
  background: rgba(0,0,0,0.55); color: #fff; font-size: 24px; line-height: 1;
  display: flex; align-items: center; justify-content: center; transition: transform 0.12s, background 0.12s;
}
.pp-video-facade:hover .pp-play { transform: scale(1.08); background: rgba(0,0,0,0.7); }
.pp-video-cap {
  position: absolute; left: 0; right: 0; bottom: 0; padding: 8px 12px; font-size: 12px; color: #fff;
  background: linear-gradient(transparent, rgba(0,0,0,0.7)); text-align: left;
}
.pp-video-placeholder { color: #e5e7eb; text-align: center; font-size: 14px; line-height: 1.5; padding: 20px; }
.pp-video-placeholder span { font-size: 12px; color: #9ca3af; }
.pp-iframe { width: 100%; height: 100%; border: 0; }
.pp-h2 { font-size: 20px; font-weight: 700; margin: 22px 0 12px; text-align: center; }
.pp-loop { display: flex; align-items: stretch; justify-content: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.pp-step {
  flex: 1 1 150px; max-width: 210px; text-align: center; padding: 14px 12px;
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px;
  display: flex; flex-direction: column; gap: 5px;
}
.pp-step-ico { font-size: 26px; line-height: 1; }
.pp-step b { font-size: 14px; }
.pp-step span { font-size: 12px; color: var(--text-muted); line-height: 1.45; }
.pp-arrow { display: flex; align-items: center; color: var(--text-faint); font-size: 20px; font-weight: 700; }
.pp-features { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 20px; }
.pp-feat { padding: 14px; background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 12px; display: flex; flex-direction: column; gap: 4px; }
.pp-feat b { font-size: 13.5px; }
.pp-feat span { font-size: 12.5px; color: var(--text-muted); line-height: 1.5; }
.pp-foot { text-align: center; padding: 8px 0 20px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.pp-foot-note { font-size: 12px; color: var(--text-muted); }
@media (max-width: 560px) {
  .pp-title { font-size: 26px; }
  .pp-features { grid-template-columns: 1fr; }
  .pp-arrow { transform: rotate(90deg); }
}

/* Intro-Overlay */
.intro-dlg { max-width: 440px; }
.intro-eyebrow {
  font-size: 10px; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase; color: var(--accent);
}
.intro-video-facade {
  position: relative; aspect-ratio: 16 / 9; border-radius: 11px; overflow: hidden; margin: 4px 0 4px;
  background: linear-gradient(135deg, #1e293b, #0f172a); background-size: cover; background-position: center;
  border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; cursor: pointer;
}

/* Video-Loop-View */
.yt-url-row { display: flex; gap: 6px; margin-bottom: 8px; }
.yt-url-row #yt-url {
  flex: 1; min-width: 0; padding: 8px 10px; font-size: 12.5px; font-family: ui-monospace, "Consolas", monospace;
  color: var(--text); background: var(--bg-card); border: 1px solid var(--border-input); border-radius: 8px; outline: none;
}
.yt-url-row #yt-url:focus { border-color: var(--accent); }
.yt-meta-card {
  margin: 8px 0; padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border);
  border-radius: 10px; display: flex; flex-direction: column; gap: 3px;
}
.yt-meta-card.hidden, .scrape-preview-wrap.hidden { display: none; }
.yt-meta-row { font-size: 12px; color: var(--text-muted); }
.yt-meta-row b { color: var(--text); font-weight: 600; }
.yt-meta-desc span { display: block; margin-top: 2px; color: var(--text-muted); line-height: 1.45; }
.scrape-preview-wrap { margin: 8px 0; }
.scrape-preview-toggle {
  border: none; background: transparent; color: var(--accent); font-size: 12px; font-weight: 600;
  cursor: pointer; padding: 2px 0; font-family: inherit;
}
.scrape-preview-wrap textarea {
  display: none; width: 100%; margin-top: 6px; height: 180px; resize: vertical; padding: 8px 10px;
  font-family: ui-monospace, "Consolas", monospace; font-size: 11.5px; line-height: 1.5; color: var(--text);
  background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 8px; outline: none;
}
.scrape-preview-wrap textarea.open { display: block; }
.yt-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 4px; }
.yt-actions .btn-p, .yt-actions .btn-s { padding: 7px 12px; font-size: 12.5px; }

/* Playlists-View */
.playlist-group-header {
  font-size: 11px; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase;
  color: var(--text-faint); margin: 4px 0 8px;
}
.playlist-empty { font-size: 12.5px; color: var(--text-muted); line-height: 1.5; }
.playlist-item-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 11px; padding: 10px; }
.playlist-item-head { display: flex; gap: 10px; }
.playlist-thumb {
  width: 96px; height: 54px; flex-shrink: 0; border-radius: 7px; border: 1px solid var(--border);
  background: linear-gradient(135deg, #1e293b, #0f172a); background-size: cover; background-position: center;
}
.playlist-item-headtext { min-width: 0; flex: 1; }
.playlist-item-title { font-size: 13px; font-weight: 600; line-height: 1.3; }
.playlist-item-meta { display: flex; flex-direction: column; gap: 1px; margin-top: 3px; }
.playlist-item-meta span { font-size: 11px; color: var(--text-muted); }
.playlist-item-links { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 9px; }
.playlist-item-links a, .playlist-item-links .small {
  font-size: 11.5px; padding: 4px 9px; border-radius: 7px; border: 1px solid var(--border);
  background: var(--bg-subtle); color: var(--text); cursor: pointer; text-decoration: none; font-family: inherit;
}
.playlist-item-links a:hover, .playlist-item-links .small:hover { background: var(--bg-hover); }
.pl-badge { font-size: 11px; font-weight: 600; color: #22c55e; padding: 4px 4px; }

/* PITCH / TAGS / SCRAPER-HINT / TOUR */
.pitch {
  background: var(--accent); color: var(--accent-tx);
  border-radius: 9px; padding: 9px 12px; margin-bottom: 11px;
  font-size: 12.5px; line-height: 1.5;
}
.pitch-head { font-weight: 700; font-size: 13.5px; margin-bottom: 2px; }
.tags { display: flex; flex-wrap: wrap; gap: 5px; margin: 9px 0 2px; }
.tag {
  font-size: 10.5px; font-weight: 600; padding: 2px 8px;
  border: 1px solid var(--border); border-radius: 999px;
  color: var(--text-muted); background: var(--bg-card); letter-spacing: 0.2px;
}
.scraper-hint {
  font-size: 11.5px; color: var(--text-muted); margin-top: 8px;
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
}
.scraper-hint strong { color: var(--text); }

/* Tour-Trigger (Chip) */
.tour-trigger {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 9px; vertical-align: middle;
  font-size: 11px; font-weight: 600; font-family: inherit;
  color: var(--accent); background: var(--bg-card);
  border: 1px solid var(--accent); border-radius: 999px; cursor: pointer;
  transition: background 0.12s;
}
.tour-trigger:hover { background: var(--bg-hover); }

/* Tour-Overlay: floatende Karte, durchklickbar + wegklickbar */
.tour-backdrop { position: fixed; inset: 0; z-index: 50; background: rgba(0, 0, 0, 0.22); }
.tour-focus {
  position: relative; z-index: 55;
  outline: 3px solid var(--accent); outline-offset: 2px; border-radius: 7px;
}
.tour-card {
  position: fixed; z-index: 60; width: 250px; max-width: calc(100vw - 20px);
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 11px;
  padding: 13px 14px; box-shadow: 0 12px 34px rgba(0, 0, 0, 0.4); color: var(--text);
}
.tour-counter { font-size: 10.5px; font-weight: 700; letter-spacing: 0.4px; color: var(--accent); margin-bottom: 5px; }
.tour-title { font-size: 14px; font-weight: 700; margin-bottom: 5px; }
.tour-body { font-size: 12.5px; line-height: 1.55; color: var(--text-muted); margin-bottom: 12px; }
.tour-nav { display: flex; align-items: center; gap: 7px; }
.tour-nav .sp { flex: 1; }
.tour-btn {
  padding: 6px 13px; font-size: 12px; font-weight: 600; font-family: inherit;
  border-radius: 8px; cursor: pointer; border: 1px solid var(--border-input);
  background: var(--bg-subtle); color: var(--text); transition: background 0.12s;
}
.tour-btn:hover { background: var(--bg-hover); }
.tour-btn.primary { background: var(--accent); color: var(--accent-tx); border-color: var(--accent); }
.tour-close {
  border: none; background: transparent; color: var(--text-muted);
  font-size: 18px; line-height: 1; cursor: pointer; padding: 0 2px; font-family: inherit;
}
.tour-close:hover { color: var(--text); }
.tour-arrow { position: absolute; width: 0; height: 0; border: 8px solid transparent; display: none; }
.tour-card.below .tour-arrow { top: -16px; border-bottom-color: var(--bg-card); }
.tour-card.above .tour-arrow { bottom: -16px; border-top-color: var(--bg-card); }

/* CHAT (linker Arbeitsflächen-Tab) */
.chat-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 12px 16px; gap: 8px; }
.chat-modes { display: flex; gap: 6px; flex-shrink: 0; }
.chat-mode-btn {
  padding: 5px 12px; font-size: 12px; font-family: inherit; cursor: pointer;
  color: var(--text-muted); background: transparent; border: 1px solid var(--border-input); border-radius: 7px;
  transition: background 0.12s, color 0.12s;
}
.chat-mode-btn:hover { background: var(--bg-hover); }
.chat-mode-btn.active { background: var(--accent); color: var(--accent-tx); border-color: var(--accent); }
.chat-source-banner {
  flex-shrink: 0; font-size: 12px; color: var(--text-muted);
  padding: 6px 10px; background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 8px;
}
.chat-source-banner b { color: var(--text); font-weight: 600; }

.chat-log {
  flex: 1 1 auto; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column; gap: 9px; padding: 4px 2px;
  scrollbar-width: thin; scrollbar-color: var(--border) transparent;
}
.msg { max-width: 86%; padding: 9px 13px; border-radius: 10px; font-size: 13px; line-height: 1.5; word-break: break-word; }
.msg.me { align-self: flex-end; background: var(--bg-subtle); color: var(--text); }
.msg.ai { align-self: flex-start; background: var(--bg-card); border: 1px solid var(--border); color: var(--text); }
.msg.err {
  align-self: flex-start; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3);
  color: #ef4444; font-size: 12px; max-width: 100%;
}
.msg.ai p { margin: 0 0 6px; }
.msg.ai p:last-child { margin-bottom: 0; }
.msg.ai h2, .msg.ai h3, .msg.ai h4 { margin: 8px 0 4px; font-size: 13.5px; font-weight: 600; }
.msg.ai ul, .msg.ai ol { margin: 4px 0; padding-left: 18px; }
.msg.ai li { margin: 2px 0; }
.msg.ai code { background: var(--bg-subtle); padding: 1px 4px; border-radius: 3px; font-family: ui-monospace, "Consolas", monospace; font-size: 12px; }
.msg.ai pre { background: var(--bg-subtle); padding: 8px 10px; border-radius: 6px; overflow-x: auto; margin: 6px 0; }
.msg.ai pre code { background: none; padding: 0; }
.msg.ai a { color: var(--accent); text-decoration: underline; word-break: break-all; }
.msg.ai blockquote { border-left: 3px solid var(--accent); margin: 4px 0; padding: 2px 10px; color: var(--text-muted); }
.msg.ai hr { border: none; border-top: 1px solid var(--border); margin: 8px 0; }

.chat-empty {
  display: flex; flex-direction: column; align-items: flex-start; gap: 6px;
  padding: 12px 13px; margin: 4px 0; background: var(--bg-card);
  border: 1px solid var(--border); border-radius: 10px;
}
.chat-empty .ce-head { font-size: 12.5px; font-weight: 700; color: var(--text); }
.chat-empty p { font-size: 12px; line-height: 1.5; color: var(--text-muted); margin: 0; }
.chat-empty .ce-hint a { color: var(--accent); }
.chat-empty .btn-s { margin-top: 3px; padding: 6px 12px; font-size: 12px; }

.chat-ex { display: flex; flex-wrap: wrap; gap: 6px; }
.chat-ex button {
  padding: 5px 10px; font-size: 11.5px; color: var(--text); background: var(--bg-card);
  border: 1px solid var(--border); border-radius: 7px; cursor: pointer; font-family: inherit;
  transition: background 0.12s, border-color 0.12s;
}
.chat-ex button:hover { background: var(--bg-hover); border-color: var(--border-input); }

.composer { display: flex; gap: 8px; align-items: flex-end; padding-top: 9px; border-top: 1px solid var(--border); }
.composer #msg {
  flex: 1; min-width: 0; resize: none; padding: 8px 10px; font-family: inherit; font-size: 13px;
  line-height: 1.4; color: var(--text); background: var(--bg-card); border: 1px solid var(--border-input);
  border-radius: 8px; outline: none;
}
.composer #msg:focus { border-color: var(--accent); }
.chat-pane .composer { flex-shrink: 0; }

/* Datei-Viewer-Aktionen (links) */
.viewer-actions { margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--border); display: flex; gap: 8px; flex-wrap: wrap; }
.vault-file-chat-btn {
  padding: 8px 14px; font-size: 13px; font-weight: 600; font-family: inherit; cursor: pointer;
  color: var(--accent-tx); background: var(--accent); border: 1px solid var(--accent); border-radius: 9px;
}
.vault-file-chat-btn:hover { background: var(--accent-h); }
.scrape-chat-wrap:empty { display: none; }

/* Frontmatter-Block */
.fm-block { margin: 0 0 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-subtle); overflow: hidden; }
.fm-block > summary { cursor: pointer; padding: 7px 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase; color: var(--text-faint); }
.fm-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.fm-table th, .fm-table td { text-align: left; padding: 5px 12px; border-top: 1px solid var(--border); vertical-align: top; }
.fm-table th { width: 34%; color: var(--text-muted); font-weight: 600; }
.fm-table td { color: var(--text); word-break: break-word; }

/* Markdown-Bilder */
.md-image { max-width: 100%; height: auto; border-radius: 6px; display: block; margin: 4px 0; }
.md-img-broken { display: inline-block; font-size: 12px; color: var(--text-faint); background: var(--bg-subtle); border: 1px dashed var(--border); border-radius: 6px; padding: 6px 10px; }

/* LOCKED */
.view-locked { display: flex; align-items: center; justify-content: center; min-height: 100%; padding: 24px 16px; }
.locked-card {
  max-width: 280px; display: flex; flex-direction: column; align-items: center; text-align: center;
  gap: 8px; padding: 24px 18px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 14px;
}
.locked-ico { font-size: 42px; line-height: 1; }
.locked-title { font-size: 15px; font-weight: 600; color: var(--text); }
.locked-card p { font-size: 12.5px; color: var(--text-muted); line-height: 1.5; }
.locked-card .btn-p { margin-top: 6px; text-decoration: none; }

/* Buttons */
.btn-p {
  display: inline-flex; align-items: center; justify-content: center; padding: 8px 15px;
  font-size: 13px; font-weight: 600; font-family: inherit; color: var(--accent-tx);
  background: var(--accent); border: 1px solid var(--accent); border-radius: 9px; cursor: pointer;
  text-decoration: none; transition: background 0.12s, opacity 0.12s;
}
.btn-p:hover { background: var(--accent-h); }
.btn-s {
  display: inline-flex; align-items: center; justify-content: center; padding: 8px 15px;
  font-size: 13px; font-weight: 500; font-family: inherit; color: var(--text);
  background: var(--bg-subtle); border: 1px solid var(--border-input); border-radius: 9px; cursor: pointer;
  transition: background 0.12s;
}
.btn-s:hover { background: var(--bg-hover); }

.swatch {
  width: 18px; height: 18px; border-radius: 50%; background: var(--c); border: 2px solid transparent;
  cursor: pointer; padding: 0; transition: transform 0.12s, border-color 0.12s;
}
.swatch:hover { transform: scale(1.15); }
.swatch.active { border-color: var(--text); }

/* Dialoge */
dialog {
  background: var(--bg-card); color: var(--text); border: 1px solid var(--border);
  border-radius: 14px; padding: 20px; max-width: 360px; width: calc(100% - 32px);
}
dialog::backdrop { background: rgba(0, 0, 0, 0.5); }
.dlg-body { display: flex; flex-direction: column; gap: 10px; }
.dlg-title { font-size: 16px; font-weight: 700; color: var(--text); }
.dlg-sec {
  font-size: 10px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase;
  color: var(--text-faint); margin-top: 6px;
}
.fld { display: flex; flex-direction: column; gap: 3px; }
.fld > span { font-size: 11.5px; color: var(--text-muted); }
.fld select, .fld input {
  width: 100%; padding: 8px 10px; font-size: 13px; font-family: inherit; color: var(--text);
  background: var(--bg-card); border: 1px solid var(--border-input); border-radius: 8px; outline: none;
}
.fld select:focus, .fld input:focus { border-color: var(--accent); }
.dlg-hint { font-size: 11.5px; color: var(--text-muted); line-height: 1.5; }
.dlg-hint a { color: var(--accent); }
.dlg-actions { display: flex; gap: 9px; margin-top: 10px; }
.swatches { display: flex; gap: 8px; }

/* Markdown-Typografie (.doc.markdown) */
.doc.markdown h1 { font-size: 30px; font-weight: 700; line-height: 1.25; margin: 0 0 18px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
.doc.markdown h2 { font-size: 23px; font-weight: 700; line-height: 1.3; margin: 30px 0 12px; }
.doc.markdown h3 { font-size: 18px; font-weight: 600; margin: 24px 0 10px; }
.doc.markdown h4 { font-size: 15px; font-weight: 600; margin: 20px 0 8px; }
.doc.markdown p { margin: 0 0 14px; line-height: 1.7; }
.doc.markdown ul, .doc.markdown ol { margin: 0 0 14px; padding-left: 26px; }
.doc.markdown li { margin: 5px 0; line-height: 1.6; }
.doc.markdown code { background: var(--bg-subtle); padding: 2px 5px; border-radius: 4px; font-family: ui-monospace, "Consolas", monospace; font-size: 0.88em; }
.doc.markdown pre { background: var(--bg-subtle); padding: 14px 16px; border-radius: 8px; overflow-x: auto; margin: 0 0 16px; }
.doc.markdown pre code { background: none; padding: 0; font-size: 13px; }
.doc.markdown blockquote { border-left: 3px solid var(--accent); padding-left: 14px; margin: 0 0 14px; color: var(--text-muted); }
.doc.markdown a { color: var(--accent); text-decoration: none; }
.doc.markdown a:hover { text-decoration: underline; }
.doc.markdown a.wiki-link { color: var(--accent); border-bottom: 1px dashed var(--accent); }
.doc.markdown a.wiki-link:hover { border-bottom-style: solid; text-decoration: none; }
.doc.markdown hr { border: none; border-top: 1px solid var(--border); margin: 24px 0; }
.doc.markdown img { max-width: 100%; height: auto; border-radius: 6px; }
.doc.markdown table { border-collapse: collapse; width: 100%; margin: 0 0 16px; font-size: 13.5px; }
.doc.markdown th, .doc.markdown td { border: 1px solid var(--border); padding: 7px 11px; text-align: left; }
.doc.markdown th { background: var(--bg-subtle); font-weight: 600; }

/* Responsive */
@media (max-width: 760px) {
  .browser { flex-direction: column; }
  .viewport { height: 40vh; flex: none; }
  .drag-handle { display: none; }
  .panel { width: 100% !important; flex: 1; border-left: none; border-top: 1px solid var(--border); }
}
</style>
</head>
<body>

<div class="browser">
  <section class="viewport" id="viewport">
    <div class="chrome">
      <div class="winbtns"><i class="wb r"></i><i class="wb y"></i><i class="wb g"></i></div>
      <div class="tab" id="tab"><span id="tab-ico">📄</span><span id="tab-label">wiki/index.md</span></div>
      <div class="urlbar"><span class="lock">🔒</span><span id="urlbar-text">ewtos://vault/wiki/index.md</span></div>
    </div>
    <div class="doc-wrap" id="doc-wrap"><article class="doc markdown" id="doc"></article></div>
    <div class="chat-pane" id="chat-pane" style="display:none">
      <div class="chat-modes" id="chat-modes">
        <button class="chat-mode-btn" data-mode="vault" type="button">Vault</button>
        <button class="chat-mode-btn" data-mode="page" type="button">Seite</button>
        <button class="chat-mode-btn" data-mode="file" type="button">Datei</button>
      </div>
      <div class="chat-source-banner" id="chat-banner"></div>
      <div class="chat-log" id="chat-log"></div>
      <div class="chat-ex" id="chat-ex"></div>
      <form class="composer" id="chat-form">
        <textarea id="msg" rows="2" placeholder="Frag etwas…"></textarea>
        <button id="send-btn" class="btn-p" type="submit">Senden</button>
      </form>
    </div>
  </section>

  <div class="drag-handle" id="drag-handle" role="separator" aria-orientation="vertical" title="Breite ziehen"></div>

  <aside class="panel" id="panel">
    <header class="eb-header">
      <input id="tool-search" class="tool-search" type="search" placeholder="Tool suchen…" autocomplete="off">
      <div class="header-right">
        <span class="status"><span id="status-dot" class="dot online" title="Demo verbunden"></span></span>
        <button id="dark-toggle" class="hbtn" type="button" title="Dark/Light">☀</button>
        <button id="burger-btn" class="hbtn burger" type="button" title="Navigation" aria-expanded="true">☰</button>
      </div>
    </header>
    <div class="workspace">
      <div class="work-main"><main id="content"></main></div>
      <aside id="nav-sidebar" class="nav-sidebar open">
        <div id="nav-main">
          <button class="nav-item active" data-view="home"   title="Übersicht">▦</button>
          <button class="nav-item"        data-view="vault"  title="Vault">📚</button>
          <button class="nav-item"        data-view="web"    title="Web-Tools">🌐</button>
          <button class="nav-item"        data-view="video"  title="Video">🎬</button>
          <button class="nav-item"        data-view="bilder" title="Bilder">🎨</button>
          <button class="nav-item"        data-view="chat"   title="Chat">💬</button>
        </div>
        <div class="nav-sidebar-foot">
          <button id="open-settings" class="nav-item" type="button" title="Einstellungen">⚙</button>
          <button id="reconnect"     class="nav-item" type="button" title="Neu laden">↻</button>
        </div>
      </aside>
    </div>
  </aside>
</div>

<dialog id="settings-dlg">
  <form method="dialog" class="dlg-body">
    <div class="dlg-title">Einstellungen</div>
    <div class="dlg-sec">Erscheinungsbild</div>
    <div class="swatches">
      <button type="button" class="swatch" data-theme="neutral" style="--c:#6b7280" title="Neutral"></button>
      <button type="button" class="swatch" data-theme="ocean"   style="--c:#3b82f6" title="Ocean"></button>
      <button type="button" class="swatch" data-theme="forest"  style="--c:#22c55e" title="Forest"></button>
      <button type="button" class="swatch" data-theme="sunset"  style="--c:#a855f7" title="Sunset"></button>
      <button type="button" class="swatch" data-theme="ember"   style="--c:#f59e0b" title="Ember"></button>
    </div>
    <div class="dlg-sec">KI-Anbieter (BYOK)</div>
    <label class="fld"><span>Anbieter</span>
      <select id="provider">
        <option value="gemini">Google Gemini (kostenloser Tier)</option>
        <option value="openai">OpenAI</option>
        <option value="anthropic">Anthropic Claude</option>
      </select>
    </label>
    <label class="fld"><span>API-Key</span>
      <input id="api-key" type="password" placeholder="Dein API-Key" autocomplete="off">
    </label>
    <label class="fld"><span>Modell</span>
      <input id="model" list="models-dl" autocomplete="off" spellcheck="false">
      <datalist id="models-dl"></datalist>
    </label>
    <div class="dlg-hint" id="key-hint"></div>
    <div class="dlg-actions"><button type="submit" class="btn-p">Fertig</button></div>
  </form>
</dialog>

<dialog id="tool-dlg">
  <div class="dlg-body">
    <div class="dlg-title"><span id="dlg-name">Tool</span></div>
    <p class="dlg-hint">Dieses Tool läuft in der echten Extension mit deinem eigenen Server — deine Daten bleiben bei dir (DSGVO-freundlich, kein Cloud-Lock-in).</p>
    <div class="dlg-actions">
      <a href="https://ewtos.com" target="_blank" rel="noopener" class="btn-p">Installieren →</a>
      <button class="btn-s" type="button" data-close>Schließen</button>
    </div>
  </div>
</dialog>

<dialog id="intro-dlg" class="intro-dlg">
  <div class="dlg-body">
    <div class="intro-eyebrow">Live-Simulation</div>
    <div class="dlg-title">Willkommen bei Ewtos Office-Brain</div>
    <p class="dlg-hint">Das hier ist die App selbst — im Browser nachgestellt. Links die geöffnete Seite, rechts das Sidepanel mit allen Tools. Schau das Erklärvideo, schick es durch dein Brain, oder scrape gleich diese Seite.</p>
    <div class="intro-video-facade" id="intro-video-facade" style="background-image:url()">
      <button class="pp-play" id="intro-play" type="button" aria-label="Video abspielen">&#x25B6;</button>
      <div class="pp-video-cap">Erklärvideo · <span id="intro-dur"></span></div>
    </div>
    <div class="dlg-actions">
      <button class="btn-p" type="button" data-close>Demo starten →</button>
    </div>
  </div>
</dialog>

<script>
const MODELS = {
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"],
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
  anthropic: ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-8"]
};
const HINTS = {
  gemini: 'Noch keinen? <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Kostenlosen Gemini-Key holen →</a>',
  openai: 'Key unter <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com/api-keys</a>',
  anthropic: 'Key unter <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>'
};

let files = [];
let activePath = null;
let pageContext = null;
let pageHost = null;
let currentView = "home";
let chatMode = "vault";
let chatFile = null;
let chatFileContent = "";
const histories = {};

/* ===== Demo-Video (Mockup) — TODO: nach Upload gegen echtes Video tauschen ===== */
/* Nur id/url/title/transcript/description/summary anpassen, Rest folgt automatisch. */
const VIDEO = {
  id: "PLACEHOLDER_ewtos01",
  url: "https://www.youtube.com/watch?v=PLACEHOLDER_ewtos01",
  title: "EwtosBrain — Dein zweites Gehirn im Browser (in 90 Sekunden erklärt)",
  kanal: "Dario | ewtos.com",
  dauer: "1:32",
  aufrufe: 1240,
  likes: 87,
  upload_datum: "2026-07-01",
  thema: "ki-tools",
  slug: "ewtosbrain-zweites-gehirn-im-browser",
  description: "EwtosBrain ist eine Chrome-Extension mit lokalem Server, die dein Wissen in einem Obsidian-Vault sammelt und KI-nutzbar macht — nach der Karpathy-Methode statt RAG. In diesem Video: der Loop von der Rohquelle über den Ingest bis zum Chat mit deinem eigenen Wissen. Dein Server, dein Modell, deine Daten.",
  summary: "EwtosBrain ist eine Chrome-Extension mit lokalem Python-Server, die als täglicher KI-Assistent Wissen in einem Obsidian-Vault aus Markdown-Dateien sammelt. Statt RAG/Vektor-DB nutzt sie die Karpathy-Methode: Die KI liest kuratierte Wiki-Seiten direkt. Kern ist der selbst-fütternde Loop — eine Quelle (z.B. YouTube-Transkript) landet immutable in raw/, wird per Ingest zusammengefasst ins wiki/ überführt und ist danach im Chat durchsuchbar. Prinzip Server = Gehirn, Extension = Gesicht: Owner können Mitarbeiter-Chats übernehmen, Claude Code nutzt dieselben Tools via MCP. Datenhoheit ist zentral — eigener Server, DSGVO-freundlich, frei wählbares LLM.",
  transcript: [
    "[00:00] Was, wenn dein Browser ein Gedächtnis hätte — eins, das dir gehört?",
    "[00:06] Der Arbeitsalltag ist ein Wissens-Chaos. Ein Video hier, ein Artikel da, eine Notiz in einem Tool, das du in zwei Wochen nie wieder öffnest.",
    "[00:16] Alles verstreut, nichts durchsuchbar. Und wenn du es brauchst, fängst du wieder bei Google an.",
    "[00:24] EwtosBrain ist dein zweites Gehirn — direkt im Browser.",
    "[00:29] Eine Chrome-Extension mit einem lokalen Python-Server, der dein Wissen in einem Obsidian-Vault sammelt: einfache Markdown-Dateien, die dir gehören.",
    "[00:39] Statt einer komplizierten Vektor-Datenbank liest die KI dein Wiki einfach direkt, Seite für Seite, wie ein Mensch, der sich durchklickt.",
    "[00:48] Das nennen wir die Karpathy-Methode. Kein Embedding-Zauber, nur sauber kuratiertes Wissen, das die KI wirklich versteht.",
    "[00:57] So funktioniert der Loop. Du findest ein YouTube-Video, zum Beispiel genau dieses hier. Ein Klick, und EwtosBrain zieht das Transkript.",
    "[01:07] Es landet unangetastet in deinem raw-Ordner, der Rohquelle. Dann der Ingest: die KI fasst es zusammen und legt es sauber in dein Wiki ab.",
    "[01:17] Ab jetzt ist es Teil deines Gehirns. Du fragst im Chat: Worum ging es in dem Video? Und bekommst die Antwort aus deinem eigenen Wissen.",
    "[01:27] Quelle rein, Wissen raus. Ein Wiki, das sich selbst füttert.",
    "[01:33] Und weil das Gehirn auf dem Server sitzt und nicht in der Extension, kann dein Chef Mitarbeiter-Chats übernehmen, und Claude Code nutzt dieselben Tools als seine Hände und Füße.",
    "[01:44] Dein Wissen bleibt bei dir, auf deinem Server, DSGVO-freundlich, mit dem KI-Modell deiner Wahl.",
    "[01:51] Probier es direkt hier unten aus: Schick dieses Video durch dein Brain und frag es selbst. Willkommen bei EwtosBrain."
  ].join("\n")
};
const VID_DATUM = "2026-07-01";
const RAW_PATH = "raw/youtube/" + VID_DATUM + "-" + VIDEO.slug + ".md";
const WIKI_PATH = "wiki/resources/videos/" + VIDEO.slug + ".md";
const CREATOR_PATH = "wiki/resources/creators/dario-ewtos.md";
const RAW_REF = "raw/youtube/" + VID_DATUM + "-" + VIDEO.slug;

function thumbUrl(id) { return "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg"; }

const vaultOverride = {};
const extraFiles = [];
let videoFetched = false;
let videoInBrain = false;
let videoIngested = false;

function rawMarkdown() {
  const t = thumbUrl(VIDEO.id);
  return [
    "---",
    "datum: " + VID_DATUM,
    "quelle: " + VIDEO.url,
    "titel: " + VIDEO.title,
    "target_playlist: EwtosBrain Demo",
    "tags: [video, " + VIDEO.thema + "]",
    "typ: video",
    "kanal: " + VIDEO.kanal,
    "dauer: " + VIDEO.dauer,
    "aufrufe: " + VIDEO.aufrufe,
    "likes: " + VIDEO.likes,
    "upload_datum: " + VIDEO.upload_datum,
    "thumbnail_url: " + t,
    "---",
    "",
    "# " + VIDEO.title,
    "",
    "![Thumbnail](" + t + ")",
    "",
    "## Beschreibung",
    "",
    VIDEO.description,
    "",
    "## Transkript",
    "",
    VIDEO.transcript
  ].join("\n");
}

function wikiMarkdown() {
  const t = thumbUrl(VIDEO.id);
  return [
    "---",
    "typ: video",
    "titel: " + VIDEO.title,
    "status: aktiv",
    "quelle_url: " + VIDEO.url,
    "video_id: " + VIDEO.id,
    "thumbnail_url: " + t,
    "kanal: " + VIDEO.kanal,
    "upload_datum: " + VIDEO.upload_datum,
    "dauer: " + VIDEO.dauer,
    "aufrufe: " + VIDEO.aufrufe,
    "likes: " + VIDEO.likes,
    "thema: " + VIDEO.thema,
    "tags: [video]",
    "transcript: " + RAW_REF,
    "playlists: [ewtosbrain-demo]",
    "zuletzt: " + VID_DATUM,
    "---",
    "",
    "# " + VIDEO.title,
    "",
    "![Thumbnail](" + t + ")",
    "",
    "- **Kanal:** " + VIDEO.kanal + " · **Upload:** " + VIDEO.upload_datum + " · **Dauer:** " + VIDEO.dauer,
    "- **Aufrufe:** " + VIDEO.aufrufe + " · **Likes:** " + VIDEO.likes,
    "- **Quelle:** " + VIDEO.url,
    "",
    "## Beschreibung",
    VIDEO.description,
    "",
    "## Zusammenfassung",
    VIDEO.summary,
    "",
    "## Transkript",
    "[[" + RAW_REF + "]]"
  ].join("\n");
}

function creatorMarkdown() {
  return [
    "---",
    "typ: creator",
    "titel: " + VIDEO.kanal,
    "name: " + VIDEO.kanal,
    "kanal_url: https://www.youtube.com/@ewtos",
    "plattform: youtube",
    "tags: [creator]",
    "zuletzt: " + VID_DATUM,
    "---",
    "",
    "# " + VIDEO.kanal,
    "",
    "## Profil",
    "Dario von ewtos.com — Webentwickler in einer Werbeagentur, baut KI-Lösungen, WordPress-Plugins und Automationen. Kanal rund um EwtosBrain und das Konzept Zweites Gehirn.",
    "",
    "## Videos",
    "- [[wiki/resources/videos/" + VIDEO.slug + "]]"
  ].join("\n");
}

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(u) {
  const t = String(u || "").trim();
  if (t === "#" || /^https?:\/\//i.test(t)) return t;
  return null;
}

function renderInline(text) {
  let s = text;
  const codeStash = [];
  s = s.replace(/`([^`]+)`/g, (m, c) => {
    codeStash.push("<code>" + c + "</code>");
    return "\u0000" + (codeStash.length - 1) + "\u0000";
  });
  s = s.replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, (m, alt, url) => {
    return '<img class="md-image" src="' + escapeHtml(url) + '" alt="' + escapeHtml(alt) + '" loading="lazy">';
  });
  s = s.replace(/!\[\[([^\]]+?)\]\]/g, (m, rel) => {
    const r = rel.trim();
    return '<img class="md-image" data-vault-src="' + escapeHtml(r) + '" alt="' + escapeHtml(r) + '" loading="lazy">';
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, rel) => {
    return '<img class="md-image" data-vault-src="' + escapeHtml(rel.trim()) + '" alt="' + escapeHtml(alt) + '" loading="lazy">';
  });
  s = s.replace(/\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|([^\]]+))?\]\]/g, (m, path, alias) => {
    const display = (alias || path).trim();
    return '<a href="#" class="wiki-link" data-rel="' + escapeHtml(path.trim()) + '">' + escapeHtml(display) + "</a>";
  });
  s = s.replace(/\[([^\]]+)\]\((?!https?:\/\/)([^)#\s]+\.md)(?:#[^)]*)?\)/g, (m, txt, path) => {
    return '<a href="#" class="wiki-link" data-rel="' + escapeHtml(path) + '">' + txt + "</a>";
  });
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, txt, url) => {
    const u = safeUrl(url);
    if (!u) return txt;
    if (u === "#") return '<a href="#">' + txt + "</a>";
    return '<a href="' + u + '" class="ext-link" target="_blank" rel="noopener">' + txt + "</a>";
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?=[^_\w]|$)/g, "$1<em>$2</em>");
  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => codeStash[+i]);
  return s;
}

function renderMD(md) {
  let raw = md == null ? "" : String(md);
  let fmHtml = "";
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    const rows = fm[1].trim().split(/\r?\n/).map((line) => {
      const mm = line.match(/^([\w][\w-]*):\s*(.*)$/);
      if (!mm) return "";
      return "<tr><th>" + escapeHtml(mm[1]) + "</th><td>" + renderInline(escapeHtml(mm[2].trim())) + "</td></tr>";
    }).filter(Boolean);
    if (rows.length) {
      fmHtml = '<details class="fm-block" open><summary>Metadaten</summary><table class="fm-table"><tbody>' + rows.join("") + "</tbody></table></details>";
    }
    raw = raw.slice(fm[0].length);
  }
  const escaped = escapeHtml(raw);
  const lines = escaped.split(/\r?\n/);
  const out = [];
  if (fmHtml) out.push(fmHtml);
  let i = 0;
  let para = [];

  function flushPara() {
    if (!para.length) return;
    out.push("<p>" + para.map(renderInline).join("<br>") + "</p>");
    para = [];
  }

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      flushPara();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      out.push("<pre><code>" + buf.join("\n") + "</code></pre>");
      continue;
    }

    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      flushPara();
      out.push("<hr>");
      i++;
      continue;
    }

    const h = line.match(/^\s*(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara();
      const lvl = h[1].length;
      out.push("<h" + lvl + ">" + renderInline(h[2].trim()) + "</h" + lvl + ">");
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push("<blockquote>" + buf.map(renderInline).join("<br>") + "</blockquote>");
      continue;
    }

    if (/^\s*([-*])\s+/.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^\s*([-*])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      out.push("<ul>" + items.map((it) => "<li>" + renderInline(it) + "</li>").join("") + "</ul>");
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push("<ol>" + items.map((it) => "<li>" + renderInline(it) + "</li>").join("") + "</ol>");
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushPara();
      i++;
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flushPara();
  return out.join("\n");
}

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/\s+/g, "-");
}

function resolveVaultPath(rel) {
  let r = String(rel || "").trim();
  if (!r) return null;
  if (!/\.(md|txt)$/i.test(r)) r = r + ".md";
  if (files.indexOf(r) !== -1) return r;
  const base = r.slice(r.lastIndexOf("/") + 1);
  const hit = files.find((f) => f === base || f.endsWith("/" + base));
  if (hit) return hit;
  const wikiTry = "wiki/" + r;
  if (files.indexOf(wikiTry) !== -1) return wikiTry;
  return null;
}

function wireDocLinks(root) {
  const doc = root || $("#doc");
  if (!doc) return;
  $$("a.wiki-link", doc).forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const target = resolveVaultPath(a.dataset.rel);
      if (target) openFile(target);
    });
  });
  $$("img.md-image", doc).forEach((img) => {
    if (!img.getAttribute("src")) {
      const rel = img.getAttribute("data-vault-src") || "";
      img.replaceWith(document.createTextNode("[" + rel + "]"));
      return;
    }
    img.addEventListener("error", () => {
      const span = document.createElement("span");
      span.className = "md-img-broken";
      span.textContent = "[Bild: " + (img.getAttribute("alt") || "") + "]";
      img.replaceWith(span);
    });
  });
}

function openInViewport(label, url, md, filePath) {
  const tl = $("#tab-label");
  const ub = $("#urlbar-text");
  const doc = $("#doc");
  const ic = $("#tab-ico");
  if (ic) ic.textContent = "📄";
  if (tl) tl.textContent = label;
  if (ub) ub.textContent = url;
  if (doc) {
    let html = renderMD(md);
    if (filePath) {
      html += '<div class="viewer-actions">' +
        '<button class="vault-file-chat-btn" id="file-chat-btn" type="button">💬 Mit dieser Datei chatten</button>' +
        "</div>";
    }
    doc.innerHTML = html;
    wireDocLinks(doc);
    const fcb = $("#file-chat-btn", doc);
    if (fcb) fcb.addEventListener("click", () => openChatTab("file", filePath, md));
  }
  pitchActive = false;
  showDoc();
}

const PITCH_URL = "https://ewtos.com";
let pitchActive = false;

function pitchHtml() {
  return '<div class="pitch-page">' +
    '<div class="pp-hero">' +
      '<div class="pp-eyebrow">Chrome-Extension + lokaler Server</div>' +
      '<h1 class="pp-title">Dein zweites Gehirn &mdash; direkt im Browser.</h1>' +
      '<p class="pp-sub">EwtosBrain sammelt dein Wissen in einem Obsidian-Vault und macht es KI-nutzbar &mdash; nach der Karpathy-Methode statt RAG. Dein Server, dein Modell, deine Daten.</p>' +
      '<div class="pp-cta">' +
        '<button class="btn-p" data-cta="video" type="button">&#x25B6; Video durchs Brain schicken</button>' +
        '<button class="btn-s" data-cta="vault" type="button">Vault erkunden</button>' +
      '</div>' +
    '</div>' +
    '<div class="pp-video">' +
      '<div class="pp-video-facade" id="pp-video-facade" style="background-image:url(' + thumbUrl(VIDEO.id) + ')">' +
        '<button class="pp-play" id="pp-play" type="button" aria-label="Video abspielen">&#x25B6;</button>' +
        '<div class="pp-video-cap">' + escapeHtml(VIDEO.title) + ' &middot; ' + VIDEO.dauer + '</div>' +
      '</div>' +
    '</div>' +
    '<h2 class="pp-h2">So funktioniert der Loop</h2>' +
    '<div class="pp-loop">' +
      '<div class="pp-step"><div class="pp-step-ico">🎬</div><b>Quelle rein</b><span>YouTube, Webseite &hellip; landet immutable in <code>raw/</code></span></div>' +
      '<div class="pp-arrow">&rarr;</div>' +
      '<div class="pp-step"><div class="pp-step-ico">🧠</div><b>Ingest</b><span>KI fasst zusammen, kuratiert ins <code>wiki/</code></span></div>' +
      '<div class="pp-arrow">&rarr;</div>' +
      '<div class="pp-step"><div class="pp-step-ico">💬</div><b>Chat</b><span>Frag dein eigenes Wissen</span></div>' +
    '</div>' +
    '<h2 class="pp-h2">Warum EwtosBrain</h2>' +
    '<div class="pp-features">' +
      '<div class="pp-feat"><b>🔒 Datenhoheit</b><span>Läuft auf deinem Server. DSGVO-freundlich, kein Cloud-Lock-in.</span></div>' +
      '<div class="pp-feat"><b>🧩 Karpathy statt RAG</b><span>Die KI liest dein Wiki direkt &mdash; keine Vektor-DB, kein Embedding-Aufwand.</span></div>' +
      '<div class="pp-feat"><b>🖐 Server = Gehirn</b><span>Owner übernehmen Mitarbeiter-Chats, Claude Code nutzt dieselben Tools via MCP.</span></div>' +
      '<div class="pp-feat"><b>🔁 Multi-LLM &middot; BYOK</b><span>Anthropic, OpenAI, Gemini oder Ollama lokal &mdash; dein Modell.</span></div>' +
    '</div>' +
    '<div class="pp-foot">' +
      '<button class="btn-p" data-cta="video" type="button">Jetzt den Loop ausprobieren &rarr;</button>' +
      '<div class="pp-foot-note">Tipp: Rechts im Sidepanel sind alle Tools. Du kannst sogar <b>diese Seite scrapen</b>.</div>' +
    '</div>' +
  '</div>';
}

function renderPitch() {
  const tl = $("#tab-label");
  const ub = $("#urlbar-text");
  const ic = $("#tab-ico");
  const doc = $("#doc");
  if (ic) ic.textContent = "🧠";
  if (tl) tl.textContent = "Ewtos Office-Brain";
  if (ub) ub.textContent = PITCH_URL;
  if (doc) doc.innerHTML = pitchHtml();
  pitchActive = true;
  activePath = null;
  showDoc();

  const play = $("#pp-play");
  const facade = $("#pp-video-facade");
  if (play && facade) {
    play.addEventListener("click", () => {
      if (VIDEO.id.indexOf("PLACEHOLDER") === 0) {
        facade.innerHTML = '<div class="pp-video-placeholder">Dein Erklärvideo kommt hier rein.<br><span>Platzhalter &mdash; Video-ID nach Upload eintragen.</span></div>';
        return;
      }
      facade.innerHTML = '<iframe class="pp-iframe" src="https://www.youtube.com/embed/' + VIDEO.id + '?autoplay=1" title="EwtosBrain" frameborder="0" allow="autoplay; encrypted-media" allowfullscreen></iframe>';
    });
  }
  $$("[data-cta]", doc).forEach((b) => {
    b.addEventListener("click", () => setView(b.dataset.cta));
  });
}

function pitchMarkdown() {
  return [
    "# Dein zweites Gehirn — direkt im Browser",
    "",
    VIDEO.description,
    "",
    "## So funktioniert der Loop",
    "- **Quelle rein:** YouTube, Webseite … landet immutable in raw/",
    "- **Ingest:** Die KI fasst zusammen und kuratiert ins wiki/",
    "- **Chat:** Frag dein eigenes Wissen",
    "",
    "## Warum EwtosBrain",
    "- **Datenhoheit:** Läuft auf deinem Server. DSGVO-freundlich, kein Cloud-Lock-in.",
    "- **Karpathy statt RAG:** Die KI liest dein Wiki direkt — keine Vektor-DB.",
    "- **Server = Gehirn:** Owner übernehmen Mitarbeiter-Chats, Claude Code nutzt dieselben Tools via MCP.",
    "- **Multi-LLM · BYOK:** Anthropic, OpenAI, Gemini oder Ollama lokal.",
    "",
    "Erklärvideo: " + VIDEO.title + " (" + VIDEO.dauer + ")"
  ].join("\n");
}

const VIEWS = {
  home: `<div class="view view-home">
  <div class="tools-head" style="padding-bottom:6px">
    Ewtos Office-Brain
    <span class="view-sub"> &mdash; Vault &middot; Browser-Tools &middot; Chat &middot; BYOK</span>
  </div>
  <div class="pitch">
    <div class="pitch-head">&#x1F9E0; Dein zweites Gehirn &mdash; direkt im Browser.</div>
    Vault-Wissen, Web-Tools und Chat an einem Ort. Der Server ist dein Gehirn: dein Wissen
    bleibt auf deiner Maschine &mdash; DSGVO-freundlich, kein Cloud-Lock-in.
  </div>
  <div class="tools-head">Werkzeuge</div>
  <div class="tgroup"><div class="tgroup-label">Vault</div><div class="tiles">
    <button class="tile" data-open="vault">📚<span>Explorer</span></button>
    <button class="tile" data-open="crm">🤝<span>CRM</span></button>
    <button class="tile" data-open="todos">✅<span>Todos</span></button>
    <button class="tile locked" data-lock="Dokument-Ingest">📥<span>Ingest</span></button>
    <button class="tile locked" data-lock="Vault Health">🩺<span>Health</span></button>
    <button class="tile locked" data-lock="Notizen">📝<span>Notizen</span></button>
  </div></div>
  <div class="tgroup"><div class="tgroup-label">Web</div><div class="tiles">
    <button class="tile" data-open="web">📄<span>Scrape</span></button>
    <button class="tile locked" data-lock="SEO Check">🔍<span>SEO</span></button>
    <button class="tile locked" data-lock="URL Extractor">🔗<span>URLs</span></button>
    <button class="tile locked" data-lock="Bookmarks">🔖<span>Bookmarks</span></button>
  </div></div>
  <div class="tgroup"><div class="tgroup-label">Video</div><div class="tiles">
    <button class="tile" data-open="video">🎬<span>YouTube</span></button>
    <button class="tile" data-open="playlists">🎵<span>Playlists</span></button>
  </div></div>
  <div class="tgroup"><div class="tgroup-label">Bilder</div><div class="tiles">
    <button class="tile locked" data-lock="Image Analyse">🖼️<span>Analyse</span></button>
    <button class="tile locked" data-lock="Image Generator">🪄<span>Generator</span></button>
    <button class="tile" data-open="colorpicker">🎨<span>Picker</span></button>
    <button class="tile locked" data-lock="Screenshot">📸<span>Screenshot</span></button>
  </div></div>
</div>`,
  vault: `<div class="view">
  <div class="view-head">
    📚 Vault Explorer
    <button class="tour-trigger" id="vault-tour" type="button">&#x2139; So funktioniert's</button>
  </div>
  <div class="view-sub" style="margin:-4px 0 8px">Datei klicken &mdash; öffnet links im Viewport.</div>
  <ul class="filelist" id="filelist"></ul>
  <button class="btn-p" id="vault-chat-btn" type="button" style="margin:6px 0 10px">💬 Mit Vault chatten</button>
  <div class="tags">
    <span class="tag">read-only Demo</span>
    <span class="tag">dein Server</span>
    <span class="tag">DSGVO</span>
    <span class="tag">kein Cloud-Lock-in</span>
  </div>
</div>`,
  web: `<div class="view">
  <div class="pitch">
    <div class="pitch-head">&#x26A1; URL &#x2192; sauberes Markdown. Sofort.</div>
    Jede Webseite in KI-lesbares Markdown &mdash; direkt zum Chatten bereit.
  </div>
  <div class="scrape-row">
    <input id="scrape-url" type="url" placeholder="https://example.com" autocomplete="off">
    <button id="scrape-go" class="btn-p">Scrapen</button>
  </div>
  <div class="scrape-status" id="scrape-status"></div>
  <div class="scrape-chat-wrap" id="scrape-chat-wrap" style="margin-top:8px"></div>
  <div class="scraper-hint">
    <strong>Echte App:</strong> 2 Scraper (DOM + Playwright) &middot; Demo: leichter Fetch
    <button class="tour-trigger" id="web-tour" type="button">&#x2139; Details</button>
  </div>
</div>`,
  crm: `<div class="view">
  <div class="view-head">
    <button class="back-btn" data-home type="button">&larr; Übersicht</button>
    🤝 CRM <span class="view-sub">&mdash; Kunden-Cockpit (Demo)</span>
  </div>
  <div class="view-sub" style="margin:-4px 0 10px">4 Beispiel-Kunden. In der echten App liegt jeder als Markdown im Vault.</div>
  <div class="crm-list" id="crm-list"></div>
  <div class="view-note">Echte App: Kunden leben unter <code>kontext/kunden/</code> &mdash; editierbar, versioniert, DSGVO-konform auf deinem Server. Der Chat-Agent kann sie lesen und pflegen.</div>
</div>`,
  todos: `<div class="view">
  <div class="view-head">
    <button class="back-btn" data-home type="button">&larr; Übersicht</button>
    ✅ Todos <span class="view-sub">&mdash; Demo, lokal</span>
  </div>
  <div class="todo-add">
    <input id="todo-input" type="text" placeholder="Neues Todo…" autocomplete="off">
    <button id="todo-add-btn" class="btn-p" type="button">Hinzufügen</button>
  </div>
  <ul class="todo-list" id="todo-list"></ul>
  <div class="view-note">Echte App: Todos leben in <code>notes/todos.md</code> im Vault &mdash; der Chat-Agent hakt sie ab (<code>list_todos</code>, <code>add_todo</code>, <code>update_todo</code>).</div>
</div>`,
  colorpicker: `<div class="view">
  <div class="view-head">
    <button class="back-btn" data-home type="button">&larr; Übersicht</button>
    🎨 Color Picker <span class="view-sub">&mdash; Demo</span>
  </div>
  <div class="pitch">
    <div class="pitch-head">&#x1F58D; Farbpipette</div>
    Nimm jede Farbe vom Bildschirm auf &mdash; Hex &amp; RGB, ein Klick zum Kopieren.
  </div>
  <button id="cp-pick" class="btn-p" type="button" style="margin:2px 0 12px">Farbe aufnehmen</button>
  <div class="cp-result" id="cp-result"></div>
  <div class="cp-recent-wrap" id="cp-recent-wrap" style="display:none">
    <div class="tgroup-label">Zuletzt</div>
    <div class="cp-recent" id="cp-recent"></div>
  </div>
  <div class="view-note">Nutzt die native EyeDropper-API deines Browsers. Echte App: pickt auch gezielt aus DOM-Elementen und exportiert ganze Paletten.</div>
</div>`,
  video: `<div class="view">
  <div class="view-head">
    <button class="back-btn" data-home type="button">&larr; Übersicht</button>
    🎬 YouTube <span class="view-sub">&mdash; Transkript &rarr; Brain (Demo)</span>
  </div>
  <div class="view-sub" style="margin:-4px 0 10px">Schick das Erklärvideo durch den kompletten Loop: holen &rarr; ins Brain &rarr; Playlist &rarr; Ingest &rarr; Chat.</div>
  <div class="yt-url-row">
    <input id="yt-url" type="url" autocomplete="off" spellcheck="false">
    <button id="yt-fetch" class="btn-p" type="button">Transkript holen</button>
  </div>
  <div class="scrape-status" id="yt-status"></div>
  <div class="yt-meta-card hidden" id="yt-meta"></div>
  <div class="scrape-preview-wrap hidden" id="yt-preview">
    <button class="scrape-preview-toggle" id="yt-preview-toggle" type="button">&#x25B8; Transkript anzeigen</button>
    <textarea id="yt-transcript" readonly></textarea>
  </div>
  <div class="yt-actions" id="yt-actions"></div>
  <div class="view-note">Demo: kein echter Scrape &mdash; die Daten sind vorbereitet. Echte App: DOM-Scraper + Server-Fallback holen Transkript &amp; Metadaten live und speichern in <code>raw/youtube/</code>.</div>
</div>`,
  playlists: `<div class="view">
  <div class="view-head">
    <button class="back-btn" data-home type="button">&larr; Übersicht</button>
    🎵 Playlists <span class="view-sub">&mdash; Demo</span>
  </div>
  <div class="playlist-group-header" id="pl-header">EwtosBrain Demo</div>
  <div id="playlist-detail"></div>
  <div class="view-note">Echte App: Playlists gruppieren Videos nach <code>thema</code> unter <code>wiki/resources/playlists/</code>.</div>
</div>`
};

function lockedView(ico, title) {
  return `<div class="view view-locked">
  <div class="locked-card">
    <div class="locked-ico">${ico}</div>
    <div class="locked-title">${title}</div>
    <p>Diese Werkzeuge laufen in der echten Extension mit eigenem Server.</p>
    <a href="https://ewtos.com" target="_blank" rel="noopener" class="btn-p">Installieren →</a>
  </div>
</div>`;
}

const TOURS = {
  vault: [
    { target: "#filelist", title: "Dein Vault", body: "In der echten App liegen hier deine Ordner: kontext/ (wer du bist), raw/ (Quellen, immutable), wiki/ (LLM-kuratiert), PARA-Buckets." },
    { target: "#filelist", title: "Karpathy statt RAG", body: "Die KI liest die Wiki-Seiten direkt wie ein Mensch im Wiki — keine Vektor-DB, kein Embedding-Aufwand." },
    { target: "#doc", title: "Direkt editierbar", body: "Echte App: Datei links im Viewport öffnen, tippen, Strg+S — der Vault wird sofort aktualisiert. Diese Demo ist read-only." },
    { target: "#vault-chat-btn", title: "Direkt fragen", body: "Öffnet den Chat links im Tab — frag dein ganzes Vault-Wissen. Oder öffne eine Datei und klick dort 'Mit dieser Datei chatten'. BYOK, dein Key, dein Server." }
  ],
  web: [
    { target: "#scrape-url", title: "URL → Markdown", body: "Jede Webseite in Sekunden in sauberes, KI-lesbares Markdown verwandeln." },
    { target: ".scraper-hint", title: "Zwei Scraper", body: "Echte App: DOM-Scraper (liest den Tab, blitzschnell, auch hinter Login) + Playwright (headless Chrome, rendert JS voll, klickt FAQ/Accordeons auf). Diese Demo nutzt nur einen leichten Server-Fetch." },
    { target: "#scrape-url", title: "Über die Seite fragen", body: "Nach dem Scrapen erscheint 'Mit dieser Seite chatten' — der Chat öffnet links im Tab mit dem Seiteninhalt als Kontext." }
  ]
};

let tourState = null;

function endTour() {
  if (!tourState) return;
  if (tourState.focusEl) tourState.focusEl.classList.remove("tour-focus");
  if (tourState.card) tourState.card.remove();
  if (tourState.backdrop) tourState.backdrop.remove();
  document.removeEventListener("keydown", tourState.onKey);
  window.removeEventListener("resize", tourState.onResize);
  tourState = null;
}

function startTour(view) {
  endTour();
  const steps = TOURS[view];
  if (!steps || !steps.length) return;
  const backdrop = document.createElement("div");
  backdrop.className = "tour-backdrop";
  backdrop.addEventListener("click", endTour);
  const card = document.createElement("div");
  card.className = "tour-card";
  document.body.appendChild(backdrop);
  document.body.appendChild(card);
  const onKey = (e) => { if (e.key === "Escape") endTour(); };
  const onResize = () => positionTourCard();
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onResize);
  tourState = { steps, i: 0, backdrop, card, focusEl: null, onKey, onResize };
  renderTourStep();
}

function renderTourStep() {
  if (!tourState) return;
  const { steps, i, card } = tourState;
  const step = steps[i];
  if (tourState.focusEl) {
    tourState.focusEl.classList.remove("tour-focus");
    tourState.focusEl = null;
  }
  const target = step.target ? $(step.target) : null;
  if (target) {
    target.classList.add("tour-focus");
    tourState.focusEl = target;
  }
  const first = i === 0;
  const last = i === steps.length - 1;
  card.innerHTML =
    '<span class="tour-arrow"></span>' +
    '<div class="tour-counter">Tipp ' + (i + 1) + " / " + steps.length + "</div>" +
    '<div class="tour-title">' + escapeHtml(step.title) + "</div>" +
    '<div class="tour-body">' + escapeHtml(step.body) + "</div>" +
    '<div class="tour-nav">' +
      (first ? "" : '<button class="tour-btn" data-prev type="button">Zurück</button>') +
      '<span class="sp"></span>' +
      '<button class="tour-btn primary" data-next type="button">' + (last ? "Fertig" : "Weiter") + "</button>" +
      '<button class="tour-close" data-close type="button" title="Schließen">×</button>' +
    "</div>";
  const nextBtn = card.querySelector("[data-next]");
  if (nextBtn) nextBtn.addEventListener("click", () => {
    if (last) endTour();
    else { tourState.i++; renderTourStep(); }
  });
  const prevBtn = card.querySelector("[data-prev]");
  if (prevBtn) prevBtn.addEventListener("click", () => { tourState.i--; renderTourStep(); });
  const closeBtn = card.querySelector("[data-close]");
  if (closeBtn) closeBtn.addEventListener("click", endTour);
  positionTourCard();
}

function positionTourCard() {
  if (!tourState) return;
  const { card, focusEl } = tourState;
  const arrow = card.querySelector(".tour-arrow");
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const M = 10;
  card.classList.remove("above", "below");
  if (!focusEl) {
    card.style.left = Math.round((vw - cw) / 2) + "px";
    card.style.top = Math.round((vh - ch) / 2) + "px";
    if (arrow) arrow.style.display = "none";
    return;
  }
  if (arrow) arrow.style.display = "";
  const r = focusEl.getBoundingClientRect();
  let top;
  let below = true;
  if (r.bottom + 16 + ch + M <= vh) { top = r.bottom + 16; below = true; }
  else if (r.top - 16 - ch - M >= 0) { top = r.top - 16 - ch; below = false; }
  else { top = Math.max(M, Math.min(vh - ch - M, r.bottom + 16)); below = r.top < vh / 2; }
  card.classList.add(below ? "below" : "above");
  let left = r.left + r.width / 2 - cw / 2;
  left = Math.max(M, Math.min(vw - cw - M, left));
  card.style.left = Math.round(left) + "px";
  card.style.top = Math.round(top) + "px";
  if (arrow) {
    let ax = r.left + r.width / 2 - left;
    ax = Math.max(14, Math.min(cw - 14, ax));
    arrow.style.left = Math.round(ax - 8) + "px";
  }
}

function setView(name) {
  if (name === "chat") { openChatTab("vault"); return; }
  const content = $("#content");
  if (!content) return;
  endTour();
  currentView = name;
  if (name === "bilder") content.innerHTML = lockedView("🎨", "Bilder-Tools");
  else content.innerHTML = VIEWS[name] || VIEWS.home;

  $$(".nav-item[data-view]").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === name);
  });
  $$("[data-home]").forEach((b) => b.addEventListener("click", () => setView("home")));

  if (name === "home") {
    wireHome();
    const ts = $("#tool-search");
    if (ts && ts.value.trim()) filterTiles(ts.value);
  } else if (name === "crm") wireCrm();
  else if (name === "todos") wireTodos();
  else if (name === "colorpicker") wireColorPicker();
  else if (name === "video") wireVideo();
  else if (name === "playlists") wirePlaylists();
  else if (name === "vault") {
    loadFiles().then(() => {
      $$("#filelist .f-item").forEach((el) => {
        el.addEventListener("click", () => openFile(el.dataset.path));
      });
    });
    const tt = $("#vault-tour");
    if (tt) tt.addEventListener("click", () => startTour("vault"));
    const vcb = $("#vault-chat-btn");
    if (vcb) vcb.addEventListener("click", () => openChatTab("vault"));
  } else if (name === "web") wireWeb();
}

function wireHome() {
  $$(".tile[data-open]").forEach((t) => {
    t.addEventListener("click", () => setView(t.dataset.open));
  });
  $$(".tile.locked[data-lock]").forEach((t) => {
    t.addEventListener("click", () => openToolDlg(t.dataset.lock));
  });
}

function filterTiles(q) {
  const query = (q || "").trim().toLowerCase();
  $$(".tgroup").forEach((g) => {
    let anyVisible = false;
    $$(".tile", g).forEach((t) => {
      const label = (t.textContent || "") + " " + (t.dataset.open || "") + " " + (t.dataset.lock || "");
      const hit = !query || label.toLowerCase().indexOf(query) !== -1;
      t.classList.toggle("hidden", !hit);
      if (hit) anyVisible = true;
    });
    g.classList.toggle("hidden", !anyVisible);
  });
}

function initToolSearch() {
  const inp = $("#tool-search");
  if (!inp) return;
  inp.addEventListener("input", () => {
    const q = inp.value;
    if (q.trim() && currentView !== "home") setView("home");
    filterTiles(q);
  });
}

const CRM = [
  { name: "Bäckerei Sonnenschein", firma: "Sonnenschein GmbH", projekt: "Website-Relaunch", status: "aktiv", kontakt: "vor 3 Tagen", tags: ["WordPress", "Elementor"] },
  { name: "Zahnarztpraxis Dr. Meier", firma: "Praxis am Markt", projekt: "SEO & Local", status: "lead", kontakt: "vor 1 Woche", tags: ["SEO", "Google Business"] },
  { name: "Autohaus Brandt", firma: "Brandt & Söhne KG", projekt: "Elementor-Wartung", status: "aktiv", kontakt: "gestern", tags: ["Wartung", "Hosting"] },
  { name: "Café Central", firma: "Central Gastro UG", projekt: "Social Media", status: "angebot", kontakt: "vor 2 Wochen", tags: ["Instagram", "Content"] }
];
const CRM_STATUS = { aktiv: "Aktiv", lead: "Lead", angebot: "Angebot raus", pausiert: "Pausiert" };

function crmInitials(name) {
  const parts = name.replace(/^(Dr\.|Café|Bäckerei|Autohaus|Zahnarztpraxis)\s+/i, "").split(/\s+/).filter(Boolean);
  const a = (parts[0] || name)[0] || "?";
  const b = (parts[1] || "")[0] || "";
  return (a + b).toUpperCase();
}

function wireCrm() {
  const wrap = $("#crm-list");
  if (!wrap) return;
  wrap.innerHTML = CRM.map((c) => {
    const tags = c.tags.map((t) => '<span class="tag">' + escapeHtml(t) + "</span>").join("");
    return '<div class="crm-card">' +
      '<div class="crm-avatar">' + escapeHtml(crmInitials(c.name)) + "</div>" +
      '<div class="crm-body">' +
        '<div class="crm-name">' + escapeHtml(c.name) +
          ' <span class="crm-status ' + c.status + '">' + escapeHtml(CRM_STATUS[c.status] || c.status) + "</span></div>" +
        '<div class="crm-meta">' + escapeHtml(c.firma) + " &middot; " + escapeHtml(c.projekt) + "</div>" +
        '<div class="crm-tags">' + tags + "</div>" +
      "</div>" +
      '<div class="crm-kontakt">' + escapeHtml(c.kontakt) + "</div>" +
    "</div>";
  }).join("");
}

let todos = [
  { text: "Angebot Café Central nachfassen", done: false },
  { text: "Elementor-Update Autohaus Brandt testen", done: false },
  { text: "SEO-Audit Zahnarztpraxis Meier", done: true },
  { text: "Newsletter-Template finalisieren", done: false }
];

function renderTodos() {
  const ul = $("#todo-list");
  if (!ul) return;
  if (!todos.length) {
    ul.innerHTML = '<li class="todo-empty">Keine Todos &mdash; leg oben eins an.</li>';
    return;
  }
  ul.innerHTML = todos.map((t, i) => {
    return '<li class="todo-item' + (t.done ? " done" : "") + '" data-i="' + i + '">' +
      '<button class="todo-check" data-toggle="' + i + '" type="button" aria-label="Umschalten">' + (t.done ? "☑" : "☐") + "</button>" +
      '<span class="todo-text">' + escapeHtml(t.text) + "</span>" +
      '<button class="todo-del" data-del="' + i + '" type="button" aria-label="Löschen">×</button>' +
    "</li>";
  }).join("");
  $$("#todo-list [data-toggle]").forEach((b) => {
    b.addEventListener("click", () => {
      const i = +b.dataset.toggle;
      todos[i].done = !todos[i].done;
      renderTodos();
    });
  });
  $$("#todo-list [data-del]").forEach((b) => {
    b.addEventListener("click", () => {
      todos.splice(+b.dataset.del, 1);
      renderTodos();
    });
  });
}

function addTodo() {
  const inp = $("#todo-input");
  if (!inp) return;
  const text = inp.value.trim();
  if (!text) return;
  todos.push({ text, done: false });
  inp.value = "";
  renderTodos();
}

function wireTodos() {
  const btn = $("#todo-add-btn");
  const inp = $("#todo-input");
  if (btn) btn.addEventListener("click", addTodo);
  if (inp) inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addTodo(); }
  });
  renderTodos();
}

const cpRecent = [];

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "";
  const n = parseInt(m[1], 16);
  return "rgb(" + ((n >> 16) & 255) + ", " + ((n >> 8) & 255) + ", " + (n & 255) + ")";
}

function cpCopy(hex, statusEl) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(hex).then(() => {
      if (statusEl) { statusEl.textContent = "Kopiert: " + hex; }
    }).catch(() => {});
  }
}

function showColor(hex) {
  const res = $("#cp-result");
  if (!res) return;
  const rgb = hexToRgb(hex);
  res.innerHTML =
    '<div class="cp-swatch" style="background:' + escapeHtml(hex) + '"></div>' +
    '<div class="cp-info">' +
      '<button class="cp-val" data-copy="' + escapeHtml(hex) + '" type="button">' + escapeHtml(hex) + "</button>" +
      '<button class="cp-val" data-copy="' + escapeHtml(rgb) + '" type="button">' + escapeHtml(rgb) + "</button>" +
      '<div class="cp-status" id="cp-status">Klick auf einen Wert zum Kopieren</div>' +
    "</div>";
  $$("#cp-result [data-copy]").forEach((b) => {
    b.addEventListener("click", () => cpCopy(b.dataset.copy, $("#cp-status")));
  });
  if (cpRecent.indexOf(hex) === -1) {
    cpRecent.unshift(hex);
    while (cpRecent.length > 8) cpRecent.pop();
  }
  renderCpRecent();
}

function renderCpRecent() {
  const wrap = $("#cp-recent-wrap");
  const box = $("#cp-recent");
  if (!wrap || !box) return;
  if (!cpRecent.length) { wrap.style.display = "none"; return; }
  wrap.style.display = "";
  box.innerHTML = cpRecent.map((h) =>
    '<button class="cp-chip" data-copy="' + escapeHtml(h) + '" title="' + escapeHtml(h) + '" type="button" style="background:' + escapeHtml(h) + '"></button>'
  ).join("");
  $$("#cp-recent [data-copy]").forEach((b) => {
    b.addEventListener("click", () => cpCopy(b.dataset.copy, $("#cp-status")));
  });
}

async function wireColorPicker() {
  const btn = $("#cp-pick");
  const res = $("#cp-result");
  if (!btn) return;
  if (!window.EyeDropper) {
    btn.disabled = true;
    if (res) res.innerHTML = '<div class="cp-status">Dein Browser unterstützt die EyeDropper-API nicht (Chrome/Edge ab v95). In der echten Extension gibt es einen DOM-basierten Fallback.</div>';
    renderCpRecent();
    return;
  }
  btn.addEventListener("click", async () => {
    try {
      const r = await new window.EyeDropper().open();
      if (r && r.sRGBHex) showColor(r.sRGBHex);
    } catch (e) {}
  });
  renderCpRecent();
}

/* ===== Simulierter Video-Loop ===== */

function ytStatus(text, cls) {
  const s = $("#yt-status");
  if (!s) return;
  s.textContent = text;
  s.className = "scrape-status" + (cls ? " " + cls : "");
}

function renderVideoMeta() {
  const card = $("#yt-meta");
  if (!card) return;
  card.classList.remove("hidden");
  card.innerHTML =
    '<div class="yt-meta-row">Titel: <b>' + escapeHtml(VIDEO.title) + "</b></div>" +
    '<div class="yt-meta-row">Kanal: ' + escapeHtml(VIDEO.kanal) + "</div>" +
    '<div class="yt-meta-row">Info: ' + VIDEO.dauer + " &middot; " + VIDEO.aufrufe + " Aufrufe &middot; " + VIDEO.likes + " Likes</div>" +
    '<div class="yt-meta-row">Upload: ' + VIDEO.upload_datum + "</div>" +
    '<div class="yt-meta-row yt-meta-desc">Beschreibung: <span>' + escapeHtml(VIDEO.description) + "</span></div>";
}

function renderVideoActions() {
  const wrap = $("#yt-actions");
  if (!wrap) return;
  if (!videoFetched) { wrap.innerHTML = ""; return; }
  let html = "";
  if (!videoInBrain) {
    html += '<button class="btn-p" id="yt-brain" type="button">🧠 Ins Brain holen</button>';
  } else {
    html += '<button class="btn-s" id="yt-open-raw" type="button">🗂 raw/ öffnen</button>';
    html += '<button class="btn-s" id="yt-open-playlist" type="button">🎵 In Playlist ansehen</button>';
    if (!videoIngested) {
      html += '<button class="btn-p" id="yt-ingest" type="button">📥 Ingest &rarr; wiki/</button>';
    } else {
      html += '<button class="btn-s" id="yt-open-wiki" type="button">📖 wiki/ öffnen</button>';
      html += '<button class="btn-p" id="yt-ask" type="button">💬 Jetzt fragen</button>';
    }
  }
  wrap.innerHTML = html;
  const b1 = $("#yt-brain");
  if (b1) b1.addEventListener("click", promoteToRaw);
  const b2 = $("#yt-ingest");
  if (b2) b2.addEventListener("click", ingestVideo);
  const b3 = $("#yt-open-raw");
  if (b3) b3.addEventListener("click", () => { setView("vault"); setTimeout(() => openFile(RAW_PATH), 60); });
  const b4 = $("#yt-open-wiki");
  if (b4) b4.addEventListener("click", () => { setView("vault"); setTimeout(() => openFile(WIKI_PATH), 60); });
  const b5 = $("#yt-open-playlist");
  if (b5) b5.addEventListener("click", () => setView("playlists"));
  const b6 = $("#yt-ask");
  if (b6) b6.addEventListener("click", () => setView("chat"));
}

function doVideoFetch() {
  const btn = $("#yt-fetch");
  if (btn) btn.disabled = true;
  ytStatus("Lade Transkript & Metadaten…", "");
  setTimeout(() => {
    videoFetched = true;
    renderVideoMeta();
    const prev = $("#yt-preview");
    const ta = $("#yt-transcript");
    if (ta) ta.value = VIDEO.transcript;
    if (prev) prev.classList.remove("hidden");
    ytStatus("Geholt: " + VIDEO.transcript.split("\n").length + " Segmente · " + VIDEO.dauer, "ok");
    renderVideoActions();
    if (btn) btn.disabled = false;
  }, 650);
}

function promoteToRaw() {
  videoInBrain = true;
  vaultOverride[RAW_PATH] = rawMarkdown();
  if (extraFiles.indexOf(RAW_PATH) === -1) extraFiles.push(RAW_PATH);
  ytStatus("Ins Brain geholt: " + RAW_PATH, "ok");
  renderVideoActions();
}

function ingestVideo() {
  videoIngested = true;
  vaultOverride[WIKI_PATH] = wikiMarkdown();
  vaultOverride[CREATOR_PATH] = creatorMarkdown();
  if (extraFiles.indexOf(WIKI_PATH) === -1) extraFiles.push(WIKI_PATH);
  if (extraFiles.indexOf(CREATOR_PATH) === -1) extraFiles.push(CREATOR_PATH);
  ytStatus("Ingest fertig: " + WIKI_PATH + " (mit Zusammenfassung)", "ok");
  renderVideoActions();
}

function wireVideo() {
  const inp = $("#yt-url");
  const btn = $("#yt-fetch");
  if (inp && !inp.value) inp.value = VIDEO.url;
  if (btn) btn.addEventListener("click", doVideoFetch);
  const tog = $("#yt-preview-toggle");
  if (tog) tog.addEventListener("click", () => {
    const ta = $("#yt-transcript");
    if (!ta) return;
    const shown = ta.classList.toggle("open");
    tog.innerHTML = shown ? "&#x25BE; Transkript verbergen" : "&#x25B8; Transkript anzeigen";
  });
  if (videoFetched) {
    renderVideoMeta();
    const prev = $("#yt-preview");
    const ta = $("#yt-transcript");
    if (ta) ta.value = VIDEO.transcript;
    if (prev) prev.classList.remove("hidden");
    ytStatus("Bereits geholt · " + VIDEO.dauer, "ok");
  }
  renderVideoActions();
}

function wirePlaylists() {
  const box = $("#playlist-detail");
  if (!box) return;
  if (!videoInBrain) {
    box.innerHTML = '<div class="playlist-empty">Noch nichts im Brain. Hol dir zuerst das Video im YouTube-Tool &mdash; danach taucht es hier auf.</div>' +
      '<button class="btn-p" id="pl-goto-video" type="button" style="margin-top:10px">Zum YouTube-Tool</button>';
    const g = $("#pl-goto-video");
    if (g) g.addEventListener("click", () => setView("video"));
    return;
  }
  box.innerHTML =
    '<div class="playlist-item-card">' +
      '<div class="playlist-item-head">' +
        '<div class="playlist-thumb" style="background-image:url(' + thumbUrl(VIDEO.id) + ')"></div>' +
        '<div class="playlist-item-headtext">' +
          '<div class="playlist-item-title">' + escapeHtml(VIDEO.title) + "</div>" +
          '<div class="playlist-item-meta"><span>' + escapeHtml(VIDEO.kanal) + "</span><span>hinzugefügt " + VID_DATUM + "</span></div>" +
        "</div>" +
      "</div>" +
      '<div class="playlist-item-links">' +
        '<a href="' + VIDEO.url + '" target="_blank" rel="noopener">YouTube</a>' +
        '<button class="small" id="pl-explorer" type="button">🗂 Explorer</button>' +
        '<button class="small" id="pl-chat" type="button">💬 Chat</button>' +
        (videoIngested ? '<span class="pl-badge">im Wiki ✓</span>' : '<button class="small" id="pl-ingest" type="button">📥 Ingest</button>') +
      "</div>" +
    "</div>";
  const e = $("#pl-explorer");
  if (e) e.addEventListener("click", () => { setView("vault"); setTimeout(() => openFile(videoIngested ? WIKI_PATH : RAW_PATH), 60); });
  const c = $("#pl-chat");
  if (c) c.addEventListener("click", () => setView("chat"));
  const ing = $("#pl-ingest");
  if (ing) ing.addEventListener("click", () => { ingestVideo(); wirePlaylists(); });
}

function openToolDlg(name) {
  const dn = $("#dlg-name");
  if (dn) dn.textContent = name;
  const dlg = $("#tool-dlg");
  if (dlg && dlg.showModal) dlg.showModal();
}

function buildFilelist() {
  const ul = $("#filelist");
  if (!ul) return;
  const groups = {};
  const order = [];
  files.forEach((p) => {
    const idx = p.lastIndexOf("/");
    const dir = idx === -1 ? "" : p.slice(0, idx + 1);
    if (!groups[dir]) {
      groups[dir] = [];
      order.push(dir);
    }
    groups[dir].push(p);
  });
  let html = "";
  order.forEach((dir) => {
    if (dir) html += '<li class="f-dir">' + escapeHtml(dir) + "</li>";
    groups[dir].forEach((p) => {
      const name = p.slice(p.lastIndexOf("/") + 1);
      const cls = p === activePath ? "f-item active" : "f-item";
      html += '<li class="' + cls + '" data-path="' + escapeHtml(p) + '">' + escapeHtml(name) + "</li>";
    });
  });
  ul.innerHTML = html;
}

async function loadFiles() {
  try {
    const res = await fetch("/demo/vault/files");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    files = Array.isArray(data.files) ? data.files : [];
  } catch (e) {
    files = [];
  }
  extraFiles.forEach((p) => { if (files.indexOf(p) === -1) files.push(p); });
  files.sort();
  buildFilelist();
}

async function openFile(path) {
  if (vaultOverride[path] != null) {
    activePath = path;
    openInViewport(path, "ewtos://vault/" + path, vaultOverride[path], path);
    $$("#filelist .f-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.path === path);
    });
    return;
  }
  try {
    const res = await fetch("/demo/vault/read?path=" + encodeURIComponent(path));
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    activePath = path;
    openInViewport(path, "ewtos://vault/" + path, data.content || "", path);
    $$("#filelist .f-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.path === path);
    });
  } catch (e) {
    openInViewport(path, "ewtos://vault/" + path, "Datei konnte nicht geladen werden.");
  }
}

function wireWeb() {
  const go = $("#scrape-go");
  const inp = $("#scrape-url");
  if (inp && pitchActive && !inp.value) inp.value = PITCH_URL;
  if (go) go.addEventListener("click", doScrape);
  if (inp) {
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doScrape();
      }
    });
  }
  const tt = $("#web-tour");
  if (tt) tt.addEventListener("click", () => startTour("web"));
}

function showPageChatBtn() {
  const w = $("#scrape-chat-wrap");
  if (!w) return;
  w.innerHTML = '<button class="btn-p" id="scrape-chat" type="button">💬 Mit dieser Seite chatten</button>';
  const b = $("#scrape-chat");
  if (b) b.addEventListener("click", () => openChatTab("page"));
}

function scrapePitchPage() {
  const status = $("#scrape-status");
  const md = pitchMarkdown();
  openInViewport("ewtos.com", PITCH_URL, md);
  pageContext = md;
  pageHost = "ewtos.com";
  if (status) {
    status.textContent = "Gescrapt: " + md.split(/\s+/).length + " Wörter (diese Pitch-Seite)";
    status.className = "scrape-status ok";
  }
  showPageChatBtn();
}

async function doScrape() {
  const inp = $("#scrape-url");
  const status = $("#scrape-status");
  const go = $("#scrape-go");
  if (!inp) return;
  const url = inp.value.trim();
  if (!/^https?:\/\//i.test(url)) {
    if (status) {
      status.textContent = "Bitte eine gültige http(s)-URL eingeben.";
      status.className = "scrape-status err";
    }
    return;
  }
  let uhost = "";
  try { uhost = new URL(url).hostname.replace(/^www\./, ""); } catch (e) {}
  if (uhost === "ewtos.com") { scrapePitchPage(); return; }
  if (go) go.disabled = true;
  if (status) {
    status.textContent = "Lade…";
    status.className = "scrape-status";
  }
  try {
    const res = await fetch("/demo/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data.detail || ("Fehler " + res.status);
      if (status) {
        status.textContent = detail;
        status.className = "scrape-status err";
      }
      return;
    }
    let host = data.url;
    try {
      host = new URL(data.url).hostname;
    } catch (e) {}
    openInViewport(host, data.url, data.markdown || "");
    pageContext = data.markdown || "";
    pageHost = host;
    if (status) {
      status.textContent = "Gescrapt: " + (data.wordCount || 0) + " Wörter";
      status.className = "scrape-status ok";
    }
    showPageChatBtn();
  } catch (e) {
    if (status) {
      status.textContent = "Netzwerkfehler beim Scrapen.";
      status.className = "scrape-status err";
    }
  } finally {
    if (go) go.disabled = false;
  }
}

function showDoc() {
  const dw = $("#doc-wrap"), cp = $("#chat-pane");
  if (dw) dw.style.display = "";
  if (cp) cp.style.display = "none";
}

function showChat() {
  const dw = $("#doc-wrap"), cp = $("#chat-pane");
  if (dw) dw.style.display = "none";
  if (cp) cp.style.display = "flex";
}

function ctxKey() {
  if (chatMode === "page") return "page:" + (pageHost || "");
  if (chatMode === "file") return "file:" + (chatFile || "");
  return "vault";
}

const CHAT_EX = {
  vault: [
    ["Was ist die Karpathy-Methode und warum kein RAG?", "Karpathy-Methode?"],
    ["Welche Tools bietet Ewtos Office-Brain?", "Welche Tools?"],
    ["Wie funktioniert das mit eigenem Server und Daten?", "Server & Daten?"]
  ],
  page: [
    ["Was ist der Kerninhalt dieser Seite?", "Kerninhalt?"],
    ["Fasse diese Seite in 3 Sätzen zusammen.", "Zusammenfassung"],
    ["Welche Produkte oder Dienstleistungen werden angeboten?", "Angebote?"]
  ],
  file: [
    ["Worum geht es in dieser Datei?", "Worum geht's?"],
    ["Fasse diese Datei kurz zusammen.", "Zusammenfassung"],
    ["Was sind die wichtigsten Punkte?", "Wichtigste Punkte?"]
  ]
};

function getKey() {
  const inp = $("#api-key");
  let k = inp && inp.value.trim();
  if (!k) k = sessionStorage.getItem("eb-key") || "";
  return k;
}

function chatEmptyState() {
  return '<div class="chat-empty">' +
    '<div class="ce-head">&#x1F511; Bring your own Key</div>' +
    '<p>Der Chat l&auml;uft mit <b>deinem eigenen</b> API-Key &mdash; keine Serverkosten, dein Key bleibt lokal im Browser.</p>' +
    '<p class="ce-hint">Noch keinen? <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Kostenlosen Gemini-Key holen &rarr;</a></p>' +
    '<button type="button" class="btn-s" id="ce-setkey">Key eintragen</button>' +
    '</div>';
}

function chatBannerHtml() {
  if (chatMode === "page") return '🌐 Chat: <b>' + escapeHtml(pageHost || "Seite") + "</b>";
  if (chatMode === "file") return '🗒 Chat: <b>' + escapeHtml(chatFile || "") + "</b>";
  return "🧠 Chat mit <b>Vault</b> &mdash; dein ganzes Wissen";
}

function chatTabLabel() {
  if (chatMode === "file") return "Chat — " + (chatFile || "");
  if (chatMode === "page") return "Chat — " + (pageHost || "Seite");
  return "Chat — Vault";
}

function updateChatPane() {
  const bn = $("#chat-banner");
  if (bn) bn.innerHTML = chatBannerHtml();
  $$("#chat-modes .chat-mode-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === chatMode);
  });
  const ex = $("#chat-ex");
  const hist = histories[ctxKey()] || [];
  if (ex) {
    if (hist.length) { ex.style.display = "none"; ex.innerHTML = ""; }
    else {
      ex.style.display = "";
      ex.innerHTML = (CHAT_EX[chatMode] || CHAT_EX.vault)
        .map((q) => '<button type="button" data-q="' + escapeHtml(q[0]) + '">' + escapeHtml(q[1]) + "</button>").join("");
    }
  }
  const log = $("#chat-log");
  if (!log) return;
  if (!hist.length) {
    log.innerHTML = chatEmptyState();
    const sk = $("#ce-setkey");
    if (sk) sk.addEventListener("click", () => { const dlg = $("#settings-dlg"); if (dlg && dlg.showModal) dlg.showModal(); });
    return;
  }
  log.innerHTML = "";
  hist.forEach((m) => {
    const el = document.createElement("div");
    if (m.role === "user") { el.className = "msg me"; el.textContent = m.content || ""; }
    else { el.className = "msg ai"; el.innerHTML = renderMD(m.content || ""); wireDocLinks(el); }
    log.appendChild(el);
  });
  log.scrollTop = log.scrollHeight;
}

function openChatTab(mode, file, content) {
  chatMode = mode || "vault";
  if (chatMode === "file") {
    if (file) chatFile = file;
    if (content != null) chatFileContent = content;
  }
  if (chatMode === "page" && !pageContext) chatMode = "vault";
  const ic = $("#tab-ico"), tl = $("#tab-label"), ub = $("#urlbar-text");
  if (ic) ic.textContent = "💬";
  if (tl) tl.textContent = chatTabLabel();
  if (ub) ub.textContent = "ewtos://chat";
  pitchActive = false;
  showChat();
  updateChatPane();
  const msg = $("#msg");
  if (msg) msg.focus();
}

function switchChatMode(mode) {
  const bn = $("#chat-banner");
  if (mode === "page" && !pageContext) {
    if (bn) bn.innerHTML = "Erst eine Seite scrapen (Web-Tool rechts).";
    return;
  }
  if (mode === "file" && !chatFile) {
    if (bn) bn.innerHTML = "Erst eine Datei öffnen und &bdquo;Mit dieser Datei chatten&ldquo;.";
    return;
  }
  chatMode = mode;
  const tl = $("#tab-label");
  if (tl) tl.textContent = chatTabLabel();
  updateChatPane();
}

function wireChatOnce() {
  const form = $("#chat-form");
  const msg = $("#msg");
  if (form) form.addEventListener("submit", (e) => { e.preventDefault(); if (msg) ask(msg.value); });
  if (msg) msg.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(msg.value); }
  });
  const ex = $("#chat-ex");
  if (ex) ex.addEventListener("click", (e) => {
    const b = e.target.closest("[data-q]");
    if (b) ask(b.dataset.q);
  });
  $$("#chat-modes .chat-mode-btn").forEach((b) => {
    b.addEventListener("click", () => switchChatMode(b.dataset.mode));
  });
}

async function ask(raw) {
  const q = (raw || "").trim();
  if (!q) return;
  const key = getKey();
  if (!key) {
    const dlg = $("#settings-dlg");
    if (dlg && dlg.showModal) dlg.showModal();
    return;
  }
  const log = $("#chat-log");
  const ex = $("#chat-ex");
  const msg = $("#msg");
  if (msg) msg.value = "";
  if (ex) { ex.style.display = "none"; }
  if (log && log.querySelector(".chat-empty")) log.innerHTML = "";

  const k = ctxKey();
  if (!histories[k]) histories[k] = [];
  const hist = histories[k];

  const me = document.createElement("div");
  me.className = "msg me";
  me.textContent = q;
  if (log) log.appendChild(me);

  const ai = document.createElement("div");
  ai.className = "msg ai";
  ai.textContent = "…";
  if (log) { log.appendChild(ai); log.scrollTop = log.scrollHeight; }

  const provider = ($("#provider") && $("#provider").value) || "gemini";
  const model = ($("#model") && $("#model").value.trim()) || (MODELS[provider] && MODELS[provider][0]) || "";

  let ctx = null, ingested = null;
  if (chatMode === "page") ctx = pageContext;
  else if (chatMode === "file") ctx = chatFileContent;
  else if (videoIngested) ingested = vaultOverride[WIKI_PATH];

  try {
    const res = await fetch("/demo/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, api_key: key, model, message: q, history: hist.slice(), context: ctx, ingested })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      ai.className = "msg err";
      ai.textContent = data.detail || ("Fehler " + res.status);
    } else {
      ai.innerHTML = renderMD(data.answer || "");
      wireDocLinks(ai);
      hist.push({ role: "user", content: q });
      hist.push({ role: "assistant", content: data.answer || "" });
      while (hist.length > 16) hist.shift();
    }
  } catch (e) {
    ai.className = "msg err";
    ai.textContent = "Netzwerkfehler beim Senden.";
  }
  if (log) log.scrollTop = log.scrollHeight;
}

function initResize() {
  const handle = $("#drag-handle");
  if (!handle) return;
  const stored = localStorage.getItem("eb-panel-w");
  if (stored) document.documentElement.style.setProperty("--panel-w", stored + "px");

  let active = false;

  function onMove(e) {
    if (!active) return;
    let w = window.innerWidth - e.clientX;
    if (w < 300) w = 300;
    if (w > 640) w = 640;
    document.documentElement.style.setProperty("--panel-w", w + "px");
  }
  function onUp() {
    if (!active) return;
    active = false;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    const cur = getComputedStyle(document.documentElement).getPropertyValue("--panel-w").trim();
    const num = parseInt(cur, 10);
    if (!isNaN(num)) localStorage.setItem("eb-panel-w", num);
  }
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    active = true;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function initBurger() {
  const btn = $("#burger-btn");
  const nav = $("#nav-sidebar");
  if (!btn || !nav) return;
  btn.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  });
}

function markActiveSwatch() {
  const theme = document.documentElement.dataset.theme || "neutral";
  $$(".swatch").forEach((s) => {
    s.classList.toggle("active", s.dataset.theme === theme);
  });
}

function updateDarkIcon() {
  const dt = $("#dark-toggle");
  if (!dt) return;
  dt.textContent = document.documentElement.dataset.mode === "dark" ? "☀" : "☽";
}

function initTheme() {
  const mode = localStorage.getItem("eb-dark") || "dark";
  const theme = localStorage.getItem("eb-theme") || "neutral";
  document.documentElement.dataset.mode = mode;
  document.documentElement.dataset.theme = theme;
  updateDarkIcon();
  markActiveSwatch();

  $$(".swatch").forEach((s) => {
    s.addEventListener("click", () => {
      document.documentElement.dataset.theme = s.dataset.theme;
      localStorage.setItem("eb-theme", s.dataset.theme);
      markActiveSwatch();
    });
  });

  const dt = $("#dark-toggle");
  if (dt) {
    dt.addEventListener("click", () => {
      const cur = document.documentElement.dataset.mode === "dark" ? "light" : "dark";
      document.documentElement.dataset.mode = cur;
      localStorage.setItem("eb-dark", cur);
      updateDarkIcon();
    });
  }
}

function fillModels(provider) {
  const dl = $("#models-dl");
  const hint = $("#key-hint");
  const modelInp = $("#model");
  const list = MODELS[provider] || [];
  if (dl) dl.innerHTML = list.map((m) => '<option value="' + escapeHtml(m) + '"></option>').join("");
  if (hint) hint.innerHTML = HINTS[provider] || "";
  if (modelInp && !modelInp.value.trim() && list.length) modelInp.value = list[0];
}

function initSettings() {
  const open = $("#open-settings");
  if (open) {
    open.addEventListener("click", () => {
      const dlg = $("#settings-dlg");
      if (dlg && dlg.showModal) dlg.showModal();
    });
  }
  const recon = $("#reconnect");
  if (recon) recon.addEventListener("click", () => location.reload());

  const provider = $("#provider");
  if (provider) {
    provider.addEventListener("change", () => {
      const modelInp = $("#model");
      if (modelInp) modelInp.value = "";
      fillModels(provider.value);
    });
  }

  const keyInp = $("#api-key");
  if (keyInp) {
    const stored = sessionStorage.getItem("eb-key");
    if (stored) keyInp.value = stored;
    keyInp.addEventListener("change", () => {
      sessionStorage.setItem("eb-key", keyInp.value.trim());
    });
  }

  fillModels(provider ? provider.value : "gemini");
}

function initDialogs() {
  $$("dialog").forEach((dlg) => {
    $$("[data-close]", dlg).forEach((b) => {
      b.addEventListener("click", () => dlg.close());
    });
    dlg.addEventListener("mousedown", (e) => {
      if (e.target === dlg) dlg.close();
    });
  });
}

function initNav() {
  $$(".nav-item[data-view]").forEach((b) => {
    b.addEventListener("click", () => setView(b.dataset.view));
  });
}

function initIntro() {
  const dlg = $("#intro-dlg");
  if (!dlg) return;
  if (sessionStorage.getItem("eb-intro-seen")) return;
  const dur = $("#intro-dur");
  if (dur) dur.textContent = VIDEO.dauer;
  const facade = $("#intro-video-facade");
  if (facade) facade.style.backgroundImage = "url(" + thumbUrl(VIDEO.id) + ")";
  const play = $("#intro-play");
  if (play && facade) {
    play.addEventListener("click", (e) => {
      e.preventDefault();
      if (VIDEO.id.indexOf("PLACEHOLDER") === 0) {
        facade.innerHTML = '<div class="pp-video-placeholder">Dein Erklärvideo kommt hier rein.<br><span>Platzhalter &mdash; Video-ID nach Upload eintragen.</span></div>';
        return;
      }
      facade.innerHTML = '<iframe class="pp-iframe" src="https://www.youtube.com/embed/' + VIDEO.id + '?autoplay=1" title="EwtosBrain" frameborder="0" allow="autoplay; encrypted-media" allowfullscreen></iframe>';
    });
  }
  dlg.addEventListener("close", () => sessionStorage.setItem("eb-intro-seen", "1"));
  if (dlg.showModal) dlg.showModal();
}

async function init() {
  initTheme();
  initResize();
  initBurger();
  initSettings();
  initDialogs();
  initNav();
  initToolSearch();
  wireChatOnce();

  try {
    await loadFiles();
  } catch (e) {}
  renderPitch();

  setView("home");
  initIntro();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
</script>
</body>
</html>"""
