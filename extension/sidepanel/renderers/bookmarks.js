// Bookmarks-Tool Renderer. ewtos.com
import { el, makeYouTubeThumb } from '../dom.js';
import { state } from '../state.js';
import { getHttpBase, getActiveVault, getActiveVaultId, withVaultId } from '../modules/api.js';
import { captureHighlightedTabs, copyHighlightedTabUrls } from './playlists.js';

let bookmarksState = { all: [], search: "", activeTag: null };

export async function renderBookmarksTool() {
  state.panelTitle.textContent = "Bookmarks";
  state.panelBody.replaceChildren();
  const pendingAction = state.pendingToolOptions?.action;

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
  state.panelBody.append(vaultHint, toolbar, searchWrap, tagCloud, status, listWrap);

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
