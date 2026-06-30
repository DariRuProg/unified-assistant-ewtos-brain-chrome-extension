// Bookmarks-Tool Renderer. ewtos.com
import { el, makeYouTubeThumb } from '../dom.js';
import { state } from '../state.js';
import { getHttpBase, getActiveVault, getActiveVaultId, withVaultId } from '../modules/api.js';
import { captureHighlightedTabs, copyHighlightedTabUrls } from './playlists.js';
import { t } from '../../i18n/i18n.js';

let bookmarksState = { all: [], search: "", activeTag: null, view: "tiles", collapsed: {} };

// Favicon über den Google-Favicon-Service (CSP erlaubt https:). Kein eigener Speicher.
function faviconUrl(url) {
  try {
    const host = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
  } catch { return null; }
}

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

export async function renderBookmarksTool() {
  state.panelTitle.textContent = t("bookmarks.title");
  state.panelBody.replaceChildren();
  const pendingAction = state.pendingToolOptions?.action;

  const vaultHint = el("div", { className: "notes-vault-hint" });
  const toolbar = el("div", { className: "playlist-toolbar" });
  const addBtn = el("button", { type: "button", textContent: t("bookmarks.add") });
  const captureTabsBtn = el("button", {
    type: "button",
    textContent: t("bookmarks.capture_tabs"),
    title: t("bookmarks.capture_tabs_title"),
  });
  const copyUrlsBtn = el("button", {
    type: "button",
    textContent: t("bookmarks.copy_urls"),
    title: t("bookmarks.copy_urls_title"),
  });
  toolbar.append(addBtn, captureTabsBtn, copyUrlsBtn);
  const status = el("div", { className: "tool-status" });
  const searchWrap = el("div", { className: "bookmark-search" });
  const searchInput = el("input", { type: "search", placeholder: t("bookmarks.search_placeholder"), value: bookmarksState.search });
  searchWrap.append(searchInput);

  const viewSwitch = el("div", { className: "bookmark-viewswitch" });
  const VIEW_MODES = [
    ["tiles", t("bookmarks.view_tiles")],
    ["list", t("bookmarks.view_list")],
    ["groups", t("bookmarks.view_groups")],
  ];
  const viewBtns = {};
  for (const [mode, label] of VIEW_MODES) {
    const b = el("button", { type: "button", className: "bookmark-viewbtn", textContent: label });
    viewBtns[mode] = b;
    viewSwitch.append(b);
  }
  const tagCloud = el("div", { className: "tag-cloud" });
  const listWrap = el("div", { className: "bookmark-list" });
  state.panelBody.append(vaultHint, toolbar, searchWrap, viewSwitch, tagCloud, status, listWrap);

  try {
    const stored = await chrome.storage.local.get("bookmarkViewMode");
    if (stored.bookmarkViewMode) bookmarksState.view = stored.bookmarkViewMode;
  } catch (_) {}
  function syncViewButtons() {
    for (const [mode] of VIEW_MODES) viewBtns[mode].classList.toggle("active", bookmarksState.view === mode);
  }
  syncViewButtons();

  const httpBase = await getHttpBase();
  const vaultId = await getActiveVaultId(httpBase);
  const vault = await getActiveVault(httpBase);
  vaultHint.textContent = vault ? t("notes.vault_hint", { name: vault.name }) : t("notes.no_vault_active");
  addBtn.addEventListener("click", () => showAddBookmarkDialog(httpBase, vaultId, () => renderBookmarksTool()));
  captureTabsBtn.addEventListener("click", () => captureHighlightedTabs(httpBase, vaultId, captureTabsBtn, () => renderBookmarksTool()));
  copyUrlsBtn.addEventListener("click", () => copyHighlightedTabUrls(copyUrlsBtn));

  if (pendingAction === "add") addBtn.click();
  else if (pendingAction === "capture_tabs") captureTabsBtn.click();
  else if (pendingAction === "copy_urls") copyUrlsBtn.click();

  status.textContent = t("common.loading");
  try {
    const res = await fetch(withVaultId(`${httpBase}/tools/bookmarks`, vaultId));
    if (!res.ok) {
      status.textContent = t("bookmarks.error_status", { status: res.status });
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
      if (bookmarksState.view === "tiles") renderBookmarksTiles(httpBase, vaultId, listWrap, filtered);
      else if (bookmarksState.view === "groups") renderBookmarksGroups(httpBase, vaultId, listWrap, filtered);
      else renderBookmarksList(httpBase, vaultId, listWrap, filtered);
    }

    for (const [mode] of VIEW_MODES) {
      viewBtns[mode].addEventListener("click", async () => {
        if (bookmarksState.view === mode) return;
        bookmarksState.view = mode;
        syncViewButtons();
        try { await chrome.storage.local.set({ bookmarkViewMode: mode }); } catch (_) {}
        applyFilters();
      });
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
      listWrap.append(el("div", { className: "empty", textContent: t("bookmarks.empty") }));
      return;
    }
    applyFilters();
  } catch (err) {
    status.textContent = t("common.error_msg", { message: err.message || err });
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
    const clear = el("button", { type: "button", textContent: t("bookmarks.clear_filter"), className: "tag-pill clear" });
    clear.addEventListener("click", () => onTagClick(bookmarksState.activeTag));
    target.append(clear);
  }
}

function renderBookmarksList(httpBase, vaultId, target, items) {
  target.replaceChildren();
  if (!items.length) {
    target.append(el("div", { className: "empty", textContent: t("bookmarks.no_match") }));
    return;
  }
  // Group by first thema
  const untaggedLabel = t("bookmarks.untagged");
  const groups = {};
  for (const b of items) {
    const key = (b.themen && b.themen[0]) || untaggedLabel;
    if (!groups[key]) groups[key] = [];
    groups[key].push(b);
  }
  const sortedKeys = Object.keys(groups).sort((a, b) => {
    if (a === untaggedLabel) return 1;
    if (b === untaggedLabel) return -1;
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

// Gruppiert nach erstem Thema; untagged ans Ende.
function groupByThema(items) {
  const untaggedLabel = t("bookmarks.untagged");
  const groups = {};
  for (const b of items) {
    const key = (b.themen && b.themen[0]) || untaggedLabel;
    (groups[key] = groups[key] || []).push(b);
  }
  const keys = Object.keys(groups).sort((a, b) => {
    if (a === untaggedLabel) return 1;
    if (b === untaggedLabel) return -1;
    return a.localeCompare(b);
  });
  return { groups, keys };
}

function renderBookmarksTiles(httpBase, vaultId, target, items) {
  target.replaceChildren();
  if (!items.length) {
    target.append(el("div", { className: "empty", textContent: t("bookmarks.no_match") }));
    return;
  }
  const grid = el("div", { className: "bookmark-grid" });
  for (const b of items) grid.append(renderBookmarkTile(httpBase, vaultId, b));
  target.append(grid);
}

function renderBookmarksGroups(httpBase, vaultId, target, items) {
  target.replaceChildren();
  if (!items.length) {
    target.append(el("div", { className: "empty", textContent: t("bookmarks.no_match") }));
    return;
  }
  const { groups, keys } = groupByThema(items);
  for (const key of keys) {
    const collapsed = bookmarksState.collapsed[key] !== false; // default: zusammengeklappt
    const section = el("div", { className: "bookmark-accordion" + (collapsed ? " collapsed" : "") });
    const header = el("button", {
      type: "button",
      className: "bookmark-accordion-head",
      textContent: `${collapsed ? "▸" : "▾"} ${key} (${groups[key].length})`,
    });
    const grid = el("div", { className: "bookmark-grid" });
    if (collapsed) grid.style.display = "none";
    else for (const b of groups[key]) grid.append(renderBookmarkTile(httpBase, vaultId, b));
    header.addEventListener("click", () => {
      const now = !(bookmarksState.collapsed[key] !== false);
      bookmarksState.collapsed[key] = now;
      section.classList.toggle("collapsed", now);
      header.textContent = `${now ? "▸" : "▾"} ${key} (${groups[key].length})`;
      if (now) { grid.style.display = "none"; grid.replaceChildren(); }
      else { grid.style.display = ""; for (const b of groups[key]) grid.append(renderBookmarkTile(httpBase, vaultId, b)); }
    });
    section.append(header, grid);
    target.append(section);
  }
}

function renderBookmarkTile(httpBase, vaultId, b) {
  const tile = el("div", { className: "bookmark-tile" });
  const link = el("a", { className: "bookmark-tile-link", href: b.url, target: "_blank" });
  link.rel = "noopener noreferrer";

  const thumbBox = el("div", { className: "bookmark-tile-thumb" });
  const ytThumb = makeYouTubeThumb(b.url);
  if (ytThumb) {
    thumbBox.append(ytThumb);
  } else {
    const fav = faviconUrl(b.url);
    if (fav) {
      const img = el("img", { className: "bookmark-favicon", src: fav, alt: "", loading: "lazy" });
      img.addEventListener("error", () => { img.style.display = "none"; });
      thumbBox.append(img);
    }
  }
  link.append(thumbBox);

  const info = el("div", { className: "bookmark-tile-info" });
  info.append(el("div", { className: "bookmark-tile-title", textContent: b.title || b.url }));
  const sub = el("div", { className: "bookmark-tile-sub" });
  sub.append(el("span", { className: "bookmark-tile-host", textContent: hostnameOf(b.url) }));
  if (b.date) sub.append(el("span", { className: "bookmark-date", textContent: b.date }));
  info.append(sub);
  if (b.themen && b.themen.length) {
    info.append(el("div", { className: "bookmark-tile-tags", textContent: b.themen.map((x) => `#${x}`).join(" ") }));
  }
  link.append(info);
  tile.append(link);

  const actions = el("div", { className: "bookmark-tile-actions" });
  const editBtn = el("button", { type: "button", textContent: "✎", className: "small", title: t("bookmarks.edit_title") });
  editBtn.addEventListener("click", () => showEditBookmarkDialog(httpBase, vaultId, b, () => renderBookmarksTool()));
  const delBtn = el("button", { type: "button", textContent: "🗑", className: "small", title: t("bookmarks.delete") });
  delBtn.addEventListener("click", () => deleteBookmark(httpBase, vaultId, b));
  actions.append(editBtn, delBtn);
  tile.append(actions);
  return tile;
}

async function deleteBookmark(httpBase, vaultId, b) {
  if (!confirm(t("bookmarks.delete_confirm", { title: b.title }))) return;
  const r = await fetch(withVaultId(`${httpBase}/tools/bookmarks/delete`, vaultId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ match: b.url || b.title, date: b.date || null }),
  });
  if (r.ok) renderBookmarksTool();
  else { const e = await r.json().catch(() => ({})); alert(t("bookmarks.error_delete", { status: r.status, detail: e.detail || "" })); }
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
  if (b.source) left.append(el("span", { textContent: t("bookmarks.source_label", { source: b.source }) }));
  if (b.themen && b.themen.length) {
    if (b.source) left.append(el("span", { textContent: " · " }));
    left.append(el("span", { textContent: b.themen.map((t) => `#${t}`).join(" ") }));
  }
  meta.append(left);
  const actions = el("span", { className: "bookmark-actions" });
  const editBtn = el("button", { type: "button", textContent: "✎", className: "small", title: t("bookmarks.edit_title") });
  editBtn.addEventListener("click", () => showEditBookmarkDialog(httpBase, vaultId, b, () => renderBookmarksTool()));
  actions.append(editBtn);
  const delBtn = el("button", { type: "button", textContent: t("bookmarks.delete"), className: "small" });
  delBtn.addEventListener("click", async () => {
    if (!confirm(t("bookmarks.delete_confirm", { title: b.title }))) return;
    const matchValue = b.url || b.title;
    const r = await fetch(withVaultId(`${httpBase}/tools/bookmarks/delete`, vaultId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ match: matchValue, date: b.date || null }),
    });
    if (r.ok) renderBookmarksTool();
    else { const e = await r.json().catch(() => ({})); alert(t("bookmarks.error_delete", { status: r.status, detail: e.detail || "" })); }
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
  dialog.append(el("h3", { textContent: t("bookmarks.dialog_edit_headline") }));

  const titleInput = el("input", { type: "text", placeholder: t("bookmarks.title_placeholder"), value: bookmark.title || "" });
  const noteInput = el("input", { type: "text", placeholder: t("bookmarks.note_placeholder"), value: bookmark.note || "" });
  const themenInput = el("input", {
    type: "text",
    placeholder: t("bookmarks.topics_placeholder"),
    value: (bookmark.themen || []).join(", "),
  });
  const status = el("div", { className: "tool-status" });
  const actions = el("div", { className: "playlist-picker-actions" });
  const cancel = el("button", { type: "button", textContent: t("common.cancel") });
  const ok = el("button", { type: "button", textContent: t("bookmarks.save"), className: "primary" });
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
    ok.disabled = true; status.textContent = t("common.saving");
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
        status.textContent = t("bookmarks.error_delete", { status: r.status, detail: err.detail || "" });
        status.className = "tool-status error";
        ok.disabled = false;
        return;
      }
      overlay.remove();
      onSaved && onSaved();
    } catch (err) {
      status.textContent = t("common.error_msg", { message: err.message || err });
      status.className = "tool-status error";
      ok.disabled = false;
    }
  });
  titleInput.focus();
}

function showAddBookmarkDialog(httpBase, vaultId, onAdded) {
  const overlay = el("div", { className: "playlist-picker-overlay" });
  const dialog = el("div", { className: "playlist-picker" });
  dialog.append(el("h3", { textContent: t("bookmarks.dialog_add_headline") }));

  const urlInput = el("input", { type: "url", placeholder: t("bookmarks.url_placeholder") });
  const titleInput = el("input", { type: "text", placeholder: t("bookmarks.title_optional") });
  const noteInput = el("input", { type: "text", placeholder: t("bookmarks.note_placeholder") });
  const themenInput = el("input", { type: "text", placeholder: t("bookmarks.topics_add_placeholder") });
  const status = el("div", { className: "tool-status" });
  const actions = el("div", { className: "playlist-picker-actions" });
  const cancel = el("button", { type: "button", textContent: t("common.cancel") });
  const ok = el("button", { type: "button", textContent: t("bookmarks.add_btn"), className: "primary" });
  actions.append(cancel, ok);
  dialog.append(urlInput, titleInput, noteInput, themenInput, status, actions);
  overlay.append(dialog);
  document.body.append(overlay);

  cancel.addEventListener("click", () => overlay.remove());
  ok.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) { status.textContent = t("bookmarks.url_required"); status.className = "tool-status error"; return; }
    const themen = themenInput.value
      .split(",")
      .map((t) => t.trim().replace(/^#/, "").toLowerCase())
      .filter((t) => /^[a-z][\w\-/]*$/.test(t));
    ok.disabled = true; status.textContent = t("common.saving");
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
        status.textContent = t("bookmarks.error_delete", { status: r.status, detail: err.detail || "" });
        status.className = "tool-status error";
        ok.disabled = false;
        return;
      }
      overlay.remove();
      onAdded && onAdded();
    } catch (err) {
      status.textContent = t("common.error_msg", { message: err.message || err });
      status.className = "tool-status error";
      ok.disabled = false;
    }
  });
  urlInput.focus();
}
