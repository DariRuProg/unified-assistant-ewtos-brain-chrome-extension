// Note-Taker + Todos Renderer. ewtos.com
import { el } from '../dom.js';
import { state } from '../state.js';
import { getHttpBase, getActiveVault, getActiveVaultId, withVaultId } from '../modules/api.js';
import { renderMarkdown } from '../markdown.js';

const TODO_LINE_RE = /^(\s*)- \[( |x|X)\] (.*)$/;
const DUE_RE = /@(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/;

export async function renderNotesFile(kind, opts) {
  state.panelTitle.textContent = opts.title;

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

  state.panelBody.append(vaultHint, meta, textarea, rendered, status, toolbar, fallbackRow, ...(promoteSection ? [promoteSection] : []));

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

export async function renderTodos() {
  state.panelTitle.textContent = "Todos";

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

  state.panelBody.append(vaultHint, meta, list, addForm, sourceArea, status, toolbar, fallbackRow);

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
