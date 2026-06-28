// Vault-Explorer + Vault-Gesundheit Renderer. ewtos.com
import { el } from '../dom.js';
import { state } from '../state.js';
import { getHttpBase } from '../modules/api.js';
import { renderMarkdown, renderLineDiff, openInObsidian } from '../markdown.js';
import { openTool } from '../modules/tool-runner.js';
import { renderBaseInto } from './base-view.js';

const VH_SEVERITY = {
  error: { icon: "🔴", label: "Fehler" },
  warn: { icon: "🟡", label: "Warnung" },
  info: { icon: "🔵", label: "Info" },
};

// Schicht-Zuordnung nach Top-Level-Segment — färbt Ordner im Explorer.
// Unterordner erben die Farbe des Top-Ordners (z.B. raw/youtube = raw).
const LAYER_BY_TOP = {
  raw: "raw", wiki: "wiki", crm: "crm", kontext: "kontext",
  inbox: "workspace", journal: "workspace",
  templates: "os", assets: "os",
  ".claude": "os", ".obsidian": "os", ".ewtosbrain": "os", ".ewtos-backups": "os",
};
function layerOf(path) {
  return LAYER_BY_TOP[(path || "").split("/")[0]] || "";
}

// Legende: Schicht -> Anzeige-Label.
const LAYER_LEGEND = [
  ["raw", "raw"], ["wiki", "wiki"], ["crm", "crm"],
  ["kontext", "kontext"], ["workspace", "inbox/journal"], ["os", "os"],
];

// Modell-agnostischer Copy-Paste-Prompt zum Ingesten aller noch nicht ingesteten
// Roh-Quellen. In Claude Code oder ein beliebiges LLM mit Vault-Zugriff einfügen.
function buildIngestPrompt(paths) {
  const list = paths.map((p) => `- ${p}`).join("\n");
  return [
    "Ingeste folgende Roh-Quellen in meinen Obsidian-Vault nach der Karpathy-Methode (raw/ → wiki/).",
    "",
    "Für JEDE Quelle:",
    "1. Roh-Datei lesen.",
    "2. Passende Vorlage aus templates/ nehmen (Video → templates/video.md, Creator → creator.md, Playlist → playlist.md, sonst wissensseite.md/quelle.md). Frontmatter-Keys + Sektionen exakt übernehmen.",
    "3. Kuratierte Wiki-Page im passenden PARA-Ordner anlegen — Videos/Playlists/Creators flach unter wiki/resources/, sonst wiki/projects|areas|resources/. Sachgebiet als freies Frontmatter-Feld `thema` (kein Ordner pro Thema).",
    "4. Bidirektional verlinken: Wiki-Page `## Quellen` → [[raw/...]], Roh-Datei-Frontmatter `kuratiert_in: \"[[wiki/...]]\"`.",
    "5. Seite in den passenden `## Pages`-Index-Hub eintragen.",
    "Am Ende EINEN gesammelten Eintrag in log.md (Datum — was ingested).",
    "Dateinamen kebab-case + ISO-Datum. Frag nach, bevor du bestehende Pages überschreibst.",
    "",
    "Quellen:",
    list,
  ].join("\n");
}

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
  searchRow.append(searchInput, searchBtn, guideBtn);
  header.append(vaultSelect, searchRow);

  const legend = el("div", { className: "vault-legend" });
  for (const [layer, label] of LAYER_LEGEND) {
    const item = el("span", { className: "vault-legend-item" });
    item.append(el("span", { className: "vault-legend-dot layer-" + layer }), el("span", { textContent: label }));
    legend.append(item);
  }

  const breadcrumb = el("div", { className: "vault-breadcrumb" });
  const listBox = el("div", { className: "vault-list" });
  const viewerBox = el("div", { className: "vault-viewer", style: "display:none" });
  const status = el("div", { className: "tool-status" });

  const chatFab = el("button", { className: "vault-chat-fab", title: "Chat mit Vault", textContent: "💬" });
  chatFab.addEventListener("click", () => openWorkspaceTab("notes/scratchpad.md", false, "vault"));
  state.panelBody.append(header, legend, breadcrumb, listBox, viewerBox, status, chatFab);

  let currentVaultId = null;
  let currentPath = "";
  let currentFile = null;
  let canWrite = false;
  let searchActive = false;
  let vaultsById = {};
  let pendingFind = "";
  let explorerShowHidden = false;
  let explorerAllowDelete = false;
  let sensitiveFolders = new Set();  // explizit als sensibel markierte Ordner
  let sensitiveFiles = new Set();    // einzeln per Frontmatter markierte Dateien
  const expandedPaths = new Set();
  let savedScrollTop = 0;
  let revealPath = null;
  let selectedFile = null;  // im Tab geöffnete Datei — im Baum markiert
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

  async function loadSensitiveState() {
    sensitiveFolders = new Set();
    sensitiveFiles = new Set();
    if (!currentVaultId) return;
    try {
      const res = await fetch(`${httpBase}/tools/vault_sensitive/${encodeURIComponent(currentVaultId)}`);
      if (!res.ok) return;
      const data = await res.json();
      sensitiveFolders = new Set(data.folders || []);
      sensitiveFiles = new Set(data.files || []);
    } catch (_) {}
  }

  // Sensibler Vorfahre eines Pfads (geerbte Sperre), oder null.
  function ancestorSensitive(path) {
    for (const f of sensitiveFolders) {
      if (path !== f && path.startsWith(f + "/")) return f;
    }
    return null;
  }

  // Lock-Zustand für eine Zeile. inherited = über einen Eltern-Ordner gesperrt.
  function lockState(path, isFolder) {
    const inherited = ancestorSensitive(path);
    const selfLocked = isFolder ? sensitiveFolders.has(path) : sensitiveFiles.has(path);
    return { locked: selfLocked || !!inherited, inherited: !!inherited && !selfLocked };
  }

  async function toggleFolderSensitive(path, makeSensitive) {
    try {
      const res = await fetch(`${httpBase}/tools/vault_sensitive/folder/${encodeURIComponent(currentVaultId)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder: path, sensitive: makeSensitive }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || `HTTP ${res.status}`); }
      const data = await res.json();
      sensitiveFolders = new Set(data.folders || []);
      setStatus(makeSensitive ? `Ordner gesperrt: ${path}` : `Ordner entsperrt: ${path}`);
      await renderView();
    } catch (err) {
      setStatus("Ordner-Flag fehlgeschlagen: " + (err.message || err), "error");
    }
  }

  async function toggleFileSensitive(path, makeSensitive) {
    try {
      const res = await fetch(`${httpBase}/tools/vault_sensitive/file/${encodeURIComponent(currentVaultId)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rel_path: path, sensitive: makeSensitive }),
      });
      if (res.status === 403) { setStatus("Datei-Flag braucht Schreibrecht (write_files).", "error"); return; }
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || `HTTP ${res.status}`); }
      if (makeSensitive) sensitiveFiles.add(path); else sensitiveFiles.delete(path);
      setStatus(makeSensitive ? `Datei gesperrt: ${path}` : `Datei entsperrt: ${path}`);
      await renderView();
    } catch (err) {
      setStatus("Datei-Flag fehlgeschlagen: " + (err.message || err), "error");
    }
  }

  function makeLockBtn(path, isFolder) {
    const st = lockState(path, isFolder);
    const b = el("span", {
      className: "vault-row-lock" + (st.locked ? " on" : "") + (st.inherited ? " inherited" : ""),
      textContent: st.locked ? "🔒" : "🔓",
    });
    if (st.inherited) {
      b.title = "Gesperrt über übergeordneten Ordner";
    } else {
      b.title = st.locked
        ? (isFolder ? "Ordner ist sensibel — klicken zum Entsperren" : "Datei ist sensibel — klicken zum Entsperren")
        : (isFolder ? "Ordner als sensibel markieren (DSGVO — nur freigegebenes LLM)" : "Datei als sensibel markieren");
    }
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (st.inherited) return;  // geerbt: am Eltern-Ordner ändern
      if (isFolder) toggleFolderSensitive(path, !st.locked);
      else toggleFileSensitive(path, !st.locked);
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
    if (selectedFile) {
      // Breadcrumb zeigt den Pfad der im Tab geöffneten Datei. Ordner-Segmente
      // klappen den Baum auf diese Ebene zusammen + scrollen hin.
      const segs = selectedFile.split("/").filter(Boolean);
      const rootLink = el("a", { href: "#", textContent: "/", className: "vault-crumb" });
      rootLink.addEventListener("click", (e) => { e.preventDefault(); collapseToFolder(null); });
      breadcrumb.append(rootLink);
      let acc = "";
      for (let i = 0; i < segs.length; i++) {
        breadcrumb.append(el("span", { className: "vault-crumb-sep", textContent: " / " }));
        acc = acc ? acc + "/" + segs[i] : segs[i];
        if (i === segs.length - 1) {
          breadcrumb.append(el("span", { className: "vault-crumb-current", textContent: segs[i] }));
        } else {
          const folderPath = acc;
          const a = el("a", { href: "#", textContent: segs[i], className: "vault-crumb" });
          a.addEventListener("click", (e) => { e.preventDefault(); collapseToFolder(folderPath); });
          breadcrumb.append(a);
        }
      }
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
    const images = data.images || [];
    const others = data.other || [];
    const counts = data.counts || {};
    if (depth === 0 && !folders.length && !files.length && !images.length && !others.length) {
      container.append(el("div", { className: "vault-empty", textContent: "Leerer Ordner." }));
      return;
    }
    for (const f of folders) {
      const layer = layerOf(f);
      const row = el("div", { className: "vault-entry vault-folder" + (layer ? " layer-" + layer : "") });
      row.dataset.path = f;
      row.style.paddingLeft = (depth * 14 + 4) + "px";
      const caret = el("span", { className: "vault-caret", textContent: "▸" });
      const cnt = counts[f];
      const nameText = basename(f) + (cnt != null ? ` (${cnt})` : "");
      row.append(caret, el("span", { className: "vault-icon", textContent: "📁" }), el("span", { className: "vault-name", textContent: nameText }));
      row.append(makeLockBtn(f, true));
      if (canWrite) {
        const addBtn = el("span", { className: "vault-row-add", textContent: "＋", title: "Neue Datei / Ordner hier anlegen" });
        addBtn.addEventListener("click", (e) => { e.stopPropagation(); showCreateMenu(e.clientX, e.clientY, f); });
        row.append(addBtn);
        row.addEventListener("contextmenu", (e) => { e.preventDefault(); showCreateMenu(e.clientX, e.clientY, f); });
      }
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
      row.append(makeLockBtn(f, false));
      if (canWrite && explorerAllowDelete) row.append(makeDeleteBtn(f, () => renderView()));
      row.addEventListener("click", () => { selectedFile = f; markSelected(); renderBreadcrumb(); openWorkspaceTab(f); });
      row.addEventListener("contextmenu", (e) => { e.preventDefault(); showRowMenu(e.clientX, e.clientY, f); });
      container.append(row);
    }
    for (const f of images) {
      const row = el("div", { className: "vault-entry vault-file vault-image-file" });
      row.dataset.path = f;
      row.style.paddingLeft = (depth * 14 + 20) + "px";
      row.append(el("span", { className: "vault-icon", textContent: "🖼️" }), el("span", { className: "vault-name", textContent: basename(f) }));
      row.addEventListener("click", () => { selectedFile = f; markSelected(); renderBreadcrumb(); openWorkspaceTab(f); });
      container.append(row);
    }
    for (const f of others) {
      const row = el("div", { className: "vault-entry vault-file vault-other-file" });
      row.dataset.path = f;
      row.style.paddingLeft = (depth * 14 + 20) + "px";
      row.append(el("span", { className: "vault-icon", textContent: "📎" }), el("span", { className: "vault-name", textContent: basename(f) }));
      row.addEventListener("click", () => { selectedFile = f; markSelected(); renderBreadcrumb(); openWorkspaceTab(f); });
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

  // Breadcrumb-Klick: Baum auf die angeklickte Ebene zusammenklappen + hinscrollen.
  // folderPath = null → komplett zur Wurzel (alle Ordner zu, Auswahl gelöscht).
  async function collapseToFolder(folderPath) {
    searchActive = false;
    currentFile = null;
    if (!folderPath) {
      expandedPaths.clear();
      selectedFile = null;
    } else {
      for (const p of Array.from(expandedPaths)) {
        if (p !== folderPath && p.startsWith(folderPath + "/")) expandedPaths.delete(p);
      }
      let acc = "";
      for (const seg of folderPath.split("/")) { acc = acc ? acc + "/" + seg : seg; expandedPaths.add(acc); }
      revealPath = folderPath;
    }
    await renderView();
  }

  // Datei im Baum sichtbar machen + markieren (z.B. wenn ihr Tab aktiv wird).
  async function revealFile(relPath) {
    selectedFile = relPath;
    const sel = (window.CSS && CSS.escape) ? CSS.escape(relPath) : relPath.replace(/"/g, '\\"');
    const visible = listBox.querySelector(`.vault-file[data-path="${sel}"]`);
    if (visible && !currentFile && !searchActive) {
      markSelected();
      renderBreadcrumb();
      visible.scrollIntoView({ block: "nearest" });
      return;
    }
    let acc = "";
    for (const seg of relPath.split("/").slice(0, -1)) { acc = acc ? acc + "/" + seg : seg; expandedPaths.add(acc); }
    revealPath = relPath;
    currentFile = null;
    searchActive = false;
    await renderView();
  }

  // Explorer-Markierung an den aktiven Browser-Tab koppeln (Sidebar ist tab-übergreifend):
  // wird ein Workspace-Tab aktiv, markiert der Explorer dessen Datei (ggf. Vault-Wechsel).
  const WORKSPACE_PREFIX = chrome.runtime.getURL("workspace/workspace.html");
  async function syncToTab(tab) {
    if (!tab || !tab.url || !tab.url.startsWith(WORKSPACE_PREFIX)) return;
    if (searchActive || currentFile) return;  // Suche/Datei-Viewer nicht unterbrechen
    let vid, rel;
    try { const u = new URL(tab.url); vid = u.searchParams.get("vault_id"); rel = u.searchParams.get("rel_path"); }
    catch { return; }
    if (!vid || !rel) return;
    if (vid !== currentVaultId) {
      if (!vaultsById[vid]) return;
      currentVaultId = vid;
      vaultSelect.value = vid;
      canWrite = !!(vaultsById[vid]?.permissions?.write_files);
      await chrome.storage.local.set({ selectedVaultId: vid });
      expandedPaths.clear();
      await loadSensitiveState();
    }
    await revealFile(rel);
  }
  async function syncToActiveTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await syncToTab(tab);
    } catch (_) {}
  }

  // Workspace-Tab signalisiert Datei-Navigation → Explorer springt mit
  chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
    if (!msg || msg.type !== "ws_nav_file") return;
    const { vault_id, rel_path } = msg;
    if (!vault_id || !rel_path) return;
    (async () => {
      if (vault_id !== currentVaultId) {
        if (!vaultsById[vault_id]) return;
        currentVaultId = vault_id;
        vaultSelect.value = vault_id;
        canWrite = !!(vaultsById[vault_id]?.permissions?.write_files);
        await chrome.storage.local.set({ selectedVaultId: vault_id });
        expandedPaths.clear();
        await loadSensitiveState();
      }
      await revealFile(rel_path);
    })();
  });

  // Datei im Browserfenster öffnen (eigener Tab mit Ansicht/Editor/Chat).
  // Default: bestehenden Workspace-Tab wiederverwenden (Tab fragt selbst nach,
  // falls dort ungespeicherte Änderungen offen sind). forceNew=true → neuer Tab.
  function openWorkspaceTab(relPath, forceNew = false, chatMode = "") {
    if (!currentVaultId || !relPath) return;
    const extra = chatMode ? `&chat_mode=${encodeURIComponent(chatMode)}` : "";
    const url = chrome.runtime.getURL(
      `workspace/workspace.html?vault_id=${encodeURIComponent(currentVaultId)}&rel_path=${encodeURIComponent(relPath)}${extra}`
    );
    if (forceNew) { chrome.tabs.create({ url }); return; }
    const prefix = chrome.runtime.getURL("workspace/workspace.html");
    chrome.tabs.query({}, (tabs) => {
      const existing = (tabs || []).find((t) => t.url && t.url.startsWith(prefix));
      if (!existing) { chrome.tabs.create({ url }); return; }
      // Broadcast an Extension-Seiten (tabs.sendMessage erreicht nur Content-Scripts).
      // targetTabId filtert auf den richtigen Workspace-Tab; der Tab navigiert selbst
      // und fragt vorher bei ungespeicherten Änderungen nach.
      chrome.runtime.sendMessage(
        { type: "ws_open_file", targetTabId: existing.id, vault_id: currentVaultId, rel_path: relPath, chat_mode: chatMode },
        (resp) => {
          if (chrome.runtime.lastError || resp === undefined) {
            // Kein Empfänger (Tab noch am Laden) → direkt auf die Datei setzen.
            chrome.tabs.update(existing.id, { url, active: true }, () => { void chrome.runtime.lastError; });
          } else {
            chrome.tabs.update(existing.id, { active: true });
          }
        }
      );
    });
  }

  // Mini-Kontextmenü für „In neuem Tab öffnen" (Rechtsklick auf eine Datei).
  let rowMenuEl = null;
  function closeRowMenu() {
    if (rowMenuEl) { rowMenuEl.remove(); rowMenuEl = null; }
    document.removeEventListener("click", closeRowMenu);
  }
  function showRowMenu(x, y, relPath) {
    closeRowMenu();
    rowMenuEl = el("div", { className: "vault-ctx-menu" });
    const item = el("button", { type: "button", className: "vault-ctx-item", textContent: "In neuem Tab öffnen" });
    item.addEventListener("click", (e) => { e.stopPropagation(); closeRowMenu(); openWorkspaceTab(relPath, true); });
    rowMenuEl.append(item);
    rowMenuEl.style.left = x + "px";
    rowMenuEl.style.top = y + "px";
    document.body.append(rowMenuEl);
    setTimeout(() => document.addEventListener("click", closeRowMenu), 0);
  }

  // Neue Datei/Ordner anlegen — IN dem uebergebenen Ordner (parentRel; "" = Vault-Root).
  async function createEntry(parentRel, kind) {
    const isFolder = kind === "folder";
    const name = (prompt(isFolder ? "Name des neuen Ordners:" : "Name der neuen Datei (.md):", "") || "").trim();
    if (!name) return;
    const rel = parentRel ? `${parentRel}/${name}` : name;
    try {
      if (isFolder) {
        const r = await fetch(`${httpBase}/tools/vault_folder_new/${encodeURIComponent(currentVaultId)}?rel_path=${encodeURIComponent(rel)}`, { method: "POST" });
        if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || `HTTP ${r.status}`); }
        if (parentRel) { let acc = ""; for (const seg of parentRel.split("/")) { acc = acc ? acc + "/" + seg : seg; expandedPaths.add(acc); } }
        expandedPaths.add(rel);
        revealPath = rel;
        setStatus("Ordner angelegt: " + rel);
        await renderView();
      } else {
        const fileRel = rel.endsWith(".md") ? rel : rel + ".md";
        const r = await fetch(`${httpBase}/tools/vault_file_new/${encodeURIComponent(currentVaultId)}?rel_path=${encodeURIComponent(fileRel)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "" }) });
        if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || `HTTP ${r.status}`); }
        if (parentRel) { let acc = ""; for (const seg of parentRel.split("/")) { acc = acc ? acc + "/" + seg : seg; expandedPaths.add(acc); } }
        await openFile(fileRel);
      }
    } catch (err) {
      setStatus("Anlegen fehlgeschlagen: " + (err.message || err), "error");
    }
  }

  function showCreateMenu(x, y, parentRel) {
    closeRowMenu();
    rowMenuEl = el("div", { className: "vault-ctx-menu" });
    const fileItem = el("button", { type: "button", className: "vault-ctx-item", textContent: "Neue Datei" });
    fileItem.addEventListener("click", (e) => { e.stopPropagation(); closeRowMenu(); createEntry(parentRel, "file"); });
    const folderItem = el("button", { type: "button", className: "vault-ctx-item", textContent: "Neuer Ordner" });
    folderItem.addEventListener("click", (e) => { e.stopPropagation(); closeRowMenu(); createEntry(parentRel, "folder"); });
    rowMenuEl.append(fileItem, folderItem);
    rowMenuEl.style.left = x + "px";
    rowMenuEl.style.top = y + "px";
    document.body.append(rowMenuEl);
    setTimeout(() => document.addEventListener("click", closeRowMenu), 0);
  }

  // Markiert die im Tab geöffnete Datei im Baum (ohne Datei-Viewer im Sidepanel).
  function markSelected() {
    if (!selectedFile) return;
    const sel = (window.CSS && CSS.escape) ? CSS.escape(selectedFile) : selectedFile.replace(/"/g, '\\"');
    const target = listBox.querySelector(`.vault-file[data-path="${sel}"]`);
    if (!target) return;  // Datei nicht sichtbar (zugeklappt) — bestehende Highlights nicht anfassen
    listBox.querySelectorAll(".vault-entry.vault-active").forEach((e) => e.classList.remove("vault-active"));
    target.classList.add("vault-active");
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
          selectedFile = r.rel_path;
          openWorkspaceTab(r.rel_path);
        });
        row.addEventListener("contextmenu", (e) => { e.preventDefault(); showRowMenu(e.clientX, e.clientY, r.rel_path); });
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
        if (currentFile.toLowerCase().endsWith(".base")) {
          renderBaseInto(body, httpBase, currentVaultId, currentFile, (rel) => {
            selectedFile = rel;
            openWorkspaceTab(rel);
          });
        } else {
        body.innerHTML = renderMarkdown(data.content || "");
        // Lokale Vault-Bilder über den Asset-Endpoint laden
        body.querySelectorAll("img.md-image[data-vault-src]").forEach((img) => {
          const rel = img.getAttribute("data-vault-src");
          img.src = `${httpBase}/tools/vault_asset/${encodeURIComponent(currentVaultId)}/${rel.split("/").map(encodeURIComponent).join("/")}`;
          img.addEventListener("error", () => { img.replaceWith(document.createTextNode(`[Bild nicht gefunden: ${rel}]`)); });
        });
        }

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
        // Obsidian wird NUR hier angeboten — bei einer im Vault-Explorer geöffneten Datei.
        const obsidianBtn = el("button", {
          type: "button",
          className: "vault-obsidian-btn obsidian-button",
          textContent: "✎ In Obsidian öffnen",
          title: "Diese Datei in Obsidian öffnen (externe App)",
        });
        obsidianBtn.addEventListener("click", () => {
          const v = vaultsById[currentVaultId];
          const vaultName = v ? (v.path.split(/[\\/]/).filter(Boolean).pop() || v.name) : "";
          openInObsidian(vaultName, currentFile);
        });
        viewerActions.append(obsidianBtn);
        if (canWrite && currentFile && currentFile.toLowerCase().endsWith(".md")) {
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
      const newFolderBtn = el("button", { type: "button", className: "vault-new-btn", textContent: "+ Ordner" });
      newFolderBtn.addEventListener("click", () => createEntry("", "folder"));
      toolbar.append(newBtn, newFolderBtn);
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
    if (selectedFile) markSelected();  // Markierung der im Tab offenen Datei halten
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
    selectedFile = null;
    await loadSensitiveState();
    await renderView();
  });

  // Aktiven Tab beobachten → Markierung folgt dem geöffneten Workspace-Tab.
  const onTabActivated = () => syncToActiveTab();
  const onTabUpdated = (id, info, tab) => { if (info.url && tab.active) syncToActiveTab(); };
  chrome.tabs.onActivated.addListener(onTabActivated);
  chrome.tabs.onUpdated.addListener(onTabUpdated);
  state.currentToolCleanup = () => {
    chrome.tabs.onActivated.removeListener(onTabActivated);
    chrome.tabs.onUpdated.removeListener(onTabUpdated);
  };

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
    await loadSensitiveState();
    await renderView();
    if (!initialFile) await syncToActiveTab();  // beim Öffnen direkt den aktiven Tab spiegeln
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

    const uningested = findings.filter((f) => f.category === "raw_uningested" && f.path);
    if (uningested.length) {
      const box = el("div", { className: "vh-ingest-box" });
      box.append(el("div", {
        className: "vh-ingest-title",
        textContent: `📥 ${uningested.length} Roh-Quelle(n) noch nicht ingested`,
      }));
      const btn = el("button", {
        type: "button",
        className: "vh-ingest-btn",
        textContent: "Ingest-Prompt kopieren",
        title: "Prompt mit allen uningesteten Quellen in die Zwischenablage — in beliebiges LLM (Subscription) einfügen",
      });
      btn.addEventListener("click", async () => {
        const prompt = buildIngestPrompt(uningested.map((f) => f.path));
        try {
          await navigator.clipboard.writeText(prompt);
          btn.textContent = "✓ Kopiert";
          setTimeout(() => { btn.textContent = "Ingest-Prompt kopieren"; }, 2000);
        } catch (_) {
          setStatus("Clipboard nicht verfügbar — Prompt im Status unten.", "error");
          setStatus(prompt);
        }
      });
      box.append(btn);
      listBox.append(box);
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
        if (f.path) {
          const pathEl = el("code", { className: "vh-path", textContent: f.path });
          // Datei-Pfade (nicht Ordner) anklickbar → im Vault-Explorer öffnen.
          if (!f.path.endsWith("/")) {
            pathEl.classList.add("clickable");
            pathEl.title = "Im Vault-Explorer öffnen";
            pathEl.addEventListener("click", () =>
              openTool("vault_explorer", { initialFile: f.path, vaultId: currentVaultId }));
          }
          head.append(pathEl);
        }
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
