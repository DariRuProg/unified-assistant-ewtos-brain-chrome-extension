// Note-Taker + Todos Renderer. ewtos.com
import { el } from '../dom.js';
import { state } from '../state.js';
import { getHttpBase, getActiveVault, getActiveVaultId, withVaultId } from '../modules/api.js';
import { renderMarkdown, wireVaultImages } from '../markdown.js';
import { openWorkspaceTab } from '../modules/workspace-tab.js';
import { t } from '../../i18n/i18n.js';

const TODO_LINE_RE = /^(\s*)- \[( |x|X)\] (.*)$/;
const DUE_RE = /@(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/;

export async function renderNotesFile(kind, opts) {
  state.panelTitle.textContent = opts.title;

  const vaultHint = el("div", { className: "notes-vault-hint" });
  const meta = el("div", { className: "tool-status", textContent: t("common.loading") });
  const textarea = el("textarea", { placeholder: opts.placeholder });
  textarea.classList.add("scratchpad");
  const rendered = el("div", { className: "notes-rendered hidden" });
  const status = el("div", { className: "tool-status" });

  const viewToggle = el("button", { type: "button", textContent: t("notes.preview") });
  viewToggle.classList.add("secondary");
  const openTabBtn = el("button", { type: "button", textContent: t("common.open_tab"), title: t("notes.open_tab_title") });
  openTabBtn.classList.add("secondary");
  openTabBtn.style.display = "none";
  const exportBtn = el("button", { textContent: t("notes.save_as") });
  const fallbackRow = el("div", { className: "export-row hidden" });
  const fallbackInput = el("input", {
    type: "text",
    placeholder: t("notes.path_placeholder"),
  });
  const fallbackSave = el("button", { textContent: t("notes.save") });
  const fallbackCancel = el("button", { textContent: t("notes.cancel") });
  fallbackCancel.classList.add("secondary");
  const fallbackBtns = el("div");
  fallbackBtns.append(fallbackSave, fallbackCancel);
  fallbackRow.append(fallbackInput, fallbackBtns);

  // Promote-to-raw ("Ins Brain") — nur für Scratchpad
  let promoteSection = null;
  if (kind === "scratchpad") {
    const promoteBtn = el("button", { textContent: t("notes.promote"), className: "secondary" });
    promoteBtn.style.marginTop = "6px";

    const promoteForm = el("div");
    promoteForm.style.cssText = "display:none;margin-top:8px;padding:10px;border:1px solid var(--border,#ddd);border-radius:6px;background:var(--bg-subtle);";

    const promoteTitle = el("input", { type: "text", placeholder: t("notes.promote_title_placeholder") });
    const promoteSub = el("select");
    ["eigene-notizen", "artikel", "chat-archive"].forEach(s => promoteSub.append(new Option(s, s)));
    const promoteDesc = el("textarea", { placeholder: t("notes.promote_desc_placeholder") });
    promoteDesc.style.cssText = "min-height:52px;resize:vertical;margin-top:6px;font-size:12px;";
    const promoteHint = el("div", { className: "tool-status" });
    const promoteSubBtn = el("button", { textContent: t("notes.promote_btn") });
    const promoteCancelBtn = el("button", { textContent: t("notes.cancel"), className: "secondary" });
    promoteCancelBtn.style.marginLeft = "6px";

    const promoteSubLabel = el("label", { textContent: t("notes.promote_folder_label") });
    promoteSubLabel.style.cssText = "margin-top:6px;display:block;";
    const promoteInfoHint = el("div", { className: "tool-status", textContent: t("notes.promote_hint") });
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
      if (!title) { promoteHint.textContent = t("notes.title_required"); promoteHint.className = "tool-status error"; return; }
      promoteSubBtn.disabled = true;
      promoteHint.textContent = t("notes.promoting");
      promoteHint.className = "tool-status";
      try {
        const httpBase2 = await getHttpBase();
        const vaultId = await getActiveVaultId(httpBase2);
        if (!vaultId) throw new Error(t("notes.no_vault"));
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
        promoteHint.textContent = t("notes.promote_saved", { path: data.data?.raw_path || "OK" });
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
  toolbar.append(viewToggle, openTabBtn, exportBtn);

  state.panelBody.append(vaultHint, meta, textarea, rendered, status, toolbar, fallbackRow, ...(promoteSection ? [promoteSection] : []));

  const httpBase = await getHttpBase();
  const vaultId = await getActiveVaultId(httpBase);
  const vault = await getActiveVault(httpBase);
  if (vault) {
    vaultHint.textContent = t("notes.vault_hint", { name: vault.name });
  } else {
    vaultHint.textContent = t("notes.no_vault_active");
  }
  let saveTimer = null;
  let lastSaved = "";
  let started = null;
  let currentRelPath = null;
  let viewMode = "edit"; // "edit" | "rendered"

  function refreshRendered() {
    rendered.innerHTML = renderMarkdown(textarea.value || "");
    wireVaultImages(rendered, vaultId, httpBase);
  }

  openTabBtn.addEventListener("click", () => {
    if (vaultId && currentRelPath) openWorkspaceTab(vaultId, currentRelPath);
  });

  viewToggle.addEventListener("click", () => {
    if (viewMode === "edit") {
      refreshRendered();
      textarea.classList.add("hidden");
      rendered.classList.remove("hidden");
      viewToggle.textContent = t("notes.source");
      viewMode = "rendered";
    } else {
      rendered.classList.add("hidden");
      textarea.classList.remove("hidden");
      viewToggle.textContent = t("notes.preview");
      viewMode = "edit";
    }
  });

  function setMeta() {
    meta.textContent = started ? t("notes.active_since", { started }) : "";
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
    setStatus(t("common.saving"));
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
      setStatus(t("common.saved"), "success");
    } catch (err) {
      setStatus(t("common.error_msg", { message: err.message || err }), "error");
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
    setStatus(t("notes.unsaved"));
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
      setStatus(t("notes.exported", { name }), "success");
    } catch (err) {
      if (err?.name === "AbortError") { setStatus(t("notes.export_cancelled")); return; }
      setStatus(t("notes.export_error", { error: err.message || err }), "error");
    }
  });

  fallbackCancel.addEventListener("click", () => {
    fallbackRow.classList.add("hidden");
    fallbackInput.value = "";
  });

  fallbackSave.addEventListener("click", async () => {
    const target = fallbackInput.value.trim();
    if (!target) { setStatus(t("notes.path_missing"), "error"); return; }
    fallbackSave.disabled = true;
    try {
      const name = await exportViaServer(target);
      setStatus(t("notes.exported", { name }), "success");
      fallbackRow.classList.add("hidden");
      fallbackInput.value = "";
    } catch (err) {
      setStatus(t("notes.export_error", { error: err.message || err }), "error");
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
    currentRelPath = data.rel_path || null;
    if (currentRelPath) openTabBtn.style.display = "";
    textarea.value = data.content || "";
    lastSaved = textarea.value;
    setMeta();
    setStatus(textarea.value ? t("notes.loading") : t("notes.empty_start"), "");
  } catch (err) {
    setStatus(t("chat.load_failed", { error: err.message || err }), "error");
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
  const timeSuffix = due.time ? ` ${due.time}` : "";

  if (diffMs < 0) {
    if (min < 60) return t("notes.overdue", { n: min, unit: "min" });
    if (h < 24) return t("notes.overdue", { n: h, unit: "h" });
    return t("notes.overdue", { n: d, unit: "d" });
  }
  if (min < 60) return t("notes.in_time", { n: min, unit: "min" });
  if (h < 24) return due.time ? t("notes.today_time", { time: due.time }) : t("notes.today");
  if (d === 1) return due.time ? t("notes.tomorrow_time", { time: due.time }) : t("notes.tomorrow");
  if (d < 7) return t("notes.in_days", { d, time: timeSuffix });
  const dd = new Date(due.date);
  return dd.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" }) + timeSuffix;
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
  const meta = el("div", { className: "tool-status", textContent: t("common.loading") });
  const list = el("div", { className: "todo-list" });

  const addForm = el("form", { className: "todo-add" });
  const addInput = el("input", {
    type: "text",
    placeholder: t("notes.todos_placeholder"),
    title: t("notes.todos_placeholder_title"),
  });
  const addBtn = el("button", { type: "submit", textContent: "+" });
  addForm.append(addInput, addBtn);

  const sourceArea = el("textarea", { placeholder: "Markdown-Quelle (- [ ] / - [x])" });
  sourceArea.classList.add("scratchpad", "hidden");

  const status = el("div", { className: "tool-status" });

  const toolbar = el("div", { className: "todo-toolbar" });
  const sourceToggle = el("button", { type: "button", textContent: t("notes.source") });
  sourceToggle.classList.add("secondary");
  const exportBtn = el("button", { type: "button", textContent: t("notes.save_as") });
  toolbar.append(sourceToggle, exportBtn);

  const fallbackRow = el("div", { className: "export-row hidden" });
  const fallbackInput = el("input", { type: "text", placeholder: t("notes.path_placeholder") });
  const fallbackSave = el("button", { type: "button", textContent: t("notes.save") });
  const fallbackCancel = el("button", { type: "button", textContent: t("notes.cancel") });
  fallbackCancel.classList.add("secondary");
  const fallbackBtns = el("div");
  fallbackBtns.append(fallbackSave, fallbackCancel);
  fallbackRow.append(fallbackInput, fallbackBtns);

  state.panelBody.append(vaultHint, meta, list, addForm, sourceArea, status, toolbar, fallbackRow);

  const httpBase = await getHttpBase();
  const vaultId = await getActiveVaultId(httpBase);
  const vault = await getActiveVault(httpBase);
  vaultHint.textContent = vault ? t("notes.vault_hint", { name: vault.name }) : t("notes.no_vault_active");
  let content = "";
  let saveTimer = null;
  let started = null;
  let sourceMode = false;

  function setMeta() {
    meta.textContent = started ? t("notes.active_since", { started }) : "";
  }

  function setStatus(text, level = "") {
    status.textContent = text;
    status.className = "tool-status" + (level ? " " + level : "");
  }

  function render() {
    list.replaceChildren();
    const items = parseTodoLines(content).filter((x) => x.isTodo);
    if (!items.length) {
      list.append(el("div", { className: "todo-empty", textContent: t("notes.todos_empty") }));
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
      const del = el("button", { type: "button", className: "todo-del", textContent: t("notes.delete_todo"), title: t("notes.delete_todo_title") });
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
    setStatus(t("notes.unsaved"));
    saveTimer = setTimeout(save, delay);
  }

  async function save() {
    if (sourceMode) content = sourceArea.value;
    setStatus(t("common.saving"));
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
      setStatus(t("common.saved"), "success");
    } catch (err) {
      setStatus(t("common.error_msg", { message: err.message || err }), "error");
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
      sourceToggle.textContent = t("notes.source");
      render();
      scheduleSave(0);
    } else {
      sourceMode = true;
      sourceArea.value = content;
      sourceArea.classList.remove("hidden");
      list.classList.add("hidden");
      addForm.classList.add("hidden");
      sourceToggle.textContent = t("common.list");
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
      setStatus(t("notes.exported", { name: handle.name }), "success");
    } catch (err) {
      if (err?.name === "AbortError") { setStatus(t("notes.export_cancelled")); return; }
      setStatus(t("notes.export_error", { error: err.message || err }), "error");
    }
  });

  fallbackCancel.addEventListener("click", () => {
    fallbackRow.classList.add("hidden");
    fallbackInput.value = "";
  });

  fallbackSave.addEventListener("click", async () => {
    const target = fallbackInput.value.trim();
    if (!target) { setStatus(t("notes.path_missing"), "error"); return; }
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
      const name = data.path?.split(/[\\/]/).pop() || target;
      setStatus(t("notes.exported", { name }), "success");
      fallbackRow.classList.add("hidden");
      fallbackInput.value = "";
    } catch (err) {
      setStatus(t("notes.export_error", { error: err.message || err }), "error");
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
    setStatus(content ? t("notes.loading") : t("notes.empty_fresh"), "");
  } catch (err) {
    setStatus(t("chat.load_failed", { error: err.message || err }), "error");
  }
}
