# @author Dario | ewtos.com
"""Standalone-Demo: öffentliche Web-Vorschau der App (ohne Extension).

Zeigt Extension-Optik (Tool-Kacheln, Vault-Explorer, 5 Themes + Dark/Light) und
erlaubt BYOK-Chat gegen den read-only Beispiel-Vault. Keys werden pro Request verwendet
und nicht gespeichert. Keine eigenen Server-LLM-Kosten (rein BYOK).
"""
from __future__ import annotations

from typing import Any

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


@router.post("/demo/chat")
def demo_chat(req: DemoChatRequest) -> dict[str, Any]:
    if not (req.api_key or "").strip():
        raise HTTPException(400, "Bitte einen eigenen API-Key eintragen.")
    if not (req.message or "").strip():
        raise HTTPException(400, "Leere Nachricht.")
    backend = _backend_for(req.provider, req.api_key.strip())
    model = (req.model or "").strip() or _DEFAULT_MODELS.get(req.provider.strip().lower(), "gemini-2.5-flash")
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


_PAGE = """<!DOCTYPE html>
<html lang="de" data-mode="dark" data-theme="neutral">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ewtos Office-Brain — Live-Demo</title>
<style>
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

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.5;
  background:var(--bg);color:var(--text);height:100vh;display:flex;flex-direction:column;
  overflow:hidden;transition:background .2s,color .2s}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
button{cursor:pointer;font-family:inherit}

/* Header */
.app-hdr{background:var(--hdr-bg);color:var(--hdr-tx);padding:0 14px;height:46px;
  display:flex;align-items:center;justify-content:space-between;flex-shrink:0;gap:10px}
.logo{display:flex;align-items:center;gap:7px}
.logo-ico{font-size:17px}
.logo-tx{font-weight:700;font-size:14px;letter-spacing:-.2px}
.demo-badge{background:rgba(255,255,255,.14);font-size:10px;font-weight:700;
  padding:2px 7px;border-radius:20px;letter-spacing:.5px}
.theme-bar{display:flex;align-items:center;gap:4px}
.swatch{width:17px;height:17px;border-radius:50%;border:2px solid transparent;
  background:var(--c,#6b7280);padding:0;transition:transform .15s,border-color .15s}
.swatch:hover{transform:scale(1.25)}
.swatch.active{border-color:var(--hdr-tx)}
#dark-btn{background:rgba(255,255,255,.1);border:none;color:var(--hdr-tx);
  width:27px;height:27px;border-radius:7px;font-size:13px;display:flex;
  align-items:center;justify-content:center;margin-left:4px}
#dark-btn:hover{background:rgba(255,255,255,.2)}

/* Body */
.app-body{display:flex;flex:1;overflow:hidden}

/* Sidebar */
.sidebar{width:182px;flex-shrink:0;background:var(--bg-card);
  border-right:1px solid var(--border);overflow-y:auto;padding-bottom:12px}
.tool-grp{padding:0 0 2px}
.tool-sec{font-size:10px;font-weight:700;color:var(--text-faint);letter-spacing:.7px;
  padding:10px 10px 4px;text-transform:uppercase}
.tool-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:5px;padding:0 7px}
.tool-tile{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;
  gap:5px;padding:8px 4px 7px;background:var(--bg-subtle);border:1px solid var(--border);
  border-radius:10px;text-align:center;transition:background .15s,border-color .15s}
.tool-tile:hover{background:var(--bg-hover);border-color:var(--border-input)}
.tr-ico{width:34px;height:34px;background:var(--bg-card);border-radius:8px;
  display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}
.tr-lbl{font-size:10px;font-weight:600;color:var(--text);line-height:1.2;word-break:break-word}
.tool-tile.active{border-color:var(--accent)}
.tool-tile.active .tr-ico{background:var(--accent);color:var(--accent-tx)}
.tool-tile.locked{opacity:.42}
.tool-tile.locked:hover{background:var(--bg-subtle);border-color:var(--border)}

/* Main */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;background:var(--bg)}

/* Tabs */
.tab-bar{display:flex;align-items:center;border-bottom:1px solid var(--border);
  background:var(--bg-card);padding:0 12px;flex-shrink:0;gap:2px;height:40px}
.tab{padding:0 14px;height:40px;border:none;background:none;color:var(--text-muted);
  font-size:13px;font-weight:550;border-bottom:2px solid transparent;
  transition:color .15s;display:flex;align-items:center}
.tab:hover{color:var(--text)}
.tab.active{color:var(--text);border-bottom-color:var(--accent)}
.tab-hint{margin-left:auto;font-size:11px;color:var(--text-faint)}
.tab-pane{flex:1;overflow:hidden;display:flex;flex-direction:column}
.tab-pane.hidden{display:none}

/* Vault Explorer */
.vault-pane{display:flex;height:100%;overflow:hidden}
.file-list{width:205px;flex-shrink:0;border-right:1px solid var(--border);
  overflow-y:auto;background:var(--bg-card)}
.file-hdr{padding:8px 12px;font-size:10px;font-weight:700;color:var(--text-faint);
  border-bottom:1px solid var(--border);letter-spacing:.5px;text-transform:uppercase}
#files{list-style:none}
#files .f-dir{font-size:10px;font-weight:700;color:var(--text-faint);
  padding:9px 12px 3px;cursor:default;letter-spacing:.4px}
#files .f-item{padding:6px 14px;font-size:12px;cursor:pointer;color:var(--text-muted);
  border-left:2px solid transparent;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#files .f-item:hover{background:var(--bg-hover);color:var(--text)}
#files .f-item.active{background:var(--bg-subtle);color:var(--accent);
  border-left-color:var(--accent);font-weight:600}
.file-view{flex:1;display:flex;flex-direction:column;overflow:hidden}
.file-view-hdr{padding:7px 16px;font-size:11px;color:var(--text-muted);
  border-bottom:1px solid var(--border);background:var(--bg-card);
  flex-shrink:0;font-family:monospace}
#file-content{flex:1;overflow:auto;padding:20px;font-family:monospace;font-size:13px;
  line-height:1.75;white-space:pre-wrap;color:var(--text);background:var(--bg)}

/* Chat */
.chat-wrap{display:flex;flex-direction:column;height:100%;overflow:hidden}
.chat-cfg{background:var(--bg-card);border-bottom:1px solid var(--border);
  padding:11px 14px;flex-shrink:0;display:flex;flex-direction:column;gap:8px}
.cfg-row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
.cfg-f{display:flex;flex-direction:column;gap:3px}
.cfg-f label{font-size:11px;color:var(--text-muted);font-weight:500}
.cfg-f select,.cfg-f input{padding:7px 10px;background:var(--bg);
  border:1px solid var(--border-input);border-radius:8px;color:var(--text);font-size:13px}
.cfg-hint{font-size:11px;color:var(--text-muted);padding-bottom:1px}
.cfg-hint a{color:var(--accent)}
.chat-log{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:9px}
.msg{padding:9px 13px;border-radius:10px;max-width:86%;white-space:pre-wrap;font-size:13px;line-height:1.55}
.msg-me{align-self:flex-end;background:var(--bg-subtle)}
.msg-ai{align-self:flex-start;background:var(--bg-card);border:1px solid var(--border)}
.msg-err{align-self:flex-start;color:#ef4444;font-size:12px;padding:6px 0}
.chat-ex{padding:0 14px 8px;display:flex;flex-wrap:wrap;gap:6px;flex-shrink:0}
.chat-ex button{padding:5px 10px;background:var(--bg-card);border:1px solid var(--border);
  border-radius:7px;font-size:12px;color:var(--text-muted)}
.chat-ex button:hover{color:var(--text);background:var(--bg-hover)}
.chat-comp{display:flex;gap:8px;padding:10px 14px;border-top:1px solid var(--border);
  flex-shrink:0;background:var(--bg-card)}
.chat-comp textarea{flex:1;padding:8px 11px;background:var(--bg);
  border:1px solid var(--border-input);border-radius:9px;color:var(--text);
  font-size:13px;resize:none;font-family:inherit}
.chat-comp button{padding:8px 16px;background:var(--accent);color:var(--accent-tx);
  border:none;border-radius:9px;font-weight:700;font-size:13px;white-space:nowrap}
.chat-comp button:disabled{opacity:.5;cursor:default}

/* Footer */
.app-ftr{padding:7px 14px;background:var(--bg-card);border-top:1px solid var(--border);
  font-size:12px;color:var(--text-muted);text-align:center;flex-shrink:0}

/* Dialog */
dialog{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;
  padding:22px;max-width:340px;color:var(--text)}
dialog::backdrop{background:rgba(0,0,0,.5)}
.dlg-hint{font-size:12px;color:var(--text-muted);margin-top:8px;line-height:1.5}
.dlg-actions{display:flex;gap:9px;margin-top:16px}
.btn-p{padding:8px 15px;background:var(--accent);color:var(--accent-tx);
  border-radius:8px;font-weight:700;font-size:13px;text-decoration:none;display:inline-block}
.btn-p:hover{text-decoration:none;background:var(--accent-h)}
.btn-s{padding:8px 15px;background:var(--bg-subtle);color:var(--text);
  border:1px solid var(--border);border-radius:8px;font-size:13px}

@media(max-width:600px){.sidebar{display:none}}
</style>
</head>
<body>

<header class="app-hdr">
  <div class="logo">
    <span class="logo-ico">\U0001f9e0</span>
    <span class="logo-tx">Ewtos Office-Brain</span>
    <span class="demo-badge">DEMO</span>
  </div>
  <div class="theme-bar">
    <button class="swatch" data-theme="neutral" style="--c:#6b7280" title="Neutral"></button>
    <button class="swatch" data-theme="ocean"   style="--c:#3b82f6" title="Ocean"></button>
    <button class="swatch" data-theme="forest"  style="--c:#22c55e" title="Forest"></button>
    <button class="swatch" data-theme="sunset"  style="--c:#a855f7" title="Sunset"></button>
    <button class="swatch" data-theme="ember"   style="--c:#f59e0b" title="Ember"></button>
    <button id="dark-btn" title="Dark/Light">☉</button>
  </div>
</header>

<div class="app-body">
  <nav class="sidebar">

    <div class="tool-grp">
      <div class="tool-sec">Vault</div>
      <div class="tool-grid">
        <button class="tool-tile active" data-goto="explorer" title="Vault Explorer — Demo aktiv">
          <span class="tr-ico">\U0001f4da</span><span class="tr-lbl">Explorer</span>
        </button>
        <button class="tool-tile active" data-goto="chat" title="Chat — Demo aktiv">
          <span class="tr-ico">\U0001f4ac</span><span class="tr-lbl">Chat</span>
        </button>
        <button class="tool-tile locked" data-locked="Note-Taker">
          <span class="tr-ico">\U0001f4dd</span><span class="tr-lbl">Notizen</span>
        </button>
        <button class="tool-tile locked" data-locked="Todos">
          <span class="tr-ico">✅</span><span class="tr-lbl">Todos</span>
        </button>
        <button class="tool-tile locked" data-locked="CRM">
          <span class="tr-ico">\U0001f91d</span><span class="tr-lbl">CRM</span>
        </button>
        <button class="tool-tile locked" data-locked="Vault Health">
          <span class="tr-ico">\U0001fa7a</span><span class="tr-lbl">Health</span>
        </button>
      </div>
    </div>

    <div class="tool-grp">
      <div class="tool-sec">Web</div>
      <div class="tool-grid">
        <button class="tool-tile locked" data-locked="Page Scrape">
          <span class="tr-ico">\U0001f4c4</span><span class="tr-lbl">Scrape</span>
        </button>
        <button class="tool-tile locked" data-locked="SEO Check">
          <span class="tr-ico">\U0001f50d</span><span class="tr-lbl">SEO</span>
        </button>
        <button class="tool-tile locked" data-locked="URL Extractor">
          <span class="tr-ico">\U0001f517</span><span class="tr-lbl">URLs</span>
        </button>
        <button class="tool-tile locked" data-locked="Bookmarks">
          <span class="tr-ico">\U0001f516</span><span class="tr-lbl">Bookmarks</span>
        </button>
      </div>
    </div>

    <div class="tool-grp">
      <div class="tool-sec">Video</div>
      <div class="tool-grid">
        <button class="tool-tile locked" data-locked="YouTube Transcript">
          <span class="tr-ico">\U0001f3ac</span><span class="tr-lbl">YouTube</span>
        </button>
        <button class="tool-tile locked" data-locked="Playlists">
          <span class="tr-ico">\U0001f3b5</span><span class="tr-lbl">Playlists</span>
        </button>
      </div>
    </div>

    <div class="tool-grp">
      <div class="tool-sec">Images</div>
      <div class="tool-grid">
        <button class="tool-tile locked" data-locked="Image Analyse">
          <span class="tr-ico">\U0001f5bc️</span><span class="tr-lbl">Analyse</span>
        </button>
        <button class="tool-tile locked" data-locked="Image Generator">
          <span class="tr-ico">\U0001fa84</span><span class="tr-lbl">Generator</span>
        </button>
        <button class="tool-tile locked" data-locked="Color Picker">
          <span class="tr-ico">\U0001f3a8</span><span class="tr-lbl">Picker</span>
        </button>
        <button class="tool-tile locked" data-locked="Screenshot">
          <span class="tr-ico">\U0001f4f8</span><span class="tr-lbl">Screenshot</span>
        </button>
      </div>
    </div>

  </nav>

  <main class="main">
    <div class="tab-bar">
      <button class="tab active" data-tab="explorer">\U0001f4da Vault Explorer</button>
      <button class="tab" data-tab="chat">\U0001f4ac Chat</button>
      <span class="tab-hint">read-only Demo</span>
    </div>

    <div class="tab-pane" id="pane-explorer">
      <div class="vault-pane">
        <div class="file-list">
          <div class="file-hdr">demo_vault /</div>
          <ul id="files"></ul>
        </div>
        <div class="file-view">
          <div class="file-view-hdr" id="file-path">—</div>
          <pre id="file-content">Lade Vault…</pre>
        </div>
      </div>
    </div>

    <div class="tab-pane hidden" id="pane-chat">
      <div class="chat-wrap">
        <div class="chat-cfg">
          <div class="cfg-row">
            <div class="cfg-f">
              <label>Anbieter</label>
              <select id="provider">
                <option value="gemini">Google Gemini (kostenloser Tier)</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic Claude</option>
              </select>
            </div>
            <div class="cfg-f" style="flex:1;min-width:180px">
              <label>API-Key</label>
              <input id="api-key" type="password" placeholder="Dein API-Key" autocomplete="off">
            </div>
          </div>
          <div class="cfg-row">
            <div class="cfg-f" style="flex:1">
              <label>Modell <span style="font-weight:400;font-size:10px;color:var(--text-faint)">(frei editierbar)</span></label>
              <input id="model" list="models-dl" autocomplete="off" spellcheck="false">
              <datalist id="models-dl"></datalist>
            </div>
            <div class="cfg-hint" id="key-hint">
              Noch keinen? <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Kostenlosen Gemini-Key holen →</a>
            </div>
          </div>
        </div>
        <div class="chat-log" id="chat-log"></div>
        <div class="chat-ex" id="chat-ex">
          <button data-q="Was ist die Karpathy-Methode und warum kein RAG?">Karpathy-Methode?</button>
          <button data-q="Welche Tools bietet Ewtos Office-Brain im Browser?">Welche Tools?</button>
          <button data-q="Wie funktioniert das mit dem eigenen Server und den Daten?">Daten &amp; Server?</button>
        </div>
        <div class="chat-comp">
          <textarea id="msg" placeholder="Frag etwas zum Demo-Vault…" rows="2"></textarea>
          <button id="send-btn">Senden</button>
        </div>
      </div>
    </div>
  </main>
</div>

<footer class="app-ftr">
  Gefällt's? &nbsp;·&nbsp;
  <a href="https://ewtos.com" target="_blank" rel="noopener">Vollversion auf ewtos.com →</a>
  &nbsp;·&nbsp; Self-hosted · BYOK · DSGVO-freundlich
</footer>

<dialog id="tool-dlg">
  <strong id="dlg-name">Tool</strong> läuft in der echten Extension + eigenem Server.
  <p class="dlg-hint">
    Ewtos Office-Brain verbindet sich mit deinem lokal oder auf einem VPS laufenden Server
    — deine Daten bleiben bei dir, DSGVO-konform, kein Cloud-Lock-in.
  </p>
  <div class="dlg-actions">
    <a href="https://ewtos.com" target="_blank" rel="noopener" class="btn-p">Installieren →</a>
    <button class="btn-s" onclick="document.getElementById('tool-dlg').close()">Schließen</button>
  </div>
</dialog>

<script>
const MODELS = {
  gemini:    ["gemini-2.5-flash","gemini-2.5-pro","gemini-2.5-flash-lite"],
  openai:    ["gpt-4o-mini","gpt-4o","gpt-4.1-mini"],
  anthropic: ["claude-haiku-4-5-20251001","claude-sonnet-4-6","claude-opus-4-8"]
};
const HINTS = {
  gemini:    'Noch keinen? <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Kostenlosen Gemini-Key holen →</a>',
  openai:    'Key unter <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com/api-keys</a>',
  anthropic: 'Key unter <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>'
};

// --- Theme / Dark Mode ---
const html = document.documentElement;
const darkBtn = document.getElementById("dark-btn");

function setMode(dark) {
  html.dataset.mode = dark ? "dark" : "light";
  darkBtn.textContent = dark ? "☀" : "☽";
  darkBtn.title = dark ? "Light Mode" : "Dark Mode";
  localStorage.setItem("eb-dark", dark ? "1" : "0");
}
function setTheme(t) {
  html.dataset.theme = t;
  document.querySelectorAll(".swatch").forEach(s => s.classList.toggle("active", s.dataset.theme === t));
  localStorage.setItem("eb-theme", t);
}
const savedDark = localStorage.getItem("eb-dark");
setMode(savedDark === null ? true : savedDark === "1");
setTheme(localStorage.getItem("eb-theme") || "neutral");

darkBtn.addEventListener("click", () => setMode(html.dataset.mode !== "dark"));
document.querySelectorAll(".swatch").forEach(s => s.addEventListener("click", () => setTheme(s.dataset.theme)));

// --- Tabs ---
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});
function switchTab(name) {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tab-pane").forEach(p => p.classList.toggle("hidden", p.id !== "pane-" + name));
}

// --- Sidebar active tiles ---
document.querySelectorAll(".tool-tile[data-goto]").forEach(tile => {
  tile.addEventListener("click", () => switchTab(tile.dataset.goto));
});

// --- Locked tiles ---
document.querySelectorAll(".tool-tile[data-locked]").forEach(tile => {
  tile.addEventListener("click", () => {
    document.getElementById("dlg-name").textContent = tile.dataset.locked;
    document.getElementById("tool-dlg").showModal();
  });
});

// --- Vault Explorer ---
async function loadFiles() {
  const res = await fetch("/demo/vault/files");
  const { files } = await res.json();
  const ul = document.getElementById("files");
  ul.innerHTML = "";
  const dirs = {};
  files.forEach(f => {
    const slash = f.lastIndexOf("/");
    const dir = slash > -1 ? f.slice(0, slash) : "";
    (dirs[dir] = dirs[dir] || []).push(f);
  });
  for (const [dir, fs] of Object.entries(dirs)) {
    if (dir) {
      const li = document.createElement("li");
      li.className = "f-dir";
      li.textContent = dir + "/";
      ul.appendChild(li);
    }
    fs.forEach(f => {
      const li = document.createElement("li");
      li.className = "f-item";
      li.textContent = (dir ? "  " : "") + f.slice(dir ? dir.length + 1 : 0);
      li.dataset.path = f;
      li.title = f;
      li.addEventListener("click", () => openFile(f));
      ul.appendChild(li);
    });
  }
  const start = files.find(f => f === "wiki/index.md") || files[0];
  if (start) openFile(start);
}

async function openFile(path) {
  document.querySelectorAll(".f-item").forEach(li => li.classList.toggle("active", li.dataset.path === path));
  document.getElementById("file-path").textContent = path;
  document.getElementById("file-content").textContent = "Lade…";
  try {
    const res = await fetch("/demo/vault/read?path=" + encodeURIComponent(path));
    const data = await res.json();
    document.getElementById("file-content").textContent = data.content || "(leer)";
  } catch {
    document.getElementById("file-content").textContent = "Fehler beim Laden.";
  }
}

loadFiles().catch(() => {
  document.getElementById("file-content").textContent = "Vault konnte nicht geladen werden.";
});

// --- Chat ---
const provEl = document.getElementById("provider");
const keyEl  = document.getElementById("api-key");
const modelEl = document.getElementById("model");
const msgEl  = document.getElementById("msg");
const sendBtn = document.getElementById("send-btn");
const logEl  = document.getElementById("chat-log");
const history = [];

try { keyEl.value = sessionStorage.getItem("eb-key") || ""; } catch {}
keyEl.addEventListener("change", () => { try { sessionStorage.setItem("eb-key", keyEl.value); } catch {} });

function applyProvider(resetModel) {
  const p = provEl.value;
  document.getElementById("key-hint").innerHTML = HINTS[p] || "";
  document.getElementById("models-dl").innerHTML = (MODELS[p] || []).map(m => `<option value="${m}">`).join("");
  if (resetModel || !modelEl.value.trim()) modelEl.value = (MODELS[p] || [""])[0];
}
provEl.addEventListener("change", () => applyProvider(true));
applyProvider(false);

function bubble(cls, txt) {
  const d = document.createElement("div");
  d.className = "msg " + cls;
  d.textContent = txt;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
  return d;
}

async function ask(q) {
  q = (q || "").trim();
  if (!q) return;
  const key = keyEl.value.trim();
  if (!key) { bubble("msg-err", "Bitte zuerst einen API-Key eintragen."); keyEl.focus(); return; }
  bubble("msg-me", q);
  msgEl.value = "";
  sendBtn.disabled = true;
  document.getElementById("chat-ex").style.display = "none";
  const thinking = bubble("msg-ai", "…");
  try {
    const res = await fetch("/demo/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: provEl.value, api_key: key, model: modelEl.value.trim(), message: q, history })
    });
    const data = await res.json();
    if (!res.ok) { thinking.remove(); bubble("msg-err", data.detail || "Fehler " + res.status); return; }
    thinking.textContent = data.answer;
    history.push({ role: "user", content: q }, { role: "assistant", content: data.answer });
  } catch {
    thinking.remove(); bubble("msg-err", "Server nicht erreichbar.");
  } finally {
    sendBtn.disabled = false;
  }
}

sendBtn.addEventListener("click", () => ask(msgEl.value));
msgEl.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(msgEl.value); }
});
document.getElementById("chat-ex").addEventListener("click", e => {
  const b = e.target.closest("[data-q]");
  if (b) ask(b.dataset.q);
});
</script>
</body>
</html>"""
