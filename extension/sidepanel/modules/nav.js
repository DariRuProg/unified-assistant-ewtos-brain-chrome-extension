// Navigation (Tabs, Tool-Liste) + Quick-Actions. ewtos.com
import { el } from '../dom.js';
import { state } from '../state.js';
import { content, quickActions, navSidebarMain, viewCrumb } from './dom-refs.js';
import { openTool } from './tool-runner.js';
import { openWorkspaceTab } from './workspace-tab.js';
import { showBriefingPanel, showQuickSavePage } from '../renderers/briefing.js';
import { t } from '../../i18n/i18n.js';

// Tools, die rein clientseitig laufen (direkter background.js-Pfad, kein Server nötig).
// Alles andere gilt konservativ als server-abhängig → "Server"-Badge, wenn offline.
export const OFFLINE_TOOLS = new Set([
  "page_scrape", "seo_check", "url_extractor",
  "image_analyse", "color_picker", "screenshot", "youtube_transcript",
]);
export const toolNeedsServer = (id) => !OFFLINE_TOOLS.has(id);

export function getGroups() {
  return [
  {
    id: "vault",
    label: t("nav.vault"),
    icon: "📚",
    sub: t("nav.vault_sub"),
    tools: [
      { id: "vault_explorer",  label: t("nav.vault_explorer"),  hint: t("nav.vault_explorer_hint"), icon: "📚" },
      { id: "crm",             label: t("nav.crm"),             hint: t("nav.crm_hint"), icon: "🤝" },
      { id: "ingest_document", label: t("nav.ingest_document"), hint: t("nav.ingest_document_hint"), icon: "📥" },
      { id: "vault_health",    label: t("nav.vault_health"),    hint: t("nav.vault_health_hint"), icon: "🩺" },
      { id: "scratchpad",      label: t("nav.scratchpad"),      hint: t("nav.scratchpad_hint"), icon: "📝" },
      { id: "todos",           label: t("nav.todos"),           hint: t("nav.todos_hint"), icon: "✅" },
    ],
  },
  {
    id: "web",
    label: t("nav.web"),
    icon: "🌐",
    sub: t("nav.web_sub"),
    tools: [
      { id: "page_scrape",   label: t("nav.page_scrape"),    hint: t("nav.page_scrape_hint"), icon: "📄",
        actions: [
          { label: t("nav.scrape_content_only"), icon: "▸", action: "scrape_content" },
          { label: t("nav.scrape_full_page"), icon: "▸", action: "scrape_full" },
        ],
      },
      { id: "seo_check",     label: t("nav.seo_check"),     hint: t("nav.seo_check_hint"), icon: "🔍" },
      { id: "url_extractor", label: t("nav.url_extractor"), hint: t("nav.url_extractor_hint"), icon: "🔗" },
      { id: "bookmarks",     label: t("nav.bookmarks"),     hint: t("nav.bookmarks_hint"), icon: "🔖",
        actions: [
          { label: t("nav.add_bookmark"), icon: "+", action: "add" },
          { label: t("nav.capture_tabs"), icon: "⇲", action: "capture_tabs" },
          { label: t("nav.copy_urls"), icon: "⧉", action: "copy_urls" },
        ],
      },
    ],
  },
  {
    id: "video",
    label: t("nav.video"),
    icon: "🎬",
    sub: t("nav.video_sub"),
    tools: [
      { id: "youtube_transcript", label: t("nav.youtube_transcript"), hint: t("nav.youtube_transcript_hint"), icon: "🎬" },
      { id: "playlists",          label: t("nav.playlists"),          hint: t("nav.playlists_hint"), icon: "🎵" },
    ],
  },
  {
    id: "bilder",
    label: t("nav.images"),
    icon: "🎨",
    sub: t("nav.images_sub"),
    tools: [
      { id: "image_analyse",   label: t("nav.image_analyse"),   hint: t("nav.image_analyse_hint"), icon: "🖼️" },
      { id: "image_generator", label: t("nav.image_gen"),       hint: t("nav.image_gen_hint"), icon: "🪄" },
      { id: "color_picker",    label: t("nav.color_picker"),    hint: t("nav.color_picker_hint"), icon: "🎨" },
      { id: "screenshot", label: t("nav.screenshot"), hint: t("nav.screenshot_hint"), icon: "📸",
        actions: [
          { label: t("nav.shot_visible"), icon: "▸", action: "shot_visible" },
          { label: t("nav.shot_area"), icon: "▸", action: "shot_area" },
          { label: t("nav.shot_full"), icon: "▸", action: "shot_full" },
        ],
      },
    ],
  },
  // navOnly: erscheint als Icon in der Sidebar, öffnet das Tool direkt statt zu filtern.
  { id: "chat", label: t("nav.chat"), icon: "💬", navOnly: true, tools: [] },
  ];
}

export function getQuickSpecial() {
  return {
    _briefing:   { label: t("nav.briefing"),    icon: "☀", run: () => showBriefingPanel() },
    _save_page:  { label: t("nav.save_to_vault"), icon: "📥", run: () => showQuickSavePage() },
  };
}

// _briefing bewusst NICHT im Default — fürs MVP versteckt. Bleibt via getQuickSpecial()
// manuell als Favorit hinzufügbar und per Eintrag hier sofort reaktivierbar.
export const DEFAULT_QUICK_SLOTS = ["vault_explorer", "scratchpad", "todos", "_save_page"];

function getQuickOption(id) {
  if (!id) return null;
  const special = getQuickSpecial();
  if (special[id]) {
    return { id, label: special[id].label, icon: special[id].icon, special: true };
  }
  for (const g of getGroups()) {
    const tool = g.tools.find((x) => !x.separator && x.id === id);
    if (tool) return { id: tool.id, label: tool.label, icon: tool.icon || "•", special: false };
  }
  return null;
}

function getAllQuickOptions() {
  const opts = [];
  for (const [id, meta] of Object.entries(getQuickSpecial())) {
    opts.push({ id, label: meta.label, icon: meta.icon, special: true });
  }
  for (const g of getGroups()) {
    for (const tool of g.tools) {
      if (tool.separator || tool.soon) continue;
      opts.push({ id: tool.id, label: tool.label, icon: tool.icon || "•", group: g.label });
    }
  }
  return opts;
}

function runQuickSlot(id) {
  const special = getQuickSpecial();
  if (special[id]) return special[id].run();
  openTool(id);
}

export function renderQuickActions() {
  quickActions.replaceChildren();

  const row = el("div", { className: "quick-row" });

  state.quickSlots.forEach((slotId, idx) => {
    const opt = getQuickOption(slotId);
    if (!opt) return;
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
}

async function saveQuickSlots() {
  await chrome.storage.local.set({ quickSlots: state.quickSlots });
  renderQuickActions();
}

function openSlotContextMenu(x, y, idx) {
  document.querySelectorAll(".slot-context-menu").forEach((m) => m.remove());
  const menu = el("div", { className: "slot-context-menu" });
  const change = el("button", { type: "button", textContent: t("nav.edit_slot") });
  const remove = el("button", { type: "button", textContent: t("nav.remove_slot") });
  change.addEventListener("click", () => { menu.remove(); openQuickEditor(); });
  remove.addEventListener("click", async () => {
    menu.remove();
    state.quickSlots.splice(idx, 1);
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

export function openQuickEditor() {
  document.querySelectorAll(".quick-editor").forEach((e) => e.remove());
  const editor = el("div", { className: "quick-editor" });
  const head = el("div", { className: "quick-editor-head" });
  const title = el("span", { className: "title", textContent: t("nav.favorites_editor_title") });
  const closeBtn = el("button", { type: "button", className: "close", textContent: "✕" });
  closeBtn.addEventListener("click", () => editor.remove());
  head.append(title, closeBtn);

  const slotsRow = el("div", { className: "quick-editor-slots" });
  const picker = el("div", { className: "quick-editor-picker" });

  function renderSlotsRow() {
    slotsRow.replaceChildren();
    if (state.quickSlots.length === 0) {
      slotsRow.append(el("span", { className: "qe-empty", textContent: t("nav.favorites_empty") }));
      return;
    }
    state.quickSlots.forEach((slotId, idx) => {
      const opt = getQuickOption(slotId);
      if (!opt) return;
      const slot = el("button", { type: "button", className: "qe-slot", title: `${opt.label} entfernen` });
      slot.append(el("span", { className: "ico", textContent: opt.icon }));
      slot.append(el("span", { className: "lbl", textContent: opt.label }));
      slot.addEventListener("click", async () => {
        state.quickSlots.splice(idx, 1);
        await saveQuickSlots();
        renderSlotsRow();
        renderPicker();
      });
      slotsRow.append(slot);
    });
  }

  function renderPicker() {
    picker.replaceChildren();
    const used = new Set(state.quickSlots.filter(Boolean));
    for (const opt of getAllQuickOptions()) {
      const item = el("button", { type: "button", className: "qe-pick" + (used.has(opt.id) ? " used" : "") });
      item.append(el("span", { className: "ico", textContent: opt.icon }));
      item.append(el("span", { className: "lbl", textContent: opt.label }));
      if (opt.group) item.append(el("span", { className: "grp", textContent: opt.group }));
      item.addEventListener("click", async () => {
        if (used.has(opt.id)) return;
        state.quickSlots.push(opt.id);
        await saveQuickSlots();
        renderSlotsRow();
        renderPicker();
      });
      picker.append(item);
    }
  }

  renderSlotsRow();
  renderPicker();

  const hint = el("div", { className: "qe-hint",
    textContent: t("nav.favorites_hint"),
  });

  editor.append(head, slotsRow, hint, picker);
  quickActions.after(editor);
}

export function applyQuickRowVisibility() {
  const searching = !!(state.searchQuery || "").trim();
  const show = state.showQuickRow && state.activeTab === "all" && !state.activeTool && !searching;
  quickActions.classList.toggle("hidden", !show);
}

export function updateCrumb() {
  if (!viewCrumb) return;
  if (state.activeTool || state.activeTab === "all") { viewCrumb.textContent = ""; return; }
  const g = getGroups().find((x) => x.id === state.activeTab);
  viewCrumb.textContent = g ? " / " + g.label : "";
}

// Öffnet einen Workspace-Tab für Vault/Datei/Allgemein-Chat.
// vault_id kommt aus chrome.storage (selectedVaultId); rel_path ist ein sinnvoller Fallback.
async function openChatTab(chatMode) {
  let vaultId = "";
  let relPath = "inbox/scratchpad.md";
  try {
    const stored = await chrome.storage.local.get(["selectedVaultId", "chatScratchpadPath"]);
    vaultId = stored.selectedVaultId || "";
    if (stored.chatScratchpadPath) relPath = stored.chatScratchpadPath;
  } catch (_) {}

  if (!vaultId) {
    // Kein Vault konfiguriert — zum Panel-Chat (zeigt "kein Vault" hint)
    openTool("chat");
    return;
  }

  openWorkspaceTab(vaultId, relPath, { chatMode });
}

// Chat-Chooser-Popover am 💬-Icon in der Nav-Rail.
function openChatChooser(anchorBtn) {
  // Schließe existierende Chooser
  document.querySelectorAll(".chat-chooser").forEach((m) => m.remove());

  const menu = el("div", { className: "chat-chooser" });

  const options = [
    { mode: "page",    icon: "🌐", label: t("nav.chat_page"),    hint: t("nav.chat_page_hint"),    where: "panel" },
    { mode: "vault",   icon: "📚", label: t("nav.chat_vault"),   hint: t("nav.chat_vault_hint"),   where: "tab" },
    { mode: "file",    icon: "📄", label: t("nav.chat_file"),    hint: t("nav.chat_file_hint"),    where: "tab" },
    { mode: "general", icon: "✦",  label: t("nav.chat_general"), hint: t("nav.chat_general_hint"), where: "tab", isNew: true },
  ];

  for (const opt of options) {
    const btn = el("button", { type: "button", className: "chat-chooser-item" });
    const ico = el("span", { className: "cci-ico", textContent: opt.icon });
    const txt = el("span", { className: "cci-txt" });
    const lbl = el("span", { className: "cci-label" });
    lbl.textContent = opt.label;
    if (opt.isNew) {
      const badge = el("span", { className: "cci-new", textContent: t("nav.chat_new_badge") });
      lbl.append(badge);
    }
    const hint = el("span", { className: "cci-hint", textContent: opt.hint });
    txt.append(lbl, hint);
    const where = el("span", { className: `cci-where cci-where--${opt.where}`, textContent: opt.where === "panel" ? t("nav.chat_where_panel") : t("nav.chat_where_tab") });
    btn.append(ico, txt, where);
    btn.addEventListener("click", () => {
      menu.remove();
      if (opt.mode === "page") {
        openTool("chat", { startMode: "page" });
      } else if (opt.mode === "file") {
        openTool("vault_explorer");
      } else {
        openChatTab(opt.mode);
      }
    });
    menu.append(btn);
  }

  document.body.append(menu);

  // Rail liegt rechts → Menu links vom Button positionieren, mit Viewport-Clamping
  const rect = anchorBtn.getBoundingClientRect();
  const menuW = menu.offsetWidth || 244;
  const menuH = menu.offsetHeight || 160;
  menu.style.left = `${Math.max(8, rect.left - menuW - 4)}px`;
  menu.style.top  = `${Math.min(rect.top, window.innerHeight - menuH - 8)}px`;

  // Schließen bei Klick außerhalb
  const close = (e) => {
    if (menu.contains(e.target) || e.target === anchorBtn) return;
    menu.remove();
    document.removeEventListener("click", close, true);
  };
  setTimeout(() => document.addEventListener("click", close, true), 0);
}

export function renderSidebar() {
  navSidebarMain.replaceChildren();
  const items = [{ id: "all", label: t("nav.all"), icon: "▦" }, ...getGroups()];
  for (const it of items) {
    const b = el("button", {
      type: "button",
      title: it.label,
      textContent: it.icon,
      className: "nav-item" + (it.id === state.activeTab ? " active" : ""),
    });
    if (it.navOnly) {
      b.addEventListener("click", (e) => { e.stopPropagation(); openChatChooser(b); });
    } else {
      b.addEventListener("click", () => {
        state.activeTab = it.id;
        state.activeTool = null;
        renderSidebar();
        renderToolList();
        applyQuickRowVisibility();
        updateCrumb();
      });
    }
    navSidebarMain.append(b);
  }
}

// Markiert server-abhängige Tools offline mit Dim-Klasse + orangem "Server"-Badge.
function applyServerBadge(li, tool) {
  if (!(toolNeedsServer(tool.id) && state.serverConnected === false)) return;
  const base = li.classList.contains("tool-tile") ? "tool-tile" : "tool-row";
  li.classList.add(base + "--needs-server");
  li.dataset.tool = tool.id;
  li.title = t("nav.needs_server_title");
  li.append(el("span", { className: "tool-badge tool-badge--server", textContent: t("nav.needs_server_badge") }));
}

function buildToolTile(t) {
  const li = el("li", { className: "tool-tile" });
  li.append(el("span", { className: "tr-ico", textContent: t.icon || "•" }));
  li.append(el("span", { className: "tr-label", textContent: t.label }));
  applyServerBadge(li, t);
  li.addEventListener("click", () => openTool(t.id, t.openOptions || null));
  return li;
}

function buildToolRow(t) {
  const hasActions = Array.isArray(t.actions) && t.actions.length > 0;
  const li = el("li", { className: "tool-row" });
  li.append(el("span", { className: "tr-ico", textContent: t.icon || "•" }));
  const txt = el("span", { className: "tr-txt" });
  txt.append(el("span", { className: "tr-label", textContent: t.label }));
  if (t.hint) txt.append(el("span", { className: "tr-hint", textContent: t.hint }));
  li.append(txt);
  applyServerBadge(li, t);
  li.addEventListener("click", (e) => {
    if (e.target.closest(".tool-caret, .tool-popover")) return;
    openTool(t.id, t.openOptions || null);
  });
  if (!hasActions) {
    li.append(el("span", { className: "tr-caret", textContent: "›" }));
    return li;
  }
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
  return li;
}

export function setToolViewMode(mode) {
  state.toolViewMode = mode;
  chrome.storage.local.set({ toolViewMode: mode });
  renderToolList();
}

export function renderToolList() {
  content.replaceChildren();

  const mode = state.toolViewMode;
  const isTile = mode === "tile";
  const isFlat = mode === "tile-flat";
  const buildRow = (isTile || isFlat) ? buildToolTile : buildToolRow;
  const listClass = "tools" + ((isTile || isFlat) ? " tools--tiles" : "");

  const q = (state.searchQuery || "").trim().toLowerCase();
  if (q) {
    const results = el("ul", { className: listClass });
    const matches = [];
    for (const g of getGroups()) {
      if (g.navOnly) continue;
      for (const tool of g.tools) {
        const hay = `${tool.label} ${tool.hint || ""} ${g.label}`.toLowerCase();
        if (hay.includes(q)) matches.push(tool);
      }
    }
    if (matches.length === 0) {
      results.append(el("li", { className: "search-empty", textContent: t("nav.no_results", { query: state.searchQuery.trim() }) }));
    } else {
      for (const tool of matches) results.append(buildRow(tool));
    }
    content.append(results);
    return;
  }

  const list = el("ul", { className: listClass });

  if (state.activeTab === "all") {
    for (const g of getGroups()) {
      if (g.navOnly) continue;
      if (!isFlat) {
        const sec = el("li", { className: "tool-sec" });
        sec.append(el("span", { className: "ts-ico", textContent: g.icon }));
        sec.append(el("span", { className: "ts-label", textContent: g.label }));
        list.append(sec);
      }
      for (const tool of g.tools) list.append(buildRow(tool));
    }
  } else {
    const group = getGroups().find((g) => g.id === state.activeTab);
    if (!group || group.navOnly) return;
    if (!isFlat) {
      const head = el("li", { className: "group-head" });
      const title = el("span", { className: "gh-title" });
      title.append(el("span", { className: "gh-ico", textContent: group.icon }));
      title.append(el("span", { className: "gh-label", textContent: group.label }));
      head.append(title);
      if (group.sub) head.append(el("span", { className: "gh-sub", textContent: group.sub }));
      list.append(head);
    }
    for (const tool of group.tools) list.append(buildRow(tool));
  }
  content.append(list);
}
