// Navigation (Tabs, Tool-Liste) + Quick-Actions. ewtos.com
import { el } from '../dom.js';
import { state } from '../state.js';
import { content, quickActions, tabsNav } from './dom-refs.js';
import { openTool } from '../sidepanel.js';
import { showBriefingPanel, showQuickSavePage } from '../renderers/briefing.js';

export const GROUPS = [
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

export const QUICK_SPECIAL = {
  _briefing:   { label: "Briefing",    icon: "☀", run: () => showBriefingPanel() },
  _save_page:  { label: "Ins Vault",   icon: "📥", run: () => showQuickSavePage() },
};

export const DEFAULT_QUICK_SLOTS = ["vault_explorer", "scratchpad", "todos", "_briefing", "_save_page"];

export const QUICK_SLOT_COUNT = 5;

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

async function setViewMode(mode) {
  if (state.toolViewMode === mode) return;
  state.toolViewMode = mode;
  await chrome.storage.local.set({ toolViewMode: state.toolViewMode });
  renderTabs();
  if (!state.activeTool) renderToolList();
}

export function renderQuickActions() {
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

export function openQuickEditor(targetIdx) {
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

export async function loadQuickRowPref() {
  const { hideQuickRowOnTool: pref } = await chrome.storage.local.get("hideQuickRowOnTool");
  state.hideQuickRowOnTool = !!pref;
  applyQuickRowVisibility();
}

export function applyQuickRowVisibility() {
  if (state.hideQuickRowOnTool && state.activeTool) quickActions.classList.add("hidden");
  else quickActions.classList.remove("hidden");
}

export function renderTabs() {
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

export function renderToolList() {
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
