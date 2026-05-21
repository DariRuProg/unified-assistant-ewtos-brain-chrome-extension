// Sidepanel: connection status, tab navigation, tool runner. ewtos.com

// ── Theme & Dark Mode ────────────────────────────────────────────────────────

const html = document.documentElement;

function applyTheme(theme, darkMode) {
  if (theme && theme !== "neutral") {
    html.dataset.theme = theme;
  } else {
    delete html.dataset.theme;
  }
  if (darkMode) {
    html.dataset.mode = "dark";
  } else {
    delete html.dataset.mode;
  }
}

function updateDarkToggleIcon(darkMode) {
  const btn = document.getElementById("dark-toggle");
  if (btn) btn.textContent = darkMode ? "☽" : "☀";
}

(async () => {
  const { theme = "neutral", darkMode = false } =
    await chrome.storage.local.get(["theme", "darkMode"]);
  applyTheme(theme, darkMode);
  updateDarkToggleIcon(darkMode);
  toolViewMode = (await chrome.storage.local.get("toolViewMode")).toolViewMode || "list";
})();

chrome.storage.onChanged.addListener((changes) => {
  if (changes.theme !== undefined || changes.darkMode !== undefined) {
    chrome.storage.local.get(["theme", "darkMode"], ({ theme = "neutral", darkMode = false }) => {
      applyTheme(theme, darkMode);
      updateDarkToggleIcon(darkMode);
    });
  }
  if (changes.playlistPick && changes.playlistPick.newValue) {
    checkPendingPlaylistPick();
  }
});

// ── DOM refs ─────────────────────────────────────────────────────────────────

const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const tabsNav = document.getElementById("tabs");
const content = document.getElementById("content");
const openOptions = document.getElementById("open-options");
const reconnectBtn = document.getElementById("reconnect");
const quickActions = document.getElementById("quick-actions");

const TOOL_RENDERERS = {
  youtube_transcript: renderYoutubeTranscript,
  scratchpad: () => renderNotesFile("scratchpad", {
    title: "Note-Taker",
    placeholder: "Notizen, Gedanken, Skizzen... wird automatisch gespeichert.",
  }),
  todos: renderTodos,
  chat: renderChat,
  playlists: renderPlaylistsTool,
  bookmarks: renderBookmarksTool,
  page_scrape: renderPageScrape,
  seo_check: renderSeoCheck,
  image_analyse: renderImageAnalyse,
  color_picker: renderColorPicker,
  screenshot: renderScreenshot,
  url_extractor: renderUrlExtractor,
};

const GROUPS = [
  {
    id: "vault",
    label: "Vault",
    tools: [
      { id: "chat", label: "Chat mit Vault", hint: "Karpathy-Navigation, Claude API", icon: "💬" },
      { id: "scratchpad", label: "Note-Taker", hint: "globaler Scratchpad", icon: "📝" },
      { id: "todos", label: "Todos", hint: "klickbare Liste mit Due-Dates", icon: "✅" },
      { id: "playlists", label: "Playlists", hint: "Video-Sammlungen pro Säule", icon: "🎵" },
      { id: "bookmarks", label: "Bookmarks", hint: "URL-Inbox aus Browser-Capture", icon: "🔖" },
    ],
  },
  {
    id: "web",
    label: "Web",
    tools: [
      { id: "youtube_transcript", label: "YouTube-Transcript", hint: "Transkript aus aktivem Tab", icon: "🎬" },
      { id: "page_scrape", label: "Page-Scrape", hint: "Aktiver Tab → bereinigtes Markdown", icon: "📄" },
      { id: "seo_check", label: "SEO-Check", hint: "Title, Meta, Headings, OG-Tags", icon: "🔍" },
      { id: "image_analyse", label: "Image-Analyse", hint: "Bilder + Alt-Text-Check", icon: "🖼️" },
      { id: "color_picker", label: "Color-Picker", hint: "CSS-Variablen + Farbpalette", icon: "🎨" },
      { id: "screenshot", label: "Screenshot", hint: "Sichtbaren Tab als PNG", icon: "📸" },
      { id: "url_extractor", label: "URL-Extraktor", hint: "Alle Links der aktuellen Seite", icon: "🔗" },
    ],
  },
  {
    id: "code",
    label: "Code",
    tools: [
      { id: "tbd", label: "noch undefiniert", hint: "Sprint 3", soon: true },
    ],
  },
];

const QUICK_TOOLS = [
  { id: "chat",      label: "Chat",  icon: "💬" },
  { id: "scratchpad", label: "Notiz", icon: "📝" },
  { id: "todos",     label: "Todos", icon: "✅" },
  { id: "_briefing", label: "Morgen", icon: "☀", action: showBriefingPanel },
];

let activeTab = GROUPS[0].id;
let activeTool = null;
let toolViewMode = "list";

// Re-bound on each openTool call so renderers can target current tool view.
let panelTitle = null;
let panelBody = null;

async function getHttpBase() {
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  return (serverUrl || "ws://localhost:9988/ws")
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/ws$/, "");
}

setStatus(false, "verbinde...");
renderTabs();
renderToolList();
renderQuickActions();
checkPendingPlaylistPick();
checkPendingBrainPick();
checkActiveTabForYoutube();

chrome.runtime.sendMessage({ type: "get_connection_status" }, (resp) => {
  if (chrome.runtime.lastError) return;
  if (resp) setStatus(!!resp.connected);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "connection_status") setStatus(!!msg.connected);
});

// Wenn das Sidepanel schon offen ist und ein neuer Context-Menu-Pick reinkommt,
// triggert checkPendingPlaylistPick — sonst würde der Picker nie auftauchen.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.playlistPick && changes.playlistPick.newValue) {
    checkPendingPlaylistPick();
  }
  if (area === "local" && changes.brainPick && changes.brainPick.newValue) {
    checkPendingBrainPick();
  }
});

openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());

reconnectBtn.addEventListener("click", () => {
  setStatus(false, "verbinde...");
  chrome.runtime.sendMessage({ type: "reconnect" });
});

document.getElementById("retry-connect")?.addEventListener("click", () => {
  setStatus(false, "verbinde...");
  chrome.runtime.sendMessage({ type: "reconnect" });
});

document.getElementById("dark-toggle").addEventListener("click", async () => {
  const isDark = html.dataset.mode === "dark";
  const { theme = "neutral" } = await chrome.storage.local.get("theme");
  applyTheme(theme, !isDark);
  updateDarkToggleIcon(!isDark);
  chrome.storage.local.set({ darkMode: !isDark });
});

function setStatus(connected, customText) {
  statusDot.classList.toggle("online", connected);
  statusDot.classList.toggle("offline", !connected);
  statusText.textContent = customText ?? (connected ? "verbunden" : "offline");
  const banner = document.getElementById("offline-banner");
  if (banner) banner.classList.toggle("hidden", connected);
}

async function checkPendingPlaylistPick() {
  const { playlistPick } = await chrome.storage.local.get("playlistPick");
  if (!playlistPick || !playlistPick.url) return;
  // ignore stale picks (older than 5 min)
  if (playlistPick.ts && Date.now() - playlistPick.ts > 5 * 60 * 1000) {
    chrome.storage.local.remove("playlistPick");
    return;
  }
  await showPlaylistPicker(playlistPick);
}

async function showPlaylistPicker({ url, title, channel, duration, views, published, likes, description }) {
  const httpBase = await getHttpBase();
  const { selectedVaultId } = await chrome.storage.local.get("selectedVaultId");
  let vaultId = selectedVaultId;
  if (!vaultId) {
    try {
      const res = await fetch(`${httpBase}/vaults`);
      const data = await res.json();
      vaultId = data.vaults?.[0]?.id;
    } catch {}
  }
  if (!vaultId) return;

  let playlists = [];
  try {
    const res = await fetch(`${httpBase}/tools/playlists/${vaultId}`);
    const data = await res.json();
    playlists = data.items || [];
  } catch (err) {
    if (err?.message?.includes("403") || String(err).includes("403")) {
      alert("Playlists-Permission ist im Vault nicht aktiviert. In den Optionen freischalten.");
    }
    chrome.storage.local.remove("playlistPick");
    return;
  }

  const overlay = el("div", { className: "playlist-picker-overlay" });
  const dialog = el("div", { className: "playlist-picker" });
  const titleEl = el("h3", { textContent: "Zu Playlist hinzufügen" });
  const meta = el("div", { className: "playlist-picker-meta" });
  const metaParts = [title || url];
  if (channel) metaParts.push(`· ${channel}`);
  if (duration) metaParts.push(`· ${duration}`);
  if (views) metaParts.push(`· ${views}`);
  meta.textContent = metaParts.join(" ");
  meta.title = url;

  // Auto-Pull-Optionen
  const optsRow = el("div", { className: "playlist-picker-opts" });
  const pullLabel = el("label", { className: "checkbox-row" });
  const pullCheckbox = el("input", { type: "checkbox" });
  pullCheckbox.checked = true;  // default on — User wollte das ja explizit
  const pullText = el("span", { textContent: "Transcript ziehen + Summary erstellen" });
  pullLabel.append(pullCheckbox, pullText);
  const tsLabel = el("label", { className: "checkbox-row" });
  const tsCheckbox = el("input", { type: "checkbox" });
  tsCheckbox.checked = false;  // default: Transcript ohne Zeitstempel
  const tsText = el("span", { textContent: "mit Zeitstempeln" });
  tsLabel.append(tsCheckbox, tsText);
  optsRow.append(pullLabel, tsLabel);

  const list = el("div", { className: "playlist-picker-list" });

  if (!playlists.length) {
    const empty = el("div", { className: "playlist-picker-empty" });
    empty.textContent = "Noch keine Playlists. Lege eine an:";
    const newName = el("input", { type: "text", placeholder: "Playlist-Name (z.B. KI Tutorials)" });
    const createBtn = el("button", { textContent: "Anlegen + hinzufügen" });
    createBtn.addEventListener("click", async () => {
      const name = newName.value.trim();
      if (!name) return;
      try {
        await fetch(`${httpBase}/tools/playlists/${vaultId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        }).then((r) => { if (!r.ok) throw new Error("create failed"); });
        const meta = { url, title, channel, duration, views, published, likes, description };
        const opts = { autoPull: pullCheckbox.checked, withTimestamps: tsCheckbox.checked };
        await addAndMaybePull(httpBase, vaultId, name, meta, opts);
        cleanup(true);
      } catch (err) {
        alert("Fehler: " + err.message);
      }
    });
    empty.append(newName, createBtn);
    list.append(empty);
  } else {
    for (const p of playlists) {
      const btn = el("button", { type: "button", className: "playlist-pick-btn" });
      btn.textContent = `${p.name} (${p.item_count})`;
      btn.addEventListener("click", async () => {
        try {
          const meta = { url, title, channel, duration, views, published, likes, description };
          const opts = { autoPull: pullCheckbox.checked, withTimestamps: tsCheckbox.checked };
          await addAndMaybePull(httpBase, vaultId, p.name, meta, opts);
          cleanup(true);
        } catch (err) {
          alert("Fehler: " + err.message);
        }
      });
      list.append(btn);
    }
    // Plus: neue Playlist gleich anlegen
    const sep = el("div", { className: "playlist-picker-sep", textContent: "oder neu:" });
    const newName = el("input", { type: "text", placeholder: "neuer Playlist-Name" });
    const createBtn = el("button", { textContent: "Anlegen + hinzufügen" });
    createBtn.addEventListener("click", async () => {
      const name = newName.value.trim();
      if (!name) return;
      try {
        await fetch(`${httpBase}/tools/playlists/${vaultId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        }).then((r) => { if (!r.ok) throw new Error("create failed"); });
        const meta = { url, title, channel, duration, views, published, likes, description };
        const opts = { autoPull: pullCheckbox.checked, withTimestamps: tsCheckbox.checked };
        await addAndMaybePull(httpBase, vaultId, name, meta, opts);
        cleanup(true);
      } catch (err) {
        alert("Fehler: " + err.message);
      }
    });
    list.append(sep, newName, createBtn);
  }

  const cancelBtn = el("button", { type: "button", className: "secondary", textContent: "Abbrechen" });
  cancelBtn.addEventListener("click", () => cleanup(false));

  dialog.append(titleEl, meta, optsRow, list, cancelBtn);
  overlay.append(dialog);
  document.body.append(overlay);

  function cleanup(success) {
    chrome.storage.local.remove("playlistPick");
    overlay.remove();
  }
}

async function addAndMaybePull(httpBase, vaultId, name, meta, opts) {
  const { url, title, channel, duration, views, published, likes, description } = meta;
  const { autoPull, withTimestamps } = opts;

  // 1) Add to playlist (creates video page with all metadata)
  const addRes = await fetch(
    `${httpBase}/tools/playlists/${vaultId}/${encodeURIComponent(name)}/items`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        title,
        youtuber: channel,
        dauer: duration,
        views,
        published,
        likes,
        description,
      }),
    },
  );
  if (!addRes.ok) {
    const text = await addRes.text().catch(() => "");
    throw new Error(`Add failed (${addRes.status}): ${text}`);
  }
  const addData = await addRes.json();
  if (addData.added === false) {
    const reason = addData.reason === "duplicate"
      ? `'${title}' ist bereits in '${name}'.`
      : `Nicht hinzugefügt: ${addData.reason || "unbekannt"}`;
    alert(reason);
    return addData;
  }
  const videoSlug = (addData.video_page || "").split("/").pop();
  if (!autoPull || !videoSlug) return addData;

  // 2) Auto-Pull: Transcript + Summary as background flow.
  // Hand off to background worker via runtime message — keeps the picker
  // closing instantly while the heavy work runs.
  chrome.runtime.sendMessage({
    type: "auto_pull_video",
    payload: { httpBase, vaultId, slug: videoSlug, url, withTimestamps },
  }).catch(() => {});

  return addData;
}

function renderTabs() {
  tabsNav.replaceChildren();
  for (const g of GROUPS) {
    const b = el("button", {
      type: "button",
      className: "tab" + (g.id === activeTab ? " active" : ""),
      textContent: g.label,
    });
    b.addEventListener("click", () => {
      activeTab = g.id;
      activeTool = null;
      renderTabs();
      renderToolList();
    });
    tabsNav.append(b);
  }
}

function renderToolList() {
  content.replaceChildren();
  const group = GROUPS.find((g) => g.id === activeTab);
  if (!group) return;

  const listHeader = el("div", { className: "tools-header" });
  const toggleBtn = el("button", {
    type: "button",
    className: "view-toggle-btn",
    title: toolViewMode === "grid" ? "Listen-Ansicht" : "Kachel-Ansicht",
    textContent: toolViewMode === "grid" ? "☰" : "⊞",
  });
  toggleBtn.addEventListener("click", async () => {
    toolViewMode = toolViewMode === "grid" ? "list" : "grid";
    await chrome.storage.local.set({ toolViewMode });
    renderToolList();
  });
  listHeader.append(toggleBtn);

  const list = el("ul", { className: "tools " + toolViewMode });
  for (const t of group.tools) {
    const li = el("li", { className: "tool" + (t.soon ? " soon" : "") });
    if (toolViewMode === "grid" && t.icon) {
      li.append(el("span", { className: "tool-icon", textContent: t.icon }));
    }
    li.append(el("span", { className: "tool-label", textContent: t.label }));
    if (toolViewMode === "list" && t.hint) {
      li.append(el("span", { className: "hint", textContent: t.hint }));
    }
    if (t.soon) {
      li.append(el("span", { className: "badge", textContent: "bald" }));
    } else {
      li.addEventListener("click", () => openTool(t.id));
    }
    list.append(li);
  }
  content.append(listHeader, list);
}

function renderQuickActions() {
  quickActions.replaceChildren();
  for (const t of QUICK_TOOLS) {
    const btn = el("button", {
      type: "button",
      className: "quick-btn" + (activeTool === t.id ? " active" : ""),
    });
    if (t.icon) {
      btn.append(el("span", { className: "quick-icon", textContent: t.icon }));
    }
    btn.append(el("span", { textContent: t.label }));
    if (t.action) {
      btn.addEventListener("click", () => t.action());
    } else {
      btn.addEventListener("click", () => openTool(t.id));
    }
    quickActions.append(btn);
  }
}

function openTool(toolId) {
  const renderer = TOOL_RENDERERS[toolId];
  if (!renderer) return;
  for (const g of GROUPS) {
    if (g.tools.some((t) => t.id === toolId)) { activeTab = g.id; break; }
  }
  activeTool = toolId;
  renderTabs();
  renderQuickActions();

  content.replaceChildren();
  const view = el("section", { className: "tool-view" });
  const header = el("div", { className: "tool-header" });
  const back = el("button", { type: "button", className: "back", textContent: "←" });
  back.addEventListener("click", closeTool);
  panelTitle = el("h3");
  header.append(back, panelTitle);
  panelBody = el("div", { className: "tool-body" });
  view.append(header, panelBody);
  content.append(view);

  renderer();
}

function closeTool() {
  activeTool = null;
  panelTitle = null;
  panelBody = null;
  renderQuickActions();
  renderToolList();
}

function renderYoutubeTranscript() {
  panelTitle.textContent = "YouTube-Transcript";

  const urlInput = el("input", { type: "url", placeholder: "https://www.youtube.com/watch?v=..." });
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.url && /youtube\.com\/watch/.test(tab.url)) {
      urlInput.value = tab.url;
    }
  });
  const runBtn = el("button", { textContent: "Transcript holen" });
  const status = el("div", { className: "tool-status" });
  const output = el("textarea", { placeholder: "Ergebnis erscheint hier...", readOnly: true });

  runBtn.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) {
      status.textContent = "URL angeben";
      status.className = "tool-status error";
      return;
    }
    runBtn.disabled = true;
    status.textContent = "läuft... (kann ~10 Sek dauern)";
    status.className = "tool-status";
    output.value = "";

    try {
      const httpBase = await getHttpBase();
      const res = await fetch(`${httpBase}/tools/youtube_transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
      output.value = data?.transcript || "";
      status.textContent = "fertig";
      status.className = "tool-status success";
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
    } finally {
      runBtn.disabled = false;
    }
  });

  panelBody.append(urlInput, runBtn, status, output);
}

async function renderNotesFile(kind, opts) {
  panelTitle.textContent = opts.title;

  const meta = el("div", { className: "tool-status", textContent: "lade..." });
  const textarea = el("textarea", { placeholder: opts.placeholder });
  textarea.classList.add("scratchpad");
  const status = el("div", { className: "tool-status" });

  const exportBtn = el("button", { textContent: "Speichern unter..." });
  const fallbackRow = el("div", { className: "export-row hidden" });
  const fallbackInput = el("input", {
    type: "text",
    placeholder: "absoluter Pfad, z.B. E:\\...\\datei.md",
  });
  const fallbackSave = el("button", { textContent: "Speichern" });
  const fallbackCancel = el("button", { textContent: "Abbrechen" });
  fallbackCancel.classList.add("secondary");
  const fallbackBtns = el("div");
  fallbackBtns.append(fallbackSave, fallbackCancel);
  fallbackRow.append(fallbackInput, fallbackBtns);

  // Promote-to-raw ("Ins Brain") — nur für Scratchpad
  let promoteSection = null;
  if (kind === "scratchpad") {
    const promoteBtn = el("button", { textContent: "Ins Brain", className: "secondary" });
    promoteBtn.style.marginTop = "6px";

    const promoteForm = el("div");
    promoteForm.style.cssText = "display:none;margin-top:8px;padding:10px;border:1px solid var(--border,#ddd);border-radius:6px;background:var(--bg-subtle);";

    const promoteTitle = el("input", { type: "text", placeholder: "Titel (Pflichtfeld)" });
    const promoteSub = el("select");
    ["eigene-notizen", "artikel", "chat-archive"].forEach(s => promoteSub.append(new Option(s, s)));
    const promoteDesc = el("textarea", { placeholder: "Beschreibung (optional)" });
    promoteDesc.style.cssText = "min-height:52px;resize:vertical;margin-top:6px;font-size:12px;";
    const promoteHint = el("div", { className: "tool-status" });
    const promoteSubBtn = el("button", { textContent: "Promote" });
    const promoteCancelBtn = el("button", { textContent: "Abbrechen", className: "secondary" });
    promoteCancelBtn.style.marginLeft = "6px";

    const promoteSubLabel = el("label", { textContent: "Ziel-Ordner:" });
    promoteSubLabel.style.cssText = "margin-top:6px;display:block;";
    const promoteInfoHint = el("div", { className: "tool-status", textContent: "Sucht Datumsblock oder Textmatch im Scratchpad" });
    promoteInfoHint.style.fontSize = "11px";
    const promoteActRow = el("div");
    promoteActRow.style.marginTop = "8px";
    promoteActRow.append(promoteSubBtn, promoteCancelBtn);

    promoteForm.append(
      promoteInfoHint,
      promoteTitle,
      promoteSubLabel,
      promoteSub,
      promoteDesc,
      promoteHint,
      promoteActRow,
    );

    promoteBtn.addEventListener("click", () => {
      promoteForm.style.display = promoteForm.style.display === "none" ? "block" : "none";
    });
    promoteCancelBtn.addEventListener("click", () => {
      promoteForm.style.display = "none";
    });
    promoteSubBtn.addEventListener("click", async () => {
      const title = promoteTitle.value.trim();
      if (!title) { promoteHint.textContent = "Titel erforderlich"; promoteHint.className = "tool-status error"; return; }
      promoteSubBtn.disabled = true;
      promoteHint.textContent = "promoting...";
      promoteHint.className = "tool-status";
      try {
        const httpBase2 = await getHttpBase();
        const vaultId = await getActiveVaultId(httpBase2);
        if (!vaultId) throw new Error("Kein Vault konfiguriert");
        const res = await fetch(`${httpBase2}/tools/promote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vault_id: vaultId,
            source: "scratchpad",
            identifier: title,
            target_subfolder: promoteSub.value,
            title,
            description: promoteDesc.value.trim() || null,
          }),
        });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch {}
        if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
        promoteHint.textContent = `Gespeichert: ${data.data?.raw_path || "OK"}`;
        promoteHint.className = "tool-status success";
        promoteTitle.value = "";
        promoteDesc.value = "";
      } catch (err) {
        promoteHint.textContent = err.message || String(err);
        promoteHint.className = "tool-status error";
      } finally {
        promoteSubBtn.disabled = false;
      }
    });

    promoteSection = el("div");
    promoteSection.append(promoteBtn, promoteForm);
  }

  panelBody.append(meta, textarea, status, exportBtn, fallbackRow, ...(promoteSection ? [promoteSection] : []));

  const httpBase = await getHttpBase();
  let saveTimer = null;
  let lastSaved = "";
  let started = null;

  function setMeta() {
    meta.textContent = started ? `aktiv seit ${started}` : "";
  }

  function setStatus(text, level = "") {
    status.textContent = text;
    status.className = "tool-status" + (level ? " " + level : "");
  }

  function buildExportBody(filename, content) {
    if (!filename.toLowerCase().endsWith(".md")) return content;
    const today = new Date().toISOString().slice(0, 10);
    return `---\nexported: ${today}\nsource: ${kind}\n---\n\n${content.trimEnd()}\n`;
  }

  function suggestedName() {
    const today = new Date().toISOString().slice(0, 10);
    return `${kind}-${today}.md`;
  }

  async function save() {
    const content = textarea.value;
    if (content === lastSaved) return;
    setStatus("speichere...");
    try {
      const res = await fetch(`${httpBase}/tools/notes/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
      lastSaved = content;
      if (data?.started && !started) { started = data.started; setMeta(); }
      setStatus("gespeichert", "success");
    } catch (err) {
      setStatus("Fehler: " + (err.message || err), "error");
    }
  }

  async function exportViaPicker() {
    const handle = await window.showSaveFilePicker({
      suggestedName: suggestedName(),
      types: [
        { description: "Markdown", accept: { "text/markdown": [".md"] } },
        { description: "Text", accept: { "text/plain": [".txt"] } },
      ],
    });
    const writable = await handle.createWritable();
    await writable.write(buildExportBody(handle.name, textarea.value));
    await writable.close();
    return handle.name;
  }

  async function exportViaServer(target) {
    const res = await fetch(`${httpBase}/tools/notes/${kind}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: target, content: textarea.value }),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
    return data.path?.split(/[\\/]/).pop() || target;
  }

  textarea.addEventListener("input", () => {
    clearTimeout(saveTimer);
    setStatus("ungespeichert...");
    saveTimer = setTimeout(save, 1200);
  });

  textarea.addEventListener("blur", () => {
    clearTimeout(saveTimer);
    save();
  });

  exportBtn.addEventListener("click", async () => {
    clearTimeout(saveTimer);
    await save();
    if (!window.showSaveFilePicker) {
      fallbackRow.classList.remove("hidden");
      fallbackInput.focus();
      return;
    }
    try {
      const name = await exportViaPicker();
      setStatus("exportiert: " + name, "success");
    } catch (err) {
      if (err?.name === "AbortError") { setStatus("Export abgebrochen"); return; }
      setStatus("Export-Fehler: " + (err.message || err), "error");
    }
  });

  fallbackCancel.addEventListener("click", () => {
    fallbackRow.classList.add("hidden");
    fallbackInput.value = "";
  });

  fallbackSave.addEventListener("click", async () => {
    const target = fallbackInput.value.trim();
    if (!target) { setStatus("Pfad fehlt", "error"); return; }
    fallbackSave.disabled = true;
    try {
      const name = await exportViaServer(target);
      setStatus("exportiert: " + name, "success");
      fallbackRow.classList.add("hidden");
      fallbackInput.value = "";
    } catch (err) {
      setStatus("Export-Fehler: " + (err.message || err), "error");
    } finally {
      fallbackSave.disabled = false;
    }
  });

  try {
    const res = await fetch(`${httpBase}/tools/notes/${kind}`);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
    started = data.started;
    textarea.value = data.content || "";
    lastSaved = textarea.value;
    setMeta();
    setStatus(textarea.value ? "geladen" : "leer — los geht's", "");
  } catch (err) {
    setStatus("Laden fehlgeschlagen: " + (err.message || err), "error");
  }
}

const TODO_LINE_RE = /^(\s*)- \[( |x|X)\] (.*)$/;
const DUE_RE = /@(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/;

function parseTodoLines(content) {
  return content.split("\n").map((line, i) => {
    const m = line.match(TODO_LINE_RE);
    if (!m) return { i, isTodo: false, raw: line };
    const rawText = m[3];
    const due = parseDue(rawText);
    return {
      i,
      isTodo: true,
      indent: m[1],
      checked: m[2].toLowerCase() === "x",
      text: due ? rawText.replace(DUE_RE, "").replace(/\s+/g, " ").trim() : rawText,
      due,
    };
  });
}

function parseDue(text) {
  const m = text.match(DUE_RE);
  if (!m) return null;
  const date = m[1];
  const time = m[2] || null;
  const iso = `${date}T${time || "23:59"}:00`;
  const ts = new Date(iso);
  if (isNaN(ts.getTime())) return null;
  return { date, time, ts };
}

function formatDue(due) {
  const now = new Date();
  const diffMs = due.ts - now;
  const min = Math.round(Math.abs(diffMs) / 60000);
  const h = Math.round(Math.abs(diffMs) / 3600000);
  const d = Math.round(Math.abs(diffMs) / 86400000);
  const t = due.time ? ` ${due.time}` : "";

  if (diffMs < 0) {
    if (min < 60) return `überfällig ${min}min`;
    if (h < 24) return `überfällig ${h}h`;
    return `überfällig ${d}d`;
  }
  if (min < 60) return `in ${min}min`;
  if (h < 24) return due.time ? `heute ${due.time}` : "heute";
  if (d === 1) return due.time ? `morgen ${due.time}` : "morgen";
  if (d < 7) return `in ${d}d${t}`;
  const dd = new Date(due.date);
  return dd.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }) + t;
}

function dueLevel(due) {
  if (!due) return "";
  const diffMs = due.ts - new Date();
  if (diffMs < 0) return "overdue";
  if (diffMs < 24 * 3600 * 1000) return "soon";
  return "normal";
}

function setLine(content, index, newLine) {
  const lines = content.split("\n");
  lines[index] = newLine;
  return lines.join("\n");
}

function deleteLine(content, index) {
  const lines = content.split("\n");
  lines.splice(index, 1);
  return lines.join("\n");
}

function appendTodo(content, text) {
  const trimmed = content.replace(/\s+$/, "");
  const sep = trimmed ? "\n" : "";
  return trimmed + sep + "- [ ] " + text;
}

async function renderTodos() {
  panelTitle.textContent = "Todos";

  const meta = el("div", { className: "tool-status", textContent: "lade..." });
  const list = el("div", { className: "todo-list" });

  const addForm = el("form", { className: "todo-add" });
  const addInput = el("input", {
    type: "text",
    placeholder: "neues Todo... optional @2026-05-04 14:00",
    title: "Format für Termin: @YYYY-MM-DD oder @YYYY-MM-DD HH:MM",
  });
  const addBtn = el("button", { type: "submit", textContent: "+" });
  addForm.append(addInput, addBtn);

  const sourceArea = el("textarea", { placeholder: "Markdown-Quelle (- [ ] / - [x])" });
  sourceArea.classList.add("scratchpad", "hidden");

  const status = el("div", { className: "tool-status" });

  const toolbar = el("div", { className: "todo-toolbar" });
  const sourceToggle = el("button", { type: "button", textContent: "Quellcode" });
  sourceToggle.classList.add("secondary");
  const exportBtn = el("button", { type: "button", textContent: "Speichern unter..." });
  toolbar.append(sourceToggle, exportBtn);

  const fallbackRow = el("div", { className: "export-row hidden" });
  const fallbackInput = el("input", { type: "text", placeholder: "absoluter Pfad, z.B. E:\\...\\datei.md" });
  const fallbackSave = el("button", { type: "button", textContent: "Speichern" });
  const fallbackCancel = el("button", { type: "button", textContent: "Abbrechen" });
  fallbackCancel.classList.add("secondary");
  const fallbackBtns = el("div");
  fallbackBtns.append(fallbackSave, fallbackCancel);
  fallbackRow.append(fallbackInput, fallbackBtns);

  panelBody.append(meta, list, addForm, sourceArea, status, toolbar, fallbackRow);

  const httpBase = await getHttpBase();
  let content = "";
  let saveTimer = null;
  let started = null;
  let sourceMode = false;

  function setMeta() {
    meta.textContent = started ? `aktiv seit ${started}` : "";
  }

  function setStatus(text, level = "") {
    status.textContent = text;
    status.className = "tool-status" + (level ? " " + level : "");
  }

  function render() {
    list.replaceChildren();
    const items = parseTodoLines(content).filter((x) => x.isTodo);
    if (!items.length) {
      list.append(el("div", { className: "todo-empty", textContent: "Keine Todos." }));
      return;
    }
    for (const item of items) {
      const row = el("div", { className: "todo-item" + (item.checked ? " done" : "") });
      const cb = el("input", { type: "checkbox", checked: item.checked });
      cb.addEventListener("change", () => {
        const newMark = cb.checked ? "x" : " ";
        const newLine = `${item.indent}- [${newMark}] ${item.text}`;
        content = setLine(content, item.i, newLine);
        scheduleSave();
        render();
      });
      const text = el("span", { className: "todo-text", textContent: item.text });
      let dueBadge = null;
      if (item.due) {
        dueBadge = el("span", {
          className: "todo-due " + dueLevel(item.due),
          textContent: formatDue(item.due),
          title: item.due.date + (item.due.time ? " " + item.due.time : ""),
        });
      }
      const del = el("button", { type: "button", className: "todo-del", textContent: "×", title: "Löschen" });
      del.addEventListener("click", () => {
        content = deleteLine(content, item.i);
        scheduleSave();
        render();
      });
      row.append(cb, text);
      if (dueBadge) row.append(dueBadge);
      row.append(del);
      list.append(row);
    }
  }

  function scheduleSave(delay = 500) {
    clearTimeout(saveTimer);
    setStatus("ungespeichert...");
    saveTimer = setTimeout(save, delay);
  }

  async function save() {
    if (sourceMode) content = sourceArea.value;
    setStatus("speichere...");
    try {
      const res = await fetch(`${httpBase}/tools/notes/todos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
      if (data?.started && !started) { started = data.started; setMeta(); }
      setStatus("gespeichert", "success");
    } catch (err) {
      setStatus("Fehler: " + (err.message || err), "error");
    }
  }

  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = addInput.value.trim();
    if (!text) return;
    content = appendTodo(content, text);
    addInput.value = "";
    if (sourceMode) sourceArea.value = content;
    render();
    scheduleSave(0);
  });

  sourceToggle.addEventListener("click", () => {
    if (sourceMode) {
      content = sourceArea.value;
      sourceMode = false;
      sourceArea.classList.add("hidden");
      list.classList.remove("hidden");
      addForm.classList.remove("hidden");
      sourceToggle.textContent = "Quellcode";
      render();
      scheduleSave(0);
    } else {
      sourceMode = true;
      sourceArea.value = content;
      sourceArea.classList.remove("hidden");
      list.classList.add("hidden");
      addForm.classList.add("hidden");
      sourceToggle.textContent = "Liste";
    }
  });

  sourceArea.addEventListener("input", () => scheduleSave(1200));

  function buildExportBody(filename) {
    if (!filename.toLowerCase().endsWith(".md")) return content;
    const today = new Date().toISOString().slice(0, 10);
    return `---\nexported: ${today}\nsource: todos\n---\n\n${content.trimEnd()}\n`;
  }

  exportBtn.addEventListener("click", async () => {
    if (sourceMode) content = sourceArea.value;
    clearTimeout(saveTimer);
    await save();
    if (!window.showSaveFilePicker) {
      fallbackRow.classList.remove("hidden");
      fallbackInput.focus();
      return;
    }
    try {
      const today = new Date().toISOString().slice(0, 10);
      const handle = await window.showSaveFilePicker({
        suggestedName: `todos-${today}.md`,
        types: [
          { description: "Markdown", accept: { "text/markdown": [".md"] } },
          { description: "Text", accept: { "text/plain": [".txt"] } },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(buildExportBody(handle.name));
      await writable.close();
      setStatus("exportiert: " + handle.name, "success");
    } catch (err) {
      if (err?.name === "AbortError") { setStatus("Export abgebrochen"); return; }
      setStatus("Export-Fehler: " + (err.message || err), "error");
    }
  });

  fallbackCancel.addEventListener("click", () => {
    fallbackRow.classList.add("hidden");
    fallbackInput.value = "";
  });

  fallbackSave.addEventListener("click", async () => {
    const target = fallbackInput.value.trim();
    if (!target) { setStatus("Pfad fehlt", "error"); return; }
    fallbackSave.disabled = true;
    try {
      const res = await fetch(`${httpBase}/tools/notes/todos/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: target, content }),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
      setStatus("exportiert: " + (data.path?.split(/[\\/]/).pop() || target), "success");
      fallbackRow.classList.add("hidden");
      fallbackInput.value = "";
    } catch (err) {
      setStatus("Export-Fehler: " + (err.message || err), "error");
    } finally {
      fallbackSave.disabled = false;
    }
  });

  try {
    const res = await fetch(`${httpBase}/tools/notes/todos`);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
    started = data.started;
    content = data.content || "";
    setMeta();
    render();
    setStatus(content ? "geladen" : "leer — leg los", "");
  } catch (err) {
    setStatus("Laden fehlgeschlagen: " + (err.message || err), "error");
  }
}

async function renderChat() {
  panelTitle.textContent = "Chat mit Vault";

  const httpBase = await getHttpBase();

  // Header: vault picker + meta line
  const header = el("div", { className: "chat-header" });
  const vaultSelect = el("select", { className: "vault-picker" });
  header.append(vaultSelect);
  const meta = el("div", { className: "tool-status", textContent: "lade Vaults..." });

  const log = el("div", { className: "chat-log" });
  const inputWrap = el("form", { className: "chat-input" });
  const inputArea = el("textarea", { placeholder: "Frage an den Vault... (Enter = senden, Shift+Enter = Zeilenumbruch)", rows: 2 });
  const sendBtn = el("button", { type: "submit", textContent: "→" });
  const micBtn = el("button", { type: "button", textContent: "🎙", title: "Spracheingabe" });
  micBtn.classList.add("mic-btn");
  inputWrap.append(inputArea, micBtn, sendBtn);

  const toolbar = el("div", { className: "chat-toolbar" });
  const clearBtn = el("button", { type: "button", textContent: "Verlauf löschen" });
  clearBtn.classList.add("secondary");
  toolbar.append(clearBtn);

  const status = el("div", { className: "tool-status" });

  let chatMode = "vault";

  const modeRow = el("div", { className: "chat-mode-row" });
  const vaultBtn = el("button", { type: "button", className: "chat-mode-btn active", textContent: "📚 Vault" });
  const pageBtn  = el("button", { type: "button", className: "chat-mode-btn", textContent: "🌐 Seite" });
  modeRow.append(vaultBtn, pageBtn);

  vaultBtn.addEventListener("click", () => {
    chatMode = "vault";
    vaultBtn.classList.add("active");
    pageBtn.classList.remove("active");
  });
  pageBtn.addEventListener("click", async () => {
    chatMode = "page";
    pageBtn.classList.add("active");
    vaultBtn.classList.remove("active");
    const stored = (await chrome.storage.local.get("lastPageScrape")).lastPageScrape;
    if (stored?.title) {
      setStatus(`Seite: ${stored.title}`);
    } else {
      setStatus("Kein Seiteninhalt — zuerst Page-Scrape ausführen", "error");
    }
  });

  panelBody.append(header, modeRow, meta, log, status, inputWrap, toolbar);

  let busy = false;
  let currentVaultId = null;

  function renderLog(messages) {
    log.replaceChildren();
    const visible = messages.filter((m) => typeof m.content === "string");
    if (!visible.length) {
      log.append(el("div", { className: "chat-empty", textContent: "Noch keine Nachrichten. Frag den Vault was!" }));
      return;
    }
    for (const m of visible) {
      const bubble = el("div", { className: "chat-msg " + m.role });
      if (m.role === "assistant") {
        bubble.innerHTML = renderMarkdown(m.content);
      } else {
        bubble.textContent = m.content;
      }
      log.append(bubble);
    }
    log.scrollTop = log.scrollHeight;
  }

  function setStatus(text, level = "") {
    status.textContent = text;
    status.className = "tool-status" + (level ? " " + level : "");
  }

  function showEmptyState(message, withOptionsLink = true) {
    panelBody.replaceChildren();
    const wrap = el("div", { className: "chat-empty-state" });
    wrap.append(el("p", { textContent: message }));
    if (withOptionsLink) {
      const btn = el("button", { type: "button", textContent: "Einstellungen öffnen" });
      btn.addEventListener("click", () => chrome.runtime.openOptionsPage());
      wrap.append(btn);
    }
    panelBody.append(wrap);
  }

  async function loadVaultChat(vaultId) {
    currentVaultId = vaultId;
    await chrome.storage.local.set({ selectedVaultId: vaultId });
    setStatus("lade...");
    try {
      const res = await fetch(`${httpBase}/tools/chat/${vaultId}`);
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
      const sourceLabel = {
        claude_md: "CLAUDE.md aktiv",
        override: "Override aktiv",
        default: "Default-Prompt (keine CLAUDE.md)",
      }[data.prompt_source] || data.prompt_source || "?";
      meta.textContent = `${data.vault?.name || vaultId} · Modell: ${data.model} · max ${data.max_user_turns} Paare · ${sourceLabel}`;
      renderLog(data.messages || []);
      setStatus("");
      inputArea.focus();
    } catch (err) {
      setStatus("Laden fehlgeschlagen: " + (err.message || err), "error");
    }
  }

  function appendBubble(role, text = "") {
    // Remove "noch keine nachrichten" placeholder if present
    const empty = log.querySelector(".chat-empty");
    if (empty) empty.remove();
    const bubble = el("div", { className: "chat-msg " + role });
    if (text) bubble.textContent = text;
    log.append(bubble);
    log.scrollTop = log.scrollHeight;
    return bubble;
  }

  async function send(message) {
    if (busy) return;
    if (!currentVaultId) {
      setStatus("Bitte zuerst einen Vault auswählen", "error");
      return;
    }
    busy = true;
    sendBtn.disabled = true;
    inputArea.disabled = true;
    micBtn.disabled = true;
    vaultSelect.disabled = true;

    // Echo user message immediately
    appendBubble("user", message);
    const assistantBubble = appendBubble("assistant");
    assistantBubble.classList.add("streaming");
    let assistantText = "";

    setStatus("denkt...");
    try {
      let pageContext = null;
      if (chatMode === "page") {
        const stored = (await chrome.storage.local.get("lastPageScrape")).lastPageScrape;
        if (!stored || !stored.markdown) {
          assistantBubble.classList.remove("streaming");
          assistantBubble.textContent = "Kein Seiteninhalt vorhanden — bitte zuerst das Page-Scrape-Tool ausführen.";
          setStatus("Kein Seiteninhalt", "error");
          busy = false;
          sendBtn.disabled = false;
          inputArea.disabled = false;
          micBtn.disabled = false;
          vaultSelect.disabled = false;
          return;
        }
        pageContext = `Titel: ${stored.title}\nURL: ${stored.url}\n\n${stored.markdown}`.slice(0, 8000);
        setStatus(`Seite: ${stored.title}`);
      }

      const chatBody = { message };
      if (pageContext) chatBody.page_context = pageContext;

      const res = await fetch(`${httpBase}/tools/chat/${currentVaultId}/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(chatBody),
      });
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(errText || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let pendingEvent = null;

      function dispatch(event, data) {
        if (event === "text_delta") {
          assistantText += data.text;
          assistantBubble.innerHTML = renderMarkdown(assistantText);
          log.scrollTop = log.scrollHeight;
        } else if (event === "tool_start") {
          const path = data.input?.path ? ` ${data.input.path}` : "";
          setStatus(`${data.tool}${path}...`);
        } else if (event === "tool_end") {
          // optional: subtle ack — keep status as "denkt..." until next event
          if (!data.ok) setStatus(`${data.tool} fehlgeschlagen`, "error");
        } else if (event === "done") {
          assistantBubble.classList.remove("streaming");
          if (assistantText.trim()) {
            assistantBubble.innerHTML = renderMarkdown(assistantText);
          } else {
            assistantBubble.textContent = "(keine Textantwort)";
          }
          const u = data.usage || {};
          const consulted = data.consulted?.length ? ` · gelesen: ${data.consulted.join(", ")}` : "";
          const cached = u.cache_read_input_tokens ? ` · cache-hit ${u.cache_read_input_tokens}` : "";
          setStatus(`fertig (${u.input_tokens || 0} in / ${u.output_tokens || 0} out${cached})${consulted}`, "success");
        } else if (event === "error") {
          assistantBubble.classList.remove("streaming");
          assistantBubble.textContent = "Fehler: " + (data.message || "unbekannt");
          assistantBubble.classList.add("error");
          setStatus("Fehler: " + (data.message || "unbekannt"), "error");
        }
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by blank lines
        const events = buffer.split(/\n\n/);
        buffer = events.pop(); // keep incomplete trailing
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
      assistantBubble.classList.remove("streaming");
      assistantBubble.classList.add("error");
      assistantBubble.textContent = "Fehler: " + (err.message || err);
      setStatus("Fehler: " + (err.message || err), "error");
    } finally {
      busy = false;
      sendBtn.disabled = false;
      inputArea.disabled = false;
      micBtn.disabled = false;
      vaultSelect.disabled = false;
      inputArea.focus();
    }
  }

  // Spracheingabe via Content-Script-Injection — ewtos.com
  // SpeechRecognition läuft im Tab-Kontext (dort ist getUserMedia erlaubt),
  // Ergebnisse kommen per chrome.runtime.sendMessage zurück.
  let recording = false;
  let baseText = "";

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "transcript_result") {
      inputArea.value = baseText + msg.text;
    } else if (msg.type === "transcript_end") {
      baseText = inputArea.value;
      recording = false;
      micBtn.classList.remove("recording");
      micBtn.title = "Spracheingabe";
    } else if (msg.type === "transcript_error") {
      recording = false;
      micBtn.classList.remove("recording");
      micBtn.title = "Spracheingabe";
      if (msg.error !== "aborted") setStatus("Mikrofon-Fehler: " + msg.error, "error");
    }
  });

  micBtn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (recording) {
      if (tab?.id) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => { if (window.__ewtosMic) { window.__ewtosMic.stop(); } },
        }).catch(() => {});
      }
      recording = false;
      micBtn.classList.remove("recording");
      micBtn.title = "Spracheingabe";
      return;
    }

    if (!tab?.id || !tab.url?.startsWith("http")) {
      setStatus("Spracheingabe braucht eine http(s)-Seite im aktiven Tab", "error");
      return;
    }

    baseText = inputArea.value;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          if (window.__ewtosMic) { window.__ewtosMic.stop(); window.__ewtosMic = null; }
          const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
          if (!SR) return { error: "not_supported" };
          const r = new SR();
          r.lang = "de-DE";
          r.interimResults = true;
          r.continuous = false;
          window.__ewtosMic = r;
          r.onresult = (e) => {
            let text = "";
            for (const res of e.results) text += res[0].transcript;
            chrome.runtime.sendMessage({ type: "transcript_result", text });
          };
          r.onend = () => {
            window.__ewtosMic = null;
            chrome.runtime.sendMessage({ type: "transcript_end" });
          };
          r.onerror = (ev) => {
            window.__ewtosMic = null;
            chrome.runtime.sendMessage({ type: "transcript_error", error: ev.error });
          };
          r.start();
          return { ok: true };
        },
      });
      if (results?.[0]?.result?.error === "not_supported") {
        setStatus("SpeechRecognition nicht verfügbar", "error");
        return;
      }
      recording = true;
      micBtn.classList.add("recording");
      micBtn.title = "Aufnahme stoppen";
    } catch (err) {
      setStatus("Spracheingabe-Fehler: " + err.message, "error");
    }
  });

  vaultSelect.addEventListener("change", () => {
    if (vaultSelect.value && vaultSelect.value !== currentVaultId) {
      loadVaultChat(vaultSelect.value);
    }
  });

  inputWrap.addEventListener("submit", (e) => {
    e.preventDefault();
    const msg = inputArea.value.trim();
    if (!msg) return;
    inputArea.value = "";
    send(msg);
  });

  inputArea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      inputWrap.requestSubmit();
    }
  });

  clearBtn.addEventListener("click", async () => {
    if (!currentVaultId) return;
    if (!confirm("Verlauf für diesen Vault löschen?")) return;
    try {
      const res = await fetch(`${httpBase}/tools/chat/${currentVaultId}/clear`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      renderLog([]);
      setStatus("Verlauf geleert", "success");
    } catch (err) {
      setStatus("Fehler: " + (err.message || err), "error");
    }
  });

  // Initial load: get vault list, populate dropdown, restore last selection
  try {
    const res = await fetch(`${httpBase}/vaults`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const vaults = data.vaults || [];
    if (!vaults.length) {
      showEmptyState("Noch kein Vault verbunden. Lege in den Einstellungen einen an, dann kannst du chatten.");
      return;
    }
    vaultSelect.replaceChildren();
    for (const v of vaults) {
      vaultSelect.append(el("option", { value: v.id, textContent: v.name }));
    }
    const { selectedVaultId } = await chrome.storage.local.get("selectedVaultId");
    const startId = vaults.some((v) => v.id === selectedVaultId) ? selectedVaultId : vaults[0].id;
    vaultSelect.value = startId;
    await loadVaultChat(startId);
  } catch (err) {
    setStatus("Vault-Liste konnte nicht geladen werden: " + (err.message || err), "error");
  }
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderMarkdown(text) {
  // Preserve fenced code blocks before any other processing.
  const codeBlocks = [];
  let src = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = codeBlocks.length;
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    codeBlocks.push(`<pre><code${langAttr}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return `\x00CODEBLOCK${i}\x00`;
  });

  const blocks = src.split(/\n{2,}/);
  const html = blocks.map((block) => {
    const trimmed = block.trim();
    if (/^\x00CODEBLOCK\d+\x00$/.test(trimmed)) return trimmed;

    const lines = block.split("\n").filter((l) => l !== "");
    if (!lines.length) return "";

    // Heading
    const h = lines[0].match(/^(#{1,6})\s*(.+)$/);
    if (h) {
      const level = h[1].length;
      const headingHtml = `<h${level}>${inlineMd(h[2])}</h${level}>`;
      if (lines.length === 1) return headingHtml;
      return headingHtml + "<p>" + inlineMd(lines.slice(1).join(" ")) + "</p>";
    }

    // Horizontal rule
    if (lines.length === 1 && /^[-*_]{3,}$/.test(lines[0].trim())) {
      return "<hr>";
    }

    // Table: first line has |, second line is the separator (|---|)
    if (lines.length >= 2 && lines[0].includes("|") && /^\|[\s\-:|]+\|/.test(lines[1])) {
      const parseRow = (l) => l.split("|").slice(1, -1).map((c) => c.trim());
      const headers = parseRow(lines[0]).map((c) => `<th>${inlineMd(c)}</th>`).join("");
      const rows = lines.slice(2)
        .filter((l) => l.includes("|"))
        .map((l) => parseRow(l).map((c) => `<td>${inlineMd(c)}</td>`).join(""))
        .map((cells) => `<tr>${cells}</tr>`)
        .join("");
      return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
    }

    // Blockquote
    if (lines.every((l) => /^>\s?/.test(l))) {
      const inner = lines.map((l) => l.replace(/^>\s?/, "")).join("\n");
      return `<blockquote>${renderMarkdown(inner)}</blockquote>`;
    }

    // Ordered list
    if (lines.every((l) => /^\d+\.\s+/.test(l))) {
      const items = lines.map((l) => {
        const m = l.match(/^\d+\.\s+(.+)$/);
        return m ? `<li>${inlineMd(m[1])}</li>` : "";
      }).join("");
      return `<ol>${items}</ol>`;
    }

    // Unordered list
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      const items = lines.map((l) => {
        const m = l.match(/^\s*[-*]\s+(\[[ xX]\]\s+)?(.+)$/);
        return m ? `<li>${inlineMd(m[2])}</li>` : "";
      }).join("");
      return `<ul>${items}</ul>`;
    }

    // Paragraph (single newlines → <br>)
    return `<p>${lines.map(inlineMd).join("<br>")}</p>`;
  }).join("");

  return html.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);
}

function inlineMd(s) {
  s = escapeHtml(s);
  // Inline code first — protect content from other replacements
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    const i = codes.length;
    codes.push(`<code>${c}</code>`);
    return `\x01CODE${i}\x01`;
  });
  // Bold+italic, bold, italic, strikethrough
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  // Links [text](url) — only allow http(s) for safety
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  // Auto-link bare URLs
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)(?=[\s.,)!?]|$)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  // Restore code spans
  s = s.replace(/\x01CODE(\d+)\x01/g, (_, i) => codes[Number(i)]);
  return s;
}

// --- Vault helper (used by Playlists/Bookmarks tools) -------------------

async function getActiveVault(httpBase) {
  const { selectedVaultId } = await chrome.storage.local.get("selectedVaultId");
  try {
    const res = await fetch(`${httpBase}/vaults`);
    const data = await res.json();
    const list = data.vaults || [];
    if (selectedVaultId) {
      const found = list.find((v) => v.id === selectedVaultId);
      if (found) return found;
    }
    return list[0] || null;
  } catch {
    return null;
  }
}

async function getActiveVaultId(httpBase) {
  const v = await getActiveVault(httpBase);
  return v?.id || null;
}

function obsidianUri(vaultName, relPath) {
  // obsidian://open?vault=...&file=...   (URL-encode + drop .md if present)
  const file = relPath.replace(/\.md$/i, "");
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file)}`;
}

function openInObsidian(vaultName, relPath) {
  // Custom-Protocol-Handler brauchen User-Gesture + Chrome-API. Ein normaler
  // <a href="obsidian://..."> wird vom Sidepanel-Context blockiert, deshalb
  // gehen wir den Weg über chrome.tabs.create — die Extension hat dafür die
  // Permission und Chrome lässt den Protocol-Handler greifen.
  const uri = obsidianUri(vaultName, relPath);
  if (chrome.tabs && chrome.tabs.create) {
    chrome.tabs.create({ url: uri, active: true });
  } else {
    window.open(uri, "_blank");
  }
}

// --- Playlists Tool -----------------------------------------------------

async function renderPlaylistsTool() {
  panelTitle.textContent = "Playlists";
  panelBody.replaceChildren();

  const status = el("div", { className: "tool-status" });
  const toolbar = el("div", { className: "playlist-toolbar" });
  const newBtn = el("button", { textContent: "+ Neue Playlist", type: "button" });
  const captureYtBtn = el("button", {
    textContent: "📑 Markierte YT-Tabs",
    type: "button",
    title: "Alle markierten YouTube-Tabs zu einer Playlist hinzufügen",
  });
  captureYtBtn.addEventListener("click", () => captureHighlightedYoutubeTabs());
  toolbar.append(newBtn, captureYtBtn);
  const listWrap = el("div", { className: "playlist-list" });
  panelBody.append(toolbar, status, listWrap);

  const httpBase = await getHttpBase();
  const vaultId = await getActiveVaultId(httpBase);
  if (!vaultId) {
    status.textContent = "Kein Vault konfiguriert. In den Einstellungen anlegen.";
    status.className = "tool-status error";
    return;
  }

  newBtn.addEventListener("click", () => showCreatePlaylistDialog(httpBase, vaultId, () => renderPlaylistsTool()));

  status.textContent = "lade...";
  try {
    const res = await fetch(`${httpBase}/tools/playlists/${vaultId}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      status.textContent = `Fehler ${res.status}: ${err.detail || ""}`;
      status.className = "tool-status error";
      return;
    }
    const data = await res.json();
    const items = data.items || [];
    status.textContent = "";
    if (!items.length) {
      listWrap.append(el("div", { className: "empty", textContent: "Noch keine Playlists. Mit '+ Neue Playlist' anlegen." }));
      return;
    }
    // Group by saeule
    const groups = {};
    for (const p of items) {
      const k = p.saeule || "knowledge-library/ai";
      if (!groups[k]) groups[k] = [];
      groups[k].push(p);
    }
    for (const saeule of Object.keys(groups).sort()) {
      const section = el("div", { className: "playlist-group" });
      section.append(el("h4", { className: "playlist-group-header", textContent: saeule }));
      const ul = el("ul", { className: "playlist-items" });
      for (const p of groups[saeule]) {
        const li = el("li", { className: "playlist-item" });
        const main = el("div", { className: "playlist-item-main" });
        main.append(el("span", { className: "playlist-name", textContent: p.name }));
        main.append(el("span", { className: "playlist-count", textContent: `${p.item_count} Items` }));
        li.append(main);
        li.addEventListener("click", () => renderPlaylistDetail(p.name, p.saeule));
        ul.append(li);
      }
      section.append(ul);
      listWrap.append(section);
    }
  } catch (err) {
    status.textContent = `Fehler: ${err.message || err}`;
    status.className = "tool-status error";
  }
}

function showCreatePlaylistDialog(httpBase, vaultId, onCreated) {
  const overlay = el("div", { className: "playlist-picker-overlay" });
  const dialog = el("div", { className: "playlist-picker" });
  dialog.append(el("h3", { textContent: "Neue Playlist anlegen" }));

  const nameInput = el("input", { type: "text", placeholder: "Playlist-Name (z.B. KI Tutorials)" });
  const themaInput = el("input", { type: "text", placeholder: "Thema (frei, optional)" });
  const saeuleInput = el("input", { type: "text", placeholder: "Säule (z.B. knowledge-library/ai, work/crafts/web-development/skills/wordpress)", value: "knowledge-library/ai" });
  const status = el("div", { className: "tool-status" });
  const actions = el("div", { className: "playlist-picker-actions" });
  const cancel = el("button", { type: "button", textContent: "Abbrechen" });
  const ok = el("button", { type: "button", textContent: "Anlegen", className: "primary" });
  actions.append(cancel, ok);

  dialog.append(nameInput, themaInput, saeuleInput, status, actions);
  overlay.append(dialog);
  document.body.append(overlay);

  cancel.addEventListener("click", () => overlay.remove());
  ok.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) { status.textContent = "Name ist Pflicht"; status.className = "tool-status error"; return; }
    const saeule = saeuleInput.value.trim() || "knowledge-library/ai";
    const body = { name, thema: themaInput.value.trim() || null };
    ok.disabled = true; status.textContent = "lege an...";
    try {
      const url = `${httpBase}/tools/playlists/${vaultId}?saeule=${encodeURIComponent(saeule)}`;
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        status.textContent = `Fehler ${res.status}: ${err.detail || ""}`;
        status.className = "tool-status error";
        ok.disabled = false;
        return;
      }
      overlay.remove();
      onCreated && onCreated();
    } catch (err) {
      status.textContent = `Fehler: ${err.message || err}`;
      status.className = "tool-status error";
      ok.disabled = false;
    }
  });
  nameInput.focus();
}

async function renderPlaylistDetail(name, saeule) {
  panelTitle.textContent = `${name} (${saeule})`;
  panelBody.replaceChildren();

  const toolbar = el("div", { className: "playlist-toolbar" });
  const backBtn = el("button", { type: "button", textContent: "← zurück" });
  backBtn.addEventListener("click", () => renderPlaylistsTool());
  const pullBtn = el("button", { type: "button", textContent: "⏬ Alle Pending ziehen", title: "Alle Videos ohne Transcript automatisch abrufen" });
  const infoBtn = el("button", {
    type: "button",
    textContent: "ⓘ",
    className: "info-btn",
    title: "Summary-Workflow erklären",
  });
  infoBtn.addEventListener("click", () => showSummaryWorkflowInfo(name));
  toolbar.append(backBtn, pullBtn, infoBtn);
  const status = el("div", { className: "tool-status" });
  const orchestrationStatus = el("div", { className: "orchestration-status hidden" });
  const itemsWrap = el("div", { className: "playlist-items-detail" });
  panelBody.append(toolbar, status, orchestrationStatus, itemsWrap);

  const httpBase = await getHttpBase();
  const vault = await getActiveVault(httpBase);
  if (!vault) { status.textContent = "Kein Vault."; return; }
  const vaultId = vault.id;
  const vaultName = vault.name;

  pullBtn.addEventListener("click", () => runPullPending({
    httpBase, vaultId, playlistName: name, saeule,
    statusEl: orchestrationStatus, button: pullBtn,
    onDone: () => renderPlaylistDetail(name, saeule),
  }));

  status.textContent = "lade...";
  try {
    const url = `${httpBase}/tools/playlists/${vaultId}/${encodeURIComponent(name)}?saeule=${encodeURIComponent(saeule)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      status.textContent = `Fehler ${res.status}: ${err.detail || ""}`;
      status.className = "tool-status error";
      return;
    }
    const data = await res.json();
    const items = data.items || [];
    status.textContent = "";
    if (!items.length) {
      itemsWrap.append(el("div", { className: "empty", textContent: "(keine Videos in der Playlist)" }));
      return;
    }
    for (const it of items) {
      itemsWrap.append(renderVideoCard(httpBase, vaultId, vaultName, name, saeule, it));
    }
  } catch (err) {
    status.textContent = `Fehler: ${err.message || err}`;
    status.className = "tool-status error";
  }
}

function renderVideoCard(httpBase, vaultId, vaultName, playlistName, saeule, it) {
  const card = el("div", { className: "playlist-item-card" });
  card.append(el("div", { className: "playlist-item-title", textContent: it.title }));
  const meta = el("div", { className: "playlist-item-meta" });
  if (it.channel) meta.append(el("span", { textContent: it.channel }));
  if (it.added) meta.append(el("span", { textContent: it.added }));
  card.append(meta);

  const links = el("div", { className: "playlist-item-links" });
  if (it.url) {
    const a = el("a", { textContent: "YouTube", href: it.url, target: "_blank" });
    a.rel = "noopener noreferrer";
    links.append(a);
  }

  const detailsBtn = el("button", { type: "button", textContent: "▼ Details", className: "small details-toggle" });
  links.append(detailsBtn);

  if (it.page) {
    const obsidianBtn = el("button", { type: "button", textContent: "✎ Obsidian", className: "small obsidian-button" });
    obsidianBtn.addEventListener("click", () => openInObsidian(vaultName, it.page + ".md"));
    links.append(obsidianBtn);
  }

  const removeBtn = el("button", { type: "button", textContent: "Entfernen", className: "small" });
  removeBtn.addEventListener("click", () => showRemoveDialog({
    httpBase, vaultId, playlistName, saeule, item: it,
    onDone: () => renderPlaylistDetail(playlistName, saeule),
  }));
  links.append(removeBtn);
  card.append(links);

  // Details-Akkordeon (lazy load)
  const details = el("div", { className: "playlist-item-details hidden" });
  card.append(details);
  let loaded = false;
  detailsBtn.addEventListener("click", async () => {
    const isHidden = details.classList.contains("hidden");
    if (isHidden) {
      details.classList.remove("hidden");
      detailsBtn.textContent = "▲ Details";
      if (!loaded && it.page) {
        details.textContent = "lade...";
        try {
          const fileUrl = `${httpBase}/tools/vault_file/${vaultId}?rel_path=${encodeURIComponent(it.page + ".md")}`;
          const res = await fetch(fileUrl);
          if (!res.ok) {
            const e = await res.json().catch(() => ({}));
            details.textContent = `Fehler beim Laden: ${e.detail || res.status}`;
            return;
          }
          const data = await res.json();
          details.replaceChildren();
          renderMasterPagePreview(details, data.content || "", httpBase, vaultId, vaultName);
          loaded = true;
        } catch (err) {
          details.textContent = `Fehler: ${err.message || err}`;
        }
      }
    } else {
      details.classList.add("hidden");
      detailsBtn.textContent = "▼ Details";
    }
  });
  return card;
}

function renderMasterPagePreview(target, mdContent, httpBase, vaultId, vaultName) {
  // Strip frontmatter
  let body = mdContent;
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end !== -1) body = body.slice(end + 4).replace(/^\n+/, "");
  }
  // Find sections: ## Kern-Insights, ## Zusammenfassung, ## Transcript
  const sections = {};
  const headerRe = /^##\s+(.+?)\s*$/gm;
  const positions = [];
  let m;
  while ((m = headerRe.exec(body)) !== null) {
    positions.push({ name: m[1].trim(), start: m.index, contentStart: m.index + m[0].length });
  }
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const next = positions[i + 1];
    sections[p.name] = body.slice(p.contentStart, next ? next.start : body.length).trim();
  }

  const insights = sections["Kern-Insights"];
  const summary = sections["Zusammenfassung"];
  const transcript = sections["Transcript"];

  if (insights) {
    target.append(el("h5", { className: "preview-h", textContent: "Kern-Insights" }));
    const div = el("div", { className: "preview-md" });
    div.innerHTML = renderMarkdown(insights);
    target.append(div);
  }
  if (summary) {
    target.append(el("h5", { className: "preview-h", textContent: "Zusammenfassung" }));
    const div = el("div", { className: "preview-md" });
    div.innerHTML = renderMarkdown(summary);
    target.append(div);
  }
  if (transcript) {
    target.append(el("h5", { className: "preview-h", textContent: "Transcript" }));
    // Transcript-Sektion ist meist nur ein Wikilink — extract und mache Vault-File-Read-Link
    const wl = transcript.match(/\[\[([^\]]+)\]\]/);
    if (wl) {
      const transcriptPath = wl[1] + ".md";
      const a = el("a", {
        textContent: "Transcript anzeigen",
        href: "#",
        className: "obsidian-link",
      });
      a.addEventListener("click", async (ev) => {
        ev.preventDefault();
        const existing = target.querySelector(".transcript-content");
        if (existing) { existing.remove(); return; }
        const wrap = el("div", { className: "transcript-content" });
        wrap.textContent = "lade...";
        target.append(wrap);
        try {
          const url = `${httpBase}/tools/vault_file/${vaultId}?rel_path=${encodeURIComponent(transcriptPath)}`;
          const r = await fetch(url);
          const d = await r.json();
          let txt = d.content || "";
          if (txt.startsWith("---")) {
            const end = txt.indexOf("\n---", 3);
            if (end !== -1) txt = txt.slice(end + 4).replace(/^\n+/, "");
          }
          wrap.textContent = "";
          const pre = el("pre", { className: "transcript-text", textContent: txt });
          wrap.append(pre);
        } catch (err) {
          wrap.textContent = `Fehler: ${err.message || err}`;
        }
      });
      target.append(a);
      const obsidianA = el("button", {
        type: "button",
        textContent: "  •  in Obsidian öffnen",
        className: "obsidian-link-btn",
      });
      obsidianA.addEventListener("click", () => openInObsidian(vaultName, transcriptPath));
      target.append(obsidianA);
    } else {
      const div = el("div", { className: "preview-md" });
      div.innerHTML = renderMarkdown(transcript);
      target.append(div);
    }
  }
  if (!insights && !summary && !transcript) {
    target.append(el("div", { className: "empty", textContent: "(noch keine Insights/Summary/Transcript in der Master-Page)" }));
  }
}

async function runPullPending({ httpBase, vaultId, playlistName, saeule, statusEl, button, onDone }) {
  // Custom-Dialog statt nativem confirm — wegen Summary-Checkbox
  const summarize = await showPullPendingDialog(playlistName);
  if (summarize === null) return; // Abbrechen

  button.disabled = true;
  statusEl.classList.remove("hidden");
  statusEl.classList.remove("error");
  const summarizeNote = summarize ? " + Auto-Summary (API-Token!)" : "";
  statusEl.textContent = `Starte Orchestrierung${summarizeNote} — bitte Extension geöffnet halten und Browser nicht schließen…`;

  try {
    const url = `${httpBase}/tools/playlists/${vaultId}/${encodeURIComponent(playlistName)}/pull_pending?saeule=${encodeURIComponent(saeule)}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ with_timestamps: false, summarize }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      statusEl.textContent = `Fehler ${r.status}: ${e.detail || ""}`;
      statusEl.classList.add("error");
      button.disabled = false;
      return;
    }
    const result = await r.json();
    statusEl.textContent = formatOrchestrationResult(result);
    button.disabled = false;
    onDone && onDone();
  } catch (err) {
    statusEl.textContent = `Fehler: ${err.message || err}`;
    statusEl.classList.add("error");
    button.disabled = false;
  }
}

function showSummaryWorkflowInfo(playlistName) {
  const overlay = el("div", { className: "playlist-picker-overlay" });
  const dialog = el("div", { className: "playlist-picker" });
  dialog.append(el("h3", { textContent: "Summary-Workflow" }));
  const body = el("div", { className: "summary-hint" });
  body.innerHTML = `
    <p style="margin:0 0 6px;">Zwei Pfade, beide schreiben Insights + Zusammenfassung in die Master-Pages.</p>
    <ul>
      <li><strong>Subscription</strong> (kein API-Token): in Claude Code tippen<br><code>/wiki-summaries ${playlistName}</code><br>oder ohne Argument für alle pending im Vault.</li>
      <li><strong>API-Key</strong> (EwtosBrain-Anthropic-Key): unten <strong>⏬ Alle Pending ziehen</strong> → Häkchen <em>"+ Summary"</em>. Kostet Anthropic-Tokens.</li>
    </ul>
  `;
  dialog.append(body);
  const actions = el("div", { className: "playlist-picker-actions" });
  const ok = el("button", { type: "button", textContent: "Verstanden", className: "primary" });
  ok.addEventListener("click", () => overlay.remove());
  actions.append(ok);
  dialog.append(actions);
  overlay.append(dialog);
  document.body.append(overlay);
}

function showPullPendingDialog(playlistName) {
  return new Promise((resolve) => {
    const overlay = el("div", { className: "playlist-picker-overlay" });
    const dialog = el("div", { className: "playlist-picker" });
    dialog.append(el("h3", { textContent: `Pending Transcripts ziehen` }));
    dialog.append(el("div", {
      className: "remove-dialog-info",
      textContent: `'${playlistName}' — pro Video ~10-15s, öffnet jeweils ein Hidden-Window in Chrome.`,
    }));

    const summaryRow = el("label", { className: "summary-checkbox-row" });
    const summaryCb = el("input", { type: "checkbox" });
    summaryRow.append(summaryCb, document.createTextNode(" + Summary über EwtosBrain-API-Key (kostet Anthropic-Tokens)"));
    dialog.append(summaryRow);

    const hint = el("div", { className: "summary-hint-inline" });
    hint.innerHTML = `Tipp: für Summary auf <strong>Subscription</strong> stattdessen <code>/wiki-summaries ${playlistName}</code> in Claude Code.`;
    dialog.append(hint);

    const actions = el("div", { className: "playlist-picker-actions" });
    const cancel = el("button", { type: "button", textContent: "Abbrechen" });
    const ok = el("button", { type: "button", textContent: "Ziehen", className: "primary" });
    actions.append(cancel, ok);
    dialog.append(actions);
    overlay.append(dialog);
    document.body.append(overlay);

    cancel.addEventListener("click", () => { overlay.remove(); resolve(null); });
    ok.addEventListener("click", () => { const v = summaryCb.checked; overlay.remove(); resolve(v); });
  });
}

function formatOrchestrationResult(r) {
  const lines = [];
  if (r.aborted) {
    lines.push(`⚠ Abgebrochen: ${r.abort_reason || "unbekannt"}`);
  }
  lines.push(`✓ Fertig: ${r.transcribed}/${r.total} transkribiert`);
  if (r.skipped_already_done) lines.push(`  (${r.skipped_already_done} hatten schon Transcript)`);
  if (r.failed && r.failed.length) {
    lines.push(`✗ ${r.failed.length} fehlgeschlagen:`);
    for (const f of r.failed.slice(0, 5)) {
      lines.push(`   • ${f.title}: ${f.error}`);
    }
    if (r.failed.length > 5) lines.push(`   …+${r.failed.length - 5} weitere`);
  }
  return lines.join("\n");
}

function showRemoveDialog({ httpBase, vaultId, playlistName, saeule, item, onDone }) {
  const overlay = el("div", { className: "playlist-picker-overlay" });
  const dialog = el("div", { className: "playlist-picker remove-dialog" });
  dialog.append(el("h3", { textContent: `'${item.title}' entfernen?` }));
  dialog.append(el("div", {
    className: "remove-dialog-info",
    textContent: "Wähle, was passieren soll:",
  }));

  const status = el("div", { className: "tool-status" });
  const actions = el("div", { className: "remove-dialog-actions" });
  const cancelBtn = el("button", { type: "button", textContent: "Abbrechen" });
  const justPlaylistBtn = el("button", { type: "button", textContent: "Nur aus Playlist", className: "primary" });
  const fullDeleteBtn = el("button", { type: "button", textContent: "Auch Master-Page + Transcript löschen", className: "danger" });
  actions.append(cancelBtn, justPlaylistBtn, fullDeleteBtn);
  dialog.append(status, actions);
  overlay.append(dialog);
  document.body.append(overlay);

  const close = () => overlay.remove();
  cancelBtn.addEventListener("click", close);

  async function doRemove(alsoDeleteMaster) {
    justPlaylistBtn.disabled = true;
    fullDeleteBtn.disabled = true;
    status.textContent = "läuft...";
    try {
      const matchValue = item.url || item.title;
      const url = `${httpBase}/tools/playlists/${vaultId}/${encodeURIComponent(playlistName)}/items/delete?saeule=${encodeURIComponent(saeule)}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ match: matchValue, also_delete_master: alsoDeleteMaster }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        status.textContent = `Fehler ${r.status}: ${e.detail || ""}`;
        status.className = "tool-status error";
        justPlaylistBtn.disabled = false;
        fullDeleteBtn.disabled = false;
        return;
      }
      const result = await r.json();
      close();
      if (alsoDeleteMaster) {
        if (result.master_deleted) {
          alert(`Komplett gelöscht. Transcript: ${result.transcript_deleted ? "auch gelöscht" : "kein Transcript vorhanden"}.`);
        } else if (!result.became_orphan) {
          alert("Aus Playlist entfernt — Master-Page bleibt, weil das Video noch in einer anderen Playlist ist.");
        }
      }
      onDone && onDone();
    } catch (err) {
      status.textContent = `Fehler: ${err.message || err}`;
      status.className = "tool-status error";
      justPlaylistBtn.disabled = false;
      fullDeleteBtn.disabled = false;
    }
  }
  justPlaylistBtn.addEventListener("click", () => doRemove(false));
  fullDeleteBtn.addEventListener("click", () => doRemove(true));
}

// --- Bookmarks Tool -----------------------------------------------------

// Bookmarks-State (über Re-Render hinweg, weil filter+search lokal sind)
let bookmarksState = { all: [], search: "", activeTag: null };

async function renderBookmarksTool() {
  panelTitle.textContent = "Bookmarks";
  panelBody.replaceChildren();

  const toolbar = el("div", { className: "playlist-toolbar" });
  const addBtn = el("button", { type: "button", textContent: "+ Bookmark hinzufügen" });
  const captureTabsBtn = el("button", {
    type: "button",
    textContent: "📑 Markierte Tabs",
    title: "Alle im aktuellen Fenster mit Strg+Klick markierten Tabs als Bookmarks erfassen",
  });
  toolbar.append(addBtn, captureTabsBtn);
  const status = el("div", { className: "tool-status" });
  const searchWrap = el("div", { className: "bookmark-search" });
  const searchInput = el("input", { type: "search", placeholder: "Suche Titel, URL, #tag…", value: bookmarksState.search });
  searchWrap.append(searchInput);
  const tagCloud = el("div", { className: "tag-cloud" });
  const listWrap = el("div", { className: "bookmark-list" });
  panelBody.append(toolbar, searchWrap, tagCloud, status, listWrap);

  const httpBase = await getHttpBase();
  addBtn.addEventListener("click", () => showAddBookmarkDialog(httpBase, () => renderBookmarksTool()));
  captureTabsBtn.addEventListener("click", () => captureHighlightedTabs(httpBase, captureTabsBtn, () => renderBookmarksTool()));

  status.textContent = "lade...";
  try {
    const res = await fetch(`${httpBase}/tools/bookmarks`);
    if (!res.ok) {
      status.textContent = `Fehler ${res.status}`;
      status.className = "tool-status error";
      return;
    }
    const data = await res.json();
    const items = data.items || [];
    status.textContent = "";
    bookmarksState.all = items.slice().reverse(); // newest first

    function applyFilters() {
      let filtered = bookmarksState.all;
      const q = bookmarksState.search.trim().toLowerCase();
      if (q) {
        filtered = filtered.filter((b) => {
          if (b.title && b.title.toLowerCase().includes(q)) return true;
          if (b.url && b.url.toLowerCase().includes(q)) return true;
          if (b.note && b.note.toLowerCase().includes(q)) return true;
          if (b.themen && b.themen.some((t) => t.toLowerCase().includes(q.replace(/^#/, "")))) return true;
          return false;
        });
      }
      if (bookmarksState.activeTag) {
        filtered = filtered.filter((b) => b.themen && b.themen.includes(bookmarksState.activeTag));
      }
      renderBookmarksList(httpBase, listWrap, filtered);
    }

    // Tag-Wolke aufbauen aus allen items
    function onTagClick(tag) {
      bookmarksState.activeTag = bookmarksState.activeTag === tag ? null : tag;
      renderTagCloud(tagCloud, bookmarksState.all, onTagClick);
      applyFilters();
    }
    renderTagCloud(tagCloud, bookmarksState.all, onTagClick);

    searchInput.addEventListener("input", () => {
      bookmarksState.search = searchInput.value;
      applyFilters();
    });

    if (!items.length) {
      listWrap.append(el("div", { className: "empty", textContent: "Keine Bookmarks. Per Rechtsklick auf Webseiten oder mit '+ Bookmark hinzufügen'." }));
      return;
    }
    applyFilters();
  } catch (err) {
    status.textContent = `Fehler: ${err.message || err}`;
    status.className = "tool-status error";
  }
}

function renderTagCloud(target, items, onTagClick) {
  target.replaceChildren();
  const counts = {};
  for (const b of items) {
    if (b.themen) for (const t of b.themen) counts[t] = (counts[t] || 0) + 1;
  }
  const sorted = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  if (!sorted.length) return;
  for (const tag of sorted) {
    const pill = el("button", {
      type: "button",
      textContent: `#${tag} ${counts[tag]}`,
      className: "tag-pill" + (bookmarksState.activeTag === tag ? " active" : ""),
    });
    pill.addEventListener("click", () => onTagClick(tag));
    target.append(pill);
  }
  if (bookmarksState.activeTag) {
    const clear = el("button", { type: "button", textContent: "× Filter aufheben", className: "tag-pill clear" });
    clear.addEventListener("click", () => onTagClick(bookmarksState.activeTag));
    target.append(clear);
  }
}

function renderBookmarksList(httpBase, target, items) {
  target.replaceChildren();
  if (!items.length) {
    target.append(el("div", { className: "empty", textContent: "(keine Bookmarks matchen den Filter)" }));
    return;
  }
  // Group by first thema
  const groups = {};
  for (const b of items) {
    const key = (b.themen && b.themen[0]) || "(Ohne Tag)";
    if (!groups[key]) groups[key] = [];
    groups[key].push(b);
  }
  const sortedKeys = Object.keys(groups).sort((a, b) => {
    if (a === "(Ohne Tag)") return 1;
    if (b === "(Ohne Tag)") return -1;
    return a.localeCompare(b);
  });
  for (const key of sortedKeys) {
    const section = el("div", { className: "playlist-group" });
    section.append(el("h4", { className: "playlist-group-header", textContent: key }));
    const sectionList = el("div", { className: "bookmark-list" });
    section.append(sectionList);
    for (const b of groups[key]) {
      sectionList.append(renderBookmarkCard(httpBase, b));
    }
    target.append(section);
  }
}

function renderBookmarkCard(httpBase, b) {
  const card = el("div", { className: "bookmark-card" });
  const head = el("div", { className: "bookmark-head" });
  const titleLink = el("a", { textContent: b.title, href: b.url, target: "_blank" });
  titleLink.rel = "noopener noreferrer";
  head.append(titleLink);
  head.append(el("span", { className: "bookmark-date", textContent: b.date }));
  card.append(head);
  if (b.note) card.append(el("div", { className: "bookmark-note", textContent: b.note }));
  const meta = el("div", { className: "bookmark-meta" });
  const left = el("span");
  if (b.source) left.append(el("span", { textContent: `quelle: ${b.source}` }));
  if (b.themen && b.themen.length) {
    if (b.source) left.append(el("span", { textContent: " · " }));
    left.append(el("span", { textContent: b.themen.map((t) => `#${t}`).join(" ") }));
  }
  meta.append(left);
  const actions = el("span", { className: "bookmark-actions" });
  const editBtn = el("button", { type: "button", textContent: "✎", className: "small", title: "Bearbeiten" });
  editBtn.addEventListener("click", () => showEditBookmarkDialog(httpBase, b, () => renderBookmarksTool()));
  actions.append(editBtn);
  const delBtn = el("button", { type: "button", textContent: "Löschen", className: "small" });
  delBtn.addEventListener("click", async () => {
    if (!confirm(`'${b.title}' löschen?`)) return;
    const matchValue = b.url || b.title;
    const r = await fetch(`${httpBase}/tools/bookmarks/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ match: matchValue, date: b.date || null }),
    });
    if (r.ok) renderBookmarksTool();
    else { const e = await r.json().catch(() => ({})); alert(`Fehler ${r.status}: ${e.detail || ""}`); }
  });
  actions.append(delBtn);
  meta.append(actions);
  card.append(meta);
  return card;
}

function showEditBookmarkDialog(httpBase, bookmark, onSaved) {
  const overlay = el("div", { className: "playlist-picker-overlay" });
  const dialog = el("div", { className: "playlist-picker" });
  dialog.append(el("h3", { textContent: "Bookmark bearbeiten" }));

  const titleInput = el("input", { type: "text", placeholder: "Titel", value: bookmark.title || "" });
  const noteInput = el("input", { type: "text", placeholder: "Notiz (optional)", value: bookmark.note || "" });
  const themenInput = el("input", {
    type: "text",
    placeholder: "Themen (Komma-getrennt)",
    value: (bookmark.themen || []).join(", "),
  });
  const status = el("div", { className: "tool-status" });
  const actions = el("div", { className: "playlist-picker-actions" });
  const cancel = el("button", { type: "button", textContent: "Abbrechen" });
  const ok = el("button", { type: "button", textContent: "Speichern", className: "primary" });
  actions.append(cancel, ok);
  dialog.append(
    el("div", { className: "remove-dialog-info", textContent: bookmark.url }),
    titleInput, noteInput, themenInput, status, actions,
  );
  overlay.append(dialog);
  document.body.append(overlay);

  cancel.addEventListener("click", () => overlay.remove());
  ok.addEventListener("click", async () => {
    const themen = themenInput.value
      .split(",")
      .map((t) => t.trim().replace(/^#/, "").toLowerCase())
      .filter((t) => /^[a-z][\w\-/]*$/.test(t));
    ok.disabled = true; status.textContent = "speichere...";
    try {
      const r = await fetch(`${httpBase}/tools/bookmarks/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          match: bookmark.url || bookmark.title,
          date: bookmark.date || null,
          title: titleInput.value.trim(),
          note: noteInput.value.trim() || null,
          themen,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        status.textContent = `Fehler ${r.status}: ${err.detail || ""}`;
        status.className = "tool-status error";
        ok.disabled = false;
        return;
      }
      overlay.remove();
      onSaved && onSaved();
    } catch (err) {
      status.textContent = `Fehler: ${err.message || err}`;
      status.className = "tool-status error";
      ok.disabled = false;
    }
  });
  titleInput.focus();
}

// Scraped YouTube-Metadaten aus einem konkreten Tab. Inline-Variante von
// extension/tools/youtube_meta.js — Sidepanel-Module-Imports sind Setup-
// Aufwand, deshalb hier dupliziert.
async function scrapeYoutubeMetaForTab(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const titleEl = document.querySelector("h1.ytd-watch-metadata yt-formatted-string")
        || document.querySelector("ytd-video-primary-info-renderer h1");
      const docTitle = (document.title || "").replace(/\s*-\s*YouTube\s*$/, "").trim();
      const title = (titleEl?.textContent || docTitle).trim();
      const channelEl = document.querySelector("ytd-channel-name #text-container yt-formatted-string a")
        || document.querySelector("ytd-channel-name a");
      const channel = (channelEl?.textContent || "").trim();
      let duration = document.querySelector(".ytp-time-duration")?.textContent?.trim() || "";
      if (!duration) {
        const m = document.querySelector("meta[itemprop='duration']")?.content?.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
        if (m) {
          const h = +m[1] || 0, mi = +m[2] || 0, s = +m[3] || 0;
          const pad = (n) => String(n).padStart(2, "0");
          duration = h > 0 ? `${h}:${pad(mi)}:${pad(s)}` : `${mi}:${pad(s)}`;
        }
      }
      return { title, channel, duration };
    },
  });
  return result?.result || { title: "", channel: "", duration: "" };
}

async function captureHighlightedYoutubeTabs() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ highlighted: true, currentWindow: true });
  } catch (err) {
    alert("Konnte Tabs nicht lesen: " + (err.message || err));
    return;
  }
  const ytTabs = tabs.filter((t) => t.url && /^https?:\/\/(www\.)?youtube\.com\/watch/.test(t.url));
  if (!ytTabs.length) {
    alert("Keine markierten YouTube-Tabs. Tipp: Strg+Klick im Tab-Strip auf YouTube-Watch-Tabs, dann hier klicken.");
    return;
  }
  const httpBase = await getHttpBase();
  const vault = await getActiveVault(httpBase);
  if (!vault) { alert("Kein Vault konfiguriert."); return; }
  // Meta parallel scrapen (Channel/Title/Duration), POSTs danach seriell.
  const items = await Promise.all(ytTabs.map(async (t) => {
    let meta = { title: t.title || t.url, channel: "", duration: "" };
    try {
      const scraped = await scrapeYoutubeMetaForTab(t.id);
      meta = { title: scraped.title || meta.title, channel: scraped.channel, duration: scraped.duration };
    } catch (err) {
      console.warn("scrape failed for tab", t.id, err);
    }
    return { url: t.url, title: meta.title, channel: meta.channel, duration: meta.duration };
  }));
  showMultiYoutubePicker(httpBase, vault, items);
}

function showMultiYoutubePicker(httpBase, vault, items) {
  const overlay = el("div", { className: "playlist-picker-overlay" });
  const dialog = el("div", { className: "playlist-picker multi-yt-picker" });
  dialog.append(el("h3", { textContent: `${items.length} markierte YouTube-Tabs` }));

  const itemList = el("ul", { className: "multi-yt-items" });
  for (const it of items) {
    const li = el("li");
    const titleSpan = el("span", { className: "multi-yt-title", textContent: it.title });
    li.append(titleSpan);
    if (it.channel) li.append(el("span", { className: "multi-yt-channel", textContent: ` · ${it.channel}` }));
    itemList.append(li);
  }
  dialog.append(itemList);

  // Smart-Vorschlag: alle vom selben Kanal? Dann Auto-Playlist-Name vorschlagen
  const channels = [...new Set(items.map((i) => i.channel).filter(Boolean))];
  let autoPlaylistName = "";
  if (channels.length === 1 && channels[0]) {
    autoPlaylistName = channels[0];
    const hint = el("div", { className: "multi-yt-hint" });
    hint.textContent = `Alle vom Kanal: ${channels[0]} — Playlist mit diesem Namen anlegen?`;
    dialog.append(hint);
  }

  const status = el("div", { className: "tool-status" });
  const playlistList = el("div", { className: "playlist-picker-list" });
  dialog.append(el("div", { className: "playlist-picker-sep", textContent: "Bestehende Playlist:" }));
  dialog.append(playlistList, status);

  // Neue Playlist Section
  const sep = el("div", { className: "playlist-picker-sep", textContent: "oder neue Playlist anlegen:" });
  const newName = el("input", { type: "text", placeholder: "Name (z.B. Karpathy-Videos)", value: autoPlaylistName });
  const newSaeule = el("input", { type: "text", placeholder: "Säule (default: knowledge-library/ai)", value: "knowledge-library/ai" });
  const createBtn = el("button", { type: "button", textContent: "Anlegen + alle hinzufügen", className: "primary" });
  dialog.append(sep, newName, newSaeule, createBtn);

  const cancelBtn = el("button", { type: "button", className: "secondary", textContent: "Abbrechen" });
  dialog.append(cancelBtn);
  cancelBtn.addEventListener("click", () => overlay.remove());

  overlay.append(dialog);
  document.body.append(overlay);

  // Bestehende Playlists laden
  (async () => {
    try {
      const r = await fetch(`${httpBase}/tools/playlists/${vault.id}`);
      const data = await r.json();
      const playlists = data.items || [];
      if (!playlists.length) {
        playlistList.append(el("div", { className: "empty", textContent: "(keine bestehenden Playlists)" }));
        return;
      }
      for (const p of playlists) {
        const btn = el("button", { type: "button", className: "playlist-pick-btn" });
        btn.textContent = `[${p.saeule}] ${p.name} (${p.item_count})`;
        btn.addEventListener("click", () => bulkAddToPlaylist(httpBase, vault.id, p.name, p.saeule, items, status, () => overlay.remove()));
        playlistList.append(btn);
      }
    } catch (err) {
      playlistList.append(el("div", { className: "empty", textContent: `Fehler: ${err.message || err}` }));
    }
  })();

  createBtn.addEventListener("click", async () => {
    const name = newName.value.trim();
    const saeule = newSaeule.value.trim() || "knowledge-library/ai";
    if (!name) { status.textContent = "Name fehlt"; status.className = "tool-status error"; return; }
    createBtn.disabled = true;
    status.textContent = "lege Playlist an…";
    try {
      const r = await fetch(`${httpBase}/tools/playlists/${vault.id}?saeule=${encodeURIComponent(saeule)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        status.textContent = `Fehler ${r.status}: ${e.detail || ""}`;
        status.className = "tool-status error";
        createBtn.disabled = false;
        return;
      }
    } catch (err) {
      status.textContent = `Fehler: ${err.message || err}`;
      status.className = "tool-status error";
      createBtn.disabled = false;
      return;
    }
    await bulkAddToPlaylist(httpBase, vault.id, name, saeule, items, status, () => overlay.remove());
  });
}

async function bulkAddToPlaylist(httpBase, vaultId, playlistName, saeule, items, statusEl, onDone) {
  statusEl.textContent = `füge 0/${items.length} hinzu…`;
  statusEl.className = "tool-status";
  let added = 0, duplicate = 0;
  const failed = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    try {
      const url = `${httpBase}/tools/playlists/${vaultId}/${encodeURIComponent(playlistName)}/items?saeule=${encodeURIComponent(saeule)}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: it.url, title: it.title, youtuber: it.channel, dauer: it.duration,
        }),
      });
      if (r.ok) {
        const d = await r.json();
        if (d.added) added++;
        else duplicate++;
      } else {
        failed.push(it.title);
      }
    } catch (err) {
      failed.push(it.title);
    }
    statusEl.textContent = `füge ${i + 1}/${items.length} hinzu…`;
  }
  let msg = `✓ ${added} hinzugefügt`;
  if (duplicate) msg += ` · ${duplicate} schon drin`;
  if (failed.length) msg += ` · ${failed.length} fehlgeschlagen`;
  alert(msg);
  onDone && onDone();
  // Liste refreshen falls in der Detail-View
  if (typeof renderPlaylistsTool === "function") renderPlaylistsTool();
}

async function captureHighlightedTabs(httpBase, button, onDone) {
  // Sidepanel-Klick triggert keinen Body-Click → Multi-Tab-Markierung bleibt
  // erhalten (im Gegensatz zum Page-Body-Rechtsklick, wo Chrome oft alle
  // außer dem aktiven Tab deselektiert).
  let tabs;
  try {
    tabs = await chrome.tabs.query({ highlighted: true, currentWindow: true });
  } catch (err) {
    alert("Konnte Tabs nicht lesen: " + (err.message || err));
    return;
  }
  const httpTabs = tabs.filter((t) => t.url && /^https?:/.test(t.url));
  if (!httpTabs.length) {
    alert("Keine markierten Tabs mit http(s)-URL. Tipp: Strg+Klick im Tab-Strip mehrere Tabs markieren, dann hier klicken.");
    return;
  }
  if (httpTabs.length === 1) {
    if (!confirm(
      "Nur 1 Tab markiert. Trotzdem als Bookmark speichern?\n\n" +
      "Tipp: Strg+Klick im Tab-Strip auf weitere Tabs markieren, dann hier klicken."
    )) return;
  }
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "läuft…";
  let saved = 0;
  const failed = [];
  for (const t of httpTabs) {
    try {
      const r = await fetch(`${httpBase}/tools/bookmarks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: t.url,
          title: t.title || t.url,
          source: "sidepanel-multi-tab",
        }),
      });
      if (r.ok) saved++;
      else failed.push(t.title || t.url);
    } catch (err) {
      failed.push(t.title || t.url);
    }
  }
  button.disabled = false;
  button.textContent = original;
  let msg = `${saved} Tab${saved === 1 ? "" : "s"} als Bookmark gespeichert.`;
  if (failed.length) msg += `\n${failed.length} fehlgeschlagen:\n  ${failed.slice(0, 5).join("\n  ")}`;
  alert(msg);
  onDone && onDone();
}

function showAddBookmarkDialog(httpBase, onAdded) {
  const overlay = el("div", { className: "playlist-picker-overlay" });
  const dialog = el("div", { className: "playlist-picker" });
  dialog.append(el("h3", { textContent: "Bookmark hinzufügen" }));

  const urlInput = el("input", { type: "url", placeholder: "https://..." });
  const titleInput = el("input", { type: "text", placeholder: "Titel (optional, sonst URL)" });
  const noteInput = el("input", { type: "text", placeholder: "Notiz (optional)" });
  const themenInput = el("input", { type: "text", placeholder: "Themen (Komma-getrennt: ki, recherche, tech)" });
  const status = el("div", { className: "tool-status" });
  const actions = el("div", { className: "playlist-picker-actions" });
  const cancel = el("button", { type: "button", textContent: "Abbrechen" });
  const ok = el("button", { type: "button", textContent: "Hinzufügen", className: "primary" });
  actions.append(cancel, ok);
  dialog.append(urlInput, titleInput, noteInput, themenInput, status, actions);
  overlay.append(dialog);
  document.body.append(overlay);

  cancel.addEventListener("click", () => overlay.remove());
  ok.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) { status.textContent = "URL ist Pflicht"; status.className = "tool-status error"; return; }
    const themen = themenInput.value
      .split(",")
      .map((t) => t.trim().replace(/^#/, "").toLowerCase())
      .filter((t) => /^[a-z][\w\-/]*$/.test(t));
    ok.disabled = true; status.textContent = "speichere...";
    try {
      const r = await fetch(`${httpBase}/tools/bookmarks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          title: titleInput.value.trim() || null,
          note: noteInput.value.trim() || null,
          source: "sidepanel",
          themen: themen.length ? themen : null,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        status.textContent = `Fehler ${r.status}: ${err.detail || ""}`;
        status.className = "tool-status error";
        ok.disabled = false;
        return;
      }
      overlay.remove();
      onAdded && onAdded();
    } catch (err) {
      status.textContent = `Fehler: ${err.message || err}`;
      status.className = "tool-status error";
      ok.disabled = false;
    }
  });
  urlInput.focus();
}

function el(tag, props = {}) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  return node;
}

// ── Sprint 3: Web-Tools ──────────────────────────────────────────────────────

function renderPageScrape() {
  panelTitle.textContent = "Page-Scrape";

  const runBtn = el("button", { textContent: "Aktiven Tab scrapen" });
  const status = el("div", { className: "tool-status" });
  const output = el("textarea", { readOnly: true, placeholder: "Ergebnis erscheint hier..." });
  const copyBtn = el("button", { textContent: "Kopieren" });
  copyBtn.classList.add("secondary");

  let lastMarkdown = "";

  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    status.textContent = "scrapt...";
    status.className = "tool-status";
    output.value = "";
    lastMarkdown = "";
    try {
      const httpBase = await getHttpBase();
      const res = await fetch(`${httpBase}/tools/page_scrape`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
      lastMarkdown = data.markdown || "";
      output.value = lastMarkdown;
      status.textContent = `${data.title || ""} — ${data.wordCount || 0} Wörter`;
      status.className = "tool-status success";
      if (data.title && !promoteTitle.value) promoteTitle.value = data.title;
      await chrome.storage.local.set({ lastPageScrape: { title: data.title || "", url: data.url || "", markdown: lastMarkdown, timestamp: Date.now() } });
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
    } finally {
      runBtn.disabled = false;
    }
  });

  copyBtn.addEventListener("click", () => {
    if (output.value) navigator.clipboard.writeText(output.value);
  });

  // ── Ins Brain ────────────────────────────────────────────────────────────
  const promoteBtn = el("button", { textContent: "Ins Brain", className: "secondary" });
  promoteBtn.style.marginTop = "6px";

  const promoteForm = el("div");
  promoteForm.style.cssText = "display:none;margin-top:8px;padding:10px;border:1px solid var(--border,#ddd);border-radius:6px;background:var(--bg-subtle);";

  const promoteTitle = el("input", { type: "text", placeholder: "Titel (Pflichtfeld)" });
  const promoteSub = el("select");
  ["artikel", "eigene-notizen", "chat-archive"].forEach(s => promoteSub.append(new Option(s, s)));
  const promoteDesc = el("textarea", { placeholder: "Beschreibung (optional)" });
  promoteDesc.style.cssText = "min-height:52px;resize:vertical;margin-top:6px;font-size:12px;";
  const promoteHint = el("div", { className: "tool-status" });
  const promoteSubBtn = el("button", { textContent: "Speichern" });
  const promoteCancelBtn = el("button", { textContent: "Abbrechen", className: "secondary" });
  promoteCancelBtn.style.marginLeft = "6px";

  const promoteSubLabel = el("label", { textContent: "Ziel-Ordner:" });
  promoteSubLabel.style.cssText = "margin-top:6px;display:block;";
  const promoteActRow = el("div");
  promoteActRow.style.marginTop = "8px";
  promoteActRow.append(promoteSubBtn, promoteCancelBtn);

  promoteForm.append(promoteTitle, promoteSubLabel, promoteSub, promoteDesc, promoteHint, promoteActRow);

  promoteBtn.addEventListener("click", () => {
    promoteForm.style.display = promoteForm.style.display === "none" ? "block" : "none";
  });
  promoteCancelBtn.addEventListener("click", () => {
    promoteForm.style.display = "none";
  });
  promoteSubBtn.addEventListener("click", async () => {
    const title = promoteTitle.value.trim();
    if (!title) { promoteHint.textContent = "Titel erforderlich"; promoteHint.className = "tool-status error"; return; }
    if (!lastMarkdown) { promoteHint.textContent = "Erst Seite scrapen"; promoteHint.className = "tool-status error"; return; }
    promoteSubBtn.disabled = true;
    promoteHint.textContent = "speichere...";
    promoteHint.className = "tool-status";
    try {
      const httpBase = await getHttpBase();
      const vaultId = await getActiveVaultId(httpBase);
      if (!vaultId) throw new Error("Kein Vault konfiguriert");
      const res = await fetch(`${httpBase}/tools/raw/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vault_id: vaultId,
          title,
          content: lastMarkdown,
          target_subfolder: promoteSub.value,
          description: promoteDesc.value.trim() || null,
        }),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) {
        if (res.status === 403) throw new Error(`Fehlende Berechtigung. <a href="#" class="open-options-link">In Options aktivieren</a>`);
        throw new Error(data?.detail || text || `HTTP ${res.status}`);
      }
      promoteHint.textContent = `Gespeichert: ${data.data?.raw_path || "OK"}`;
      promoteHint.className = "tool-status success";
      promoteTitle.value = "";
      promoteDesc.value = "";
      promoteForm.style.display = "none";
    } catch (err) {
      promoteHint.innerHTML = err.message || String(err);
      promoteHint.className = "tool-status error";
      promoteHint.querySelector(".open-options-link")?.addEventListener("click", e => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
    } finally {
      promoteSubBtn.disabled = false;
    }
  });

  const promoteSection = el("div");
  promoteSection.append(promoteBtn, promoteForm);

  panelBody.append(runBtn, status, output, copyBtn, promoteSection);
}

function renderSeoCheck() {
  panelTitle.textContent = "SEO-Check";

  const runBtn = el("button", { textContent: "Aktiven Tab analysieren" });
  const status = el("div", { className: "tool-status" });
  const output = el("div");
  output.style.cssText = "margin-top:8px;font-size:13px;line-height:1.6;";

  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    status.textContent = "analysiere...";
    status.className = "tool-status";
    output.replaceChildren();
    try {
      const httpBase = await getHttpBase();
      const res = await fetch(`${httpBase}/tools/seo_check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);

      const row = (label, value) => {
        if (!value && value !== 0) return null;
        const wrap = el("div");
        wrap.style.cssText = "padding:3px 0;border-bottom:1px solid var(--border,#eee);";
        const lbl = el("span", { textContent: label + ": " });
        lbl.style.cssText = "font-weight:600;color:var(--muted,#888);margin-right:4px;";
        wrap.append(lbl, document.createTextNode(value));
        return wrap;
      };

      const headingRow = (items, label) => {
        if (!items?.length) return null;
        const wrap = el("div");
        wrap.style.cssText = "padding:3px 0;border-bottom:1px solid var(--border,#eee);";
        const lbl = el("span", { textContent: `${label} (${items.length}): ` });
        lbl.style.cssText = "font-weight:600;color:var(--muted,#888);margin-right:4px;";
        const ul = el("ul");
        ul.style.cssText = "margin:2px 0 0 16px;padding:0;";
        items.slice(0, 5).forEach((t) => ul.append(el("li", { textContent: t })));
        if (items.length > 5) ul.append(el("li", { textContent: `… +${items.length - 5} weitere` }));
        wrap.append(lbl, ul);
        return wrap;
      };

      [
        row("URL", data.url),
        row("Title", data.title),
        row("Description", data.description),
        row("Canonical", data.canonical),
        row("Robots", data.robots),
        headingRow(data.h1, "H1"),
        headingRow(data.h2, "H2"),
        headingRow(data.h3, "H3"),
        row("OG Title", data.og_title),
        row("OG Description", data.og_description),
        row("OG Image", data.og_image),
        row("Twitter Card", data.twitter_card),
        row("Viewport", data.viewport),
        row("Favicon", data.favicon),
      ].forEach((node) => { if (node) output.append(node); });

      status.textContent = "fertig";
      status.className = "tool-status success";
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
    } finally {
      runBtn.disabled = false;
    }
  });

  panelBody.append(runBtn, status, output);
}

function renderImageAnalyse() {
  panelTitle.textContent = "Image-Analyse";

  const runBtn = el("button", { textContent: "Bilder analysieren" });
  const status = el("div", { className: "tool-status" });
  const summary = el("div", { className: "tool-status" });
  const list = el("div");
  list.style.cssText = "overflow-y:auto;max-height:420px;display:flex;flex-direction:column;gap:6px;margin-top:8px;";

  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    status.textContent = "analysiere...";
    status.className = "tool-status";
    summary.textContent = "";
    list.replaceChildren();
    try {
      const httpBase = await getHttpBase();
      const res = await fetch(`${httpBase}/tools/image_analyse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);

      const { images = [], total = 0, missing_alt = 0 } = data;
      status.textContent = "fertig";
      status.className = "tool-status success";
      summary.textContent = `${total} Bilder${missing_alt > 0 ? `, ${missing_alt} ohne Alt-Text` : ""}`;

      for (const img of images) {
        const card = el("div");
        card.style.cssText = "display:flex;gap:8px;align-items:flex-start;padding:6px;border:1px solid var(--border,#ddd);border-radius:4px;";
        const thumb = el("img");
        thumb.src = img.src;
        thumb.style.cssText = "width:72px;height:72px;object-fit:cover;flex-shrink:0;border-radius:3px;";
        const info = el("div");
        info.style.cssText = "font-size:12px;line-height:1.5;overflow:hidden;min-width:0;";
        const dims = el("div", { textContent: `${img.width} × ${img.height}` });
        dims.style.color = "var(--muted,#888)";
        const altEl = el("div");
        if (img.alt === null) {
          altEl.textContent = "kein alt-Attribut";
          altEl.style.cssText = "color:var(--error,#c00);font-weight:600;";
        } else if (img.alt === "") {
          altEl.textContent = "(leeres alt)";
          altEl.style.color = "var(--muted,#888)";
        } else {
          altEl.textContent = img.alt;
        }
        info.append(dims, altEl);
        const dlBtn = el("button", { type: "button", className: "secondary", textContent: "Download" });
        dlBtn.style.cssText = "margin-top:4px;font-size:11px;padding:2px 8px;";
        dlBtn.addEventListener("click", () => {
          const filename = (img.src || img.url || "").split("/").pop().split("?")[0] || "image.jpg";
          chrome.downloads.download({ url: img.src || img.url, filename });
        });
        info.append(dims, altEl, dlBtn);
        card.append(thumb, info);
        list.append(card);
      }

      if (images.length > 1) {
        const dlAllBtn = el("button", { type: "button", className: "secondary", textContent: "Alle herunterladen" });
        dlAllBtn.style.marginTop = "6px";
        dlAllBtn.addEventListener("click", () => {
          for (const img of images) {
            const filename = (img.src || img.url || "").split("/").pop().split("?")[0] || "image.jpg";
            chrome.downloads.download({ url: img.src || img.url, filename });
          }
        });
        list.append(dlAllBtn);
      }
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
    } finally {
      runBtn.disabled = false;
    }
  });

  panelBody.append(runBtn, status, summary, list);
}

function renderColorPicker() {
  panelTitle.textContent = "Color-Picker";

  const runBtn = el("button", { textContent: "Farben extrahieren" });
  const status = el("div", { className: "tool-status" });
  const output = el("div");
  output.style.cssText = "margin-top:8px;font-size:12px;";

  const swatch = (value) => {
    const s = el("span");
    s.style.cssText = `display:inline-block;width:16px;height:16px;border:1px solid var(--border,#ccc);background:${value};vertical-align:middle;margin-right:6px;border-radius:2px;flex-shrink:0;`;
    return s;
  };

  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    status.textContent = "extrahiere...";
    status.className = "tool-status";
    output.replaceChildren();
    try {
      const httpBase = await getHttpBase();
      const res = await fetch(`${httpBase}/tools/color_picker`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);

      if (data.has_design_system && Object.keys(data.css_vars || {}).length > 0) {
        const sec = el("div");
        sec.append(el("strong", { textContent: "CSS-Variablen" }));
        for (const [name, value] of Object.entries(data.css_vars)) {
          const row = el("div");
          row.style.cssText = "display:flex;align-items:center;margin:3px 0;";
          row.append(swatch(value), document.createTextNode(`${name}: ${value}`));
          sec.append(row);
        }
        output.append(sec);
      }

      if (data.computed?.length > 0) {
        const sec = el("div");
        sec.style.marginTop = "10px";
        sec.append(el("strong", { textContent: "Key-Elemente" }));
        for (const item of data.computed) {
          const row = el("div");
          row.style.cssText = "display:flex;align-items:center;gap:4px;margin:3px 0;";
          const lbl = el("span", { textContent: item.selector });
          lbl.style.cssText = "width:90px;color:var(--muted,#888);flex-shrink:0;";
          row.append(lbl);
          if (item.color) row.append(swatch(item.color));
          if (item.background) row.append(swatch(item.background));
          sec.append(row);
        }
        output.append(sec);
      }

      if (!data.has_design_system && !data.computed?.length) {
        status.textContent = "Keine Farben gefunden";
        status.className = "tool-status";
        return;
      }
      status.textContent = "fertig";
      status.className = "tool-status success";
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
    } finally {
      runBtn.disabled = false;
    }
  });

  const eyeBtn = el("button", { type: "button", className: "secondary", textContent: "🎨 Aus Seite" });
  const eyeResult = el("div");
  eyeResult.style.cssText = "margin-top:6px;font-size:12px;";

  eyeBtn.addEventListener("click", async () => {
    if (!window.EyeDropper) {
      eyeBtn.disabled = true;
      eyeBtn.textContent = "Nicht verfügbar";
      return;
    }
    try {
      const dropper = new EyeDropper();
      const { sRGBHex } = await dropper.open();
      eyeResult.replaceChildren();
      const row = el("div");
      row.style.cssText = "display:flex;align-items:center;gap:6px;margin:3px 0;";
      const hexCopy = el("span", { textContent: sRGBHex });
      hexCopy.style.cssText = "cursor:pointer;";
      hexCopy.title = "Kopieren";
      hexCopy.addEventListener("click", () => navigator.clipboard.writeText(sRGBHex));
      row.append(swatch(sRGBHex), hexCopy);
      eyeResult.append(row);
    } catch {
      // ESC gedrückt — kein Fehler zeigen
    }
  });

  const btnRow = el("div");
  btnRow.style.cssText = "display:flex;gap:8px;";
  btnRow.append(runBtn, eyeBtn);
  panelBody.append(btnRow, eyeResult, status, output);
}

function renderScreenshot() {
  panelTitle.textContent = "Screenshot + Annotation";

  const runBtn = el("button", { textContent: "Screenshot erstellen" });
  const status = el("div", { className: "tool-status" });

  // Annotation-Toolbar (versteckt bis Screenshot geladen)
  const toolbar = el("div", { className: "annot-toolbar" });
  toolbar.style.display = "none";

  const toolBtns = {};
  const tools = [
    { id: "pen",  label: "✏ Stift" },
    { id: "rect", label: "□ Rechteck" },
    { id: "arrow", label: "→ Pfeil" },
    { id: "text", label: "T Text" },
  ];
  let activeTool = "pen";

  tools.forEach(({ id, label }) => {
    const btn = el("button", { textContent: label });
    btn.classList.add("secondary", "annot-tool-btn");
    btn.dataset.tool = id;
    btn.addEventListener("click", () => {
      activeTool = id;
      Object.values(toolBtns).forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    });
    toolBtns[id] = btn;
    toolbar.append(btn);
  });
  toolBtns["pen"].classList.add("active");

  const colorPicker = document.createElement("input");
  colorPicker.type = "color";
  colorPicker.value = "#ff0000";
  colorPicker.className = "annot-color-picker";
  colorPicker.title = "Farbe";

  const sizeSelect = document.createElement("select");
  sizeSelect.className = "annot-size-select";
  [["2px", "2"], ["4px", "4"], ["6px", "6"]].forEach(([label, val]) => {
    const opt = document.createElement("option");
    opt.textContent = label;
    opt.value = val;
    sizeSelect.append(opt);
  });
  sizeSelect.value = "2";

  const undoBtn = el("button", { textContent: "↩ Undo" });
  undoBtn.classList.add("secondary", "annot-tool-btn");

  toolbar.append(colorPicker, sizeSelect, undoBtn);

  // Canvas
  const canvas = document.createElement("canvas");
  canvas.className = "annot-canvas";
  canvas.style.display = "none";

  const actions = el("div");
  actions.style.cssText = "display:none;gap:8px;margin-top:6px;";
  const copyBtn = el("button", { textContent: "Kopieren" });
  const dlBtn = el("button", { textContent: "Download" });
  copyBtn.classList.add("secondary");
  dlBtn.classList.add("secondary");
  actions.append(copyBtn, dlBtn);

  // Zeichnen-State
  const ctx = canvas.getContext("2d");
  const undoStack = [];
  let drawing = false;
  let startX = 0, startY = 0;
  let snapshot = null;

  function saveUndo() {
    if (undoStack.length >= 20) undoStack.shift();
    undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  }

  function getPos(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (canvas.width / r.width),
      y: (e.clientY - r.top) * (canvas.height / r.height),
    };
  }

  function drawArrow(x1, y1, x2, y2) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const headLen = Math.max(12, ctx.lineWidth * 4);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
  }

  canvas.addEventListener("mousedown", (e) => {
    const pos = getPos(e);
    startX = pos.x;
    startY = pos.y;
    drawing = true;
    ctx.strokeStyle = colorPicker.value;
    ctx.fillStyle = colorPicker.value;
    ctx.lineWidth = parseInt(sizeSelect.value, 10);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (activeTool === "text") {
      drawing = false;
      const text = prompt("Text eingeben:");
      if (!text) return;
      saveUndo();
      ctx.font = `${14 + parseInt(sizeSelect.value, 10) * 2}px sans-serif`;
      ctx.fillText(text, pos.x, pos.y);
      return;
    }

    saveUndo();

    if (activeTool === "pen") {
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
    } else {
      snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    }
  });

  canvas.addEventListener("mousemove", (e) => {
    if (!drawing) return;
    const pos = getPos(e);

    if (activeTool === "pen") {
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
      return;
    }

    // Vorschau für Rect + Arrow: vorherigen Snapshot zurückspielen
    ctx.putImageData(snapshot, 0, 0);
    ctx.strokeStyle = colorPicker.value;
    ctx.lineWidth = parseInt(sizeSelect.value, 10);
    ctx.lineCap = "round";

    if (activeTool === "rect") {
      ctx.strokeRect(startX, startY, pos.x - startX, pos.y - startY);
    } else if (activeTool === "arrow") {
      drawArrow(startX, startY, pos.x, pos.y);
    }
  });

  canvas.addEventListener("mouseup", (e) => {
    if (!drawing) return;
    drawing = false;
    if (activeTool === "pen") {
      ctx.closePath();
    }
    // Rect + Arrow sind bereits im letzten mousemove gezeichnet — nichts weiter nötig
    snapshot = null;
  });

  canvas.addEventListener("mouseleave", () => {
    if (drawing && activeTool === "pen") {
      drawing = false;
      ctx.closePath();
    }
  });

  undoBtn.addEventListener("click", () => {
    if (!undoStack.length) return;
    ctx.putImageData(undoStack.pop(), 0, 0);
  });

  // Screenshot laden
  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    status.textContent = "erstelle Screenshot...";
    status.className = "tool-status";
    canvas.style.display = "none";
    toolbar.style.display = "none";
    actions.style.display = "none";
    undoStack.length = 0;
    try {
      const httpBase = await getHttpBase();
      const res = await fetch(`${httpBase}/tools/screenshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);

      const img = new Image();
      img.onload = () => {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        ctx.drawImage(img, 0, 0);
        canvas.style.display = "block";
        toolbar.style.display = "flex";
        actions.style.display = "flex";
        status.textContent = "fertig — Annotation möglich";
        status.className = "tool-status success";
      };
      img.src = data.dataUrl;
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
    } finally {
      runBtn.disabled = false;
    }
  });

  copyBtn.addEventListener("click", async () => {
    canvas.toBlob(async (blob) => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        copyBtn.textContent = "Kopiert!";
        setTimeout(() => { copyBtn.textContent = "Kopieren"; }, 1500);
      } catch {
        copyBtn.textContent = "Fehler";
        setTimeout(() => { copyBtn.textContent = "Kopieren"; }, 1500);
      }
    }, "image/png");
  });

  dlBtn.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `screenshot-annotated-${Date.now()}.png`;
    a.click();
  });

  panelBody.append(runBtn, status, toolbar, canvas, actions);
}

// ── URL-Extraktor ────────────────────────────────────────────────────────────

function renderUrlExtractor() {
  panelTitle.textContent = "URL-Extraktor";

  const filterRow = el("label", { className: "checkbox-row" });
  const filterCb = el("input", { type: "checkbox" });
  filterCb.checked = true;
  filterRow.append(filterCb, el("span", { textContent: "Nur diese Domain" }));

  const runBtn = el("button", { textContent: "URLs extrahieren" });
  const status = el("div", { className: "tool-status" });

  const formatTabs = el("div", { className: "format-tabs" });
  const formats = ["Liste", "Komma", "JSON"];
  let activeFormat = "Liste";
  let lastUrls = [];

  const output = el("textarea", { readOnly: true, className: "url-extractor-output", placeholder: "URLs erscheinen hier..." });

  function renderOutput() {
    if (!lastUrls.length) return;
    if (activeFormat === "Liste") output.value = lastUrls.join("\n");
    else if (activeFormat === "Komma") output.value = lastUrls.join(", ");
    else output.value = JSON.stringify(lastUrls, null, 2);
  }

  for (const fmt of formats) {
    const btn = el("button", { type: "button", textContent: fmt, className: "format-tab-btn" + (fmt === activeFormat ? " active" : "") });
    btn.addEventListener("click", () => {
      activeFormat = fmt;
      for (const b of formatTabs.querySelectorAll(".format-tab-btn")) b.classList.remove("active");
      btn.classList.add("active");
      renderOutput();
    });
    formatTabs.append(btn);
  }

  const copyBtn = el("button", { textContent: "Kopieren" });
  copyBtn.classList.add("secondary");

  let lastBaseUrl = "";

  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    status.textContent = "extrahiere...";
    status.className = "tool-status";
    output.value = "";
    lastUrls = [];
    try {
      const httpBase = await getHttpBase();
      const res = await fetch(`${httpBase}/tools/url_extractor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter_domain: filterCb.checked }),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
      lastUrls = data.urls || [];
      lastBaseUrl = data.base_url || "";
      renderOutput();
      status.textContent = `${data.count || 0} URLs gefunden`;
      status.className = "tool-status success";
      panelBody.querySelector(".url-source-row")?.remove();
      const sourceRow = el("div", { className: "url-source-row" });
      sourceRow.append(el("span", { className: "url-source-label", textContent: "Quelle:" }));
      try {
        const hostname = new URL(data.base_url).hostname;
        const link = el("a", { href: data.base_url, textContent: hostname, target: "_blank", className: "url-source-link" });
        sourceRow.append(link);
        if (!promoteTitle.value) promoteTitle.value = hostname;
      } catch {
        sourceRow.append(el("span", { textContent: data.base_url }));
      }
      output.before(sourceRow);
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
    } finally {
      runBtn.disabled = false;
    }
  });

  copyBtn.addEventListener("click", () => {
    if (output.value) navigator.clipboard.writeText(output.value);
  });

  // ── Ins Brain ────────────────────────────────────────────────────────────
  const promoteBtn = el("button", { textContent: "Ins Brain", className: "secondary" });
  promoteBtn.style.marginTop = "6px";

  const promoteForm = el("div");
  promoteForm.style.cssText = "display:none;margin-top:8px;padding:10px;border:1px solid var(--border,#ddd);border-radius:6px;background:var(--bg-subtle);";

  const promoteTitle = el("input", { type: "text", placeholder: "Titel (Pflichtfeld)" });
  const promoteSub = el("select");
  ["eigene-notizen", "artikel", "chat-archive"].forEach(s => promoteSub.append(new Option(s, s)));
  const promoteDesc = el("textarea", { placeholder: "Beschreibung (optional)" });
  promoteDesc.style.cssText = "min-height:52px;resize:vertical;margin-top:6px;font-size:12px;";
  const promoteHint = el("div", { className: "tool-status" });
  const promoteSubBtn = el("button", { textContent: "Speichern" });
  const promoteCancelBtn = el("button", { textContent: "Abbrechen", className: "secondary" });
  promoteCancelBtn.style.marginLeft = "6px";

  const promoteSubLabel = el("label", { textContent: "Ziel-Ordner:" });
  promoteSubLabel.style.cssText = "margin-top:6px;display:block;";
  const promoteActRow = el("div");
  promoteActRow.style.marginTop = "8px";
  promoteActRow.append(promoteSubBtn, promoteCancelBtn);

  promoteForm.append(promoteTitle, promoteSubLabel, promoteSub, promoteDesc, promoteHint, promoteActRow);

  promoteBtn.addEventListener("click", () => {
    promoteForm.style.display = promoteForm.style.display === "none" ? "block" : "none";
  });
  promoteCancelBtn.addEventListener("click", () => {
    promoteForm.style.display = "none";
  });
  promoteSubBtn.addEventListener("click", async () => {
    const title = promoteTitle.value.trim();
    if (!title) { promoteHint.textContent = "Titel erforderlich"; promoteHint.className = "tool-status error"; return; }
    if (!lastUrls.length) { promoteHint.textContent = "Erst URLs extrahieren"; promoteHint.className = "tool-status error"; return; }
    promoteSubBtn.disabled = true;
    promoteHint.textContent = "speichere...";
    promoteHint.className = "tool-status";
    try {
      const httpBase = await getHttpBase();
      const vaultId = await getActiveVaultId(httpBase);
      if (!vaultId) throw new Error("Kein Vault konfiguriert");
      const content = lastUrls.map(u => `- ${u}`).join("\n");
      const res = await fetch(`${httpBase}/tools/raw/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vault_id: vaultId,
          title,
          content,
          target_subfolder: promoteSub.value,
          description: promoteDesc.value.trim() || null,
        }),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) {
        if (res.status === 403) throw new Error(`Fehlende Berechtigung. <a href="#" class="open-options-link">In Options aktivieren</a>`);
        throw new Error(data?.detail || text || `HTTP ${res.status}`);
      }
      promoteHint.textContent = `Gespeichert: ${data.data?.raw_path || "OK"}`;
      promoteHint.className = "tool-status success";
      promoteTitle.value = "";
      promoteDesc.value = "";
      promoteForm.style.display = "none";
    } catch (err) {
      promoteHint.innerHTML = err.message || String(err);
      promoteHint.className = "tool-status error";
      promoteHint.querySelector(".open-options-link")?.addEventListener("click", e => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
    } finally {
      promoteSubBtn.disabled = false;
    }
  });

  const promoteSection = el("div");
  promoteSection.append(promoteBtn, promoteForm);

  panelBody.append(filterRow, runBtn, status, formatTabs, output, copyBtn, promoteSection);
}

// ── Guten-Morgen-Briefing ────────────────────────────────────────────────────

async function showBriefingPanel() {
  const existing = document.querySelector(".briefing-panel");
  if (existing) { existing.remove(); return; }

  const panel = el("div", { className: "briefing-panel" });
  const header = el("div", { className: "briefing-header" });
  header.append(el("strong", { textContent: "Guten Morgen" }));
  const now = new Date();
  const dateStr = now.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const timeStr = now.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  header.append(el("div", { className: "briefing-datetime", textContent: `${dateStr} · ${timeStr}` }));
  const closeBtn = el("button", { type: "button", textContent: "×", className: "briefing-close" });
  closeBtn.addEventListener("click", () => panel.remove());
  header.append(closeBtn);
  panel.append(header);

  const body = el("div", { className: "briefing-body" });
  body.textContent = "laden...";
  panel.append(body);
  document.body.append(panel);

  try {
    const httpBase = await getHttpBase();
    const res = await fetch(`${httpBase}/tools/briefing?profile=default`);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
    body.replaceChildren();
    renderBriefingSections(body, data.data || data);
  } catch (err) {
    body.textContent = "Fehler: " + (err.message || err);
    body.className = "briefing-body error";
  }
}

function renderBriefingSections(target, briefingData) {
  const sections = briefingData.sections || [];
  for (const sec of sections) {
    const card = el("div", { className: `briefing-section briefing-section--${sec.type}` });
    card.append(el("h4", { className: "briefing-section-title", textContent: sec.title }));

    if (sec.type === "wetter") {
      for (const w of sec.items || []) {
        const row = el("div", { className: "briefing-wetter-row" });
        const city = el("span", { className: "briefing-wetter-city", textContent: w.stadt });
        const temp = el("span", { className: "briefing-wetter-temp", textContent: `${w.temp_c}°` });
        const desc = el("span", { className: "briefing-wetter-desc", textContent: w.beschreibung });
        const extra = el("span", { className: "briefing-wetter-extra", textContent: `${w.luftfeuchtigkeit}% · ${w.windgeschwindigkeit} km/h` });
        row.append(city, temp, desc, extra);
        card.append(row);
      }
    } else if (sec.type === "todos") {
      const today = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      for (const t of sec.items || []) {
        if (t.done) continue;
        const row = el("div", { className: "briefing-todo-row" });
        const text = el("span", { textContent: t.text });
        row.append(text);
        if (t.due && (t.due === today || t.due === tomorrow)) {
          row.append(el("span", { className: "briefing-due-badge", textContent: t.due === today ? "heute" : "morgen" }));
        }
        card.append(row);
      }
      if (!card.querySelector(".briefing-todo-row")) {
        card.append(el("div", { className: "briefing-empty", textContent: "Keine offenen Todos" }));
      }
    } else if (sec.type === "fristen") {
      for (const f of sec.items || []) {
        const cls = f.days_left <= 7 ? "urgent" : f.days_left <= 30 ? "warning" : "";
        const row = el("div", { className: "frist-item" + (cls ? " " + cls : "") });
        row.append(el("span", { textContent: f.title }));
        row.append(el("span", { className: "frist-days", textContent: `${f.days_left}d` }));
        card.append(row);
      }
      if (!card.querySelector(".frist-item")) {
        card.append(el("div", { className: "briefing-empty", textContent: "Keine Fristen" }));
      }
    } else if (sec.type === "lernstreak") {
      const msg = sec.days_ago === 0
        ? "Heute schon gelernt"
        : sec.last_video_title
          ? `Letztes Video: "${sec.last_video_title}" — vor ${sec.days_ago} Tag${sec.days_ago === 1 ? "" : "en"}`
          : "Heute noch kein Video";
      card.append(el("div", { textContent: msg }));
    }

    target.append(card);
  }
  if (!sections.length) {
    target.append(el("div", { className: "briefing-empty", textContent: "Keine Daten" }));
  }
}

// ── YouTube Auto-Brain Modal ─────────────────────────────────────────────────

async function checkPendingBrainPick() {
  const { brainPick } = await chrome.storage.local.get("brainPick");
  if (!brainPick || !brainPick.url) return;
  if (brainPick.ts && Date.now() - brainPick.ts > 5 * 60 * 1000) {
    chrome.storage.local.remove("brainPick");
    return;
  }
  chrome.storage.local.remove("brainPick");
  await showBrainModal(brainPick);
}

async function showBrainModal({ url, tabId }) {
  const overlay = el("div", { className: "playlist-picker-overlay" });
  const dialog = el("div", { className: "brain-modal" });
  dialog.append(el("h3", { textContent: "Video ins Brain speichern" }));
  dialog.append(el("div", { className: "brain-modal-meta", textContent: url }));

  const status = el("div", { className: "tool-status", textContent: "Transcript wird extrahiert..." });
  dialog.append(status);

  const cancelBtn = el("button", { type: "button", textContent: "Abbrechen", className: "secondary" });
  cancelBtn.addEventListener("click", () => overlay.remove());

  overlay.append(dialog);
  document.body.append(overlay);

  const httpBase = await getHttpBase();
  const vaultId = await getActiveVaultId(httpBase);
  if (!vaultId) {
    status.textContent = "Kein Vault konfiguriert.";
    status.className = "tool-status error";
    dialog.append(cancelBtn);
    return;
  }

  // Lade Säulen + Transcript parallel
  let brainData = null;
  let saeulenList = [];
  try {
    const [brainRes, saeulenRes] = await Promise.all([
      fetch(`${httpBase}/tools/auto_brain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, vault_id: vaultId, tab_id: tabId }),
      }),
      fetch(`${httpBase}/vaults/${vaultId}/saeulen`),
    ]);
    const brainText = await brainRes.text();
    let brainJson = null;
    try { brainJson = JSON.parse(brainText); } catch {}
    if (!brainRes.ok) throw new Error(brainJson?.detail || brainText || `HTTP ${brainRes.status}`);
    brainData = brainJson.data || brainJson;
    if (saeulenRes.ok) {
      const sd = await saeulenRes.json().catch(() => ({}));
      saeulenList = sd.saeulen || [];
    }
  } catch (err) {
    status.textContent = "Fehler: " + (err.message || err);
    status.className = "tool-status error";
    dialog.append(cancelBtn);
    return;
  }

  status.textContent = "";
  status.className = "tool-status";

  dialog.append(el("div", { className: "brain-modal-title", textContent: brainData.title || url }));

  const suggestion = brainData.suggestion || {};
  const confidenceCls = { high: "high", medium: "medium", low: "low" }[suggestion.confidence] || "low";
  dialog.append(el("span", { className: `confidence-badge ${confidenceCls}`, textContent: suggestion.confidence || "?" }));

  // Säulen-Dropdown
  const saeulaLabel = el("label", { textContent: "Säule" });
  const saeulaSelect = el("select");
  saeulenList.forEach(s => {
    const opt = new Option(s, s);
    if (s === suggestion.saeule) opt.selected = true;
    saeulaSelect.append(opt);
  });
  if (!saeulenList.length) saeulaSelect.append(new Option(suggestion.saeule || "knowledge-library/ai", suggestion.saeule || "knowledge-library/ai"));

  // Playlist-Dropdown mit Lazy-Load
  const playlistLabel = el("label", { textContent: "Playlist" });
  const playlistSelect = el("select");
  const playlistNewInput = el("input", { type: "text", placeholder: "Neue Playlist eingeben..." });
  playlistNewInput.style.display = "none";

  async function loadPlaylists(saeule) {
    try {
      const res = await fetch(`${httpBase}/tools/playlists/${vaultId}?saeule=${encodeURIComponent(saeule)}`);
      const data = await res.json().catch(() => ({}));
      const items = data.items || [];
      playlistSelect.replaceChildren();
      items.forEach(p => {
        const opt = new Option(p.name, p.name);
        if (p.name === suggestion.playlist_name) opt.selected = true;
        playlistSelect.append(opt);
      });
      playlistSelect.append(new Option("+ Neue Playlist...", "__new__"));
    } catch {}
  }

  saeulaSelect.addEventListener("change", () => loadPlaylists(saeulaSelect.value));
  playlistSelect.addEventListener("change", () => {
    playlistNewInput.style.display = playlistSelect.value === "__new__" ? "block" : "none";
  });

  await loadPlaylists(saeulaSelect.value);

  dialog.append(saeulaLabel, saeulaSelect, playlistLabel, playlistSelect, playlistNewInput);

  if (suggestion.tags && suggestion.tags.length) {
    dialog.append(el("div", { className: "brain-modal-tags", textContent: suggestion.tags.map(t => `#${t}`).join(" ") }));
  }

  // Ingest-Checkbox
  const ingestRow = el("label", { className: "checkbox-row" });
  const ingestCb = el("input", { type: "checkbox" });
  ingestCb.checked = true;
  ingestRow.append(ingestCb, el("span", { textContent: "Direkt ingestet (ohne Claude Code)" }));
  ingestRow.style.cssText = "margin-top:8px;font-size:12px;";
  dialog.append(ingestRow);

  const saveStatus = el("div", { className: "tool-status" });
  dialog.append(saveStatus);

  const actions = el("div", { className: "playlist-picker-actions" });
  const saveBtn = el("button", { type: "button", textContent: "Speichern", className: "primary" });

  saveBtn.addEventListener("click", async () => {
    const saeule = saeulaSelect.value;
    const playlistName = playlistSelect.value === "__new__"
      ? playlistNewInput.value.trim()
      : playlistSelect.value;
    if (!playlistName || playlistName === "__new__") {
      saveStatus.textContent = "Playlist erforderlich";
      saveStatus.className = "tool-status error";
      return;
    }
    saveBtn.disabled = true;
    saveStatus.textContent = "speichere...";
    saveStatus.className = "tool-status";
    try {
      const res = await fetch(`${httpBase}/tools/brain/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vault_id: vaultId,
          url,
          title: brainData.title || url,
          transcript: brainData.transcript || "",
          saeule,
          playlist_name: playlistName,
          tags: suggestion.tags || [],
          ingest_now: ingestCb.checked,
        }),
      });
      const resText = await res.text();
      let resData = null;
      try { resData = JSON.parse(resText); } catch {}
      if (!res.ok) throw new Error(resData?.detail || resText || `HTTP ${res.status}`);
      if (resData?.data?.ingest_warning) {
        saveStatus.textContent = `Gespeichert (Ingest-Warnung: ${resData.data.ingest_warning})`;
        saveStatus.className = "tool-status";
        setTimeout(() => overlay.remove(), 2500);
      } else {
        overlay.remove();
      }
    } catch (err) {
      const msg = err.message || String(err);
      if (msg.includes("Schreibrecht") || msg.includes("write_raw") || msg.includes("write_playlists")) {
        saveStatus.innerHTML = `Fehlende Berechtigung. <a href="#" id="perm-link">In Options aktivieren</a>`;
        saveStatus.querySelector("#perm-link").addEventListener("click", e => {
          e.preventDefault();
          chrome.runtime.openOptionsPage();
        });
      } else {
        saveStatus.textContent = "Fehler: " + msg;
      }
      saveStatus.className = "tool-status error";
      saveBtn.disabled = false;
    }
  });

  actions.append(cancelBtn, saveBtn);
  dialog.append(actions);
}

// ── YouTube-Hint im Header ───────────────────────────────────────────────────

async function checkActiveTabForYoutube() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && /^https?:\/\/(www\.)?youtube\.com\/watch/.test(tab.url)) {
      showBrainHint(tab.url, tab.id);
    } else {
      hideBrainHint();
    }
  } catch {
    hideBrainHint();
  }
}

function showBrainHint(url, tabId) {
  if (document.getElementById("brain-hint-btn")) return;
  const btn = el("button", {
    type: "button",
    id: "brain-hint-btn",
    className: "quick-btn quick-btn--brain",
  });
  btn.append(el("span", { className: "quick-icon", textContent: "⬇" }));
  btn.append(el("span", { textContent: "Brain" }));
  btn.addEventListener("click", () => showBrainModal({ url, tabId }));
  document.getElementById("quick-actions")?.append(btn);
}

function hideBrainHint() {
  document.getElementById("brain-hint-btn")?.remove();
}

chrome.tabs.onActivated.addListener(() => checkActiveTabForYoutube());
