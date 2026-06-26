// Navigation (Tabs, Tool-Liste) + Quick-Actions. ewtos.com
import { el } from '../dom.js';
import { state } from '../state.js';
import { content, quickActions, navSidebarMain, viewCrumb } from './dom-refs.js';
import { openTool } from './tool-runner.js';
import { showBriefingPanel, showQuickSavePage } from '../renderers/briefing.js';

export const GROUPS = [
  {
    id: "chat",
    label: "Chat",
    icon: "💬",
    sub: "Mit Vault oder aktiver Seite reden",
    tools: [
      { id: "chat", label: "Chat mit Vault", hint: "Fragen an den Vault (Karpathy-Methode)", icon: "📚" },
      { id: "chat_web", label: "Chat mit Seite", hint: "Mit dem Inhalt des aktiven Tabs chatten", icon: "🌐", openOptions: { startMode: "page" } },
    ],
  },
  {
    id: "notes",
    label: "Notizen",
    icon: "📝",
    sub: "Dein App-eigener Schreibtisch",
    tools: [
      { id: "scratchpad", label: "Note-Taker", hint: "globaler Scratchpad", icon: "📝" },
      { id: "todos",      label: "Todos",      hint: "klickbare Liste mit Due-Dates", icon: "✅" },
      { id: "bookmarks",  label: "Bookmarks",  hint: "URL-Inbox aus Browser-Capture", icon: "🔖",
        actions: [
          { label: "Neuen Bookmark", icon: "+", action: "add" },
          { label: "Markierte Tabs erfassen", icon: "⇲", action: "capture_tabs" },
          { label: "URLs der Tabs kopieren", icon: "⧉", action: "copy_urls" },
        ],
      },
    ],
  },
  {
    id: "vault",
    label: "Vault",
    icon: "📚",
    sub: "Das Wissens-Dateisystem",
    tools: [
      { id: "vault_explorer",  label: "Explorer",         hint: "Vault durchblättern, Dateien lesen, mit ihnen chatten", icon: "📚" },
      { id: "ingest_document", label: "Dokument-Ingest",  hint: "PDF, TXT oder Markdown in raw/ ablegen", icon: "📥" },
      { id: "vault_health",    label: "Vault-Gesundheit", hint: "Audit: Orphans, Links, Frontmatter, CLAUDE.md", icon: "🩺" },
    ],
  },
  {
    id: "video",
    label: "Video",
    icon: "🎬",
    sub: "YouTube & gesammelte Playlists",
    tools: [
      { id: "youtube_transcript", label: "YouTube-Transcript", hint: "Transkript aus aktivem Tab", icon: "🎬" },
      { id: "playlists",          label: "Playlists",          hint: "Video-Sammlungen (Thema im Frontmatter)", icon: "🎵" },
    ],
  },
  {
    id: "web",
    label: "Web",
    icon: "🌐",
    sub: "Tools für die aktuelle Webseite",
    tools: [
      { id: "page_scrape", label: "Page-Scrape", hint: "Aktiver Tab → bereinigtes Markdown", icon: "📄",
        actions: [
          { label: "Nur Inhalt scrapen", icon: "▸", action: "scrape_content" },
          { label: "Komplette Seite scrapen", icon: "▸", action: "scrape_full" },
        ],
      },
      { id: "seo_check",     label: "SEO-Check",     hint: "Title, Meta, Headings, OG-Tags", icon: "🔍" },
      { id: "url_extractor", label: "URL-Extraktor", hint: "Alle Links der aktuellen Seite", icon: "🔗" },
    ],
  },
  {
    id: "bilder",
    label: "Bilder",
    icon: "🎨",
    sub: "Analyse, Generierung, Farben, Screenshots",
    tools: [
      { id: "image_analyse",   label: "Image-Analyse", hint: "Bilder + Alt-Text-Check", icon: "🖼️" },
      { id: "image_generator", label: "Image-Gen",     hint: "Bild erzeugen + editieren (Gemini Nano)", icon: "🪄" },
      { id: "color_picker",    label: "Color-Picker",  hint: "CSS-Variablen + Farbpalette", icon: "🎨" },
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

export const QUICK_SPECIAL = {
  _briefing:   { label: "Briefing",    icon: "☀", run: () => showBriefingPanel() },
  _save_page:  { label: "Ins Vault",   icon: "📥", run: () => showQuickSavePage() },
};

export const DEFAULT_QUICK_SLOTS = ["vault_explorer", "scratchpad", "todos", "_briefing", "_save_page"];

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
  const change = el("button", { type: "button", textContent: "Bearbeiten…" });
  const remove = el("button", { type: "button", textContent: "Entfernen" });
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
  const title = el("span", { className: "title", textContent: "Favoriten-Buttons bearbeiten" });
  const closeBtn = el("button", { type: "button", className: "close", textContent: "✕" });
  closeBtn.addEventListener("click", () => editor.remove());
  head.append(title, closeBtn);

  const slotsRow = el("div", { className: "quick-editor-slots" });
  const picker = el("div", { className: "quick-editor-picker" });

  function renderSlotsRow() {
    slotsRow.replaceChildren();
    if (state.quickSlots.length === 0) {
      slotsRow.append(el("span", { className: "qe-empty", textContent: "Noch keine Favoriten — unten ein Tool wählen." }));
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
    textContent: "Tool anklicken = hinzufügen · Favorit oben anklicken = entfernen",
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
  const g = GROUPS.find((x) => x.id === state.activeTab);
  viewCrumb.textContent = g ? " / " + g.label : "";
}

export function renderSidebar() {
  navSidebarMain.replaceChildren();
  const items = [{ id: "all", label: "Alles", icon: "▦" }, ...GROUPS];
  for (const it of items) {
    const b = el("button", {
      type: "button",
      title: it.label,
      textContent: it.icon,
      className: "nav-item" + (it.id === state.activeTab ? " active" : ""),
    });
    b.addEventListener("click", () => {
      state.activeTab = it.id;
      state.activeTool = null;
      renderSidebar();
      renderToolList();
      applyQuickRowVisibility();
      updateCrumb();
    });
    navSidebarMain.append(b);
  }
}

function buildToolRow(t) {
  const hasActions = Array.isArray(t.actions) && t.actions.length > 0;
  const li = el("li", { className: "tool-row" });
  li.append(el("span", { className: "tr-ico", textContent: t.icon || "•" }));
  const txt = el("span", { className: "tr-txt" });
  txt.append(el("span", { className: "tr-label", textContent: t.label }));
  if (t.hint) txt.append(el("span", { className: "tr-hint", textContent: t.hint }));
  li.append(txt);
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

export function renderToolList() {
  content.replaceChildren();

  const q = (state.searchQuery || "").trim().toLowerCase();
  if (q) {
    const results = el("ul", { className: "tools" });
    const matches = [];
    for (const g of GROUPS) {
      for (const t of g.tools) {
        const hay = `${t.label} ${t.hint || ""} ${g.label}`.toLowerCase();
        if (hay.includes(q)) matches.push(t);
      }
    }
    if (matches.length === 0) {
      results.append(el("li", { className: "search-empty", textContent: `Keine Treffer für „${state.searchQuery.trim()}"` }));
    } else {
      for (const t of matches) results.append(buildToolRow(t));
    }
    content.append(results);
    return;
  }

  const list = el("ul", { className: "tools" });

  if (state.activeTab === "all") {
    for (const g of GROUPS) {
      const sec = el("li", { className: "tool-sec" });
      sec.append(el("span", { className: "ts-ico", textContent: g.icon }));
      sec.append(el("span", { className: "ts-label", textContent: g.label }));
      list.append(sec);
      for (const t of g.tools) list.append(buildToolRow(t));
    }
  } else {
    const group = GROUPS.find((g) => g.id === state.activeTab);
    if (!group) return;
    const head = el("li", { className: "group-head" });
    const title = el("span", { className: "gh-title" });
    title.append(el("span", { className: "gh-ico", textContent: group.icon }));
    title.append(el("span", { className: "gh-label", textContent: group.label }));
    head.append(title);
    if (group.sub) head.append(el("span", { className: "gh-sub", textContent: group.sub }));
    list.append(head);
    for (const t of group.tools) list.append(buildToolRow(t));
  }
  content.append(list);
}
