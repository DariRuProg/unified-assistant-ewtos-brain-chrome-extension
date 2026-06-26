// Bookmarks-Tool Renderer. ewtos.com
import { el, makeYouTubeThumb } from '../dom.js';
import { state } from '../state.js';
import { getHttpBase, getActiveVault, getActiveVaultId, withVaultId } from '../modules/api.js';
import { captureHighlightedTabs, copyHighlightedTabUrls } from './playlists.js';
import { t } from '../../i18n/i18n.js';

let bookmarksState = { all: [], search: "", activeTag: null };

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
  const tagCloud = el("div", { className: "tag-cloud" });
  const listWrap = el("div", { className: "bookmark-list" });
  state.panelBody.append(vaultHint, toolbar, searchWrap, tagCloud, status, listWrap);

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
