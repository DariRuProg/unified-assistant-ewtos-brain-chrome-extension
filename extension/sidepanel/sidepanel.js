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

const TOOL_RENDERERS = {
  youtube_transcript: renderYoutubeTranscript,
  scratchpad: () => renderNotesFile("scratchpad", {
    title: "Note-Taker",
    placeholder: "Notizen, Gedanken, Skizzen... wird automatisch gespeichert.",
  }),
  todos: renderTodos,
  chat: renderChat,
};

const GROUPS = [
  {
    id: "vault",
    label: "Vault",
    tools: [
      { id: "chat", label: "Chat mit Vault", hint: "Karpathy-Navigation, Claude API" },
      { id: "scratchpad", label: "Note-Taker", hint: "globaler Scratchpad" },
      { id: "todos", label: "Todos", hint: "klickbare Liste mit Due-Dates" },
    ],
  },
  {
    id: "web",
    label: "Web",
    tools: [
      { id: "youtube_transcript", label: "YouTube-Transcript", hint: "Transkript aus aktivem Tab" },
      { id: "page_scrape", label: "Page-Scrape", hint: "Sprint 3", soon: true },
      { id: "seo_check", label: "SEO-Check", hint: "Sprint 3", soon: true },
      { id: "image_analyse", label: "Image-Analyse", hint: "Sprint 3", soon: true },
      { id: "color_picker", label: "Color-Picker", hint: "Sprint 3", soon: true },
      { id: "screenshot", label: "Screenshot + Annotation", hint: "Sprint 3", soon: true },
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

let activeTab = GROUPS[0].id;
let activeTool = null;

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
checkPendingPlaylistPick();

chrome.runtime.sendMessage({ type: "get_connection_status" }, (resp) => {
  if (chrome.runtime.lastError) return;
  if (resp) setStatus(!!resp.connected);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "connection_status") setStatus(!!msg.connected);
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
  const list = el("ul", { className: "tools" });
  for (const t of group.tools) {
    const li = el("li", { className: "tool" + (t.soon ? " soon" : "") });
    li.append(el("span", { className: "tool-label", textContent: t.label }));
    if (t.hint) li.append(el("span", { className: "hint", textContent: t.hint }));
    if (t.soon) {
      li.append(el("span", { className: "badge", textContent: "bald" }));
    } else {
      li.addEventListener("click", () => openTool(t.id));
    }
    list.append(li);
  }
  content.append(list);
}

function openTool(toolId) {
  const renderer = TOOL_RENDERERS[toolId];
  if (!renderer) return;
  activeTool = toolId;

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
  renderToolList();
}

function renderYoutubeTranscript() {
  panelTitle.textContent = "YouTube-Transcript";

  const urlInput = el("input", { type: "url", placeholder: "https://www.youtube.com/watch?v=..." });
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

  panelBody.append(meta, textarea, status, exportBtn, fallbackRow);

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
  inputWrap.append(inputArea, sendBtn);

  const toolbar = el("div", { className: "chat-toolbar" });
  const clearBtn = el("button", { type: "button", textContent: "Verlauf löschen" });
  clearBtn.classList.add("secondary");
  toolbar.append(clearBtn);

  const status = el("div", { className: "tool-status" });

  panelBody.append(header, meta, log, status, inputWrap, toolbar);

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
    if (busy || !currentVaultId) return;
    busy = true;
    sendBtn.disabled = true;
    inputArea.disabled = true;
    vaultSelect.disabled = true;

    // Echo user message immediately
    appendBubble("user", message);
    const assistantBubble = appendBubble("assistant");
    assistantBubble.classList.add("streaming");
    let assistantText = "";

    setStatus("denkt...");
    try {
      const res = await fetch(`${httpBase}/tools/chat/${currentVaultId}/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ message }),
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
          assistantBubble.textContent = assistantText;
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
      vaultSelect.disabled = false;
      inputArea.focus();
    }
  }

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
    const h = lines[0].match(/^(#{1,6})\s+(.+)$/);
    if (lines.length === 1 && h) {
      const level = Math.min(h[1].length + 1, 6);
      return `<h${level}>${inlineMd(h[2])}</h${level}>`;
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

function el(tag, props = {}) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  return node;
}
