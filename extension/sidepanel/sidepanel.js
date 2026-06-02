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
  const stored = (await chrome.storage.local.get("quickSlots")).quickSlots;
  if (Array.isArray(stored)) {
    quickSlots = stored.slice(0, QUICK_SLOT_COUNT);
    while (quickSlots.length < QUICK_SLOT_COUNT) quickSlots.push(null);
  }
  renderTabs();
  renderQuickActions();
  await loadQuickRowPref();
  if (!activeTool) renderToolList();
})();

chrome.storage.onChanged.addListener((changes) => {
  if (changes.theme !== undefined || changes.darkMode !== undefined) {
    chrome.storage.local.get(["theme", "darkMode"], ({ theme = "neutral", darkMode = false }) => {
      applyTheme(theme, darkMode);
      updateDarkToggleIcon(darkMode);
    });
  }
  if (changes.hideQuickRowOnTool !== undefined) {
    hideQuickRowOnTool = !!changes.hideQuickRowOnTool.newValue;
    applyQuickRowVisibility();
  }
  if (changes.playlistPick && changes.playlistPick.newValue) {
    checkPendingPlaylistPick();
  }
});

// ── DOM refs ─────────────────────────────────────────────────────────────────

const statusDot = document.getElementById("status-dot");
const tabsNav = document.getElementById("tabs");
const content = document.getElementById("content");
const openOptions = document.getElementById("open-options");
const reconnectBtn = document.getElementById("reconnect");
const quickActions = document.getElementById("quick-actions");
const offlineBannerText = document.getElementById("offline-banner-text");
const DEFAULT_OFFLINE_HTML = offlineBannerText ? offlineBannerText.innerHTML : "";

const TOOL_RENDERERS = {
  youtube_transcript: renderYoutubeTranscript,
  scratchpad: () => renderNotesFile("scratchpad", {
    title: "Note-Taker",
    placeholder: "Notizen, Gedanken, Skizzen... wird automatisch gespeichert.",
  }),
  todos: renderTodos,
  chat: renderChat,
  vault_explorer: renderVaultExplorer,
  vault_health: renderVaultHealth,
  playlists: renderPlaylistsTool,
  bookmarks: renderBookmarksTool,
  page_scrape: renderPageScrape,
  seo_check: renderSeoCheck,
  image_analyse: renderImageAnalyse,
  color_picker: renderColorPicker,
  screenshot: renderScreenshot,
  url_extractor: renderUrlExtractor,
  image_generator: renderImageGenerator,
};

const GROUPS = [
  {
    id: "vault",
    label: "Vault",
    tools: [
      { id: "vault_explorer", label: "Explorer", hint: "Vault durchblättern, Dateien lesen, mit ihnen chatten", icon: "📚" },
      { id: "scratchpad", label: "Note-Taker", hint: "globaler Scratchpad", icon: "📝" },
      { id: "todos", label: "Todos", hint: "klickbare Liste mit Due-Dates", icon: "✅" },
      { id: "playlists", label: "Playlists", hint: "Video-Sammlungen pro Säule", icon: "🎵" },
      { id: "vault_health", label: "Vault-Gesundheit", hint: "Audit: Orphans, Links, Frontmatter, CLAUDE.md", icon: "🩺" },
      { id: "bookmarks", label: "Bookmarks", hint: "URL-Inbox aus Browser-Capture", icon: "🔖",
        actions: [
          { label: "Neuen Bookmark", icon: "+", action: "add" },
          { label: "Markierte Tabs erfassen", icon: "⇲", action: "capture_tabs" },
          { label: "URLs der Tabs kopieren", icon: "⧉", action: "copy_urls" },
        ],
      },
    ],
  },
  {
    id: "web",
    label: "Web",
    tools: [
      { id: "youtube_transcript", label: "YouTube-Transcript", hint: "Transkript aus aktivem Tab", icon: "🎬" },
      { id: "page_scrape", label: "Page-Scrape", hint: "Aktiver Tab → bereinigtes Markdown", icon: "📄",
        actions: [
          { label: "Nur Inhalt scrapen", icon: "▸", action: "scrape_content" },
          { label: "Komplette Seite scrapen", icon: "▸", action: "scrape_full" },
        ],
      },
      { id: "seo_check", label: "SEO-Check", hint: "Title, Meta, Headings, OG-Tags", icon: "🔍" },
      { id: "image_analyse", label: "Image-Analyse", hint: "Bilder + Alt-Text-Check", icon: "🖼️" },
      { id: "color_picker", label: "Color-Picker", hint: "CSS-Variablen + Farbpalette", icon: "🎨" },
      { id: "screenshot", label: "Screenshot", hint: "Sichtbar, Bereich wählen oder Ganze Seite", icon: "📸",
        actions: [
          { label: "Sichtbar", icon: "▸", action: "shot_visible" },
          { label: "Bereich wählen", icon: "▸", action: "shot_area" },
          { label: "Ganze Seite", icon: "▸", action: "shot_full" },
        ],
      },
      { id: "url_extractor", label: "URL-Extraktor", hint: "Alle Links der aktuellen Seite", icon: "🔗" },
      { id: "image_generator", label: "Image-Gen", hint: "Bild erzeugen + editieren (Gemini Nano Banana)", icon: "🪄" },
    ],
  },
];

const QUICK_SPECIAL = {
  _briefing: { label: "Briefing", icon: "☀", run: () => showBriefingPanel() },
};
const DEFAULT_QUICK_SLOTS = ["vault_explorer", "scratchpad", "todos", "_briefing"];
const QUICK_SLOT_COUNT = 4;
let quickSlots = DEFAULT_QUICK_SLOTS.slice();

function getQuickOption(id) {
  if (!id) return null;
  if (QUICK_SPECIAL[id]) {
    return { id, label: QUICK_SPECIAL[id].label, icon: QUICK_SPECIAL[id].icon, special: true };
  }
  for (const g of GROUPS) {
    const t = g.tools.find((x) => x.id === id);
    if (t) return { id: t.id, label: t.label, icon: t.icon || "•", special: false };
  }
  return null;
}

function getAllQuickOptions() {
  const opts = [];
  for (const [id, meta] of Object.entries(QUICK_SPECIAL)) {
    opts.push({ id, label: meta.label, icon: meta.icon, special: true });
  }
  for (const g of GROUPS) {
    for (const t of g.tools) {
      if (t.soon) continue;
      opts.push({ id: t.id, label: t.label, icon: t.icon || "•", group: g.label });
    }
  }
  return opts;
}

function runQuickSlot(id) {
  if (QUICK_SPECIAL[id]) return QUICK_SPECIAL[id].run();
  openTool(id);
}

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
checkStartTool();
checkActiveTabForYoutube();

// Globaler Click-Handler für Obsidian-Wikilinks aus renderMarkdown.
// Öffnet die Ziel-Datei im Vault-Explorer (gleicher Vault wie aktuell ausgewählt).
document.addEventListener("click", async (e) => {
  const link = e.target.closest("a.wiki-link");
  if (!link) return;
  e.preventDefault();
  let rel = link.dataset.rel || "";
  if (!rel) return;
  if (!/\.(md|txt)$/i.test(rel)) rel = rel + ".md";
  const { selectedVaultId } = await chrome.storage.local.get("selectedVaultId");
  if (!selectedVaultId) return;
  openTool("vault_explorer", { initialFile: rel, vaultId: selectedVaultId });
});

chrome.runtime.sendMessage({ type: "get_connection_status" }, (resp) => {
  if (chrome.runtime.lastError) return;
  if (resp) setStatus(!!resp.connected);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "connection_status") {
    if (msg.incompatible) {
      if (offlineBannerText) {
        offlineBannerText.textContent =
          `Version-Konflikt: Server v${msg.serverVersion ?? "?"}, Extension v${chrome.runtime.getManifest().version}. Bitte beide aktualisieren.`;
      }
      setStatus(false, "Version-Konflikt");
    } else {
      if (offlineBannerText) offlineBannerText.innerHTML = DEFAULT_OFFLINE_HTML;
      setStatus(!!msg.connected);
    }
  }
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
  if (area === "local" && changes.startTool && changes.startTool.newValue) {
    checkStartTool();
  }
  // Vault-Switch: Notes-Tools sind vault-scoped, also komplett neu rendern,
  // damit scratchpad/todos/bookmarks aus dem neu gewählten Vault geladen werden.
  if (area === "local" && changes.selectedVaultId && activeTool && NOTES_TOOLS.has(activeTool)) {
    openTool(activeTool);
  }
});

openOptions.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  closeBurgerMenu();
});

document.getElementById("edit-quick-slots").addEventListener("click", () => {
  closeBurgerMenu();
  openQuickEditor(null);
});

reconnectBtn.addEventListener("click", () => {
  setStatus(false, "verbinde...");
  chrome.runtime.sendMessage({ type: "reconnect" });
  closeBurgerMenu();
});

const burgerBtn = document.getElementById("burger-btn");
const burgerMenu = document.getElementById("burger-menu");

async function setViewMode(mode) {
  if (toolViewMode === mode) return;
  toolViewMode = mode;
  await chrome.storage.local.set({ toolViewMode });
  renderTabs();
  if (!activeTool) renderToolList();
}

function openBurgerMenu() {
  burgerMenu.classList.remove("hidden");
  burgerBtn.setAttribute("aria-expanded", "true");
}
function closeBurgerMenu() {
  burgerMenu.classList.add("hidden");
  burgerBtn.setAttribute("aria-expanded", "false");
}
burgerBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (burgerMenu.classList.contains("hidden")) openBurgerMenu();
  else closeBurgerMenu();
});
document.addEventListener("click", (e) => {
  if (burgerMenu.classList.contains("hidden")) return;
  if (e.target === burgerBtn || burgerMenu.contains(e.target)) return;
  closeBurgerMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !burgerMenu.classList.contains("hidden")) closeBurgerMenu();
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
  statusDot.title = customText ?? (connected ? "verbunden" : "offline");
  const banner = document.getElementById("offline-banner");
  if (banner) banner.classList.toggle("hidden", connected);
}

async function checkStartTool() {
  const { startTool } = await chrome.storage.local.get("startTool");
  if (!startTool) return;
  await chrome.storage.local.remove("startTool");
  if (TOOL_RENDERERS[startTool]) openTool(startTool);
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
  const vt = el("div", { className: "view-toggle" });
  const listBtn = el("button", {
    type: "button",
    className: "vt-btn first" + (toolViewMode === "list" ? " active" : ""),
    title: "Listen-Ansicht",
    textContent: "☰",
  });
  const gridBtn = el("button", {
    type: "button",
    className: "vt-btn last" + (toolViewMode === "grid" ? " active" : ""),
    title: "Kachel-Ansicht",
    textContent: "⊞",
  });
  listBtn.addEventListener("click", () => setViewMode("list"));
  gridBtn.addEventListener("click", () => setViewMode("grid"));
  vt.append(listBtn, gridBtn);
  tabsNav.append(vt);
}

function renderToolList() {
  content.replaceChildren();
  const group = GROUPS.find((g) => g.id === activeTab);
  if (!group) return;

  const list = el("ul", { className: "tools " + toolViewMode });
  for (const t of group.tools) {
    const hasActions = Array.isArray(t.actions) && t.actions.length > 0;
    const li = el("li", { className: "tool" + (t.soon ? " soon" : "") + (hasActions ? " has-caret" : "") });
    if (toolViewMode === "grid" && t.icon) {
      li.append(el("span", { className: "tool-icon", textContent: t.icon }));
    }
    li.append(el("span", { className: "tool-label", textContent: t.label }));
    if (toolViewMode === "list" && t.hint) {
      li.append(el("span", { className: "hint", textContent: t.hint }));
    }
    if (toolViewMode === "grid" && t.hint) {
      li.append(el("span", { className: "tool-hint", textContent: t.hint }));
    }
    if (t.soon) {
      li.append(el("span", { className: "badge", textContent: "bald" }));
    } else {
      li.addEventListener("click", (e) => {
        if (e.target.closest(".tool-caret, .tool-popover")) return;
        openTool(t.id);
      });
    }
    if (hasActions && !t.soon) {
      const caret = el("button", { type: "button", className: "tool-caret", title: "Weitere Aktionen", textContent: "▾" });
      const pop = el("div", { className: "tool-popover" });
      for (const a of t.actions) {
        const item = el("button", { type: "button", className: "tool-popover-item" });
        item.append(
          el("span", { className: "tpi-ico", textContent: a.icon || "▸" }),
          el("span", { textContent: a.label }),
        );
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          pop.classList.remove("open");
          openTool(t.id, { action: a.action });
        });
        pop.append(item);
      }
      caret.addEventListener("click", (e) => {
        e.stopPropagation();
        document.querySelectorAll(".tool-popover.open").forEach(p => { if (p !== pop) p.classList.remove("open"); });
        pop.classList.toggle("open");
      });
      li.append(caret, pop);
    }
    list.append(li);
  }
  content.append(list);
}

document.addEventListener("click", () => {
  document.querySelectorAll(".tool-popover.open").forEach(p => p.classList.remove("open"));
});

function renderQuickActions() {
  quickActions.replaceChildren();

  while (quickSlots.length < QUICK_SLOT_COUNT) quickSlots.push(null);
  if (quickSlots.length > QUICK_SLOT_COUNT) quickSlots = quickSlots.slice(0, QUICK_SLOT_COUNT);

  const row = el("div", { className: "quick-row" });
  const allFilled = quickSlots.every((id) => !!id);

  quickSlots.forEach((slotId, idx) => {
    const opt = getQuickOption(slotId);
    if (!opt) {
      const plus = el("button", {
        type: "button",
        className: "quick-btn quick-plus",
        title: "Slot belegen",
      });
      plus.append(el("span", { className: "quick-icon", textContent: "+" }));
      plus.append(el("span", { textContent: "Slot" }));
      plus.addEventListener("click", () => openQuickEditor(idx));
      row.append(plus);
      return;
    }
    const btn = el("button", {
      type: "button",
      className: "quick-btn" + (activeTool === opt.id ? " active" : ""),
      title: opt.label,
    });
    btn.append(el("span", { className: "quick-icon", textContent: opt.icon }));
    btn.append(el("span", { textContent: opt.label }));
    btn.addEventListener("click", () => runQuickSlot(opt.id));
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openSlotContextMenu(e.clientX, e.clientY, idx);
    });
    row.append(btn);
  });

  quickActions.append(row);

  if (allFilled) {
    const edit = el("button", {
      type: "button",
      className: "quick-edit-trigger",
      title: "Quick-Slots bearbeiten",
      textContent: "✎",
    });
    edit.addEventListener("click", () => openQuickEditor(null));
    quickActions.append(edit);
  }
}

async function saveQuickSlots() {
  await chrome.storage.local.set({ quickSlots });
  renderQuickActions();
}

function openSlotContextMenu(x, y, idx) {
  document.querySelectorAll(".slot-context-menu").forEach((m) => m.remove());
  const menu = el("div", { className: "slot-context-menu" });
  const change = el("button", { type: "button", textContent: "Slot ändern…" });
  const remove = el("button", { type: "button", textContent: "Slot leeren" });
  change.addEventListener("click", () => { menu.remove(); openQuickEditor(idx); });
  remove.addEventListener("click", async () => {
    menu.remove();
    quickSlots[idx] = null;
    await saveQuickSlots();
  });
  menu.append(change, remove);
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 8;
  const maxY = window.innerHeight - rect.height - 8;
  menu.style.left = Math.min(x, maxX) + "px";
  menu.style.top = Math.min(y, maxY) + "px";
  const close = (e) => {
    if (menu.contains(e.target)) return;
    menu.remove();
    document.removeEventListener("click", close);
    document.removeEventListener("keydown", esc);
  };
  const esc = (e) => { if (e.key === "Escape") { menu.remove(); document.removeEventListener("click", close); document.removeEventListener("keydown", esc); } };
  setTimeout(() => {
    document.addEventListener("click", close);
    document.addEventListener("keydown", esc);
  }, 0);
}

function openQuickEditor(targetIdx) {
  document.querySelectorAll(".quick-editor").forEach((e) => e.remove());
  const editor = el("div", { className: "quick-editor" });
  const head = el("div", { className: "quick-editor-head" });
  const title = el("span", { className: "title",
    textContent: targetIdx === null ? "Quick-Slots bearbeiten" : `Slot ${targetIdx + 1} belegen`,
  });
  const closeBtn = el("button", { type: "button", className: "close", textContent: "✕" });
  closeBtn.addEventListener("click", () => editor.remove());
  head.append(title, closeBtn);

  const slotsRow = el("div", { className: "quick-editor-slots" });
  function renderSlotsRow() {
    slotsRow.replaceChildren();
    quickSlots.forEach((slotId, idx) => {
      const opt = getQuickOption(slotId);
      const slot = el("button", { type: "button",
        className: "qe-slot" + (opt ? "" : " empty") + (selectedIdx === idx ? " selected" : ""),
        title: opt ? `Slot ${idx + 1}: ${opt.label} (klick = leeren)` : `Slot ${idx + 1} (leer)`,
      });
      slot.append(el("span", { className: "ico", textContent: opt ? opt.icon : "+" }));
      slot.append(el("span", { className: "lbl", textContent: opt ? opt.label : `Slot ${idx + 1}` }));
      slot.addEventListener("click", async () => {
        if (opt) {
          quickSlots[idx] = null;
          await saveQuickSlots();
          renderSlotsRow();
        } else {
          selectedIdx = idx;
          renderSlotsRow();
        }
      });
      slotsRow.append(slot);
    });
  }
  let selectedIdx = targetIdx !== null ? targetIdx : quickSlots.findIndex((s) => !s);
  if (selectedIdx < 0) selectedIdx = 0;
  renderSlotsRow();

  const hint = el("div", { className: "qe-hint",
    textContent: "Wähle ein Tool für den markierten Slot (oder klicke einen Slot zum Leeren):",
  });

  const picker = el("div", { className: "quick-editor-picker" });
  const used = new Set(quickSlots.filter(Boolean));
  for (const opt of getAllQuickOptions()) {
    const item = el("button", { type: "button", className: "qe-pick" });
    item.append(el("span", { className: "ico", textContent: opt.icon }));
    item.append(el("span", { className: "lbl", textContent: opt.label }));
    if (opt.group) item.append(el("span", { className: "grp", textContent: opt.group }));
    if (used.has(opt.id)) item.classList.add("used");
    item.addEventListener("click", async () => {
      const idx = selectedIdx;
      const existing = quickSlots.indexOf(opt.id);
      if (existing >= 0 && existing !== idx) quickSlots[existing] = null;
      quickSlots[idx] = opt.id;
      await saveQuickSlots();
      const nextEmpty = quickSlots.findIndex((s) => !s);
      if (nextEmpty >= 0) {
        selectedIdx = nextEmpty;
        renderSlotsRow();
        item.classList.add("used");
      } else {
        editor.remove();
      }
    });
    picker.append(item);
  }

  editor.append(head, slotsRow, hint, picker);
  quickActions.after(editor);
}

let hideQuickRowOnTool = false;

async function loadQuickRowPref() {
  const { hideQuickRowOnTool: pref } = await chrome.storage.local.get("hideQuickRowOnTool");
  hideQuickRowOnTool = !!pref;
  applyQuickRowVisibility();
}

function applyQuickRowVisibility() {
  if (hideQuickRowOnTool && activeTool) quickActions.classList.add("hidden");
  else quickActions.classList.remove("hidden");
}

let pendingToolOptions = null;
let _chatPageModeScrape = null; // set when chat is in page mode — fires on tab change
let currentToolCleanup = null;  // optional cleanup callback set by tool renderers

function runToolCleanup() {
  if (currentToolCleanup) {
    try { currentToolCleanup(); } catch {}
    currentToolCleanup = null;
  }
}

function openTool(toolId, options = null) {
  const renderer = TOOL_RENDERERS[toolId];
  if (!renderer) return;
  runToolCleanup();
  for (const g of GROUPS) {
    if (g.tools.some((t) => t.id === toolId)) { activeTab = g.id; break; }
  }
  activeTool = toolId;
  pendingToolOptions = options;
  renderTabs();
  renderQuickActions();
  applyQuickRowVisibility();

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
  pendingToolOptions = null;
}

function closeTool() {
  runToolCleanup();
  activeTool = null;
  panelTitle = null;
  panelBody = null;
  renderQuickActions();
  applyQuickRowVisibility();
  renderToolList();
}

function renderYoutubeTranscript() {
  panelTitle.textContent = "YouTube-Transcript";

  const urlRow = el("div");
  urlRow.style.cssText = "display:flex;gap:6px;align-items:stretch;";
  const urlInput = el("input", { type: "url", placeholder: "https://www.youtube.com/watch?v=..." });
  urlInput.style.flex = "1";
  const refreshBtn = el("button", {
    type: "button", textContent: "↻", title: "URL aus aktivem Tab übernehmen",
    className: "secondary",
  });
  refreshBtn.style.cssText = "padding:4px 10px;flex:0 0 auto;";
  urlRow.append(urlInput, refreshBtn);

  let lastAutoUrl = "";
  function loadFromActiveTab(force = false) {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      const u = tab?.url || "";
      if (!/youtube\.com\/watch/.test(u)) return;
      // Auto-update nur wenn Feld leer ist, das letzte Auto-Loaded entspricht
      // oder explizit ueber Refresh-Button getriggert — so wird kein manuell
      // editierter URL ueberschrieben.
      if (force || !urlInput.value.trim() || urlInput.value === lastAutoUrl) {
        urlInput.value = u;
        lastAutoUrl = u;
      }
    });
  }
  loadFromActiveTab(true);
  refreshBtn.addEventListener("click", () => loadFromActiveTab(true));

  // Auto-Detect Tab-Wechsel + URL-Aenderung im aktiven Tab
  const onActivated = () => loadFromActiveTab(false);
  const onUpdated = (tabId, changeInfo, tab) => {
    if (changeInfo.url && tab.active) loadFromActiveTab(false);
  };
  chrome.tabs.onActivated.addListener(onActivated);
  chrome.tabs.onUpdated.addListener(onUpdated);
  currentToolCleanup = () => {
    chrome.tabs.onActivated.removeListener(onActivated);
    chrome.tabs.onUpdated.removeListener(onUpdated);
  };
  const runBtn = el("button", { textContent: "Transcript holen" });
  const brainBtn = el("button", { textContent: "Ins Brain", className: "secondary" });
  brainBtn.style.marginLeft = "6px";
  brainBtn.title = "Transcript ins Vault speichern (Säule, Playlist, Tags)";
  const status = el("div", { className: "tool-status" });
  const output = el("textarea", { placeholder: "Ergebnis erscheint hier...", readOnly: true });

  // Fallback-Row: erscheint nur, wenn Browser + Server-Fallback beide fail liefern
  const fallbackRow = el("div", { className: "tool-fallback hidden" });
  fallbackRow.style.cssText = "margin-top:8px;padding:10px;border:1px solid var(--border,#ddd);border-radius:6px;background:var(--bg-subtle,#f5f5f5);";
  const fallbackHint = el("div", { className: "tool-status" });
  fallbackHint.style.cssText = "margin-bottom:6px;font-size:12px;";
  fallbackHint.textContent = "Beide Auto-Pfade fehlgeschlagen. Tab öffnen, Drei-Punkte-Menü → 'Transkript anzeigen', Liste markieren + kopieren, dann hier einfügen.";
  const openTabBtn = el("button", { textContent: "Im YouTube-Tab öffnen", className: "secondary" });
  const manualArea = el("textarea", { placeholder: "Manuell kopiertes Transcript hier einfügen..." });
  manualArea.style.cssText = "margin-top:8px;min-height:80px;";
  const useManualBtn = el("button", { textContent: "Übernehmen", className: "secondary" });
  useManualBtn.style.marginTop = "6px";
  fallbackRow.append(fallbackHint, openTabBtn, manualArea, useManualBtn);

  openTabBtn.addEventListener("click", () => {
    const url = urlInput.value.trim();
    if (!url) return;
    chrome.tabs.create({ url, active: true });
  });

  useManualBtn.addEventListener("click", () => {
    const txt = manualArea.value.trim();
    if (!txt) {
      status.textContent = "Bitte erst Transcript einfügen";
      status.className = "tool-status error";
      return;
    }
    output.value = txt;
    status.textContent = "manuell übernommen";
    status.className = "tool-status success";
    fallbackRow.classList.add("hidden");
  });

  async function fetchTranscript() {
    const url = urlInput.value.trim();
    if (!url) {
      status.textContent = "URL angeben";
      status.className = "tool-status error";
      return null;
    }
    runBtn.disabled = true;
    brainBtn.disabled = true;
    status.textContent = "läuft... (Server-API zuerst, Browser als Fallback)";
    status.className = "tool-status";
    output.value = "";
    fallbackRow.classList.add("hidden");
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
      let src;
      if (data?.source === "server_api") src = `fertig (Server-API${data?.lang ? ", " + data.lang : ""})`;
      else if (data?.source === "extension") src = "fertig (Browser-Fallback)";
      else src = "fertig";
      status.textContent = src;
      status.className = "tool-status success";
      return data;
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
      fallbackRow.classList.remove("hidden");
      return null;
    } finally {
      runBtn.disabled = false;
      brainBtn.disabled = false;
    }
  }

  runBtn.addEventListener("click", fetchTranscript);

  brainBtn.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) {
      status.textContent = "URL angeben";
      status.className = "tool-status error";
      return;
    }

    // 1. Transcript holen falls noch nicht da
    let transcript = output.value.trim();
    if (!transcript) {
      const data = await fetchTranscript();
      transcript = (data?.transcript || "").trim();
      if (!transcript) return;  // Fehler-Status ist schon gesetzt
    }

    // 2. Title aus aktivem Tab wenn URL passt — sonst undefined (showBrainModal nimmt URL)
    let title;
    try {
      const [tab] = await new Promise((resolve) =>
        chrome.tabs.query({ active: true, currentWindow: true }, resolve)
      );
      if (tab?.url === url && tab.title) {
        title = tab.title.replace(/ - YouTube$/, "").trim();
      }
    } catch {}

    // 3. Modal mit prefetched → ueberspringt auto_brain, ruft nur auto_tag
    await showBrainModal({ url, prefetched: { transcript, title } });
  });

  const chatBtn = el("button", { textContent: "💬 Chat mit Transcript", className: "secondary" });
  chatBtn.style.marginLeft = "6px";
  chatBtn.title = "Direkt mit dem geholten Transcript chatten (ohne ins Brain zu speichern)";
  chatBtn.addEventListener("click", () => {
    const transcript = (output.value || "").trim();
    if (!transcript) {
      status.textContent = "Erst Transcript holen";
      status.className = "tool-status error";
      return;
    }
    const url = urlInput.value.trim();
    openTool("chat", {
      sourceType: "page",
      sourceRef: { content: `URL: ${url}\n\n${transcript}`, title: url },
      sourceTitle: "YouTube-Transcript",
    });
  });

  const btnRow = el("div");
  btnRow.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;";
  btnRow.append(runBtn, brainBtn, chatBtn);

  panelBody.append(urlRow, btnRow, status, output, fallbackRow);
}

async function renderNotesFile(kind, opts) {
  panelTitle.textContent = opts.title;

  const vaultHint = el("div", { className: "notes-vault-hint" });
  const meta = el("div", { className: "tool-status", textContent: "lade..." });
  const textarea = el("textarea", { placeholder: opts.placeholder });
  textarea.classList.add("scratchpad");
  const rendered = el("div", { className: "notes-rendered hidden" });
  const status = el("div", { className: "tool-status" });

  const viewToggle = el("button", { type: "button", textContent: "Vorschau" });
  viewToggle.classList.add("secondary");
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

  const toolbar = el("div", { className: "todo-toolbar" });
  toolbar.append(viewToggle, exportBtn);

  panelBody.append(vaultHint, meta, textarea, rendered, status, toolbar, fallbackRow, ...(promoteSection ? [promoteSection] : []));

  const httpBase = await getHttpBase();
  const vaultId = await getActiveVaultId(httpBase);
  const vault = await getActiveVault(httpBase);
  if (vault) {
    vaultHint.textContent = `Notes-Inbox: ${vault.name}`;
  } else {
    vaultHint.textContent = "Kein Vault aktiv — Notes laufen global";
  }
  let saveTimer = null;
  let lastSaved = "";
  let started = null;
  let viewMode = "edit"; // "edit" | "rendered"

  function refreshRendered() {
    rendered.innerHTML = renderMarkdown(textarea.value || "");
  }

  viewToggle.addEventListener("click", () => {
    if (viewMode === "edit") {
      refreshRendered();
      textarea.classList.add("hidden");
      rendered.classList.remove("hidden");
      viewToggle.textContent = "Quellcode";
      viewMode = "rendered";
    } else {
      rendered.classList.add("hidden");
      textarea.classList.remove("hidden");
      viewToggle.textContent = "Vorschau";
      viewMode = "edit";
    }
  });

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
      const res = await fetch(withVaultId(`${httpBase}/tools/notes/${kind}`, vaultId), {
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
    const res = await fetch(withVaultId(`${httpBase}/tools/notes/${kind}/export`, vaultId), {
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
    const res = await fetch(withVaultId(`${httpBase}/tools/notes/${kind}`, vaultId));
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

  const vaultHint = el("div", { className: "notes-vault-hint" });
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

  panelBody.append(vaultHint, meta, list, addForm, sourceArea, status, toolbar, fallbackRow);

  const httpBase = await getHttpBase();
  const vaultId = await getActiveVaultId(httpBase);
  const vault = await getActiveVault(httpBase);
  vaultHint.textContent = vault ? `Notes-Inbox: ${vault.name}` : "Kein Vault aktiv — Notes laufen global";
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
      list.append(el("div", { className: "todo-empty", textContent: "Noch keine Todos. Mit '+ Todo' oben hinzufügen oder im Chat 'Erinnere mich an …' sagen." }));
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
      const res = await fetch(withVaultId(`${httpBase}/tools/notes/todos`, vaultId), {
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
      const res = await fetch(withVaultId(`${httpBase}/tools/notes/todos/export`, vaultId), {
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
    const res = await fetch(withVaultId(`${httpBase}/tools/notes/todos`, vaultId));
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

  const initialSource = pendingToolOptions?.sourceType && pendingToolOptions?.sourceRef
    ? { type: pendingToolOptions.sourceType, ref: pendingToolOptions.sourceRef, title: pendingToolOptions.sourceTitle || "" }
    : null;

  function updateChatTitle(mode, sourceTitle) {
    if (mode === "transcript") panelTitle.textContent = sourceTitle ? `Chat: ${sourceTitle}` : "Chat mit Transcript";
    else if (mode === "video") panelTitle.textContent = sourceTitle ? `Chat: ${sourceTitle}` : "Chat mit Video";
    else if (mode === "page") panelTitle.textContent = sourceTitle ? `Chat: ${sourceTitle}` : "Chat mit Seite";
    else if (mode === "vault_file") panelTitle.textContent = sourceTitle ? `Chat: ${sourceTitle}` : "Chat mit Datei";
    else panelTitle.textContent = "Chat mit Vault";
  }

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

  // Search toggle
  const searchToggleRow = el("div", { className: "checkbox-row", title: "Volltextsuche über alle .md-Dateien (inkl. raw/) — ermöglicht gezielte Stichwort-Suche" });
  const searchToggle = el("input", { type: "checkbox", id: "vaultSearchToggle" });
  searchToggle.checked = true; // default until loaded from server
  const searchToggleLabel = el("label", { htmlFor: "vaultSearchToggle", textContent: "Volltextsuche" });
  searchToggleRow.append(searchToggle, searchToggleLabel);

  // Load initial state from server
  try {
    const settingsRes = await fetch(`${httpBase}/settings`);
    if (settingsRes.ok) {
      const settingsData = await settingsRes.json();
      if (typeof settingsData.vault_search_enabled === "boolean") {
        searchToggle.checked = settingsData.vault_search_enabled;
      }
    }
  } catch (_) {}

  searchToggle.addEventListener("change", async () => {
    try {
      await fetch(`${httpBase}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vault_search_enabled: searchToggle.checked }),
      });
    } catch (_) {}
  });

  toolbar.append(clearBtn, searchToggleRow);

  const status = el("div", { className: "tool-status" });
  const pageUrlRow = el("div", { className: "page-url-row", style: "display:none" });

  let chatMode = "vault";
  let scrapeMode = "content"; // "content" | "full"
  let strictPage = true;
  let scrapedPage = pendingToolOptions?.pageContent || null;
  let pageChatHistory = [];
  let sourceChatHistory = [];
  let activeSource = null; // {type: "transcript"|"video", ref: {...}, title: string}

  // --- Scrape-Mode Radio-Buttons ---
  const scrapeModeRow = el("div", { className: "scrape-mode-row", style: "display:none" });
  function makeScrapeRadio(value, label) {
    const btn = el("button", { type: "button", className: "scrape-mode-btn" + (value === "content" ? " active" : ""), textContent: label });
    btn.dataset.value = value;
    btn.addEventListener("click", async () => {
      if (scrapeMode === value) return;
      scrapeMode = value;
      scrapeModeRow.querySelectorAll(".scrape-mode-btn").forEach(b => b.classList.toggle("active", b.dataset.value === value));
      if (chatMode === "page") await scrapeCurrentPage();
    });
    return btn;
  }
  scrapeModeRow.append(makeScrapeRadio("content", "Nur Inhalt"), makeScrapeRadio("full", "Alles"));

  // --- Strict-Page Toggle ---
  const strictRow = el("div", { className: "scrape-mode-row", style: "display:none" });
  const strictOnBtn  = el("button", { type: "button", className: "scrape-mode-btn active", textContent: "Nur Seite" });
  const strictOffBtn = el("button", { type: "button", className: "scrape-mode-btn", textContent: "Seite + Wissen" });
  strictOnBtn.title  = "Antwortet ausschließlich aus dem Seiteninhalt";
  strictOffBtn.title = "Ergänzt mit allgemeinem Wissen, kennzeichnet es aber";
  strictOnBtn.addEventListener("click", () => {
    if (strictPage) return;
    strictPage = true;
    pageChatHistory = [];
    strictOnBtn.classList.add("active");
    strictOffBtn.classList.remove("active");
  });
  strictOffBtn.addEventListener("click", () => {
    if (!strictPage) return;
    strictPage = false;
    pageChatHistory = [];
    strictOffBtn.classList.add("active");
    strictOnBtn.classList.remove("active");
  });
  strictRow.append(strictOnBtn, strictOffBtn);

  function setPageUrlRow(state, text) {
    if (state === "hide") { pageUrlRow.style.display = "none"; return; }
    pageUrlRow.style.display = "";
    pageUrlRow.className = "page-url-row" + (state === "error" ? " error" : state === "loading" ? " loading" : "");
    pageUrlRow.textContent = text;
  }

  async function scrapeCurrentPage() {
    setPageUrlRow("loading", "Lese Seite...");
    setStatus("lese Seite...");
    try {
      const hb = await getHttpBase();
      const res = await fetch(`${hb}/tools/page_scrape`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: scrapeMode }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.markdown) throw new Error("Kein Seiteninhalt");
      scrapedPage = { title: data.title || "", url: data.url || "", markdown: data.markdown };
      setPageUrlRow("ok", scrapedPage.title || scrapedPage.url);
      setStatus("");
    } catch (err) {
      scrapedPage = null;
      setPageUrlRow("error", "Fehler: " + (err.message || err));
      setStatus("Seite konnte nicht gelesen werden: " + (err.message || err), "error");
    }
  }

  const modeRow = el("div", { className: "chat-mode-row" });
  const vaultBtn = el("button", { type: "button", className: "chat-mode-btn active", textContent: "📚 Vault" });
  const pageBtn  = el("button", { type: "button", className: "chat-mode-btn", textContent: "🌐 Seite" });
  modeRow.append(vaultBtn, pageBtn);

  vaultBtn.addEventListener("click", () => {
    chatMode = "vault";
    vaultBtn.classList.add("active");
    pageBtn.classList.remove("active");
    _chatPageModeScrape = null;
    scrapeModeRow.style.display = "none";
    strictRow.style.display = "none";
    setPageUrlRow("hide");
    setStatus("");
    updateChatTitle("vault");
  });

  pageBtn.addEventListener("click", async () => {
    chatMode = "page";
    pageBtn.classList.add("active");
    vaultBtn.classList.remove("active");
    pageChatHistory = [];
    scrapeModeRow.style.display = "";
    strictRow.style.display = "";
    _chatPageModeScrape = scrapeCurrentPage;
    updateChatTitle("page");
    await scrapeCurrentPage();
  });

  const webHint = el("div", { className: "chat-web-hint", textContent: "Hinweis: Internet-Recherche im Chat ist noch nicht aktiv (geplant für später)." });

  const sourceBanner = el("div", { className: "chat-source-banner", style: "display:none" });

  panelBody.append(header, modeRow, scrapeModeRow, strictRow, pageUrlRow, sourceBanner, meta, log, status, inputWrap, webHint, toolbar);

  function updateWebHintVisibility() {
    webHint.style.display = chatMode === "vault" ? "" : "none";
  }
  updateWebHintVisibility();
  vaultBtn.addEventListener("click", updateWebHintVisibility);
  pageBtn.addEventListener("click", updateWebHintVisibility);

  function applySourceMode(src) {
    chatMode = src.type;
    activeSource = src;
    sourceChatHistory = [];
    _chatPageModeScrape = null;
    header.style.display = "none";
    modeRow.style.display = "none";
    scrapeModeRow.style.display = "none";
    strictRow.style.display = "none";
    setPageUrlRow("hide");
    sourceBanner.style.display = "";
    if (src.type === "transcript") {
      sourceBanner.textContent = `📜 Quelle: Transcript "${src.title || src.ref?.rel_path || ""}"`;
    } else if (src.type === "video") {
      sourceBanner.textContent = `🎬 Quelle: Video "${src.title || src.ref?.slug || ""}"`;
    } else if (src.type === "vault_file") {
      sourceBanner.textContent = `📄 Quelle: Datei ${src.title || src.ref?.rel_path || ""}`;
    } else {
      sourceBanner.textContent = `🌐 Quelle: ${src.title || "Seiteninhalt"}`;
    }
    updateChatTitle(src.type, src.title);
    updateWebHintVisibility();
    meta.textContent = "";
    log.replaceChildren();
    log.append(el("div", { className: "chat-empty", textContent: "Stell deine Frage zu diesem Inhalt." }));
  }

  // Wenn über "Mit Seite chatten" geöffnet: direkt in Page-Modus springen
  if (scrapedPage?.markdown) {
    chatMode = "page";
    pageBtn.classList.add("active");
    vaultBtn.classList.remove("active");
    scrapeModeRow.style.display = "";
    strictRow.style.display = "";
    _chatPageModeScrape = scrapeCurrentPage;
    setPageUrlRow("ok", scrapedPage.title || scrapedPage.url);
    updateChatTitle("page");
  }

  // Wenn über "💬 Chat" auf Video oder Transcript geöffnet
  if (initialSource) {
    applySourceMode(initialSource);
  }


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
    if (chatMode === "vault" && !currentVaultId) {
      setStatus("Bitte zuerst einen Vault auswählen", "error");
      return;
    }
    if (chatMode === "page" && !activeSource && !scrapedPage?.markdown) {
      setStatus("Seite wird noch geladen — kurz warten", "error");
      return;
    }
    if ((chatMode === "transcript" || chatMode === "video" || chatMode === "vault_file") && !activeSource) {
      setStatus("Keine Quelle ausgewählt", "error");
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
      let res;
      if (chatMode === "page") {
        let sourceRef;
        let historyForRequest;
        let strict;
        if (activeSource && activeSource.type === "page") {
          // Came in via "Chat mit ..." button — fixed source content, no auto-rescrape.
          sourceRef = activeSource.ref;
          historyForRequest = sourceChatHistory;
          strict = true;
        } else {
          // Came in via Mode-Buttons — live-scraped tab content.
          const pageText = `Titel: ${scrapedPage.title}\nURL: ${scrapedPage.url}\n\n${scrapedPage.markdown}`;
          sourceRef = { content: pageText.slice(0, 80000), title: scrapedPage.title };
          historyForRequest = pageChatHistory;
          strict = strictPage;
        }
        res = await fetch(`${httpBase}/tools/chat/source/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({
            source_type: "page",
            source_ref: sourceRef,
            message,
            history: historyForRequest,
            strict_source: strict,
          }),
        });
      } else if (chatMode === "transcript" || chatMode === "video" || chatMode === "vault_file") {
        res = await fetch(`${httpBase}/tools/chat/source/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({
            source_type: chatMode,
            source_ref: activeSource.ref,
            message,
            history: sourceChatHistory,
            strict_source: true,
          }),
        });
      } else {
        res = await fetch(`${httpBase}/tools/chat/${currentVaultId}/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({ message }),
        });
      }
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
          if (chatMode === "page" && data.messages) {
            if (activeSource && activeSource.type === "page") sourceChatHistory = data.messages;
            else pageChatHistory = data.messages;
          }
          if ((chatMode === "transcript" || chatMode === "video" || chatMode === "vault_file") && data.messages) sourceChatHistory = data.messages;
          const u = data.usage || {};
          const cached = u.cache_read_input_tokens ? ` · cache-hit ${u.cache_read_input_tokens}` : "";
          const baseText = `fertig (${u.input_tokens || 0} in / ${u.output_tokens || 0} out${cached})`;
          status.replaceChildren();
          status.className = "tool-status success";
          status.append(document.createTextNode(baseText));
          if (data.consulted?.length && chatMode === "vault" && currentVaultId) {
            status.append(document.createTextNode(" · gelesen: "));
            data.consulted.forEach((relPath, i) => {
              if (i > 0) status.append(document.createTextNode(", "));
              const a = el("a", { href: "#", textContent: relPath, className: "chat-citation" });
              a.addEventListener("click", (e) => {
                e.preventDefault();
                openTool("vault_explorer", { initialFile: relPath, vaultId: currentVaultId });
              });
              status.append(a);
            });
          } else if (data.consulted?.length) {
            status.append(document.createTextNode(` · gelesen: ${data.consulted.join(", ")}`));
          }
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
  // Skip when chat was opened with a specific source (video/transcript) — no vault context needed.
  if (activeSource) {
    inputArea.focus();
    return;
  }
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

async function renderVaultExplorer() {
  panelTitle.textContent = "Vault-Explorer";

  // pendingToolOptions wird in openTool() direkt nach renderer()-Aufruf
  // auf null gesetzt — synchron lesen, bevor das erste await passiert.
  const initialFile = pendingToolOptions?.initialFile || null;
  const initialVaultId = pendingToolOptions?.vaultId || null;

  const httpBase = await getHttpBase();

  const header = el("div", { className: "chat-header" });
  const vaultSelect = el("select", { className: "vault-picker" });
  const searchRow = el("div", { className: "vault-search-row" });
  const searchInput = el("input", { type: "text", className: "vault-search-input", placeholder: "Vault durchsuchen..." });
  const searchBtn = el("button", { type: "button", className: "vault-search-btn", textContent: "Suchen" });
  searchRow.append(searchInput, searchBtn);
  header.append(vaultSelect, searchRow);

  const breadcrumb = el("div", { className: "vault-breadcrumb" });
  const listBox = el("div", { className: "vault-list" });
  const viewerBox = el("div", { className: "vault-viewer", style: "display:none" });
  const status = el("div", { className: "tool-status" });

  panelBody.append(header, breadcrumb, listBox, viewerBox, status);

  // Floating Vault-Chat Button — opens classic Karpathy chat for current vault
  const fab = el("button", {
    type: "button",
    className: "vault-fab",
    title: "Mit Vault chatten (Karpathy)",
    textContent: "💬",
  });
  panelBody.append(fab);
  fab.addEventListener("click", () => {
    openTool("chat");
  });

  let currentVaultId = null;
  let currentPath = "";
  let currentFile = null;
  let canWrite = false;
  let searchActive = false;
  let vaultsById = {};
  let pendingFind = "";

  function setStatus(text, level = "") {
    status.textContent = text;
    status.className = "tool-status" + (level ? " " + level : "");
  }

  function renderBreadcrumb() {
    breadcrumb.replaceChildren();
    if (searchActive) {
      const q = searchInput.value.trim();
      breadcrumb.append(el("span", { className: "vault-crumb-current", textContent: `Suche: "${q}"` }));
      return;
    }
    if (currentFile) {
      const back = el("a", { href: "#", textContent: "← zurück", className: "vault-back" });
      back.addEventListener("click", (e) => { e.preventDefault(); currentFile = null; renderView(); });
      breadcrumb.append(back);
      const sep = el("span", { className: "vault-crumb-sep", textContent: " · " });
      const fileLabel = el("span", { className: "vault-crumb-file", textContent: currentFile });
      breadcrumb.append(sep, fileLabel);
      return;
    }
    const root = el("a", { href: "#", textContent: "/", className: "vault-crumb" });
    root.addEventListener("click", (e) => { e.preventDefault(); navigateTo(""); });
    breadcrumb.append(root);
    if (!currentPath) return;
    const parts = currentPath.split("/").filter(Boolean);
    let accum = "";
    for (let i = 0; i < parts.length; i++) {
      accum = accum ? `${accum}/${parts[i]}` : parts[i];
      breadcrumb.append(el("span", { className: "vault-crumb-sep", textContent: " / " }));
      if (i === parts.length - 1) {
        breadcrumb.append(el("span", { className: "vault-crumb-current", textContent: parts[i] }));
      } else {
        const segPath = accum;
        const a = el("a", { href: "#", textContent: parts[i], className: "vault-crumb" });
        a.addEventListener("click", (e) => { e.preventDefault(); navigateTo(segPath); });
        breadcrumb.append(a);
      }
    }
  }

  function basename(p) {
    const idx = p.lastIndexOf("/");
    return idx === -1 ? p : p.slice(idx + 1);
  }

  function clearFindHighlights(container) {
    container.querySelectorAll("mark.vault-find-hit").forEach((m) => {
      m.replaceWith(document.createTextNode(m.textContent));
    });
    container.normalize();
  }

  // Markiert alle Vorkommen von query (case-insensitive) im gerenderten Datei-Body
  // gelb. Läuft über Text-Nodes (TreeWalker), damit HTML/Tags intakt bleiben.
  function applyFindHighlights(container, query) {
    clearFindHighlights(container);
    const marks = [];
    const q = (query || "").toLowerCase();
    if (!q) return marks;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.nodeValue && node.nodeValue.toLowerCase().includes(q)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      const lower = text.toLowerCase();
      const frag = document.createDocumentFragment();
      let from = 0;
      let idx;
      while ((idx = lower.indexOf(q, from)) !== -1) {
        if (idx > from) frag.appendChild(document.createTextNode(text.slice(from, idx)));
        const mark = document.createElement("mark");
        mark.className = "vault-find-hit";
        mark.textContent = text.slice(idx, idx + q.length);
        frag.appendChild(mark);
        marks.push(mark);
        from = idx + q.length;
      }
      if (from < text.length) frag.appendChild(document.createTextNode(text.slice(from)));
      node.replaceWith(frag);
    }
    return marks;
  }

  async function navigateTo(path) {
    if (!currentVaultId) return;
    searchActive = false;
    searchInput.value = "";
    currentPath = path || "";
    currentFile = null;
    await renderView();
  }

  async function openFile(relPath, findQuery = "") {
    if (!currentVaultId) return;
    currentFile = relPath;
    pendingFind = findQuery || "";
    await renderView();
  }

  async function doSearch() {
    const q = searchInput.value.trim();
    if (!q || !currentVaultId) return;
    searchActive = true;
    currentFile = null;
    listBox.style.display = "";
    viewerBox.style.display = "none";
    listBox.replaceChildren();
    renderBreadcrumb();
    setStatus("suche...");
    try {
      const url = `${httpBase}/tools/vault_search/${encodeURIComponent(currentVaultId)}?q=${encodeURIComponent(q)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const results = data.results || [];
      if (!results.length) {
        listBox.append(el("div", { className: "vault-empty", textContent: `Keine Treffer für "${q}".` }));
      }
      for (const r of results) {
        const row = el("div", { className: "vault-entry vault-search-result" });
        row.append(el("span", { className: "vault-icon", textContent: "🔍" }));
        const textWrap = el("div", { className: "vault-entry-text" });
        textWrap.append(
          el("span", { className: "vault-name", textContent: r.rel_path }),
          el("span", { className: "vault-search-snippet", textContent: r.snippet })
        );
        row.append(textWrap);
        row.addEventListener("click", () => {
          searchActive = false;
          openFile(r.rel_path, q);
        });
        listBox.append(row);
      }
      setStatus("");
    } catch (err) {
      setStatus("Suche fehlgeschlagen: " + (err.message || err), "error");
    }
  }

  searchBtn.addEventListener("click", doSearch);
  searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
  searchInput.addEventListener("input", () => {
    if (!searchInput.value.trim() && searchActive) {
      searchActive = false;
      renderView();
    }
  });

  async function renderView() {
    renderBreadcrumb();
    if (currentFile) {
      listBox.style.display = "none";
      viewerBox.style.display = "";
      viewerBox.replaceChildren();
      setStatus("lade Datei...");
      try {
        const url = `${httpBase}/tools/vault_file/${encodeURIComponent(currentVaultId)}?rel_path=${encodeURIComponent(currentFile)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const body = el("div", { className: "vault-file-body" });
        body.innerHTML = renderMarkdown(data.content || "");

        // In-Datei-Suche (Strg+F): markiert alle Treffer gelb, springt durch.
        const findBar = el("div", { className: "vault-find-bar" });
        const findInput = el("input", { type: "text", className: "vault-find-input", placeholder: "In Datei suchen…" });
        const findPrev = el("button", { type: "button", className: "vault-find-nav", textContent: "‹", title: "Vorheriger Treffer" });
        const findNext = el("button", { type: "button", className: "vault-find-nav", textContent: "›", title: "Nächster Treffer" });
        const findCount = el("span", { className: "vault-find-count" });
        findBar.append(findInput, findPrev, findNext, findCount);
        // Unter dem sticky .tool-header kleben (sonst verschwindet die Bar dahinter).
        findBar.style.top = (document.querySelector(".tool-header")?.offsetHeight || 41) + "px";

        let hits = [];
        let currentHit = -1;
        function jumpTo(i) {
          if (!hits.length) return;
          if (currentHit >= 0 && hits[currentHit]) hits[currentHit].classList.remove("current");
          currentHit = ((i % hits.length) + hits.length) % hits.length;
          const m = hits[currentHit];
          m.classList.add("current");
          m.scrollIntoView({ block: "center", behavior: "smooth" });
          findCount.textContent = `${currentHit + 1}/${hits.length}`;
        }
        function runFind() {
          const qf = findInput.value.trim();
          hits = applyFindHighlights(body, qf);
          currentHit = -1;
          if (!qf) { findCount.textContent = ""; return; }
          findCount.textContent = hits.length ? `${hits.length} Treffer` : "kein Treffer";
          if (hits.length) jumpTo(0);
        }
        findInput.addEventListener("input", runFind);
        findInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); jumpTo(currentHit + (e.shiftKey ? -1 : 1)); }
        });
        findPrev.addEventListener("click", () => jumpTo(currentHit - 1));
        findNext.addEventListener("click", () => jumpTo(currentHit + 1));

        // Strg+F fokussiert die In-Datei-Suche (leak-frei: alten Handler ersetzen).
        if (panelBody._vaultFindKeyHandler) {
          document.removeEventListener("keydown", panelBody._vaultFindKeyHandler);
        }
        const onFindKey = (e) => {
          if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
            if (findInput.isConnected) { e.preventDefault(); findInput.focus(); findInput.select(); }
          }
        };
        panelBody._vaultFindKeyHandler = onFindKey;
        document.addEventListener("keydown", onFindKey);

        const viewerActions = el("div", { className: "vault-viewer-actions" });
        const chatBtn = el("button", {
          type: "button",
          className: "vault-file-chat-btn",
          textContent: "💬 Mit dieser Datei chatten",
        });
        chatBtn.addEventListener("click", () => {
          openTool("chat", {
            sourceType: "vault_file",
            sourceRef: { vault_id: currentVaultId, rel_path: currentFile },
            sourceTitle: currentFile,
          });
        });
        viewerActions.append(chatBtn);
        if (canWrite) {
          const editBtn = el("button", { type: "button", className: "vault-edit-btn", textContent: "Bearbeiten" });
          const rawContent = data.content || "";
          editBtn.addEventListener("click", () => showEditor(rawContent));
          viewerActions.append(editBtn);
        }
        viewerBox.append(findBar, body, viewerActions);
        if (pendingFind) {
          findInput.value = pendingFind;
          pendingFind = "";
          runFind();
        }
        setStatus("");
      } catch (err) {
        viewerBox.append(el("div", { className: "tool-status error", textContent: "Fehler: " + (err.message || err) }));
        setStatus("Datei konnte nicht geladen werden", "error");
      }
      return;
    }
    viewerBox.style.display = "none";
    listBox.style.display = "";
    listBox.replaceChildren();
    if (canWrite) {
      const toolbar = el("div", { className: "vault-toolbar" });
      const newBtn = el("button", { type: "button", className: "vault-new-btn", textContent: "+ Neue Datei" });
      toolbar.append(newBtn);
      const newForm = el("div", { className: "vault-new-file-row", style: "display:none" });
      const newInput = el("input", { type: "text", className: "vault-new-input", placeholder: "dateiname.md" });
      const newConfirm = el("button", { type: "button", textContent: "Anlegen", className: "vault-new-confirm" });
      const newCancel = el("button", { type: "button", textContent: "×", className: "vault-new-cancel" });
      newForm.append(newInput, newConfirm, newCancel);
      newBtn.addEventListener("click", () => { newForm.style.display = ""; newInput.focus(); });
      newCancel.addEventListener("click", () => { newForm.style.display = "none"; newInput.value = ""; });
      newConfirm.addEventListener("click", async () => {
        const name = newInput.value.trim();
        if (!name) return;
        const rel = currentPath ? `${currentPath}/${name}` : name;
        newConfirm.disabled = true;
        try {
          const r = await fetch(
            `${httpBase}/tools/vault_file_new/${encodeURIComponent(currentVaultId)}?rel_path=${encodeURIComponent(rel)}`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "" }) }
          );
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${r.status}`);
          }
          const finalRel = rel.endsWith(".md") ? rel : rel + ".md";
          await openFile(finalRel);
        } catch (err) {
          setStatus("Fehler: " + (err.message || err), "error");
          newConfirm.disabled = false;
        }
      });
      newInput.addEventListener("keydown", (e) => { if (e.key === "Enter") newConfirm.click(); });
      listBox.append(toolbar, newForm);
    }
    setStatus("lade Ordner...");
    try {
      const url = `${httpBase}/tools/vault_list/${encodeURIComponent(currentVaultId)}?rel_path=${encodeURIComponent(currentPath)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const folders = data.folders || [];
      const files = data.files || [];
      if (!folders.length && !files.length) {
        listBox.append(el("div", { className: "vault-empty", textContent: "Leerer Ordner." }));
      }
      for (const f of folders) {
        const row = el("div", { className: "vault-entry vault-folder" });
        row.append(el("span", { className: "vault-icon", textContent: "📁" }));
        row.append(el("span", { className: "vault-name", textContent: basename(f) }));
        row.addEventListener("click", () => navigateTo(f));
        listBox.append(row);
      }
      for (const f of files) {
        const row = el("div", { className: "vault-entry vault-file" });
        row.append(el("span", { className: "vault-icon", textContent: "📄" }));
        row.append(el("span", { className: "vault-name", textContent: basename(f) }));
        row.addEventListener("click", () => openFile(f));
        listBox.append(row);
      }
      setStatus("");
    } catch (err) {
      listBox.append(el("div", { className: "tool-status error", textContent: "Fehler: " + (err.message || err) }));
      setStatus("Ordner konnte nicht geladen werden", "error");
    }
  }

  function showEditor(initialContent) {
    viewerBox.replaceChildren();

    // In-Datei-Suche auch im Editor (Strg+F). Textareas koennen keine <mark> tragen,
    // daher Backdrop-Technik: deckungsgleiche Highlight-Ebene hinter dem (transparent
    // gemachten) Textarea, scroll-synchron.
    const findBar = el("div", { className: "vault-find-bar" });
    const findInput = el("input", { type: "text", className: "vault-find-input", placeholder: "In Datei suchen…" });
    const findPrev = el("button", { type: "button", className: "vault-find-nav", textContent: "↑", title: "Vorheriger Treffer (Shift+Enter)" });
    const findNext = el("button", { type: "button", className: "vault-find-nav", textContent: "↓", title: "Nächster Treffer (Enter)" });
    const findCount = el("span", { className: "vault-find-count" });
    findBar.append(findInput, findPrev, findNext, findCount);
    // Unter dem sticky .tool-header kleben (sonst verschwindet die Bar dahinter).
    findBar.style.top = (document.querySelector(".tool-header")?.offsetHeight || 41) + "px";

    const wrap = el("div", { className: "vault-editor-wrap" });
    const backdrop = el("div", { className: "vault-editor-backdrop" });
    const ta = el("textarea", { className: "vault-editor-textarea" });
    ta.value = initialContent;
    wrap.append(backdrop, ta);

    let matches = [];
    let curMatch = -1;
    const escHtml = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    function renderBackdrop() {
      const text = ta.value;
      const q = findInput.value;
      if (!q) {
        backdrop.textContent = text;
        matches = [];
        curMatch = -1;
        findCount.textContent = "";
        return;
      }
      const lower = text.toLowerCase();
      const ql = q.toLowerCase();
      matches = [];
      let from = 0;
      let idx;
      while ((idx = lower.indexOf(ql, from)) !== -1) { matches.push([idx, idx + ql.length]); from = idx + ql.length; }
      let html = "";
      let pos = 0;
      matches.forEach(([s, e], i) => {
        html += escHtml(text.slice(pos, s));
        html += `<mark${i === curMatch ? ' class="current"' : ""}>${escHtml(text.slice(s, e))}</mark>`;
        pos = e;
      });
      html += escHtml(text.slice(pos));
      backdrop.innerHTML = html + (text.endsWith("\n") ? " " : "");
      findCount.textContent = matches.length
        ? (curMatch >= 0 ? `${curMatch + 1}/${matches.length}` : `${matches.length} Treffer`)
        : "kein Treffer";
    }
    function syncScroll() { backdrop.scrollTop = ta.scrollTop; backdrop.scrollLeft = ta.scrollLeft; }
    function jumpTo(i) {
      if (!matches.length) return;
      curMatch = ((i % matches.length) + matches.length) % matches.length;
      renderBackdrop();
      const markEl = backdrop.querySelector("mark.current");
      if (markEl) {
        ta.scrollTop = Math.max(0, markEl.offsetTop - ta.clientHeight / 2);
        syncScroll();
      }
      findCount.textContent = `${curMatch + 1}/${matches.length}`;
    }
    function runFind() { curMatch = -1; renderBackdrop(); if (matches.length) jumpTo(0); }
    findInput.addEventListener("input", runFind);
    findInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); jumpTo(curMatch + (e.shiftKey ? -1 : 1)); }
    });
    findPrev.addEventListener("click", () => jumpTo(curMatch - 1));
    findNext.addEventListener("click", () => jumpTo(curMatch + 1));
    ta.addEventListener("input", renderBackdrop);
    ta.addEventListener("scroll", syncScroll);
    backdrop.textContent = ta.value;

    if (panelBody._vaultFindKeyHandler) {
      document.removeEventListener("keydown", panelBody._vaultFindKeyHandler);
    }
    const onFindKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        if (findInput.isConnected) { e.preventDefault(); findInput.focus(); findInput.select(); }
      }
    };
    panelBody._vaultFindKeyHandler = onFindKey;
    document.addEventListener("keydown", onFindKey);

    const actionsEl = el("div", { className: "vault-editor-actions" });
    const saveBtn = el("button", { type: "button", textContent: "Speichern", className: "vault-save-btn" });
    const cancelBtn = el("button", { type: "button", textContent: "Abbrechen" });
    actionsEl.append(saveBtn, cancelBtn);
    viewerBox.append(findBar, wrap, actionsEl);
    ta.focus();
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = "Speichere...";
      try {
        const r = await fetch(
          `${httpBase}/tools/vault_file/${encodeURIComponent(currentVaultId)}?rel_path=${encodeURIComponent(currentFile)}`,
          { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: ta.value }) }
        );
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err.detail || `HTTP ${r.status}`);
        }
        setStatus("Gespeichert.");
        setTimeout(() => setStatus(""), 2000);
        await openFile(currentFile);
      } catch (err) {
        setStatus("Fehler: " + (err.message || err), "error");
        saveBtn.disabled = false;
        saveBtn.textContent = "Speichern";
      }
    });
    cancelBtn.addEventListener("click", () => openFile(currentFile));
  }

  vaultSelect.addEventListener("change", async () => {
    currentVaultId = vaultSelect.value;
    canWrite = !!(vaultsById[currentVaultId]?.permissions?.write_files);
    await chrome.storage.local.set({ selectedVaultId: currentVaultId });
    currentPath = "";
    currentFile = null;
    await renderView();
  });

  // Initial vault load
  try {
    const res = await fetch(`${httpBase}/vaults`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const vaults = data.vaults || [];
    if (!vaults.length) {
      panelBody.replaceChildren();
      const wrap = el("div", { className: "chat-empty-state" });
      wrap.append(el("p", { textContent: "Noch kein Vault verbunden. Lege in den Einstellungen einen an." }));
      const btn = el("button", { type: "button", textContent: "Einstellungen öffnen" });
      btn.addEventListener("click", () => chrome.runtime.openOptionsPage());
      wrap.append(btn);
      panelBody.append(wrap);
      return;
    }
    vaultSelect.replaceChildren();
    for (const v of vaults) {
      vaultSelect.append(el("option", { value: v.id, textContent: v.name }));
      vaultsById[v.id] = v;
    }
    const { selectedVaultId } = await chrome.storage.local.get("selectedVaultId");
    const wantId = initialVaultId && vaults.some((v) => v.id === initialVaultId) ? initialVaultId : null;
    currentVaultId = wantId
      || (vaults.some((v) => v.id === selectedVaultId) ? selectedVaultId : vaults[0].id);
    vaultSelect.value = currentVaultId;
    canWrite = !!(vaultsById[currentVaultId]?.permissions?.write_files);
    if (initialFile) {
      const parentIdx = initialFile.lastIndexOf("/");
      currentPath = parentIdx === -1 ? "" : initialFile.slice(0, parentIdx);
      currentFile = initialFile;
    }
    await renderView();
  } catch (err) {
    setStatus("Vault-Liste konnte nicht geladen werden: " + (err.message || err), "error");
  }
}

const VH_SEVERITY = {
  error: { icon: "🔴", label: "Fehler" },
  warn: { icon: "🟡", label: "Warnung" },
  info: { icon: "🔵", label: "Info" },
};

function renderLineDiff(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const frag = document.createDocumentFragment();
  const addLine = (cls, prefix, text) =>
    frag.append(el("div", { className: "vh-diff-line " + cls, textContent: prefix + text }));
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { addLine("ctx", "  ", A[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { addLine("del", "- ", A[i]); i++; }
    else { addLine("add", "+ ", B[j]); j++; }
  }
  while (i < n) { addLine("del", "- ", A[i]); i++; }
  while (j < m) { addLine("add", "+ ", B[j]); j++; }
  return frag;
}

async function renderVaultHealth() {
  panelTitle.textContent = "Vault-Gesundheit";
  const initialVaultId = pendingToolOptions?.vaultId || null;
  const httpBase = await getHttpBase();

  const header = el("div", { className: "chat-header" });
  const vaultSelect = el("select", { className: "vault-picker" });
  const runBtn = el("button", { type: "button", className: "secondary", textContent: "Neu prüfen" });
  header.append(vaultSelect, runBtn);

  const summary = el("div", { className: "vh-summary" });
  const upgradeBox = el("div", { className: "vh-upgrade", style: "display:none" });
  const listBox = el("div", { className: "vh-list" });
  const status = el("div", { className: "tool-status" });
  panelBody.append(header, summary, upgradeBox, listBox, status);

  let currentVaultId = null;

  function setStatus(text, level = "") {
    status.textContent = text;
    status.className = "tool-status" + (level ? " " + level : "");
  }

  async function runAudit() {
    if (!currentVaultId) return;
    summary.replaceChildren();
    listBox.replaceChildren();
    upgradeBox.replaceChildren();
    upgradeBox.style.display = "none";
    setStatus("Prüfe Vault...");
    try {
      const res = await fetch(`${httpBase}/tools/vault_audit/${encodeURIComponent(currentVaultId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      renderReport(await res.json());
      setStatus("");
    } catch (err) {
      setStatus("Audit fehlgeschlagen: " + (err.message || err), "error");
    }
  }

  function renderReport(data) {
    const s = data.summary || {};
    const sev = s.by_severity || {};
    summary.append(el("div", {
      className: "vh-summary-line",
      textContent: `${s.total || 0} Befunde · 🔴 ${sev.error || 0} · 🟡 ${sev.warn || 0} · 🔵 ${sev.info || 0} · ${s.files_scanned || 0} Dateien gescannt`,
    }));

    const findings = data.findings || [];
    if (!findings.length) {
      listBox.append(el("div", { className: "vh-empty", textContent: "Keine Befunde — der Vault ist sauber. 🎉" }));
      return;
    }

    if (findings.some((f) => f.category === "claude_md_drift")) {
      renderUpgradeAffordance();
    }

    for (const sevKey of ["error", "warn", "info"]) {
      const group = findings.filter((f) => f.severity === sevKey);
      if (!group.length) continue;
      const meta = VH_SEVERITY[sevKey];
      listBox.append(el("div", { className: "vh-group-title", textContent: `${meta.icon} ${meta.label} (${group.length})` }));
      for (const f of group) {
        const row = el("div", { className: "vh-finding vh-sev-" + sevKey });
        const head = el("div", { className: "vh-finding-head" });
        head.append(el("span", { className: "vh-badge", textContent: f.category }));
        if (f.path) head.append(el("code", { className: "vh-path", textContent: f.path }));
        row.append(head);
        row.append(el("div", { className: "vh-msg", textContent: f.message }));
        if (f.recommendation) row.append(el("div", { className: "vh-rec", textContent: "→ " + f.recommendation }));
        if (f.repairable) {
          const fixBtn = el("button", { type: "button", className: "vh-fix-btn", textContent: "Reparieren" });
          fixBtn.addEventListener("click", () => repairFinding(f, fixBtn));
          row.append(fixBtn);
        }
        listBox.append(row);
      }
    }
  }

  async function repairFinding(f, btn) {
    btn.disabled = true;
    btn.textContent = "Repariere…";
    try {
      const res = await fetch(`${httpBase}/tools/vault_audit/${encodeURIComponent(currentVaultId)}/repair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: f.category, path: f.path }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatus(data.repaired ? "Repariert: " + (data.line || data.path || f.path) : "Nichts zu tun: " + (data.reason || "bereits behoben"));
      await runAudit();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Reparieren";
      setStatus("Reparatur fehlgeschlagen: " + (err.message || err), "error");
    }
  }

  function renderUpgradeAffordance() {
    upgradeBox.style.display = "";
    upgradeBox.replaceChildren();
    upgradeBox.append(el("div", { className: "vh-upgrade-title", textContent: "🩹 CLAUDE.md kann aktualisiert werden" }));
    upgradeBox.append(el("div", {
      className: "vh-upgrade-hint",
      textContent: "Verwaltete Sektionen werden non-destruktiv aktualisiert — dein eigener Text außerhalb der Marker bleibt erhalten.",
    }));
    const previewBtn = el("button", { type: "button", textContent: "Diff ansehen" });
    upgradeBox.append(previewBtn);
    previewBtn.addEventListener("click", () => showPreview(previewBtn));
  }

  async function showPreview(previewBtn) {
    previewBtn.disabled = true;
    setStatus("Lade Diff...");
    try {
      const res = await fetch(`${httpBase}/tools/vault_audit/${encodeURIComponent(currentVaultId)}/claude_md_preview`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatus("");
      const box = el("div", { className: "vh-diff-box" });
      box.append(el("div", {
        className: "vh-diff-label",
        textContent: data.changed ? `Sektionen: ${(data.sections || []).join(", ")}` : "Bereits aktuell — kein Diff.",
      }));
      if (data.changed) {
        const pre = el("pre", { className: "vh-diff" });
        pre.append(renderLineDiff(data.existing || "", data.merged || ""));
        box.append(pre);
        const applyBtn = el("button", { type: "button", className: "vault-save-btn", textContent: "Anwenden" });
        applyBtn.addEventListener("click", () => applyUpgrade(applyBtn));
        box.append(applyBtn);
      }
      upgradeBox.append(box);
      previewBtn.style.display = "none";
    } catch (err) {
      previewBtn.disabled = false;
      setStatus("Diff konnte nicht geladen werden: " + (err.message || err), "error");
    }
  }

  async function applyUpgrade(applyBtn) {
    applyBtn.disabled = true;
    applyBtn.textContent = "Wende an...";
    try {
      const res = await fetch(`${httpBase}/tools/vault_audit/${encodeURIComponent(currentVaultId)}/claude_md_apply`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus("CLAUDE.md aktualisiert.");
      await runAudit();
    } catch (err) {
      applyBtn.disabled = false;
      applyBtn.textContent = "Anwenden";
      setStatus("Fehler beim Anwenden: " + (err.message || err), "error");
    }
  }

  runBtn.addEventListener("click", runAudit);
  vaultSelect.addEventListener("change", async () => {
    currentVaultId = vaultSelect.value;
    await chrome.storage.local.set({ selectedVaultId: currentVaultId });
    await runAudit();
  });

  try {
    const res = await fetch(`${httpBase}/vaults`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const vaults = (await res.json()).vaults || [];
    if (!vaults.length) {
      panelBody.replaceChildren();
      const wrap = el("div", { className: "chat-empty-state" });
      wrap.append(el("p", { textContent: "Noch kein Vault verbunden. Lege in den Einstellungen einen an." }));
      const btn = el("button", { type: "button", textContent: "Einstellungen öffnen" });
      btn.addEventListener("click", () => chrome.runtime.openOptionsPage());
      wrap.append(btn);
      panelBody.append(wrap);
      return;
    }
    vaultSelect.replaceChildren();
    for (const v of vaults) vaultSelect.append(el("option", { value: v.id, textContent: v.name }));
    const { selectedVaultId } = await chrome.storage.local.get("selectedVaultId");
    currentVaultId =
      (initialVaultId && vaults.some((v) => v.id === initialVaultId) && initialVaultId) ||
      (vaults.some((v) => v.id === selectedVaultId) ? selectedVaultId : vaults[0].id);
    vaultSelect.value = currentVaultId;
    await runAudit();
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
  // Obsidian wikilinks [[path|alias]] / [[path#heading]] / [[path]] → öffnen Datei im Vault-Explorer
  s = s.replace(/\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_match, path, alias) => {
    const display = (alias || path).trim();
    const rel = path.trim().replace(/"/g, "&quot;");
    return `<a href="#" class="wiki-link" data-rel="${rel}">${display}</a>`;
  });
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

// Hängt vault_id als Query-Param an eine URL an. Unterstützt URLs, die bereits
// einen Query-String haben (z.B. /tools/playlists/<id>?saeule=...).
function withVaultId(url, vaultId) {
  if (!vaultId) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}vault_id=${encodeURIComponent(vaultId)}`;
}

const NOTES_TOOLS = new Set(["scratchpad", "todos", "bookmarks"]);

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
      itemsWrap.append(el("div", { className: "empty", textContent: "Noch keine Videos. Auf YouTube Rechtsklick → 'In Playlist speichern' oder per YouTube-Transcript-Tool aus dem aktiven Tab pullen." }));
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
  const head = el("div", { className: "playlist-item-head" });
  const thumb = makeYouTubeThumb(it.url);
  if (thumb) head.append(thumb);
  const headText = el("div", { className: "playlist-item-headtext" });
  headText.append(el("div", { className: "playlist-item-title", textContent: it.title }));
  const meta = el("div", { className: "playlist-item-meta" });
  if (it.channel) meta.append(el("span", { textContent: it.channel }));
  if (it.added) meta.append(el("span", { textContent: it.added }));
  headText.append(meta);
  head.append(headText);
  card.append(head);

  const links = el("div", { className: "playlist-item-links" });
  if (it.url) {
    const a = el("a", { textContent: "YouTube", href: it.url, target: "_blank" });
    a.rel = "noopener noreferrer";
    links.append(a);
  }

  const detailsBtn = el("button", { type: "button", textContent: "▼ Details", className: "small details-toggle" });
  links.append(detailsBtn);

  if (it.page) {
    const slug = it.page.split("/").pop();
    const chatBtn = el("button", { type: "button", textContent: "💬 Chat", className: "small" });
    chatBtn.addEventListener("click", () => openTool("chat", {
      sourceType: "video",
      sourceRef: { vault_id: vaultId, slug, saeule },
      sourceTitle: it.title,
    }));
    links.append(chatBtn);

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
    target.append(el("div", { className: "empty", textContent: "Noch keine Insights, Summary oder Transcript. Werden automatisch ergänzt sobald du das Video pullst oder im Wiki-Workflow ergänzt." }));
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
  const pendingAction = pendingToolOptions?.action;

  const vaultHint = el("div", { className: "notes-vault-hint" });
  const toolbar = el("div", { className: "playlist-toolbar" });
  const addBtn = el("button", { type: "button", textContent: "+ Bookmark hinzufügen" });
  const captureTabsBtn = el("button", {
    type: "button",
    textContent: "📑 Markierte Tabs",
    title: "Alle im aktuellen Fenster mit Strg+Klick markierten Tabs als Bookmarks erfassen",
  });
  const copyUrlsBtn = el("button", {
    type: "button",
    textContent: "📋 URLs kopieren",
    title: "URLs der markierten Tabs in die Zwischenablage kopieren (z.B. für NotebookLM) — ohne als Bookmark zu speichern",
  });
  toolbar.append(addBtn, captureTabsBtn, copyUrlsBtn);
  const status = el("div", { className: "tool-status" });
  const searchWrap = el("div", { className: "bookmark-search" });
  const searchInput = el("input", { type: "search", placeholder: "Suche Titel, URL, #tag…", value: bookmarksState.search });
  searchWrap.append(searchInput);
  const tagCloud = el("div", { className: "tag-cloud" });
  const listWrap = el("div", { className: "bookmark-list" });
  panelBody.append(vaultHint, toolbar, searchWrap, tagCloud, status, listWrap);

  const httpBase = await getHttpBase();
  const vaultId = await getActiveVaultId(httpBase);
  const vault = await getActiveVault(httpBase);
  vaultHint.textContent = vault ? `Notes-Inbox: ${vault.name}` : "Kein Vault aktiv — Notes laufen global";
  addBtn.addEventListener("click", () => showAddBookmarkDialog(httpBase, vaultId, () => renderBookmarksTool()));
  captureTabsBtn.addEventListener("click", () => captureHighlightedTabs(httpBase, vaultId, captureTabsBtn, () => renderBookmarksTool()));
  copyUrlsBtn.addEventListener("click", () => copyHighlightedTabUrls(copyUrlsBtn));

  if (pendingAction === "add") addBtn.click();
  else if (pendingAction === "capture_tabs") captureTabsBtn.click();
  else if (pendingAction === "copy_urls") copyUrlsBtn.click();

  status.textContent = "lade...";
  try {
    const res = await fetch(withVaultId(`${httpBase}/tools/bookmarks`, vaultId));
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
      renderBookmarksList(httpBase, vaultId, listWrap, filtered);
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

function renderBookmarksList(httpBase, vaultId, target, items) {
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
      sectionList.append(renderBookmarkCard(httpBase, vaultId, b));
    }
    target.append(section);
  }
}

function renderBookmarkCard(httpBase, vaultId, b) {
  const card = el("div", { className: "bookmark-card" });
  const thumb = makeYouTubeThumb(b.url);
  if (thumb) card.append(thumb);
  const body = el("div", { className: "bookmark-body" });
  const head = el("div", { className: "bookmark-head" });
  const titleLink = el("a", { textContent: b.title, href: b.url, target: "_blank" });
  titleLink.rel = "noopener noreferrer";
  head.append(titleLink);
  head.append(el("span", { className: "bookmark-date", textContent: b.date }));
  body.append(head);
  if (b.note) body.append(el("div", { className: "bookmark-note", textContent: b.note }));
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
  editBtn.addEventListener("click", () => showEditBookmarkDialog(httpBase, vaultId, b, () => renderBookmarksTool()));
  actions.append(editBtn);
  const delBtn = el("button", { type: "button", textContent: "Löschen", className: "small" });
  delBtn.addEventListener("click", async () => {
    if (!confirm(`'${b.title}' löschen?`)) return;
    const matchValue = b.url || b.title;
    const r = await fetch(withVaultId(`${httpBase}/tools/bookmarks/delete`, vaultId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ match: matchValue, date: b.date || null }),
    });
    if (r.ok) renderBookmarksTool();
    else { const e = await r.json().catch(() => ({})); alert(`Fehler ${r.status}: ${e.detail || ""}`); }
  });
  actions.append(delBtn);
  meta.append(actions);
  body.append(meta);
  card.append(body);
  return card;
}

function showEditBookmarkDialog(httpBase, vaultId, bookmark, onSaved) {
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
      const r = await fetch(withVaultId(`${httpBase}/tools/bookmarks/edit`, vaultId), {
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

async function captureHighlightedTabs(httpBase, vaultId, button, onDone) {
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
      const r = await fetch(withVaultId(`${httpBase}/tools/bookmarks`, vaultId), {
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

async function copyHighlightedTabUrls(button) {
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
  const text = httpTabs.map((t) => t.url).join("\n");
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    alert("Clipboard-Fehler: " + (err.message || err));
    return;
  }
  const original = button.textContent;
  button.textContent = `✓ ${httpTabs.length} URL${httpTabs.length === 1 ? "" : "s"} kopiert`;
  button.disabled = true;
  setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 1800);
}

function showAddBookmarkDialog(httpBase, vaultId, onAdded) {
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
      const r = await fetch(withVaultId(`${httpBase}/tools/bookmarks`, vaultId), {
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

function extractYouTubeId(url) {
  if (!url || typeof url !== "string") return null;
  const m = url.match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/)([\w-]{11})/);
  return m ? m[1] : null;
}

function makeYouTubeThumb(url) {
  const id = extractYouTubeId(url);
  if (!id) return null;
  const img = el("img", { className: "yt-thumb", src: `https://img.youtube.com/vi/${id}/mqdefault.jpg`, alt: "" });
  img.loading = "lazy";
  img.onerror = () => img.classList.add("yt-thumb-error");
  return img;
}

// ── Sprint 3: Web-Tools ──────────────────────────────────────────────────────

function renderPageScrape() {
  panelTitle.textContent = "Page-Scrape";
  const pendingAction = pendingToolOptions?.action;

  let scrapeMode = pendingAction === "scrape_full" ? "full" : "content";

  // URL-Anzeige des aktiven Browser-Tabs (analog YouTube-Tab)
  const urlRow = el("div", { className: "page-url-row" });
  urlRow.style.cssText = "display:flex;gap:6px;align-items:center;font-size:12px;color:var(--muted,#888);margin-bottom:6px;";
  const urlLabel = el("span", { textContent: "(kein Tab erkannt)" });
  urlLabel.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  const refreshUrlBtn = el("button", {
    type: "button", textContent: "↻", title: "URL aus aktivem Tab übernehmen", className: "secondary",
  });
  refreshUrlBtn.style.cssText = "padding:2px 8px;flex:0 0 auto;";
  urlRow.append(urlLabel, refreshUrlBtn);

  const scrapeModeRow = el("div", { className: "scrape-mode-row" });
  function makeScrapeRadio(value, label) {
    const btn = el("button", { type: "button", className: "scrape-mode-btn" + (value === scrapeMode ? " active" : ""), textContent: label });
    btn.dataset.value = value;
    btn.addEventListener("click", () => {
      if (scrapeMode === value) return;
      scrapeMode = value;
      scrapeModeRow.querySelectorAll(".scrape-mode-btn").forEach(b => b.classList.toggle("active", b.dataset.value === value));
    });
    return btn;
  }
  scrapeModeRow.append(makeScrapeRadio("content", "Nur Inhalt"), makeScrapeRadio("full", "Alles"));

  const runBtn = el("button", { textContent: "Aktiven Tab scrapen" });
  const status = el("div", { className: "tool-status" });
  const output = el("textarea", { readOnly: true, placeholder: "Ergebnis erscheint hier..." });
  const copyBtn = el("button", { textContent: "Kopieren" });
  copyBtn.classList.add("secondary");

  let lastMarkdown = "";
  let lastUrl = "";

  function updateUrlFromActiveTab() {
    if (!chrome?.tabs?.query) return;
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      const u = tab?.url || "";
      urlLabel.textContent = u || "(kein Tab erkannt)";
      urlLabel.title = u;
    });
  }

  async function runScrape() {
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
        body: JSON.stringify({ mode: scrapeMode }),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
      lastMarkdown = data.markdown || "";
      lastUrl = data.url || "";
      if (lastUrl) { urlLabel.textContent = lastUrl; urlLabel.title = lastUrl; }
      output.value = lastMarkdown;
      status.textContent = `${data.title || ""} — ${data.wordCount || 0} Wörter`;
      status.className = "tool-status success";
      if (data.title && !promoteTitle.value) promoteTitle.value = data.title;
      chatBtn.style.display = "";
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
    } finally {
      runBtn.disabled = false;
    }
  }

  runBtn.addEventListener("click", runScrape);
  refreshUrlBtn.addEventListener("click", updateUrlFromActiveTab);

  // Auto: URL erkennen + einmal scrapen beim Öffnen des Tabs.
  // Bei Browser-Tab-Wechsel wird NICHT neu gescrapt — User muss manuell drücken.
  updateUrlFromActiveTab();
  // Defer Scrape damit alle DOM-Elemente schon im Body sind (promoteTitle etc).
  setTimeout(() => { runScrape(); }, 0);

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

  const chatBtn = el("button", { type: "button", className: "secondary", textContent: "🌐 Mit Seite chatten" });
  chatBtn.style.display = "none";
  chatBtn.addEventListener("click", () => {
    const title = promoteTitle.value || "Page-Scrape";
    const content = `Titel: ${title}\nURL: ${lastUrl}\n\n${output.value || ""}`;
    openTool("chat", {
      sourceType: "page",
      sourceRef: { content, title },
      sourceTitle: title,
    });
  });

  panelBody.append(urlRow, scrapeModeRow, runBtn, status, chatBtn, output, copyBtn, promoteSection);
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
  const pendingAction = pendingToolOptions?.action;
  const initialShotMode = pendingAction === "shot_area" ? "area"
    : pendingAction === "shot_full" ? "full"
    : "visible";
  const autoRun = pendingAction && pendingAction.startsWith("shot_");

  // ── Mode row ──────────────────────────────────────────────────────────────
  let screenshotMode = initialShotMode;
  const modeRow = el("div", { className: "scrape-mode-row" });
  [["visible", "Sichtbar"], ["area", "Bereich"], ["full", "Ganze Seite"]].forEach(([value, label]) => {
    const btn = el("button", { type: "button",
      className: "scrape-mode-btn" + (value === initialShotMode ? " active" : ""),
      textContent: label });
    btn.dataset.value = value;
    btn.addEventListener("click", () => {
      if (screenshotMode === value) return;
      screenshotMode = value;
      modeRow.querySelectorAll(".scrape-mode-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.value === value));
    });
    modeRow.append(btn);
  });

  const runBtn = el("button", { textContent: "Screenshot erstellen" });
  const status = el("div", { className: "tool-status" });

  // ── Annotation-Toolbar ────────────────────────────────────────────────────
  const toolbar = el("div", { className: "annot-toolbar" });
  toolbar.style.display = "none";

  const toolBtns = {};
  const annotToolDefs = [
    { id: "pen",  label: "✏ Stift" },
    { id: "rect", label: "□ Rechteck" },
    { id: "arrow", label: "→ Pfeil" },
    { id: "text", label: "T Text" },
  ];
  let activeTool = "pen";

  annotToolDefs.forEach(({ id, label }) => {
    const btn = el("button", { textContent: label });
    btn.classList.add("secondary", "annot-tool-btn");
    btn.dataset.tool = id;
    btn.addEventListener("click", () => {
      if (cropMode) return;
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

  // ── Canvas ────────────────────────────────────────────────────────────────
  const canvas = document.createElement("canvas");
  canvas.className = "annot-canvas";
  canvas.style.display = "none";
  const ctx = canvas.getContext("2d");

  // ── Crop-Mode actions ─────────────────────────────────────────────────────
  const cropActions = el("div");
  cropActions.style.cssText = "display:none;gap:8px;margin-top:6px;flex-wrap:wrap;";
  const confirmCropBtn = el("button", { textContent: "Ausschnitt bestätigen" });
  const cancelCropBtn = el("button", { textContent: "Abbrechen", className: "secondary" });
  cropActions.append(confirmCropBtn, cancelCropBtn);

  // ── Download/Copy actions ─────────────────────────────────────────────────
  const actions = el("div");
  actions.style.cssText = "display:none;gap:8px;margin-top:6px;";
  const copyBtn = el("button", { textContent: "Kopieren" });
  const dlBtn = el("button", { textContent: "Download" });
  copyBtn.classList.add("secondary");
  dlBtn.classList.add("secondary");
  actions.append(copyBtn, dlBtn);

  // ── Drawing state ─────────────────────────────────────────────────────────
  const undoStack = [];
  let drawing = false;
  let startX = 0, startY = 0;
  let snapshot = null;

  // ── Crop state ────────────────────────────────────────────────────────────
  let cropMode = false;
  let cropStart = null;
  let cropRect = null;
  let originalImageData = null;

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

  function activateCropMode() {
    cropMode = true;
    cropRect = null;
    cropStart = null;
    originalImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    canvas.style.cursor = "crosshair";
    toolbar.style.display = "none";
    actions.style.display = "none";
    cropActions.style.display = "flex";
    status.textContent = "Bereich aufziehen, dann 'Ausschnitt bestätigen'";
    status.className = "tool-status";
  }

  confirmCropBtn.addEventListener("click", () => {
    if (!cropRect || cropRect.w < 4 || cropRect.h < 4) {
      status.textContent = "Bitte erst einen Bereich aufziehen";
      status.className = "tool-status error";
      return;
    }
    const { x, y, w, h } = cropRect;
    const cropped = ctx.getImageData(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    canvas.width = Math.round(w);
    canvas.height = Math.round(h);
    ctx.putImageData(cropped, 0, 0);
    cropMode = false;
    cropRect = null;
    originalImageData = null;
    canvas.style.cursor = "default";
    cropActions.style.display = "none";
    toolbar.style.display = "flex";
    actions.style.display = "flex";
    undoStack.length = 0;
    status.textContent = "Ausschnitt gesetzt — Annotation möglich";
    status.className = "tool-status success";
  });

  cancelCropBtn.addEventListener("click", () => {
    if (originalImageData) ctx.putImageData(originalImageData, 0, 0);
    cropMode = false;
    cropRect = null;
    originalImageData = null;
    canvas.style.cursor = "default";
    cropActions.style.display = "none";
    toolbar.style.display = "flex";
    actions.style.display = "flex";
    status.textContent = "fertig — Annotation möglich";
    status.className = "tool-status success";
  });

  // ── Canvas mouse events ───────────────────────────────────────────────────
  canvas.addEventListener("mousedown", (e) => {
    const pos = getPos(e);
    if (cropMode) { cropStart = pos; cropRect = null; return; }

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
    const pos = getPos(e);

    if (cropMode && cropStart) {
      const x = Math.min(cropStart.x, pos.x);
      const y = Math.min(cropStart.y, pos.y);
      const w = Math.abs(pos.x - cropStart.x);
      const h = Math.abs(pos.y - cropStart.y);
      ctx.putImageData(originalImageData, 0, 0);
      ctx.save();
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = "rgba(59,130,246,0.15)";
      ctx.fillRect(x, y, w, h);
      ctx.restore();
      cropRect = { x, y, w, h };
      return;
    }

    if (!drawing) return;
    if (activeTool === "pen") {
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
      return;
    }
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

  canvas.addEventListener("mouseup", () => {
    if (cropMode) return;
    if (!drawing) return;
    drawing = false;
    if (activeTool === "pen") ctx.closePath();
    snapshot = null;
  });

  canvas.addEventListener("mouseleave", () => {
    if (cropMode) return;
    if (drawing && activeTool === "pen") { drawing = false; ctx.closePath(); }
  });

  undoBtn.addEventListener("click", () => {
    if (cropMode || !undoStack.length) return;
    ctx.putImageData(undoStack.pop(), 0, 0);
  });

  // ── Helpers ───────────────────────────────────────────────────────────────
  function loadImageToCanvas(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        ctx.drawImage(img, 0, 0);
        canvas.style.display = "block";
        undoStack.length = 0;
        resolve();
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  function loadImg(dataUrl) {
    return new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = dataUrl;
    });
  }

  async function captureVisible() {
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
    return data.dataUrl;
  }

  function captureFullPage() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "full_page_screenshot" }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp?.ok) return reject(new Error(resp?.error || "Full-page capture fehlgeschlagen"));
        resolve(resp);
      });
    });
  }

  function captureRegion() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "capture_region" }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp?.ok) return reject(new Error(resp?.error || "Region capture fehlgeschlagen"));
        resolve(resp.dataUrl);
      });
    });
  }

  // ── Run button ────────────────────────────────────────────────────────────
  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    cropMode = false;
    cropRect = null;
    originalImageData = null;
    status.textContent = "erstelle Screenshot...";
    status.className = "tool-status";
    canvas.style.display = "none";
    toolbar.style.display = "none";
    cropActions.style.display = "none";
    actions.style.display = "none";
    undoStack.length = 0;

    try {
      if (screenshotMode === "full") {
        status.textContent = "scrollt durch Seite...";
        const resp = await captureFullPage();
        const dpr = resp.dpr || 1;
        const totalH = Math.round(resp.totalHeight * dpr);
        const frameW = Math.round(resp.clientWidth * dpr);

        const offscreen = document.createElement("canvas");
        offscreen.width = frameW;
        offscreen.height = totalH;
        const octx = offscreen.getContext("2d");

        for (const frame of resp.frames) {
          const img = await loadImg(frame.dataUrl);
          const destY = Math.round(frame.y * dpr);
          const remaining = totalH - destY;
          const copyH = Math.min(img.naturalHeight, remaining);
          if (copyH > 0) octx.drawImage(img, 0, 0, img.naturalWidth, copyH, 0, destY, img.naturalWidth, copyH);
        }

        canvas.width = offscreen.width;
        canvas.height = offscreen.height;
        ctx.drawImage(offscreen, 0, 0);
        canvas.style.display = "block";
        toolbar.style.display = "flex";
        actions.style.display = "flex";
        status.textContent = `fertig — ${resp.frames.length} Abschnitte, ${resp.totalHeight}px Gesamthöhe`;
        status.className = "tool-status success";
      } else if (screenshotMode === "area") {
        status.textContent = "Bereich auf der Seite aufziehen...";
        const dataUrl = await captureRegion();
        await loadImageToCanvas(dataUrl);
        toolbar.style.display = "flex";
        actions.style.display = "flex";
        status.textContent = "fertig — Annotation möglich";
        status.className = "tool-status success";
      } else {
        const dataUrl = await captureVisible();
        await loadImageToCanvas(dataUrl);
        toolbar.style.display = "flex";
        actions.style.display = "flex";
        status.textContent = "fertig — Annotation möglich";
        status.className = "tool-status success";
      }
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
    a.download = `screenshot-${screenshotMode}-${Date.now()}.png`;
    a.click();
  });

  panelBody.append(modeRow, runBtn, status, cropActions, toolbar, canvas, actions);

  if (autoRun) setTimeout(() => runBtn.click(), 0);
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

// ── Image-Generator (Gemini Nano Banana) ─────────────────────────────────────

const IMAGE_GEN_MODELS = [
  ["gemini-2.5-flash-image", "Nano Banana (2.5 Flash) — schnell"],
  ["gemini-3.1-flash-image-preview", "Nano Banana 2 (3.1 Flash) — Qualität"],
  ["gemini-3-pro-image-preview", "Nano Banana Pro (3 Pro) — 4K"],
];
const MAX_INPUT_IMAGES = 3;

const imageGenState = {
  // inputs: {base64, mime, name} fuer Uploads ODER {file, name} fuer Server-Pfade
  inputs: [],
  model: null,
  lastOutputFile: null, // Server-relativer Pfad
  gallery: [],          // Index vom Server
};

function imggenLabelForEntry(entry) {
  const p = (entry.prompt || "").trim();
  if (p) return p;
  const base = (entry.file || "").split("/").pop().replace(/\.png$/, "");
  const slug = base.replace(/^\d+-/, "").replace(/-/g, " ");
  return slug || "(ohne Prompt)";
}

function fileToInput(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Datei konnte nicht gelesen werden"));
    reader.onload = () => {
      const result = reader.result || "";
      const comma = result.indexOf(",");
      const base64 = comma >= 0 ? result.slice(comma + 1) : result;
      resolve({ name: file.name, mime: file.type || "image/png", base64 });
    };
    reader.readAsDataURL(file);
  });
}

async function renderImageGenerator() {
  panelTitle.textContent = "Image-Generator";

  const httpBase = await getHttpBase();
  const imgUrl = (rel) => `${httpBase}/tools/image_generated/${rel}`;

  // Modell aus Server-Settings holen (Default fallback)
  try {
    const res = await fetch(`${httpBase}/settings`);
    const data = await res.json();
    imageGenState.model = data.image_gen_model || IMAGE_GEN_MODELS[0][0];
  } catch {
    imageGenState.model = imageGenState.model || IMAGE_GEN_MODELS[0][0];
  }

  // Modell-Dropdown
  const modelRow = el("div", { className: "imggen-row" });
  modelRow.append(el("label", { className: "imggen-label", textContent: "Modell" }));
  const modelSelect = el("select", { className: "imggen-model" });
  for (const [value, label] of IMAGE_GEN_MODELS) {
    const opt = new Option(label, value);
    if (value === imageGenState.model) opt.selected = true;
    modelSelect.append(opt);
  }
  modelSelect.addEventListener("change", () => {
    imageGenState.model = modelSelect.value;
  });
  modelRow.append(modelSelect);

  // Prompt
  const promptArea = el("textarea", {
    className: "imggen-prompt",
    placeholder: "Was soll das Bild zeigen?\nBei Editing: 'mach den Hut blau', 'gleiche Person auf Motorrad'...",
    rows: 3,
  });

  // Input-Thumbnails
  const inputsStrip = el("div", { className: "imggen-inputs" });
  function renderInputs() {
    inputsStrip.replaceChildren();
    if (!imageGenState.inputs.length) {
      inputsStrip.append(el("span", { className: "imggen-inputs-empty", textContent: "Keine Input-Bilder. Optional bis zu " + MAX_INPUT_IMAGES + " hinzufügen." }));
    }
    imageGenState.inputs.forEach((img, idx) => {
      const card = el("div", { className: "imggen-thumb" });
      const i = el("img");
      i.src = img.file ? imgUrl(img.file) : `data:${img.mime};base64,${img.base64}`;
      i.title = img.name || "";
      const x = el("button", { type: "button", className: "imggen-thumb-x", textContent: "×", title: "Entfernen" });
      x.addEventListener("click", () => {
        imageGenState.inputs.splice(idx, 1);
        renderInputs();
      });
      card.append(i, x);
      inputsStrip.append(card);
    });
  }

  const inputControls = el("div", { className: "imggen-input-controls" });
  const fileInput = el("input", { type: "file", accept: "image/*", multiple: true });
  fileInput.style.display = "none";
  const addBtn = el("button", { type: "button", className: "secondary", textContent: "+ Bild hinzufügen" });
  addBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const files = Array.from(fileInput.files || []);
    for (const f of files) {
      if (imageGenState.inputs.length >= MAX_INPUT_IMAGES) break;
      try {
        imageGenState.inputs.push(await fileToInput(f));
      } catch (err) {
        status.textContent = "Bild laden fehlgeschlagen: " + (err.message || err);
        status.className = "tool-status error";
      }
    }
    fileInput.value = "";
    renderInputs();
  });

  function pushInputFromGallery(entry, idx) {
    if (imageGenState.inputs.length >= MAX_INPUT_IMAGES) {
      status.textContent = `Maximal ${MAX_INPUT_IMAGES} Inputs erlaubt`;
      status.className = "tool-status error";
      return false;
    }
    imageGenState.inputs.push({
      name: imggenLabelForEntry(entry).slice(0, 40),
      file: entry.file,
    });
    renderInputs();
    return true;
  }

  const continueBtn = el("button", { type: "button", className: "secondary", textContent: "↻ Letztes Ergebnis als Input" });
  continueBtn.title = "Output des letzten Calls als Input weitergeben (Editing-Modus)";
  continueBtn.addEventListener("click", () => {
    if (!imageGenState.lastOutputFile) {
      status.textContent = "Noch kein Ergebnis zum Weiterverwenden";
      status.className = "tool-status error";
      return;
    }
    if (pushInputFromGallery({ file: imageGenState.lastOutputFile, prompt: "letztes Ergebnis" })) {
      status.textContent = "als Input übernommen";
      status.className = "tool-status success";
    }
  });
  inputControls.append(addBtn, continueBtn, fileInput);

  const genBtn = el("button", { textContent: "Generieren" });
  const status = el("div", { className: "tool-status" });

  // Output
  const outputWrap = el("div", { className: "imggen-output hidden" });
  const outputImg = el("img", { className: "imggen-output-img" });
  const outputActions = el("div", { className: "imggen-output-actions" });
  const dlBtn = el("button", { type: "button", className: "secondary", textContent: "Download" });
  const editBtn = el("button", { type: "button", className: "secondary", textContent: "Bearbeiten" });
  editBtn.title = "Dieses Bild als Input für nächste Anweisung";
  const resetBtn = el("button", { type: "button", className: "secondary", textContent: "Neu starten" });
  outputActions.append(dlBtn, editBtn, resetBtn);
  outputWrap.append(outputImg, outputActions);

  // Galerie-Toolbar (Header + Ordner-öffnen + Reload)
  const galleryHeader = el("div", { className: "imggen-history-title" });
  const galleryLabel = el("span", { textContent: "Galerie" });
  const openFolderBtn = el("button", { type: "button", className: "imggen-toolbar-btn", title: "Im Datei-Explorer öffnen", textContent: "📂 Ordner" });
  const reloadBtn = el("button", { type: "button", className: "imggen-toolbar-btn", title: "Galerie neu laden", textContent: "↺" });
  galleryHeader.append(galleryLabel, reloadBtn, openFolderBtn);

  openFolderBtn.addEventListener("click", async () => {
    try {
      const res = await fetch(`${httpBase}/tools/image_gallery/open`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`);
      status.textContent = "Ordner geöffnet: " + data.path;
      status.className = "tool-status success";
    } catch (err) {
      status.textContent = "Ordner-Öffnen fehlgeschlagen: " + (err.message || err);
      status.className = "tool-status error";
    }
  });

  // Galerie aus Server-Index
  const historyWrap = el("div", { className: "imggen-history" });
  function renderHistory() {
    historyWrap.replaceChildren();
    historyWrap.append(galleryHeader);
    if (!imageGenState.gallery.length) {
      historyWrap.append(el("div", { className: "imggen-inputs-empty", textContent: "Noch keine Bilder. Generiere eins ↑" }));
      return;
    }
    const grid = el("div", { className: "imggen-history-grid" });
    imageGenState.gallery.forEach((entry, idx) => {
      const card = el("div", { className: "imggen-history-card" });
      const url = imgUrl(entry.file);
      const label = imggenLabelForEntry(entry);

      const img = el("img");
      img.src = url;
      img.title = label + "\n(Klick: Lightbox öffnen)";
      img.addEventListener("click", () => {
        const qs = new URLSearchParams({ file: entry.file, server: httpBase });
        chrome.tabs.create({
          url: chrome.runtime.getURL("lightbox/lightbox.html") + "?" + qs.toString(),
        });
      });

      const p = el("div", { className: "imggen-history-prompt", textContent: label });
      p.title = label;

      const actions = el("div", { className: "imggen-history-actions" });
      const dl = el("button", { type: "button", title: "Download", textContent: "⬇" });
      dl.addEventListener("click", (e) => {
        e.stopPropagation();
        const a = document.createElement("a");
        a.href = url;
        a.download = entry.file.split("/").pop();
        a.click();
      });
      const reuse = el("button", { type: "button", title: "Als Input weiterverwenden", textContent: "↻" });
      reuse.addEventListener("click", (e) => {
        e.stopPropagation();
        if (pushInputFromGallery(entry, idx)) {
          status.textContent = "als Input übernommen";
          status.className = "tool-status success";
        }
      });
      const del = el("button", { type: "button", title: "In Papierkorb verschieben", textContent: "×", className: "imggen-del" });
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Bild in den Papierkorb verschieben?\n" + entry.file)) return;
        try {
          const res = await fetch(`${httpBase}/tools/image_gallery/${entry.file}`, { method: "DELETE" });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`);
          if (imageGenState.lastOutputFile === entry.file) {
            imageGenState.lastOutputFile = null;
            outputWrap.classList.add("hidden");
          }
          await loadGallery();
        } catch (err) {
          status.textContent = "Löschen fehlgeschlagen: " + (err.message || err);
          status.className = "tool-status error";
        }
      });
      actions.append(dl, reuse, del);

      card.append(img, p, actions);
      grid.append(card);
    });
    historyWrap.append(grid);
  }

  async function loadGallery() {
    try {
      const res = await fetch(`${httpBase}/tools/image_gallery`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`);
      imageGenState.gallery = data.items || [];
      renderHistory();
    } catch (err) {
      status.textContent = "Galerie laden fehlgeschlagen: " + (err.message || err);
      status.className = "tool-status error";
    }
  }
  reloadBtn.addEventListener("click", loadGallery);

  dlBtn.addEventListener("click", () => {
    if (!imageGenState.lastOutputFile) return;
    const a = document.createElement("a");
    a.href = imgUrl(imageGenState.lastOutputFile);
    a.download = imageGenState.lastOutputFile.split("/").pop();
    a.click();
  });
  editBtn.addEventListener("click", () => continueBtn.click());
  resetBtn.addEventListener("click", () => {
    imageGenState.inputs = [];
    imageGenState.lastOutputFile = null;
    outputWrap.classList.add("hidden");
    promptArea.value = "";
    status.textContent = "";
    status.className = "tool-status";
    renderInputs();
  });

  genBtn.addEventListener("click", async () => {
    const prompt = promptArea.value.trim();
    if (!prompt) {
      status.textContent = "Prompt fehlt";
      status.className = "tool-status error";
      return;
    }
    genBtn.disabled = true;
    status.textContent = imageGenState.inputs.length
      ? `generiere mit ${imageGenState.inputs.length} Input-Bild(ern)...`
      : "generiere...";
    status.className = "tool-status";
    try {
      const inputImages = imageGenState.inputs.filter((x) => x.base64).map((x) => x.base64);
      const inputFiles = imageGenState.inputs.filter((x) => x.file).map((x) => x.file);
      const res = await fetch(`${httpBase}/tools/image_generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          input_images: inputImages,
          input_files: inputFiles,
          model: imageGenState.model,
        }),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || data?.error || text || `HTTP ${res.status}`);
      if (!data?.ok) throw new Error(data?.error || "Fehler beim Generieren");

      imageGenState.lastOutputFile = data.image_path;
      outputImg.src = imgUrl(data.image_path) + "?t=" + Date.now();
      outputWrap.classList.remove("hidden");
      await loadGallery();
      status.textContent = `fertig (${data.model})`;
      status.className = "tool-status success";
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
    } finally {
      genBtn.disabled = false;
    }
  });

  panelBody.append(modelRow, promptArea, inputsStrip, inputControls, genBtn, status, outputWrap, historyWrap);
  renderInputs();
  renderHistory();
  await loadGallery();

  async function consumeImageGenPick() {
    const { imgGenPick } = await chrome.storage.local.get("imgGenPick");
    if (!imgGenPick || !imgGenPick.file) return;
    // stale pick (>5min) ignorieren
    if (imgGenPick.ts && Date.now() - imgGenPick.ts > 5 * 60 * 1000) {
      chrome.storage.local.remove("imgGenPick");
      return;
    }
    chrome.storage.local.remove("imgGenPick");
    if (pushInputFromGallery({ file: imgGenPick.file, prompt: "aus Lightbox" })) {
      status.textContent = "aus Lightbox als Input übernommen";
      status.className = "tool-status success";
    }
  }
  await consumeImageGenPick();

  // Listener fuer den Fall, dass Sidepanel+Tool schon offen sind, waehrend
  // die Lightbox "Bearbeiten" anstoesst.
  const pickListener = (changes, area) => {
    if (area === "local" && changes.imgGenPick && changes.imgGenPick.newValue) {
      consumeImageGenPick();
    }
  };
  chrome.storage.onChanged.addListener(pickListener);
  currentToolCleanup = () => chrome.storage.onChanged.removeListener(pickListener);
}

// ── Guten-Morgen-Briefing ────────────────────────────────────────────────────

const BRIEFING_SOURCE_TOOLTIPS = {
  youtube_trending: "Trending-Videos der letzten 7 Tage in deiner Nische",
  competitor_videos: "Neue Videos deiner Konkurrenz-Channels",
  playlist_trending: "Top-Videos aus deinen Vault-Playlists (nach Views)",
  recommendations: "LLM-generierte 'What to do'-Vorschläge aus deinem Vault-Kontext",
  vertrags_fristen: "Kundenverträge die in den nächsten 60 Tagen auslaufen",
  kampagnen_kickoffs: "Kampagnen-Kickoffs in den nächsten 14 Tagen",
};

const BRIEFING_SOURCE_TITLES = {
  youtube_trending: "YouTube-Trending",
  competitor_videos: "Konkurrenz-Videos",
  playlist_trending: "Playlist-Trending",
  recommendations: "Empfehlungen",
  vertrags_fristen: "Vertrags-Fristen",
  kampagnen_kickoffs: "Kampagnen-Kickoffs",
  recent_videos: "Neueste Videos",
  recent_pages: "Zuletzt geändert",
  active_projects: "Aktive Projekte",
  scratchpad: "Scratchpad",
  last_journal: "Letztes Journal",
  workshops: "Workshops",
  anniversaries: "Jahrestage",
};

const BRIEFING_SOURCE_ICONS = {
  wetter: "🌤",
  todos: "✅",
  fristen: "⏰",
  lernstreak: "📚",
  vertrags_fristen: "📄",
  kampagnen_kickoffs: "🚀",
  youtube_trending: "🔥",
  competitor_videos: "👥",
  playlist_trending: "🎬",
  recommendations: "💡",
  recent_videos: "🎬",
  recent_pages: "📄",
  active_projects: "📁",
  scratchpad: "📝",
  last_journal: "📓",
  workshops: "📅",
  anniversaries: "🎉",
};

function briefingFormatNumber(n) {
  if (typeof n !== "number" || !isFinite(n)) return String(n ?? "");
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

function briefingRelativeTime(isoDate) {
  if (!isoDate) return "";
  const then = new Date(isoDate);
  if (isNaN(then.getTime())) return "";
  const diffMs = Date.now() - then.getTime();
  const days = Math.floor(diffMs / 86400000);
  if (days < 0) return "in der Zukunft";
  if (days === 0) {
    const hours = Math.floor(diffMs / 3600000);
    if (hours <= 0) return "gerade eben";
    return `vor ${hours} Std`;
  }
  if (days === 1) return "vor 1 Tag";
  if (days < 30) return `vor ${days} Tagen`;
  const months = Math.floor(days / 30);
  if (months === 1) return "vor 1 Monat";
  return `vor ${months} Monaten`;
}

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

  const profileSelect = el("select", { className: "briefing-profile-select", title: "Briefing-Profil" });
  header.append(profileSelect);

  const lookbackBtn = el("button", {
    type: "button",
    className: "briefing-lookback-btn",
    id: "btn-briefing-lookback",
    textContent: "📅 Was war vor… Tagen?",
  });
  header.append(lookbackBtn);

  const closeBtn = el("button", { type: "button", textContent: "×", className: "briefing-close" });
  closeBtn.addEventListener("click", () => panel.remove());
  header.append(closeBtn);
  panel.append(header);

  const body = el("div", { className: "briefing-body" });
  body.textContent = "laden...";
  panel.append(body);
  document.body.append(panel);

  let currentProfile = null;
  let currentVaultId = null;
  let allProfiles = [];
  let selectedProfileId = "default";

  async function loadProfiles() {
    try {
      const httpBase = await getHttpBase();
      const pres = await fetch(`${httpBase}/tools/briefing/profiles`);
      const pjson = await pres.json().catch(() => ({}));
      allProfiles = Array.isArray(pjson.data) ? pjson.data : (pjson.data?.profiles || []);
    } catch { allProfiles = []; }
    if (!allProfiles.some(p => p.id === selectedProfileId)) {
      selectedProfileId = allProfiles[0]?.id || "default";
    }
    profileSelect.replaceChildren();
    for (const p of allProfiles) {
      profileSelect.append(el("option", { value: p.id, textContent: p.name || p.id }));
    }
    profileSelect.value = selectedProfileId;
    profileSelect.style.display = allProfiles.length > 1 ? "" : "none";
  }

  async function loadCurrentBriefing() {
    body.replaceChildren();
    body.textContent = "laden...";
    body.className = "briefing-body";
    try {
      const httpBase = await getHttpBase();
      currentVaultId = await getActiveVaultId(httpBase).catch(() => null);
      const vaultParam = currentVaultId ? `&vault_id=${encodeURIComponent(currentVaultId)}` : "";
      const res = await fetch(`${httpBase}/tools/briefing?profile=${encodeURIComponent(selectedProfileId)}${vaultParam}`);
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
      const briefingData = data.data || data;
      currentProfile = allProfiles.find(p => p.id === selectedProfileId) || null;
      body.replaceChildren();
      renderBriefingSections(body, briefingData, currentProfile);
    } catch (err) {
      body.textContent = "Fehler: " + (err.message || err);
      body.className = "briefing-body error";
    }
  }

  profileSelect.addEventListener("change", () => {
    selectedProfileId = profileSelect.value;
    loadCurrentBriefing();
  });

  lookbackBtn.addEventListener("click", () => openBriefingLookback(body, loadCurrentBriefing, currentVaultId));

  await loadProfiles();
  await loadCurrentBriefing();
}

function openBriefingLookback(body, restoreFn, vaultId) {
  const existing = body.querySelector(".briefing-lookback-modal");
  if (existing) { existing.remove(); return; }

  const modal = el("div", {
    className: "briefing-lookback-modal",
    style: "display:flex; gap:6px; align-items:center; padding:8px; background:var(--bg-subtle); border-radius:4px; margin-bottom:8px;",
  });
  modal.append(el("label", { textContent: "Vor wie vielen Tagen?", style: "font-size:11px;" }));
  const input = el("input", { type: "number", value: "14", min: "1", max: "9999" });
  input.style.cssText = "width:60px; font-size:12px; padding:2px 4px;";
  const goBtn = el("button", { type: "button", textContent: "Anzeigen", className: "briefing-lookback-btn" });
  const cancelBtn = el("button", { type: "button", textContent: "Abbrechen", className: "briefing-lookback-btn" });
  modal.append(input, goBtn, cancelBtn);

  body.prepend(modal);

  cancelBtn.addEventListener("click", () => modal.remove());
  goBtn.addEventListener("click", async () => {
    const days = parseInt(input.value, 10);
    if (!days || days < 1) return;
    goBtn.disabled = true;
    goBtn.textContent = "lädt...";
    try {
      const httpBase = await getHttpBase();
      const vaultParam = vaultId ? `&vault_id=${encodeURIComponent(vaultId)}` : "";
      const res = await fetch(`${httpBase}/tools/briefing/lookback?days=${days}${vaultParam}`);
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
      const payload = data.data || data;
      if (payload.ok === false) {
        modal.remove();
        const notice = el("div", { className: "briefing-empty", textContent: payload.error || "Kein Journal-Eintrag gefunden." });
        notice.style.cssText = "padding:12px; text-align:center;";
        body.replaceChildren(notice);
        const backBtn = el("button", { type: "button", className: "briefing-lookback-btn", textContent: "← Zurück zum aktuellen Briefing" });
        backBtn.addEventListener("click", () => restoreFn());
        body.append(backBtn);
        return;
      }
      // Render lookback
      body.replaceChildren();
      const header = el("div", { className: "briefing-section-title", textContent: `Briefing vom ${payload.date}` });
      header.style.cssText = "margin-bottom:8px;";
      body.append(header);
      const md = el("div", { className: "briefing-lookback-md" });
      md.innerHTML = renderMarkdown(payload.markdown || "");
      body.append(md);
      const backBtn = el("button", { type: "button", className: "briefing-lookback-btn", textContent: "← Zurück zum aktuellen Briefing" });
      backBtn.style.marginTop = "12px";
      backBtn.addEventListener("click", () => restoreFn());
      body.append(backBtn);
    } catch (err) {
      goBtn.disabled = false;
      goBtn.textContent = "Anzeigen";
      const err2 = el("div", { className: "briefing-error", textContent: "Fehler: " + (err.message || err) });
      modal.append(err2);
    }
  });
}

function renderBriefingSections(target, briefingData, profile) {
  let sections = briefingData.sections || [];

  // Re-order nach Profil-Reihenfolge wenn vorhanden
  if (profile && Array.isArray(profile.sources) && profile.sources.length) {
    const order = profile.sources;
    sections = [...sections].sort((a, b) => {
      const ia = order.indexOf(a.type);
      const ib = order.indexOf(b.type);
      if (ia === -1 && ib === -1) return 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  }

  let quotaProblem = false;

  for (const sec of sections) {
    const card = el("div", { className: `briefing-section briefing-section--${sec.type}` });
    const items = sec.items || [];

    // Section-Header: Icon + Titel + Count
    const titleEl = el("h4", { className: "briefing-section-title" });
    const icon = BRIEFING_SOURCE_ICONS[sec.type];
    const titleText = sec.title || BRIEFING_SOURCE_TITLES[sec.type] || sec.type;
    titleEl.textContent = (icon ? icon + " " : "") + titleText + (items.length ? ` (${items.length})` : "");
    const tooltip = BRIEFING_SOURCE_TOOLTIPS[sec.type];
    if (tooltip) titleEl.title = tooltip;
    card.append(titleEl);

    // Per-Section-Error: Hinweis statt Items
    if (sec.error) {
      card.append(el("div", { className: "briefing-error", textContent: `⚠ ${sec.error}` }));
      const errStr = String(sec.error);
      if (/Quota|YOUTUBE_API_KEY|API[_-]?KEY/i.test(errStr) && (sec.type === "youtube_trending" || sec.type === "competitor_videos")) {
        quotaProblem = true;
      }
      target.append(card);
      continue;
    }

    if (sec.type === "wetter") {
      for (const w of items) {
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
      for (const t of items) {
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
    } else if (sec.type === "fristen" || sec.type === "vertrags_fristen" || sec.type === "kampagnen_kickoffs" || sec.type === "workshops" || sec.type === "anniversaries") {
      renderBriefingFristenLike(card, items, sec.type);
    } else if (sec.type === "lernstreak") {
      const msg = sec.days_ago === 0
        ? "Heute schon gelernt"
        : sec.last_video_title
          ? `Letztes Video: "${sec.last_video_title}" — vor ${sec.days_ago} Tag${sec.days_ago === 1 ? "" : "en"}`
          : "Heute noch kein Video";
      card.append(el("div", { textContent: msg }));
    } else if (sec.type === "youtube_trending" || sec.type === "competitor_videos" || sec.type === "playlist_trending") {
      renderBriefingVideoCards(card, items, sec.type);
    } else if (sec.type === "recent_videos") {
      renderBriefingPageList(card, items, { emptyText: "Keine Videos", asLink: true });
    } else if (sec.type === "recent_pages" || sec.type === "active_projects") {
      renderBriefingPageList(card, items, { emptyText: sec.type === "active_projects" ? "Keine aktiven Projekte" : "Keine Änderungen" });
    } else if (sec.type === "scratchpad") {
      if (!sec.markdown || !sec.markdown.trim()) {
        card.append(el("div", { className: "briefing-empty", textContent: "Scratchpad leer" }));
      } else {
        const md = el("div", { className: "briefing-lookback-md" });
        md.innerHTML = renderMarkdown(sec.markdown);
        card.append(md);
      }
    } else if (sec.type === "last_journal") {
      if (!items.length) {
        card.append(el("div", { className: "briefing-empty", textContent: "Kein Journal-Eintrag" }));
      } else {
        const it = items[0];
        card.append(el("div", { className: "briefing-journal-date", textContent: it.date }));
        const md = el("div", { className: "briefing-lookback-md" });
        md.innerHTML = renderMarkdown(it.preview || "");
        card.append(md);
      }
    } else if (sec.type === "recommendations") {
      renderBriefingRecommendations(card, items);
    } else {
      // Unbekannter Section-Typ: roher Fallback
      if (items.length) {
        for (const item of items) {
          card.append(el("div", { textContent: typeof item === "string" ? item : (item.text || item.title || JSON.stringify(item)) }));
        }
      } else {
        card.append(el("div", { className: "briefing-empty", textContent: "Keine Daten" }));
      }
    }

    target.append(card);
  }

  if (quotaProblem) {
    const notice = el("div", { className: "briefing-quota-notice" });
    const link = el("a", { textContent: "⚙ YouTube-API-Key in den Optionen setzen", href: "#" });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    notice.append(link);
    target.append(notice);
  }

  if (!sections.length) {
    target.append(el("div", { className: "briefing-empty", textContent: "Keine Daten" }));
  }
}

function renderBriefingFristenLike(card, items, type) {
  // type: fristen | vertrags_fristen | kampagnen_kickoffs
  const emptyText = {
    fristen: "Keine Fristen",
    vertrags_fristen: "Keine auslaufenden Verträge",
    kampagnen_kickoffs: "Keine anstehenden Kickoffs",
    workshops: "Keine anstehenden Workshops",
    anniversaries: "Keine Jahrestage",
  }[type] || "Keine Einträge";

  for (const f of items) {
    // Shape-Toleranz: title/titel, days_left/tage_offen, date/datum
    const title = f.title || f.titel || f.name || "?";
    const daysLeft = f.days_left !== undefined ? f.days_left : (f.tage_offen !== undefined ? f.tage_offen : null);
    const cls = daysLeft !== null && daysLeft <= 7 ? "urgent" : daysLeft !== null && daysLeft <= 30 ? "warning" : "";
    const row = el("div", { className: "frist-item" + (cls ? " " + cls : "") });
    row.append(el("span", { textContent: title }));
    if (daysLeft !== null) {
      row.append(el("span", { className: "frist-days", textContent: `${daysLeft}d` }));
    } else if (f.date || f.datum) {
      row.append(el("span", { className: "frist-days", textContent: f.date || f.datum }));
    }
    card.append(row);
  }
  if (!card.querySelector(".frist-item")) {
    card.append(el("div", { className: "briefing-empty", textContent: emptyText }));
  }
}

function renderBriefingPageList(card, items, opts) {
  const { emptyText = "Keine Einträge", asLink = false } = opts || {};
  if (!items.length) {
    card.append(el("div", { className: "briefing-empty", textContent: emptyText }));
    return;
  }
  for (const it of items) {
    const row = el("div", { className: "frist-item" });
    const label = it.title || it.file || "?";
    if (asLink && it.url) {
      const a = el("a", { textContent: label, href: it.url });
      a.target = "_blank"; a.rel = "noopener";
      a.addEventListener("click", (e) => { e.preventDefault(); window.open(it.url, "_blank", "noopener"); });
      row.append(a);
    } else {
      const extra = it.status && it.status !== "—" ? ` · ${it.status}` : "";
      row.append(el("span", { textContent: label + extra }));
    }
    if (it.days_ago !== null && it.days_ago !== undefined) {
      row.append(el("span", { className: "frist-days", textContent: `${it.days_ago}d` }));
    }
    card.append(row);
  }
}

function renderBriefingVideoCards(card, items, type) {
  if (!items.length) {
    card.append(el("div", { className: "briefing-empty", textContent: "Keine Videos" }));
    return;
  }

  const MAX_VISIBLE = 5;
  const visible = items.slice(0, MAX_VISIBLE);
  const hidden = items.slice(MAX_VISIBLE);

  const appendVideoCard = (parent, v) => {
    const cardEl = el("a", { className: "briefing-video-card", href: v.url || "#" });
    cardEl.target = "_blank";
    cardEl.rel = "noopener";
    cardEl.addEventListener("click", (e) => {
      e.preventDefault();
      if (v.url) window.open(v.url, "_blank", "noopener");
    });

    // Thumbnail (optional)
    if (v.thumbnail) {
      const img = el("img", { className: "briefing-video-thumb", src: v.thumbnail, alt: "" });
      img.loading = "lazy";
      img.addEventListener("error", () => img.remove());
      cardEl.append(img);
    } else if (type !== "playlist_trending") {
      // Platzhalter nur bei video-typischen Sections, nicht bei playlist
      const ph = el("div", { className: "briefing-video-thumb" });
      cardEl.append(ph);
    }

    const meta = el("div", { className: "briefing-video-meta" });
    meta.append(el("div", { className: "briefing-video-title", textContent: v.title || "Ohne Titel" }));
    if (v.channel_title) {
      meta.append(el("div", { className: "briefing-video-channel", textContent: v.channel_title }));
    }
    const statsParts = [];
    if (typeof v.views === "number") statsParts.push(`${briefingFormatNumber(v.views)} Views`);
    if (typeof v.likes === "number") statsParts.push(`${briefingFormatNumber(v.likes)} Likes`);
    if (v.published_at) statsParts.push(briefingRelativeTime(v.published_at));
    if (statsParts.length) {
      meta.append(el("div", { className: "briefing-video-stats", textContent: statsParts.join(" • ") }));
    }
    cardEl.append(meta);
    parent.append(cardEl);
  };

  for (const v of visible) appendVideoCard(card, v);

  if (hidden.length) {
    const details = el("details", { className: "briefing-show-more" });
    const summary = el("summary", { textContent: `+ ${hidden.length} weitere anzeigen` });
    details.append(summary);
    for (const v of hidden) appendVideoCard(details, v);
    card.append(details);
  }
}

function renderBriefingRecommendations(card, items) {
  if (!items.length) {
    card.append(el("div", { className: "briefing-empty", textContent: "Keine Empfehlungen" }));
    return;
  }
  const kindIcons = { artikel: "📝", video: "🎬", tipp: "💡" };
  for (const r of items) {
    const row = el("div", { className: "briefing-reco-card" });
    const icon = kindIcons[r.kind] || "💡";
    row.append(el("span", { className: "briefing-reco-icon", textContent: icon }));
    row.append(el("p", { className: "briefing-reco-text", textContent: r.text || "" }));
    card.append(row);
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

async function showBrainModal({ url, tabId, prefetched }) {
  const overlay = el("div", { className: "playlist-picker-overlay" });
  const dialog = el("div", { className: "brain-modal" });
  dialog.append(el("h3", { textContent: "Video ins Brain speichern" }));
  const thumb = makeYouTubeThumb(url);
  if (thumb) {
    thumb.classList.add("yt-thumb-large");
    dialog.append(thumb);
  }
  dialog.append(el("div", { className: "brain-modal-meta", textContent: url }));

  const status = el("div", {
    className: "tool-status",
    textContent: prefetched ? "Tags werden vorgeschlagen..." : "Transcript wird extrahiert...",
  });
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

  // Lade Säulen + (auto_brain ODER nur auto_tag bei prefetched) parallel
  let brainData = null;
  let saeulenList = [];
  try {
    let dataPromise;
    if (prefetched) {
      // Transcript+Title schon da → nur Tag-Suggestion holen
      dataPromise = fetch(`${httpBase}/tools/auto_tag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: prefetched.transcript,
          title: prefetched.title || url,
          vault_id: vaultId,
        }),
      }).then(async (r) => {
        const t = await r.text();
        let j = null;
        try { j = JSON.parse(t); } catch {}
        if (!r.ok) throw new Error(j?.detail || t || `HTTP ${r.status}`);
        return {
          transcript: prefetched.transcript,
          title: prefetched.title || url,
          url,
          suggestion: j.data || j,
        };
      });
    } else {
      // Klassischer Pfad: auto_brain holt Transcript + Tags
      dataPromise = fetch(`${httpBase}/tools/auto_brain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, vault_id: vaultId, tab_id: tabId }),
      }).then(async (r) => {
        const t = await r.text();
        let j = null;
        try { j = JSON.parse(t); } catch {}
        if (!r.ok) throw new Error(j?.detail || t || `HTTP ${r.status}`);
        return j.data || j;
      });
    }
    const [bd, saeulenRes] = await Promise.all([
      dataPromise,
      fetch(`${httpBase}/vaults/${vaultId}/saeulen`),
    ]);
    brainData = bd;
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

chrome.tabs.onActivated.addListener(() => {
  checkActiveTabForYoutube();
  if (_chatPageModeScrape) _chatPageModeScrape();
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete" || !_chatPageModeScrape) return;
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.id === tabId) _chatPageModeScrape();
  });
});
