// Sidepanel: shows connection status and tool launcher.

const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const panel = document.getElementById("tool-panel");
const panelTitle = document.getElementById("panel-title");
const panelBody = document.getElementById("panel-body");
const panelClose = document.getElementById("panel-close");
const openOptions = document.getElementById("open-options");
const reconnectBtn = document.getElementById("reconnect");

const TOOL_RENDERERS = {
  youtube_transcript: renderYoutubeTranscript,
  scratchpad: () => renderNotesFile("scratchpad", {
    title: "Note-Taker",
    placeholder: "Notizen, Gedanken, Skizzen... wird automatisch gespeichert.",
  }),
  todos: renderTodos,
};

async function getHttpBase() {
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  return (serverUrl || "ws://localhost:9988/ws")
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/ws$/, "");
}

setStatus(false, "verbinde...");

chrome.runtime.sendMessage({ type: "get_connection_status" }, (resp) => {
  if (chrome.runtime.lastError) return;
  if (resp) setStatus(!!resp.connected);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "connection_status") setStatus(!!msg.connected);
});

document.querySelectorAll(".tool[data-tool]").forEach((el) => {
  el.addEventListener("click", () => {
    const tool = el.getAttribute("data-tool");
    openPanel(tool);
  });
});

panelClose.addEventListener("click", () => panel.classList.add("hidden"));

openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());

reconnectBtn.addEventListener("click", () => {
  setStatus(false, "verbinde...");
  chrome.runtime.sendMessage({ type: "reconnect" });
});

function setStatus(connected, customText) {
  statusDot.classList.toggle("online", connected);
  statusDot.classList.toggle("offline", !connected);
  statusText.textContent = customText ?? (connected ? "verbunden" : "offline");
}

function openPanel(tool) {
  const renderer = TOOL_RENDERERS[tool];
  if (!renderer) return;
  panel.classList.remove("hidden");
  panelBody.replaceChildren();
  renderer();
}

function renderYoutubeTranscript() {
  panelTitle.textContent = "YouTube-Transcript";

  const urlInput = el("input", { type: "url", placeholder: "https://www.youtube.com/watch?v=..." });
  const runBtn = el("button", { textContent: "Transcript holen" });
  const status = el("div", { className: "tool-status" });
  const output = el("textarea", { placeholder: "Ergebnis erscheint hier...", readOnly: true });

  runBtn.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) {
      status.textContent = "URL angeben";
      status.className = "tool-status error";
      return;
    }
    runBtn.disabled = true;
    status.textContent = "läuft... (kann ~10 Sek dauern)";
    status.className = "tool-status";
    output.value = "";

    try {
      const httpBase = await getHttpBase();
      const res = await fetch(`${httpBase}/tools/youtube_transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
      output.value = data?.transcript || "";
      status.textContent = "fertig";
      status.className = "tool-status success";
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
    } finally {
      runBtn.disabled = false;
    }
  });

  panelBody.append(urlInput, runBtn, status, output);
}

async function renderNotesFile(kind, opts) {
  panelTitle.textContent = opts.title;

  const meta = el("div", { className: "tool-status", textContent: "lade..." });
  const textarea = el("textarea", { placeholder: opts.placeholder });
  textarea.classList.add("scratchpad");
  const status = el("div", { className: "tool-status" });

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

  panelBody.append(meta, textarea, status, exportBtn, fallbackRow);

  const httpBase = await getHttpBase();
  let saveTimer = null;
  let lastSaved = "";
  let started = null;

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
      const res = await fetch(`${httpBase}/tools/notes/${kind}`, {
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
    const res = await fetch(`${httpBase}/tools/notes/${kind}/export`, {
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
    const res = await fetch(`${httpBase}/tools/notes/${kind}`);
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

const TODO_LINE_RE = /^(\s*)- \[( |x|X)\] (.*)$/;

function parseTodoLines(content) {
  return content.split("\n").map((line, i) => {
    const m = line.match(TODO_LINE_RE);
    return m
      ? { i, isTodo: true, indent: m[1], checked: m[2].toLowerCase() === "x", text: m[3] }
      : { i, isTodo: false, raw: line };
  });
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

async function renderTodos() {
  panelTitle.textContent = "Todos";

  const meta = el("div", { className: "tool-status", textContent: "lade..." });
  const list = el("div", { className: "todo-list" });

  const addForm = el("form", { className: "todo-add" });
  const addInput = el("input", { type: "text", placeholder: "neues Todo, Enter zum Hinzufügen" });
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

  panelBody.append(meta, list, addForm, sourceArea, status, toolbar, fallbackRow);

  const httpBase = await getHttpBase();
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
      list.append(el("div", { className: "todo-empty", textContent: "Keine Todos." }));
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
      const del = el("button", { type: "button", className: "todo-del", textContent: "×", title: "Löschen" });
      del.addEventListener("click", () => {
        content = deleteLine(content, item.i);
        scheduleSave();
        render();
      });
      row.append(cb, text, del);
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
      const res = await fetch(`${httpBase}/tools/notes/todos`, {
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
      const res = await fetch(`${httpBase}/tools/notes/todos/export`, {
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
    const res = await fetch(`${httpBase}/tools/notes/todos`);
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

function el(tag, props = {}) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  return node;
}
