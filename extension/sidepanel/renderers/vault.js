// Vault-Explorer + Vault-Gesundheit Renderer. ewtos.com
import { el } from '../dom.js';
import { state } from '../state.js';
import { getHttpBase } from '../modules/api.js';
import { renderMarkdown, renderLineDiff } from '../markdown.js';
import { openTool } from '../modules/tool-runner.js';

const VH_SEVERITY = {
  error: { icon: "🔴", label: "Fehler" },
  warn: { icon: "🟡", label: "Warnung" },
  info: { icon: "🔵", label: "Info" },
};

export async function renderVaultExplorer() {
  state.panelTitle.textContent = "Vault-Explorer";

  // pendingToolOptions wird in openTool() direkt nach renderer()-Aufruf
  // auf null gesetzt — synchron lesen, bevor das erste await passiert.
  const initialFile = state.pendingToolOptions?.initialFile || null;
  const initialVaultId = state.pendingToolOptions?.vaultId || null;

  const httpBase = await getHttpBase();

  const header = el("div", { className: "chat-header" });
  const vaultSelect = el("select", { className: "vault-picker" });
  const searchRow = el("div", { className: "vault-search-row" });
  const searchInput = el("input", { type: "text", className: "vault-search-input", placeholder: "Vault durchsuchen..." });
  const searchBtn = el("button", { type: "button", className: "vault-search-btn", textContent: "Suchen" });
  const guideBtn = el("button", { type: "button", className: "vault-search-btn", textContent: "📖", title: "Anleitung öffnen" });
  guideBtn.addEventListener("click", () => openFile("anleitung.md"));
  const newFileBtn = el("button", { type: "button", className: "vault-search-btn", textContent: "+ Datei", title: "Neue Datei anlegen" });
  newFileBtn.addEventListener("click", async () => {
    if (!currentVaultId) return;
    const name = prompt("Dateiname (z.B. meine-notiz.md):");
    if (!name || !name.trim()) return;
    const rel = name.trim().endsWith(".md") ? name.trim() : name.trim() + ".md";
    try {
      const res = await fetch(`${httpBase}/tools/vault_file_new/${encodeURIComponent(currentVaultId)}?rel_path=${encodeURIComponent(rel)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "" }),
      });
      if (res.ok) {
        currentFile = null;
        await renderView();
      } else {
        const err = await res.json().catch(() => ({}));
        alert("Fehler: " + (err.detail || "Unbekannt"));
      }
    } catch (err) {
      alert("Fehler: " + (err.message || err));
    }
  });
  searchRow.append(searchInput, searchBtn, guideBtn, newFileBtn);
  header.append(vaultSelect, searchRow);

  const breadcrumb = el("div", { className: "vault-breadcrumb" });
  const listBox = el("div", { className: "vault-list" });
  const viewerBox = el("div", { className: "vault-viewer", style: "display:none" });
  const status = el("div", { className: "tool-status" });

  state.panelBody.append(header, breadcrumb, listBox, viewerBox, status);

  // Floating Vault-Chat Button — opens classic Karpathy chat for current vault
  const fab = el("button", {
    type: "button",
    className: "vault-fab",
    title: "Mit Vault chatten (Karpathy)",
    textContent: "💬",
  });
  state.panelBody.append(fab);
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
  let explorerShowHidden = false;
  let explorerAllowDelete = false;
  const expandedPaths = new Set();
  let savedScrollTop = 0;
  let revealPath = null;
  try {
    const _p = await chrome.storage.local.get(["explorerShowHidden", "explorerAllowDelete"]);
    explorerShowHidden = !!_p.explorerShowHidden;
    explorerAllowDelete = !!_p.explorerAllowDelete;
  } catch {}

  function setStatus(text, level = "") {
    status.textContent = text;
    status.className = "tool-status" + (level ? " " + level : "");
  }

  function makeDeleteBtn(relPath, onDone) {
    const b = el("span", { className: "vault-row-delete", textContent: "✕", title: "Löschen" });
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Löschen?\n\n${relPath}\n\nKann nicht rückgängig gemacht werden.`)) return;
      try {
        const r = await fetch(`${httpBase}/tools/vault_file/${encodeURIComponent(currentVaultId)}?rel_path=${encodeURIComponent(relPath)}`, { method: "DELETE" });
        if (!r.ok) { const er = await r.json().catch(() => ({})); throw new Error(er.detail || `HTTP ${r.status}`); }
        expandedPaths.delete(relPath);
        setStatus("Gelöscht: " + relPath);
        if (onDone) await onDone();
      } catch (err) {
        setStatus("Löschen fehlgeschlagen: " + (err.message || err), "error");
      }
    });
    return b;
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
      back.addEventListener("click", (e) => {
        e.preventDefault();
        if (currentFile) {
          revealPath = currentFile;  // beim Schließen zur Datei springen + markieren
          let acc = "";
          for (const seg of currentFile.split("/").slice(0, -1)) { acc = acc ? acc + "/" + seg : seg; expandedPaths.add(acc); }
        }
        currentFile = null;
        renderView();
      });
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

  // Baut den Vault-Baum lazy auf: Ordner laden ihre Kinder erst beim Aufklappen.
  // expandedPaths hält offene Ordner über Re-Renders (z.B. Datei schließen) hinweg.
  async function buildTreeInto(container, relPath, depth) {
    let data;
    try {
      const url = `${httpBase}/tools/vault_list/${encodeURIComponent(currentVaultId)}?rel_path=${encodeURIComponent(relPath)}&show_hidden=${explorerShowHidden}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      container.append(el("div", { className: "tool-status error", textContent: "Fehler: " + (err.message || err) }));
      return;
    }
    const folders = data.folders || [];
    const files = data.files || [];
    if (depth === 0 && !folders.length && !files.length) {
      container.append(el("div", { className: "vault-empty", textContent: "Leerer Ordner." }));
      return;
    }
    for (const f of folders) {
      const row = el("div", { className: "vault-entry vault-folder" });
      row.dataset.path = f;
      row.style.paddingLeft = (depth * 14 + 4) + "px";
      const caret = el("span", { className: "vault-caret", textContent: "▸" });
      row.append(caret, el("span", { className: "vault-icon", textContent: "📁" }), el("span", { className: "vault-name", textContent: basename(f) }));
      if (canWrite && explorerAllowDelete) row.append(makeDeleteBtn(f, () => renderView()));
      const childBox = el("div", { className: "vault-tree-children", style: "display:none" });
      let loaded = false;
      async function expand() {
        childBox.style.display = "";
        caret.textContent = "▾";
        expandedPaths.add(f);
        if (!loaded) {
          loaded = true;
          caret.textContent = "…";
          await buildTreeInto(childBox, f, depth + 1);
          caret.textContent = "▾";
        }
      }
      function collapse() {
        childBox.style.display = "none";
        caret.textContent = "▸";
        expandedPaths.delete(f);
      }
      row.addEventListener("click", async () => {
        if (childBox.style.display !== "none") collapse();
        else await expand();
      });
      container.append(row, childBox);
      if (expandedPaths.has(f)) await expand();  // Zustand wiederherstellen
    }
    for (const f of files) {
      const row = el("div", { className: "vault-entry vault-file" });
      row.dataset.path = f;
      row.style.paddingLeft = (depth * 14 + 20) + "px";
      row.append(el("span", { className: "vault-icon", textContent: "📄" }), el("span", { className: "vault-name", textContent: basename(f) }));
      if (canWrite && explorerAllowDelete) row.append(makeDeleteBtn(f, () => renderView()));
      row.addEventListener("click", () => openFile(f));
      container.append(row);
    }
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
    savedScrollTop = listBox.scrollTop || 0;  // Scroll für Rückkehr merken
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
        // Lokale Vault-Bilder über den Asset-Endpoint laden
        body.querySelectorAll("img.md-image[data-vault-src]").forEach((img) => {
          const rel = img.getAttribute("data-vault-src");
          img.src = `${httpBase}/tools/vault_asset/${encodeURIComponent(currentVaultId)}/${rel.split("/").map(encodeURIComponent).join("/")}`;
          img.addEventListener("error", () => { img.replaceWith(document.createTextNode(`[Bild nicht gefunden: ${rel}]`)); });
        });

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
        if (state.panelBody._vaultFindKeyHandler) {
          document.removeEventListener("keydown", state.panelBody._vaultFindKeyHandler);
        }
        const onFindKey = (e) => {
          if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
            if (findInput.isConnected) { e.preventDefault(); findInput.focus(); findInput.select(); }
          }
        };
        state.panelBody._vaultFindKeyHandler = onFindKey;
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
        if (canWrite && explorerAllowDelete) {
          const delFileBtn = el("button", { type: "button", className: "vault-delete-btn", textContent: "🗑 Löschen" });
          delFileBtn.addEventListener("click", async () => {
            if (!confirm(`Datei löschen?\n\n${currentFile}\n\nKann nicht rückgängig gemacht werden.`)) return;
            try {
              const r = await fetch(`${httpBase}/tools/vault_file/${encodeURIComponent(currentVaultId)}?rel_path=${encodeURIComponent(currentFile)}`, { method: "DELETE" });
              if (!r.ok) { const er = await r.json().catch(() => ({})); throw new Error(er.detail || `HTTP ${r.status}`); }
              expandedPaths.delete(currentFile);
              currentFile = null;
              await renderView();
            } catch (err) {
              setStatus("Löschen fehlgeschlagen: " + (err.message || err), "error");
            }
          });
          viewerActions.append(delFileBtn);
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
    setStatus("lade Vault...");
    const treeRoot = el("div", { className: "vault-tree" });
    listBox.append(treeRoot);
    await buildTreeInto(treeRoot, "", 0);
    setStatus("");
    if (revealPath) {
      const sel = (window.CSS && CSS.escape) ? CSS.escape(revealPath) : revealPath.replace(/"/g, '\\"');
      const target = treeRoot.querySelector(`[data-path="${sel}"]`);
      revealPath = null;
      if (target) {
        treeRoot.querySelectorAll(".vault-active").forEach((e2) => e2.classList.remove("vault-active"));
        target.classList.add("vault-active");
        target.scrollIntoView({ block: "center" });
      }
    } else if (savedScrollTop) {
      listBox.scrollTop = savedScrollTop; savedScrollTop = 0;
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

    if (state.panelBody._vaultFindKeyHandler) {
      document.removeEventListener("keydown", state.panelBody._vaultFindKeyHandler);
    }
    const onFindKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        if (findInput.isConnected) { e.preventDefault(); findInput.focus(); findInput.select(); }
      }
    };
    state.panelBody._vaultFindKeyHandler = onFindKey;
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
      state.panelBody.replaceChildren();
      const wrap = el("div", { className: "chat-empty-state" });
      wrap.append(el("p", { textContent: "Noch kein Vault verbunden. Lege in den Einstellungen einen an." }));
      const btn = el("button", { type: "button", textContent: "Einstellungen öffnen" });
      btn.addEventListener("click", () => chrome.runtime.openOptionsPage());
      wrap.append(btn);
      state.panelBody.append(wrap);
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

export async function renderVaultHealth() {
  state.panelTitle.textContent = "Vault-Gesundheit";
  const initialVaultId = state.pendingToolOptions?.vaultId || null;
  const httpBase = await getHttpBase();

  const header = el("div", { className: "chat-header" });
  const vaultSelect = el("select", { className: "vault-picker" });
  const runBtn = el("button", { type: "button", className: "secondary", textContent: "Neu prüfen" });
  header.append(vaultSelect, runBtn);

  const summary = el("div", { className: "vh-summary" });
  const upgradeBox = el("div", { className: "vh-upgrade", style: "display:none" });
  const listBox = el("div", { className: "vh-list" });
  const status = el("div", { className: "tool-status" });
  state.panelBody.append(header, summary, upgradeBox, listBox, status);

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
      state.panelBody.replaceChildren();
      const wrap = el("div", { className: "chat-empty-state" });
      wrap.append(el("p", { textContent: "Noch kein Vault verbunden. Lege in den Einstellungen einen an." }));
      const btn = el("button", { type: "button", textContent: "Einstellungen öffnen" });
      btn.addEventListener("click", () => chrome.runtime.openOptionsPage());
      wrap.append(btn);
      state.panelBody.append(wrap);
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
