// Sidepanel: connection status, tab navigation, tool runner. ewtos.com
import { el, extractYouTubeId, makeYouTubeThumb } from './dom.js';
import { renderMarkdown, escapeHtml, inlineMd, buildNestedList, obsidianUri, openInObsidian, renderLineDiff } from './markdown.js';
import { applyTheme, updateDarkToggleIcon } from './modules/theme.js';
import { state } from './state.js';
import { getHttpBase, getActiveVault, getActiveVaultId, withVaultId } from './modules/api.js';
import { renderYoutubeTranscript } from './renderers/youtube.js';
import { renderBookmarksTool } from './renderers/bookmarks.js';
import { renderNotesFile, renderTodos } from './renderers/notes.js';
import { renderChat } from './renderers/chat.js';
import { renderVaultExplorer, renderVaultHealth } from './renderers/vault.js';
import { renderPageScrape, renderSeoCheck, renderImageAnalyse, renderColorPicker, renderScreenshot, renderUrlExtractor, renderImageGenerator } from './renderers/web-tools.js';
import { showBriefingPanel, showQuickSavePage, checkPendingBrainPick, checkActiveTabForYoutube, renderDocumentIngest } from './renderers/briefing.js';
import { renderPlaylistsTool, checkPendingPlaylistPick } from './renderers/playlists.js';
import { statusDot, tabsNav, content, openOptions, reconnectBtn, quickActions, offlineBannerText, DEFAULT_OFFLINE_HTML, burgerBtn, burgerMenu } from './modules/dom-refs.js';

// Keep the background Service Worker alive via a persistent port.
// MV3 SWs are terminated after ~30s idle — an open port prevents that,
// keeping the WebSocket connection stable while the sidepanel is open.
const _keepalivePort = chrome.runtime.connect({ name: "sidepanel-keepalive" });
_keepalivePort.onDisconnect.addListener(() => { void chrome.runtime.lastError; });

// ── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  const { theme = "neutral", darkMode = false } =
    await chrome.storage.local.get(["theme", "darkMode"]);
  applyTheme(theme, darkMode);
  updateDarkToggleIcon(darkMode);
  state.toolViewMode = (await chrome.storage.local.get("toolViewMode")).toolViewMode || "list";
  const stored = (await chrome.storage.local.get("quickSlots")).quickSlots;
  if (Array.isArray(stored)) {
    state.quickSlots = stored.slice(0, QUICK_SLOT_COUNT);
    while (state.quickSlots.length < QUICK_SLOT_COUNT) state.quickSlots.push(null);
  }
  renderTabs();
  renderQuickActions();
  await loadQuickRowPref();
  if (!state.activeTool) renderToolList();
})();

chrome.storage.onChanged.addListener((changes) => {
  if (changes.theme !== undefined || changes.darkMode !== undefined) {
    chrome.storage.local.get(["theme", "darkMode"], ({ theme = "neutral", darkMode = false }) => {
      applyTheme(theme, darkMode);
      updateDarkToggleIcon(darkMode);
    });
  }
  if (changes.hideQuickRowOnTool !== undefined) {
    state.hideQuickRowOnTool = !!changes.hideQuickRowOnTool.newValue;
    applyQuickRowVisibility();
  }
  if (changes.playlistPick && changes.playlistPick.newValue) {
    checkPendingPlaylistPick();
  }
});

// ── DOM refs ─────────────────────────────────────────────────────────────────


const TOOL_RENDERERS = {
  youtube_transcript: renderYoutubeTranscript,
  scratchpad: () => renderNotesFile("scratchpad", {
    title: "Note-Taker",
    placeholder: "Notizen, Gedanken, Skizzen... wird automatisch gespeichert.",
  }),
  todos: renderTodos,
  chat: renderChat,
  chat_web: renderChat,
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
  ingest_document: renderDocumentIngest,
};

const GROUPS = [
  {
    id: "chat",
    label: "Chat",
    icon: "💬",
    tools: [
      { id: "chat", label: "Chat mit Vault", hint: "Fragen an den Vault (Karpathy-Methode)", icon: "📚" },
      { id: "chat_web", label: "Chat mit Seite", hint: "Mit dem Inhalt des aktiven Tabs chatten", icon: "🌐", openOptions: { startMode: "page" } },
    ],
  },
  {
    id: "vault",
    label: "Vault",
    icon: "📚",
    tools: [
      { id: "vault_explorer", label: "Explorer",         hint: "Vault durchblättern, Dateien lesen, mit ihnen chatten", icon: "📚" },
      { id: "scratchpad",     label: "Note-Taker",       hint: "globaler Scratchpad", icon: "📝" },
      { id: "todos",          label: "Todos",            hint: "klickbare Liste mit Due-Dates", icon: "✅" },
      { id: "playlists",      label: "Playlists",        hint: "Video-Sammlungen pro Säule", icon: "🎵" },
      { id: "bookmarks",      label: "Bookmarks",        hint: "URL-Inbox aus Browser-Capture", icon: "🔖",
        actions: [
          { label: "Neuen Bookmark", icon: "+", action: "add" },
          { label: "Markierte Tabs erfassen", icon: "⇲", action: "capture_tabs" },
          { label: "URLs der Tabs kopieren", icon: "⧉", action: "copy_urls" },
        ],
      },
      { id: "vault_health",     label: "Vault-Gesundheit", hint: "Audit: Orphans, Links, Frontmatter, CLAUDE.md", icon: "🩺" },
      { id: "ingest_document",  label: "Dokument-Ingest",  hint: "PDF, TXT oder Markdown in raw/ ablegen", icon: "📥" },
    ],
  },
  {
    id: "web",
    label: "Web",
    icon: "🌐",
    tools: [
      { id: "page_scrape", label: "Page-Scrape", hint: "Aktiver Tab → bereinigtes Markdown", icon: "📄",
        actions: [
          { label: "Nur Inhalt scrapen", icon: "▸", action: "scrape_content" },
          { label: "Komplette Seite scrapen", icon: "▸", action: "scrape_full" },
        ],
      },
      { id: "youtube_transcript", label: "YouTube-Transcript", hint: "Transkript aus aktivem Tab", icon: "🎬" },
    ],
  },
  {
    id: "analyse",
    label: "Analyse",
    icon: "🔬",
    tools: [
      { id: "seo_check",     label: "SEO-Check",     hint: "Title, Meta, Headings, OG-Tags", icon: "🔍" },
      { id: "image_analyse", label: "Image-Analyse", hint: "Bilder + Alt-Text-Check", icon: "🖼️" },
    ],
  },
  {
    id: "extras",
    label: "Extras",
    icon: "🎨",
    tools: [
      { id: "url_extractor",  label: "URL-Extraktor", hint: "Alle Links der aktuellen Seite", icon: "🔗" },
      { id: "image_generator", label: "Image-Gen",   hint: "Bild erzeugen + editieren (Gemini Nano)", icon: "🪄" },
      { id: "color_picker",   label: "Color-Picker",  hint: "CSS-Variablen + Farbpalette", icon: "🎨" },
      { id: "screenshot", label: "Screenshot", hint: "Sichtbar, Bereich wählen oder Ganze Seite", icon: "📸",
        actions: [
          { label: "Sichtbar", icon: "▸", action: "shot_visible" },
          { label: "Bereich wählen", icon: "▸", action: "shot_area" },
          { label: "Ganze Seite", icon: "▸", action: "shot_full" },
        ],
      },
    ],
  },
];

const QUICK_SPECIAL = {
  _briefing:   { label: "Briefing",    icon: "☀", run: () => showBriefingPanel() },
  _save_page:  { label: "Ins Vault",   icon: "📥", run: () => showQuickSavePage() },
};
const DEFAULT_QUICK_SLOTS = ["vault_explorer", "scratchpad", "todos", "_briefing", "_save_page"];
const QUICK_SLOT_COUNT = 5;

function getQuickOption(id) {
  if (!id) return null;
  if (QUICK_SPECIAL[id]) {
    return { id, label: QUICK_SPECIAL[id].label, icon: QUICK_SPECIAL[id].icon, special: true };
  }
  for (const g of GROUPS) {
    const t = g.tools.find((x) => !x.separator && x.id === id);
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
      if (t.separator || t.soon) continue;
      opts.push({ id: t.id, label: t.label, icon: t.icon || "•", group: g.label });
    }
  }
  return opts;
}

function runQuickSlot(id) {
  if (QUICK_SPECIAL[id]) return QUICK_SPECIAL[id].run();
  openTool(id);
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

// Externe Links (https) im Sidepanel via chrome.tabs.create öffnen —
// target="_blank" funktioniert in MV3-Sidepanels nicht zuverlässig.
document.addEventListener("click", (e) => {
  const a = e.target.closest("a.ext-link");
  if (!a) return;
  e.preventDefault();
  chrome.tabs.create({ url: a.href });
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
  if (area === "local" && changes.selectedVaultId && state.activeTool && NOTES_TOOLS.has(state.activeTool)) {
    openTool(state.activeTool);
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
  chrome.runtime.sendMessage({ type: "reconnect" }).catch(() => {});
  closeBurgerMenu();
});


async function setViewMode(mode) {
  if (state.toolViewMode === mode) return;
  state.toolViewMode = mode;
  await chrome.storage.local.set({ toolViewMode: state.toolViewMode });
  renderTabs();
  if (!state.activeTool) renderToolList();
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
  chrome.runtime.sendMessage({ type: "reconnect" }).catch(() => {});
});

document.getElementById("dark-toggle").addEventListener("click", async () => {
  const isDark = document.documentElement.dataset.mode === "dark";
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




function renderTabs() {
  tabsNav.replaceChildren();
  for (const g of GROUPS) {
    const b = el("button", {
      type: "button",
      className: "tab" + (g.id === state.activeTab ? " active" : ""),
      textContent: (g.icon ? g.icon + " " : "") + g.label,
    });
    b.addEventListener("click", () => {
      state.activeTab = g.id;
      state.activeTool = null;
      renderTabs();
      renderToolList();
      if (g.autoOpen && g.tools.filter(t => !t.separator).length === 1) {
        openTool(g.tools.find(t => !t.separator).id);
      }
    });
    tabsNav.append(b);
  }
  const vt = el("div", { className: "view-toggle" });
  const listBtn = el("button", {
    type: "button",
    className: "vt-btn first" + (state.toolViewMode === "list" ? " active" : ""),
    title: "Listen-Ansicht",
    textContent: "☰",
  });
  const gridBtn = el("button", {
    type: "button",
    className: "vt-btn last" + (state.toolViewMode === "grid" ? " active" : ""),
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
  const group = GROUPS.find((g) => g.id === state.activeTab);
  if (!group) return;

  const list = el("ul", { className: "tools " + state.toolViewMode });
  for (const t of group.tools) {
    if (t.separator) {
      list.append(el("li", { className: "tool-separator", textContent: t.label }));
      continue;
    }
    const hasActions = Array.isArray(t.actions) && t.actions.length > 0;
    const li = el("li", { className: "tool" + (t.soon ? " soon" : "") + (hasActions ? " has-caret" : "") });
    if (state.toolViewMode === "grid" && t.icon) {
      li.append(el("span", { className: "tool-icon", textContent: t.icon }));
    }
    li.append(el("span", { className: "tool-label", textContent: t.label }));
    if (state.toolViewMode === "list" && t.hint) {
      li.append(el("span", { className: "hint", textContent: t.hint }));
    }
    if (state.toolViewMode === "grid" && t.hint) {
      li.append(el("span", { className: "tool-hint", textContent: t.hint }));
    }
    if (t.soon) {
      li.append(el("span", { className: "badge", textContent: "bald" }));
    } else {
      li.addEventListener("click", (e) => {
        if (e.target.closest(".tool-caret, .tool-popover")) return;
        openTool(t.id, t.openOptions || null);
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

  while (state.quickSlots.length < QUICK_SLOT_COUNT) state.quickSlots.push(null);
  if (state.quickSlots.length > QUICK_SLOT_COUNT) state.quickSlots = state.quickSlots.slice(0, QUICK_SLOT_COUNT);

  const row = el("div", { className: "quick-row" });
  const allFilled = state.quickSlots.every((id) => !!id);

  state.quickSlots.forEach((slotId, idx) => {
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
      className: "quick-btn" + (state.activeTool === opt.id ? " active" : ""),
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
  await chrome.storage.local.set({ quickSlots: state.quickSlots });
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
    state.quickSlots[idx] = null;
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
    state.quickSlots.forEach((slotId, idx) => {
      const opt = getQuickOption(slotId);
      const slot = el("button", { type: "button",
        className: "qe-slot" + (opt ? "" : " empty") + (selectedIdx === idx ? " selected" : ""),
        title: opt ? `Slot ${idx + 1}: ${opt.label} (klick = leeren)` : `Slot ${idx + 1} (leer)`,
      });
      slot.append(el("span", { className: "ico", textContent: opt ? opt.icon : "+" }));
      slot.append(el("span", { className: "lbl", textContent: opt ? opt.label : `Slot ${idx + 1}` }));
      slot.addEventListener("click", async () => {
        if (opt) {
          state.quickSlots[idx] = null;
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
  let selectedIdx = targetIdx !== null ? targetIdx : state.quickSlots.findIndex((s) => !s);
  if (selectedIdx < 0) selectedIdx = 0;
  renderSlotsRow();

  const hint = el("div", { className: "qe-hint",
    textContent: "Wähle ein Tool für den markierten Slot (oder klicke einen Slot zum Leeren):",
  });

  const picker = el("div", { className: "quick-editor-picker" });
  const used = new Set(state.quickSlots.filter(Boolean));
  for (const opt of getAllQuickOptions()) {
    const item = el("button", { type: "button", className: "qe-pick" });
    item.append(el("span", { className: "ico", textContent: opt.icon }));
    item.append(el("span", { className: "lbl", textContent: opt.label }));
    if (opt.group) item.append(el("span", { className: "grp", textContent: opt.group }));
    if (used.has(opt.id)) item.classList.add("used");
    item.addEventListener("click", async () => {
      const idx = selectedIdx;
      const existing = state.quickSlots.indexOf(opt.id);
      if (existing >= 0 && existing !== idx) state.quickSlots[existing] = null;
      state.quickSlots[idx] = opt.id;
      await saveQuickSlots();
      const nextEmpty = state.quickSlots.findIndex((s) => !s);
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


async function loadQuickRowPref() {
  const { hideQuickRowOnTool: pref } = await chrome.storage.local.get("hideQuickRowOnTool");
  state.hideQuickRowOnTool = !!pref;
  applyQuickRowVisibility();
}

function applyQuickRowVisibility() {
  if (state.hideQuickRowOnTool && state.activeTool) quickActions.classList.add("hidden");
  else quickActions.classList.remove("hidden");
}


function runToolCleanup() {
  if (state.currentToolCleanup) {
    try { state.currentToolCleanup(); } catch {}
    state.currentToolCleanup = null;
  }
}

export function openTool(toolId, options = null) {
  const renderer = TOOL_RENDERERS[toolId];
  if (!renderer) return;
  runToolCleanup();
  for (const g of GROUPS) {
    if (g.tools.some((t) => t.id === toolId)) { state.activeTab = g.id; break; }
  }
  state.activeTool = toolId;
  state.pendingToolOptions = options;
  renderTabs();
  renderQuickActions();
  applyQuickRowVisibility();

  content.replaceChildren();
  const view = el("section", { className: "tool-view" });
  const header = el("div", { className: "tool-header" });
  const back = el("button", { type: "button", className: "back", textContent: "←" });
  back.addEventListener("click", closeTool);
  state.panelTitle = el("h3");
  header.append(back, state.panelTitle);
  state.panelBody = el("div", { className: "tool-body" });
  view.append(header, state.panelBody);
  content.append(view);

  renderer();
  state.pendingToolOptions = null;
}

function closeTool() {
  runToolCleanup();
  state.activeTool = null;
  state.panelTitle = null;
  state.panelBody = null;
  renderQuickActions();
  applyQuickRowVisibility();
  renderToolList();
}

























const NOTES_TOOLS = new Set(["scratchpad", "todos", "bookmarks"]);



// --- Playlists Tool -----------------------------------------------------











// --- Bookmarks Tool -----------------------------------------------------

// Bookmarks-State (über Re-Render hinweg, weil filter+search lokal sind)






// Scraped YouTube-Metadaten aus einem konkreten Tab. Inline-Variante von
// extension/tools/youtube_meta.js — Sidepanel-Module-Imports sind Setup-
// Aufwand, deshalb hier dupliziert.










// ── Sprint 3: Web-Tools ──────────────────────────────────────────────────────






// ── URL-Extraktor ────────────────────────────────────────────────────────────


// ── Image-Generator (Gemini Nano Banana) ─────────────────────────────────────






// ── Guten-Morgen-Briefing ────────────────────────────────────────────────────














// ── YouTube Auto-Brain Modal ─────────────────────────────────────────────────



// ── YouTube-Hint im Header ───────────────────────────────────────────────────




chrome.tabs.onActivated.addListener(() => {
  checkActiveTabForYoutube();
  if (state._chatPageModeScrape) state._chatPageModeScrape();
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete" || !state._chatPageModeScrape) return;
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.id === tabId) state._chatPageModeScrape();
  });
});

// --- Dokument-Ingest ---

