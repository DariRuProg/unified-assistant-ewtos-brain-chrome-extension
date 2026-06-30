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
    "AUSSCHLIESSLICH auf Basis des folgenden gescrapten Seiteninhalts. Steht etwas "
    "nicht drin, sag das ehrlich. Antworte auf Deutsch und knapp. Dies ist eine "
    "read-only Demo.\n\n=== Seiteninhalt ===\n{context}"
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
        system = _SYSTEM.format(context=_load_demo_context())
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
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 4px; padding: 12px 6px; background: var(--bg-subtle); border: 1px solid var(--border);
  border-radius: 10px; color: var(--text); font-size: 18px; line-height: 1; cursor: pointer;
  font-family: inherit; transition: background 0.12s, border-color 0.12s;
}
.tile span { font-size: 11px; font-weight: 600; line-height: 1.2; }
.tile:hover { background: var(--bg-hover); }
.tile:not(.locked) { border-color: var(--accent); }
.tile.locked { opacity: 0.5; cursor: pointer; }

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

/* CHAT */
.view-chat { display: flex; flex-direction: column; gap: 8px; }
.chat-ctx:empty { display: none; }
.ctx-pill {
  display: inline-flex; align-items: center; gap: 7px; padding: 5px 10px;
  background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 999px;
  font-size: 11.5px; color: var(--text);
}
.ctx-pill b { font-weight: 600; }
.ctx-pill #ctx-clear {
  border: none; background: transparent; color: var(--text-muted); font-size: 15px;
  line-height: 1; cursor: pointer; padding: 0 0 0 2px; font-family: inherit;
}
.ctx-pill #ctx-clear:hover { color: var(--text); }

.chat-log { display: flex; flex-direction: column; gap: 9px; padding: 4px 0; }
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
.doc.markdown a[data-wiki] { color: var(--accent); }
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
    <div class="doc-wrap"><article class="doc markdown" id="doc"></article></div>
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
const history = [];

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
  s = s.replace(/\[\[([^\]]+)\]\]/g, (m, w) => {
    const label = w.trim();
    return '<a href="#" data-wiki="' + escapeHtml(label) + '">' + label + "</a>";
  });
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, txt, url) => {
    const u = safeUrl(url);
    if (!u) return txt;
    if (u === "#") return '<a href="#">' + txt + "</a>";
    return '<a href="' + u + '" target="_blank" rel="noopener">' + txt + "</a>";
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?=[^_\w]|$)/g, "$1<em>$2</em>");
  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => codeStash[+i]);
  return s;
}

function renderMD(md) {
  const escaped = escapeHtml(md == null ? "" : md);
  const lines = escaped.split(/\r?\n/);
  const out = [];
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

function wireWikiLinks() {
  const doc = $("#doc");
  if (!doc) return;
  $$("[data-wiki]", doc).forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const slug = slugify(a.dataset.wiki);
      const target = "wiki/" + slug + ".md";
      if (files.indexOf(target) !== -1) openFile(target);
    });
  });
}

function openInViewport(label, url, md) {
  const tl = $("#tab-label");
  const ub = $("#urlbar-text");
  const doc = $("#doc");
  if (tl) tl.textContent = label;
  if (ub) ub.textContent = url;
  if (doc) doc.innerHTML = renderMD(md);
  wireWikiLinks();
}

const VIEWS = {
  home: `<div class="view view-home">
  <div class="tools-head">Werkzeuge</div>
  <div class="tgroup"><div class="tgroup-label">Vault</div><div class="tiles">
    <button class="tile" data-open="vault">📚<span>Explorer</span></button>
    <button class="tile" data-open="chat">💬<span>Chat</span></button>
    <button class="tile locked" data-lock="CRM">🤝<span>CRM</span></button>
    <button class="tile locked" data-lock="Dokument-Ingest">📥<span>Ingest</span></button>
    <button class="tile locked" data-lock="Vault Health">🩺<span>Health</span></button>
    <button class="tile locked" data-lock="Notizen">📝<span>Notizen</span></button>
    <button class="tile locked" data-lock="Todos">✅<span>Todos</span></button>
  </div></div>
  <div class="tgroup"><div class="tgroup-label">Web</div><div class="tiles">
    <button class="tile" data-open="web">📄<span>Scrape</span></button>
    <button class="tile locked" data-lock="SEO Check">🔍<span>SEO</span></button>
    <button class="tile locked" data-lock="URL Extractor">🔗<span>URLs</span></button>
    <button class="tile locked" data-lock="Bookmarks">🔖<span>Bookmarks</span></button>
  </div></div>
  <div class="tgroup"><div class="tgroup-label">Video</div><div class="tiles">
    <button class="tile locked" data-lock="YouTube Transcript">🎬<span>YouTube</span></button>
    <button class="tile locked" data-lock="Playlists">🎵<span>Playlists</span></button>
  </div></div>
  <div class="tgroup"><div class="tgroup-label">Bilder</div><div class="tiles">
    <button class="tile locked" data-lock="Image Analyse">🖼️<span>Analyse</span></button>
    <button class="tile locked" data-lock="Image Generator">🪄<span>Generator</span></button>
    <button class="tile locked" data-lock="Color Picker">🎨<span>Picker</span></button>
    <button class="tile locked" data-lock="Screenshot">📸<span>Screenshot</span></button>
  </div></div>
</div>`,
  vault: `<div class="view view-vault">
  <div class="view-head">📚 Vault Explorer<span class="view-sub"> — Datei klicken, öffnet links</span></div>
  <ul class="filelist" id="filelist"></ul>
</div>`,
  web: `<div class="view view-web">
  <div class="view-head">📄 Page Scrape<span class="view-sub"> — echte URL → Markdown</span></div>
  <div class="scrape-row">
    <input id="scrape-url" type="url" placeholder="https://example.com" autocomplete="off">
    <button id="scrape-go" class="btn-p">Scrapen</button>
  </div>
  <div class="scrape-status" id="scrape-status"></div>
  <p class="view-note">Holt die Seite serverseitig, wandelt sie in Markdown und zeigt sie links. Danach kannst du im Chat „über diese Seite“ reden.</p>
</div>`,
  chat: `<div class="view view-chat">
  <div class="chat-ctx" id="chat-ctx"></div>
  <div class="chat-log" id="chat-log"></div>
  <div class="chat-ex" id="chat-ex">
    <button data-q="Was ist die Karpathy-Methode und warum kein RAG?">Karpathy-Methode?</button>
    <button data-q="Welche Tools bietet Ewtos Office-Brain?">Welche Tools?</button>
    <button data-q="Wie funktioniert das mit eigenem Server und Daten?">Server &amp; Daten?</button>
  </div>
  <div class="composer">
    <textarea id="msg" rows="2" placeholder="Frag etwas…"></textarea>
    <button id="send-btn" class="btn-p">Senden</button>
  </div>
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

function setView(name) {
  const content = $("#content");
  if (!content) return;
  if (name === "video") content.innerHTML = lockedView("🎬", "Video-Tools");
  else if (name === "bilder") content.innerHTML = lockedView("🎨", "Bilder-Tools");
  else content.innerHTML = VIEWS[name] || VIEWS.home;

  $$(".nav-item[data-view]").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === name);
  });

  if (name === "home") wireHome();
  else if (name === "vault") {
    loadFiles().then(() => {
      $$("#filelist .f-item").forEach((el) => {
        el.addEventListener("click", () => openFile(el.dataset.path));
      });
    });
  } else if (name === "web") wireWeb();
  else if (name === "chat") wireChat();
}

function wireHome() {
  $$(".tile[data-open]").forEach((t) => {
    t.addEventListener("click", () => setView(t.dataset.open));
  });
  $$(".tile.locked[data-lock]").forEach((t) => {
    t.addEventListener("click", () => openToolDlg(t.dataset.lock));
  });
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
  buildFilelist();
}

async function openFile(path) {
  try {
    const res = await fetch("/demo/vault/read?path=" + encodeURIComponent(path));
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    activePath = path;
    openInViewport(path, "ewtos://vault/" + path, data.content || "");
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
  if (go) go.addEventListener("click", doScrape);
  if (inp) {
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doScrape();
      }
    });
  }
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
    updateCtxPill();
  } catch (e) {
    if (status) {
      status.textContent = "Netzwerkfehler beim Scrapen.";
      status.className = "scrape-status err";
    }
  } finally {
    if (go) go.disabled = false;
  }
}

function updateCtxPill() {
  const ctx = $("#chat-ctx");
  if (!ctx) return;
  if (pageContext) {
    ctx.innerHTML = '<div class="ctx-pill">🌐 Seite: <b>' + escapeHtml(pageHost || "") + '</b><button id="ctx-clear" title="Kontext lösen">×</button></div>';
    const clr = $("#ctx-clear");
    if (clr) {
      clr.addEventListener("click", () => {
        pageContext = null;
        pageHost = null;
        updateCtxPill();
      });
    }
  } else {
    ctx.innerHTML = "";
  }
}

function getKey() {
  const inp = $("#api-key");
  let k = inp && inp.value.trim();
  if (!k) k = sessionStorage.getItem("eb-key") || "";
  return k;
}

function wireChat() {
  const send = $("#send-btn");
  const msg = $("#msg");
  if (send) {
    send.addEventListener("click", () => {
      if (msg) ask(msg.value);
    });
  }
  if (msg) {
    msg.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        ask(msg.value);
      }
    });
  }
  $$("#chat-ex [data-q]").forEach((b) => {
    b.addEventListener("click", () => ask(b.dataset.q));
  });
  updateCtxPill();
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
  if (ex) ex.style.display = "none";
  if (msg) msg.value = "";

  const me = document.createElement("div");
  me.className = "msg me";
  me.textContent = q;
  if (log) log.appendChild(me);

  const ai = document.createElement("div");
  ai.className = "msg ai";
  ai.textContent = "…";
  if (log) {
    log.appendChild(ai);
    log.scrollTop = log.scrollHeight;
  }

  const provider = ($("#provider") && $("#provider").value) || "gemini";
  const model = ($("#model") && $("#model").value.trim()) || (MODELS[provider] && MODELS[provider][0]) || "";

  try {
    const res = await fetch("/demo/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        api_key: key,
        model,
        message: q,
        history: history.slice(),
        context: pageContext || null
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      ai.className = "msg err";
      ai.textContent = data.detail || ("Fehler " + res.status);
    } else {
      ai.innerHTML = renderMD(data.answer || "");
      history.push({ role: "user", content: q });
      history.push({ role: "assistant", content: data.answer || "" });
      while (history.length > 16) history.shift();
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

async function init() {
  initTheme();
  initResize();
  initBurger();
  initSettings();
  initDialogs();
  initNav();

  try {
    await loadFiles();
    if (files.indexOf("wiki/index.md") !== -1) await openFile("wiki/index.md");
    else if (files.length) await openFile(files[0]);
    else openInViewport("ewtos", "ewtos://vault/", "Kein Vault-Inhalt gefunden.");
  } catch (e) {
    const doc = $("#doc");
    if (doc) doc.innerHTML = renderMD("# Willkommen\n\nDer Vault konnte gerade nicht geladen werden. Versuch es mit dem Neu-Laden-Button.");
  }

  setView("home");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
</script>
</body>
</html>"""
