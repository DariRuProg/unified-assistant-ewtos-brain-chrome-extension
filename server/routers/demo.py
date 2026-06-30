# @author Dario | ewtos.com
"""Standalone-Demo: öffentliche Web-Chat-Seite (ohne Extension).

Besucher bringen ihren EIGENEN API-Key (BYOK, Schwerpunkt Gemini Free-Tier) und
chatten gegen den read-only Beispiel-Vault. Der Key wird pro Request verwendet und
NICHT gespeichert. Der Server macht keine eigenen LLM-Calls/Kosten.
"""
from __future__ import annotations

from pathlib import Path
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
    """Liest den kleinen Beispiel-Vault (CLAUDE.md + wiki/*.md) als Prompt-Kontext."""
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


@router.post("/demo/chat")
def demo_chat(req: DemoChatRequest) -> dict[str, Any]:
    if not (req.api_key or "").strip():
        raise HTTPException(400, "Bitte einen eigenen API-Key eintragen.")
    if not (req.message or "").strip():
        raise HTTPException(400, "Leere Nachricht.")
    backend = _backend_for(req.provider, req.api_key.strip())
    model = (req.model or "").strip() or _DEFAULT_MODELS.get(req.provider.strip().lower(), "gemini-2.0-flash")
    system = _SYSTEM.format(context=_load_demo_context())
    messages = [
        {"role": m.get("role"), "content": m.get("content")}
        for m in (req.history or [])
        if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)
    ][-8:]
    messages.append({"role": "user", "content": req.message.strip()})
    try:
        result = backend.complete(model=model, messages=messages, system=system, max_tokens=_MAX_TOKENS)
    except Exception as e:  # noqa: BLE001 — Key/Netz/Modell-Fehler an den Besucher melden
        msg = str(e)
        raise HTTPException(400, f"LLM-Fehler (Key/Modell prüfen): {msg[:300]}")
    answer = "".join(getattr(b, "text", "") for b in result.content if getattr(b, "type", "") == "text").strip()
    return {"answer": answer or "(keine Antwort)"}


@router.get("/demo", response_class=HTMLResponse)
def demo_page() -> str:
    return _PAGE


_PAGE = """<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ewtos Office-Brain — Live-Demo</title>
<style>
  :root { --bg:#0f1115; --card:#171a21; --bd:#262b36; --tx:#e7e9ee; --mut:#9aa3b2; --acc:#10b981; }
  * { box-sizing:border-box; }
  body { margin:0; font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--tx); }
  .wrap { max-width:760px; margin:0 auto; padding:28px 18px 60px; }
  h1 { font-size:22px; margin:0 0 2px; }
  .sub { color:var(--mut); margin:0 0 20px; font-size:14px; }
  .card { background:var(--card); border:1px solid var(--bd); border-radius:14px; padding:18px; margin-bottom:16px; }
  label { display:block; font-size:12px; color:var(--mut); margin:0 0 5px; }
  select, input, textarea { width:100%; padding:10px 12px; background:var(--bg); color:var(--tx);
    border:1px solid var(--bd); border-radius:9px; font-size:14px; }
  .row { display:flex; gap:10px; }
  .row > div { flex:1; }
  .hint { font-size:12px; color:var(--mut); margin-top:6px; }
  .hint a { color:var(--acc); }
  #log { display:flex; flex-direction:column; gap:10px; min-height:60px; margin-bottom:12px; }
  .msg { padding:10px 13px; border-radius:11px; max-width:85%; white-space:pre-wrap; }
  .me { align-self:flex-end; background:#1f2937; }
  .ai { align-self:flex-start; background:#11261f; border:1px solid #1c3a2e; }
  .err { align-self:flex-start; color:#fca5a5; font-size:13px; }
  .composer { display:flex; gap:10px; }
  .composer textarea { resize:vertical; min-height:46px; }
  button { padding:10px 16px; border:none; border-radius:9px; background:var(--acc); color:#04130d;
    font-weight:700; cursor:pointer; font-size:14px; }
  button:disabled { opacity:.5; cursor:default; }
  .ex { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
  .ex button { background:#1f2937; color:var(--tx); font-weight:500; font-size:13px; padding:6px 10px; }
  .foot { color:var(--mut); font-size:12px; margin-top:18px; text-align:center; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Ewtos Office-Brain — Live-Demo</h1>
  <p class="sub">Chatte mit einem Beispiel-Vault. <b>Bring deinen eigenen Schlüssel</b> —
     er bleibt in deinem Browser, wird nicht gespeichert. Diese Demo ist read-only.</p>

  <div class="card">
    <div class="row">
      <div>
        <label>Anbieter</label>
        <select id="provider">
          <option value="gemini">Google Gemini (kostenloser Tier)</option>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic (Claude)</option>
        </select>
      </div>
      <div>
        <label>API-Key</label>
        <input id="key" type="password" placeholder="Dein API-Key" autocomplete="off">
      </div>
    </div>
    <div class="hint" id="keyhint">
      Noch keinen? <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">
      Kostenlosen Gemini-Key holen →</a>
    </div>
    <div style="margin-top:12px">
      <label>Modell</label>
      <input id="model" list="models" autocomplete="off" spellcheck="false">
      <datalist id="models"></datalist>
      <div class="hint">Frei editierbar — z.B. ein neueres Modell, falls eines abgekündigt wurde.</div>
    </div>
  </div>

  <div class="card">
    <div id="log"></div>
    <div class="composer">
      <textarea id="msg" placeholder="Frag etwas zum Beispiel-Vault…"></textarea>
      <button id="send">Senden</button>
    </div>
    <div class="ex" id="examples">
      <button data-q="Was ist die Karpathy-Methode und warum kein RAG?">Karpathy-Methode?</button>
      <button data-q="Welche Tools bietet Ewtos Office-Brain im Browser?">Welche Tools?</button>
      <button data-q="Wie funktioniert das mit dem eigenen Server und den Daten?">Daten & Server?</button>
    </div>
  </div>

  <div class="foot">Gefällt's dir? Hol dir die Extension + den eigenen Server auf ewtos.com.</div>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  const log = $("log"), keyEl = $("key"), provEl = $("provider"), msgEl = $("msg"), sendBtn = $("send"), modelEl = $("model");
  const KEYSTORE = "ob_demo_key";
  try { keyEl.value = sessionStorage.getItem(KEYSTORE) || ""; } catch {}
  keyEl.addEventListener("change", () => { try { sessionStorage.setItem(KEYSTORE, keyEl.value); } catch {} });
  const hints = {
    gemini: 'Noch keinen? <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Kostenlosen Gemini-Key holen →</a>',
    openai: 'Key unter <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com/api-keys</a>',
    anthropic: 'Key unter <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>'
  };
  // Nur VORSCHLÄGE — das Feld ist frei editierbar, du kannst jedes Modell eintippen.
  const MODELS = {
    gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"],
    openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
    anthropic: ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-8"]
  };
  function applyProvider(resetModel) {
    const p = provEl.value;
    $("keyhint").innerHTML = hints[p];
    $("models").innerHTML = (MODELS[p] || []).map((m) => '<option value="' + m + '">').join("");
    if (resetModel || !modelEl.value.trim()) modelEl.value = (MODELS[p] || [""])[0];
  }
  provEl.addEventListener("change", () => applyProvider(true));
  applyProvider(false);

  const history = [];
  function bubble(cls, text) {
    const d = document.createElement("div");
    d.className = "msg " + cls; d.textContent = text; log.appendChild(d);
    log.scrollIntoView({ block: "end" }); return d;
  }
  async function ask(q) {
    const key = keyEl.value.trim();
    if (!key) { bubble("err", "Bitte zuerst einen API-Key eintragen."); keyEl.focus(); return; }
    if (!q) return;
    bubble("me", q);
    msgEl.value = ""; sendBtn.disabled = true;
    const thinking = bubble("ai", "…");
    try {
      const res = await fetch("/demo/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: provEl.value, api_key: key, model: modelEl.value.trim(), message: q, history })
      });
      const data = await res.json();
      if (!res.ok) { thinking.remove(); bubble("err", data.detail || ("Fehler " + res.status)); return; }
      thinking.textContent = data.answer;
      history.push({ role: "user", content: q }, { role: "assistant", content: data.answer });
    } catch (e) {
      thinking.remove(); bubble("err", "Server nicht erreichbar.");
    } finally { sendBtn.disabled = false; }
  }
  sendBtn.addEventListener("click", () => ask(msgEl.value.trim()));
  msgEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(msgEl.value.trim()); } });
  $("examples").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) ask(b.dataset.q); });
</script>
</body>
</html>"""
