// Vault-Datei im Browser-Tab: links Ansehen/Bearbeiten, rechts Chat zur Datei. ewtos.com
import { el } from "../sidepanel/dom.js";
import { getHttpBase } from "../sidepanel/modules/api.js";
import { renderMarkdown, openInObsidian } from "../sidepanel/markdown.js";
import { applyTheme } from "../sidepanel/modules/theme.js";

// Tools, die die angeheftete Datei verändern → danach Ansicht links neu laden.
const WRITE_TOOLS = new Set(["insert_into_open_file", "write_wiki_page", "generate_image"]);

const params = new URLSearchParams(location.search);
const vaultId = params.get("vault_id") || "";
const relPath = params.get("rel_path") || "";
const chatModeParam = params.get("chat_mode") || "file"; // "vault" wenn vom FAB geöffnet

const SCRATCHPAD_PATH = "notes/scratchpad.md";

let httpBase = "";
let vault = null;
let canWrite = false;
let vaultName = "";
let rawContent = "";
let editing = false;
let chatBusy = false;
let leftDirty = false;
let explorerAllowDelete = false;
let deleted = false;
let chatMode = chatModeParam;
let currentLoadedPath = chatMode === "vault" ? SCRATCHPAD_PATH : relPath;

const viewEl = document.getElementById("ws-view");
const editorEl = document.getElementById("ws-editor");
const toolbarEl = document.getElementById("ws-left-toolbar");
const leftStatusEl = document.getElementById("ws-left-status");
const bannerEl = document.getElementById("ws-changed-banner");
const chatLogEl = document.getElementById("ws-chat-log");
const chatStatusEl = document.getElementById("ws-chat-status");
const chatInputEl = document.getElementById("ws-chat-input");
const chatSendBtn = document.getElementById("ws-chat-send");

function errText(er, status) {
  const d = er && er.detail;
  if (typeof d === "string") return d;
  if (d) return JSON.stringify(d);
  return `HTTP ${status}`;
}

function setLeftStatus(msg, kind = "") {
  leftStatusEl.textContent = msg || "";
  leftStatusEl.className = "ws-left-status" + (kind ? " " + kind : "");
}

function assetUrl(rel) {
  return `${httpBase}/tools/vault_asset/${encodeURIComponent(vaultId)}/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

// Lokale Vault-Bilder über den Asset-Endpoint laden (gleiche Logik wie im Sidepanel).
function wireVaultImages(root) {
  root.querySelectorAll("img.md-image[data-vault-src]").forEach((img) => {
    const rel = img.getAttribute("data-vault-src");
    img.src = assetUrl(rel);
    img.addEventListener("error", () => {
      img.replaceWith(document.createTextNode(`[Bild nicht gefunden: ${rel}]`));
    });
  });
}

const splitEl = document.getElementById("ws-split");
const layoutToggleBtn = document.getElementById("ws-layout-toggle");
let chatLayout = "bottom"; // "bottom" (Default, Chat unter der Datei) | "side"

function applyLayout(layout) {
  chatLayout = layout === "side" ? "side" : "bottom";
  splitEl.classList.toggle("ws-layout-side", chatLayout === "side");
  layoutToggleBtn.textContent = chatLayout === "side" ? "Chat: seitlich" : "Chat: unten";
}

async function loadStoredLayout() {
  try {
    const { workspaceChatLayout } = await chrome.storage.local.get("workspaceChatLayout");
    applyLayout(workspaceChatLayout || "bottom");
  } catch (_) {
    applyLayout("bottom");
  }
}

function toggleLayout() {
  applyLayout(chatLayout === "side" ? "bottom" : "side");
  chrome.storage.local.set({ workspaceChatLayout: chatLayout });
}

async function applyStoredTheme() {
  try {
    const { theme = "neutral", darkMode = false } = await chrome.storage.local.get(["theme", "darkMode"]);
    applyTheme(theme, darkMode);
  } catch (_) {}
}

async function loadVaultMeta() {
  try {
    const res = await fetch(`${httpBase}/vaults`);
    const data = await res.json();
    vault = (data.vaults || []).find((v) => v.id === vaultId) || null;
    canWrite = !!vault?.permissions?.write_files;
    vaultName = vault ? (vault.path.split(/[\\/]/).filter(Boolean).pop() || vault.name) : "";
  } catch (_) {
    vault = null;
    canWrite = false;
  }
  document.getElementById("ws-vault-name").textContent = vault ? vault.name : "";
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
function isImagePath(p) {
  const ext = p.slice(p.lastIndexOf(".")).toLowerCase();
  return IMAGE_EXTS.has(ext);
}

async function loadFile(path) {
  if (path !== undefined) currentLoadedPath = path;
  if (isImagePath(currentLoadedPath)) {
    rawContent = "";
    renderView();
    setLeftStatus("");
    return;
  }
  setLeftStatus("lade Datei…");
  const url = `${httpBase}/tools/vault_file/${encodeURIComponent(vaultId)}?rel_path=${encodeURIComponent(currentLoadedPath)}`;
  const res = await fetch(url);
  if (!res.ok) {
    rawContent = "";
    renderView();
    setLeftStatus(res.status === 404 ? "Datei noch nicht vorhanden." : `HTTP ${res.status}`, res.status === 404 ? "" : "error");
    return;
  }
  const data = await res.json();
  rawContent = data.content || "";
  renderView();
  setLeftStatus("");
}

function renderImageView() {
  editing = false;
  editorEl.style.display = "none";
  bannerEl.style.display = "none";
  viewEl.style.display = "";
  viewEl.replaceChildren();
  const wrap = el("div", { className: "ws-image-view" });
  const img = el("img", { className: "ws-image-preview", alt: currentLoadedPath });
  img.src = assetUrl(currentLoadedPath);
  const info = el("div", { className: "ws-image-info" });
  const name = currentLoadedPath.split("/").pop();
  const ext = name.slice(name.lastIndexOf(".") + 1).toUpperCase();
  info.textContent = `${name} · ${ext}`;
  img.addEventListener("load", () => {
    info.textContent = `${name} · ${ext} · ${img.naturalWidth}×${img.naturalHeight}px`;
  });
  img.addEventListener("error", () => {
    info.textContent = `${name} · Bild konnte nicht geladen werden`;
  });
  wrap.append(img, info);
  viewEl.append(wrap);
  toolbarEl.replaceChildren();
}

function renderView() {
  if (isImagePath(currentLoadedPath)) { renderImageView(); return; }
  editing = false;
  editorEl.style.display = "none";
  viewEl.style.display = "";
  bannerEl.style.display = "none";
  viewEl.innerHTML = renderMarkdown(rawContent);
  wireVaultImages(viewEl);
  buildToolbar();
}

function buildToolbar() {
  toolbarEl.replaceChildren();
  if (editing) {
    const saveBtn = el("button", { type: "button", className: "ws-btn ws-btn-primary", textContent: "Speichern" });
    saveBtn.addEventListener("click", saveFile);
    const cancelBtn = el("button", { type: "button", className: "ws-btn", textContent: "Abbrechen" });
    cancelBtn.addEventListener("click", renderView);
    toolbarEl.append(saveBtn, cancelBtn);
    return;
  }
  if (canWrite) {
    const editBtn = el("button", { type: "button", className: "ws-btn", textContent: "Bearbeiten" });
    editBtn.addEventListener("click", showEditor);
    toolbarEl.append(editBtn);
  }
  if (canWrite && explorerAllowDelete) {
    const delBtn = el("button", { type: "button", className: "ws-btn", textContent: "🗑 Löschen" });
    delBtn.addEventListener("click", deleteFile);
    toolbarEl.append(delBtn);
  }
  const obsidianBtn = el("button", { type: "button", className: "ws-btn", textContent: "✎ In Obsidian", title: "Diese Datei in Obsidian öffnen" });
  obsidianBtn.addEventListener("click", () => { if (vaultName) openInObsidian(vaultName, relPath); });
  toolbarEl.append(obsidianBtn);
  if (!canWrite) {
    toolbarEl.append(el("span", { className: "ws-hint", textContent: "Nur Ansicht — Schreibrecht (write_files) nicht aktiv" }));
  }
}

async function deleteFile() {
  if (!confirm(`Datei löschen?\n\n${relPath}\n\nKann nicht rückgängig gemacht werden.`)) return;
  setLeftStatus("lösche…");
  try {
    const url = `${httpBase}/tools/vault_file/${encodeURIComponent(vaultId)}?rel_path=${encodeURIComponent(relPath)}`;
    const res = await fetch(url, { method: "DELETE" });
    if (!res.ok) {
      const er = await res.json().catch(() => ({}));
      throw new Error(errText(er, res.status));
    }
    deleted = true;
    editing = false;
    editorEl.style.display = "none";
    bannerEl.style.display = "none";
    toolbarEl.replaceChildren();
    viewEl.replaceChildren(el("div", { className: "ws-deleted-note", textContent: "Datei wurde gelöscht. Dieser Tab kann geschlossen werden." }));
    chatInputEl.disabled = true;
    chatSendBtn.disabled = true;
    setLeftStatus("");
  } catch (err) {
    setLeftStatus("Löschen fehlgeschlagen: " + (err.message || err), "error");
  }
}

function showEditor() {
  editing = true;
  editorEl.value = rawContent;
  viewEl.style.display = "none";
  bannerEl.style.display = "none";
  editorEl.style.display = "";
  buildToolbar();
  editorEl.focus();
}

async function saveFile() {
  setLeftStatus("speichere…");
  try {
    const url = `${httpBase}/tools/vault_file/${encodeURIComponent(vaultId)}?rel_path=${encodeURIComponent(relPath)}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: editorEl.value }),
    });
    if (res.status === 403) {
      setLeftStatus("Kein Schreibrecht (write_files) — in den Einstellungen aktivieren.", "error");
      const optBtn = el("button", { type: "button", className: "ws-btn", textContent: "Einstellungen öffnen" });
      optBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
      leftStatusEl.append(document.createTextNode(" "), optBtn);
      return;
    }
    if (!res.ok) {
      const er = await res.json().catch(() => ({}));
      throw new Error(errText(er, res.status));
    }
    await loadFile();
    setLeftStatus("Gespeichert.", "success");
  } catch (err) {
    setLeftStatus("Speichern fehlgeschlagen: " + (err.message || err), "error");
  }
}

// Nach einem Chat-Schreibvorgang: im View-Modus automatisch nachladen,
// im Editor-Modus nicht überschreiben, sondern Banner anbieten.
async function refreshLeftAfterChat() {
  if (deleted) return;
  if (editing) {
    bannerEl.style.display = "";
    return;
  }
  try {
    await loadFile();
  } catch (_) {}
}

// ---- Chat (an die Datei geheftet) -------------------------------------------

function addChatMsg(role, initialText = "") {
  const wrap = el("div", { className: `ws-chat-msg ${role}` });
  const bubble = el("div", { className: "ws-chat-bubble" });
  if (role === "user") {
    bubble.textContent = initialText;
  } else {
    bubble.classList.add("streaming");
  }
  wrap.append(bubble);
  chatLogEl.append(wrap);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
  return bubble;
}

async function sendChat() {
  const message = chatInputEl.value.trim();
  if (!message || chatBusy) return;
  chatBusy = true;
  chatSendBtn.disabled = true;
  chatInputEl.disabled = true;
  chatInputEl.value = "";
  addChatMsg("user", message);
  const bubble = addChatMsg("assistant");
  let assistantText = "";
  leftDirty = false;

  function dispatch(event, data) {
    if (event === "text_delta") {
      assistantText += data.text;
      bubble.innerHTML = renderMarkdown(assistantText);
      wireVaultImages(bubble);
      chatLogEl.scrollTop = chatLogEl.scrollHeight;
    } else if (event === "tool_start") {
      const path = data.input?.path ? ` ${data.input.path}` : "";
      chatStatusEl.textContent = `${data.tool}${path}…`;
    } else if (event === "tool_end") {
      if (data.ok && WRITE_TOOLS.has(data.tool)) leftDirty = true;
      if (!data.ok) chatStatusEl.textContent = `Tool fehlgeschlagen: ${data.tool}`;
    } else if (event === "done") {
      bubble.classList.remove("streaming");
      if (!assistantText.trim()) bubble.textContent = "(keine Antwort)";
      const u = data.usage || {};
      chatStatusEl.textContent = `fertig — ${u.input_tokens || 0} in / ${u.output_tokens || 0} out`;
      if (leftDirty) refreshLeftAfterChat();
    } else if (event === "error") {
      bubble.classList.remove("streaming");
      bubble.classList.add("error");
      bubble.textContent = "Fehler: " + (data.message || "?");
    }
  }

  try {
    const res = await fetch(`${httpBase}/tools/chat/${encodeURIComponent(vaultId)}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({
        message,
        ...(chatMode === "file" ? { pinned_file: { vault_id: vaultId, rel_path: currentLoadedPath } } : {}),
      }),
    });
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => `HTTP ${res.status}`);
      throw new Error(errText || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\n\n/);
      buffer = events.pop();
      for (const block of events) {
        let eventName = "message";
        const dataLines = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;
        let parsed = null;
        try { parsed = JSON.parse(dataLines.join("\n")); } catch { continue; }
        dispatch(eventName, parsed);
      }
    }
  } catch (err) {
    bubble.classList.remove("streaming");
    bubble.classList.add("error");
    bubble.textContent = "Fehler: " + (err.message || err);
  } finally {
    chatBusy = false;
    chatSendBtn.disabled = false;
    chatInputEl.disabled = false;
    chatInputEl.focus();
  }
}

// ---- Boot -------------------------------------------------------------------

// Eigene Tab-ID merken, um Broadcasts auf den richtigen Workspace-Tab zu filtern.
let myTabId = null;
try { chrome.tabs.getCurrent((tab) => { myTabId = tab ? tab.id : null; }); } catch (_) {}

// Sidepanel bittet, eine andere Datei in DIESEM Tab zu öffnen (Tab-Wiederverwendung).
// Bei ungespeicherten Editor-Änderungen erst nachfragen.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "ws_open_file") return;
  if (msg.targetTabId != null && myTabId != null && msg.targetTabId !== myTabId) return;
  const dirty = editing && editorEl.value !== rawContent;
  if (dirty && !confirm("Ungespeicherte Änderungen verwerfen und andere Datei öffnen?")) {
    sendResponse({ ok: false });
    return;
  }
  sendResponse({ ok: true });
  const cmExtra = msg.chat_mode ? `&chat_mode=${encodeURIComponent(msg.chat_mode)}` : "";
  location.href = chrome.runtime.getURL(
    `workspace/workspace.html?vault_id=${encodeURIComponent(msg.vault_id)}&rel_path=${encodeURIComponent(msg.rel_path)}${cmExtra}`
  );
});

async function boot() {
  await applyStoredTheme();
  await loadStoredLayout();
  layoutToggleBtn.addEventListener("click", toggleLayout);

  if (!vaultId || !relPath) {
    setLeftStatus("Fehlende Parameter (vault_id / rel_path).", "error");
    return;
  }

  document.getElementById("ws-file-path").textContent = relPath;
  document.title = `${relPath} — EwtosBrain`;

  try {
    const { explorerAllowDelete: allow } = await chrome.storage.local.get("explorerAllowDelete");
    explorerAllowDelete = !!allow;
  } catch (_) {}

  httpBase = await getHttpBase();
  await loadVaultMeta();

  document.getElementById("ws-reload-btn").addEventListener("click", () => loadFile().catch(() => {}));

  // Wiki-Links / relative .md-Links öffnen die Zieldatei in einem neuen Tab.
  viewEl.addEventListener("click", (e) => {
    const link = e.target.closest("a.wiki-link");
    if (!link) return;
    e.preventDefault();
    let rel = link.getAttribute("data-rel");
    if (!rel) return;
    if (!/\.(md|txt)$/i.test(rel)) rel = rel + ".md";
    const url = chrome.runtime.getURL(
      `workspace/workspace.html?vault_id=${encodeURIComponent(vaultId)}&rel_path=${encodeURIComponent(rel)}`
    );
    chrome.tabs.create({ url });
  });

  const chatTitleEl = document.getElementById("ws-chat-title");
  const modeToggleBtn = document.getElementById("ws-mode-toggle");
  const filePathEl = document.getElementById("ws-file-path");

  // Initial-Zustand wenn via FAB mit chat_mode=vault geöffnet
  if (chatModeParam === "vault") {
    chatTitleEl.textContent = "Chat mit Vault";
    if (modeToggleBtn) modeToggleBtn.style.display = "none"; // kein Toggle — kein "original file"
    // Echten Scratchpad-Pfad vom Server holen (inbox/ oder notes/ je nach Vault-Schema)
    try {
      const r = await fetch(`${httpBase}/tools/notes/scratchpad?vault_id=${encodeURIComponent(vaultId)}`);
      if (r.ok) {
        const data = await r.json();
        if (data.rel_path) {
          currentLoadedPath = data.rel_path;
        }
      }
    } catch (_) {}
    filePathEl.textContent = currentLoadedPath;
    document.title = `${currentLoadedPath} — EwtosBrain`;
  }

  modeToggleBtn?.addEventListener("click", () => {
    chatMode = chatMode === "file" ? "vault" : "file";
    const isVault = chatMode === "vault";
    chatTitleEl.textContent = isVault ? "Chat mit Vault" : "Chat zur Datei";
    modeToggleBtn.textContent = isVault ? "↔ Datei" : "↔ Vault";
    chatLogEl.replaceChildren();
    chatStatusEl.textContent = "";
    if (editing) renderView(); // Editierung abbrechen beim Mode-Wechsel
    const targetPath = isVault ? SCRATCHPAD_PATH : relPath;
    filePathEl.textContent = targetPath;
    document.title = `${targetPath} — EwtosBrain`;
    loadFile(targetPath).catch(() => {});
  });

  chatSendBtn.addEventListener("click", sendChat);
  chatInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });

  try {
    await loadFile();
  } catch (err) {
    setLeftStatus("Datei konnte nicht geladen werden: " + (err.message || err), "error");
  }
}

boot();
