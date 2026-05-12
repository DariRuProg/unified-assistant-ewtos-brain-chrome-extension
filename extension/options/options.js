// ewtos.com
const CLIENT_FIELDS = ["serverUrl"];

// ── Theme ─────────────────────────────────────────────────────────────────────

function applyThemeToPage(theme, darkMode) {
  const html = document.documentElement;
  if (theme && theme !== "neutral") {
    html.dataset.theme = theme;
  } else {
    delete html.dataset.theme;
  }
  if (darkMode) {
    html.dataset.mode = "dark";
  } else {
    delete html.dataset.mode;
  }
}

function setActiveSwatch(theme) {
  document.querySelectorAll(".theme-swatch").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.theme === theme);
  });
  const hidden = document.getElementById("theme");
  if (hidden) hidden.value = theme;
}

document.querySelectorAll(".theme-swatch").forEach((btn) => {
  btn.addEventListener("click", () => {
    const theme = btn.dataset.theme;
    setActiveSwatch(theme);
    chrome.storage.local.get("darkMode", ({ darkMode = false }) => {
      applyThemeToPage(theme, darkMode);
      chrome.storage.local.set({ theme });
    });
  });
});
const SERVER_FIELDS = ["notesPath", "maxUserTurns", "llmProvider", "llmModel", "ollamaBaseUrl"];
const SERVER_KEY_MAP = {
  notesPath: "notes_path",
  maxUserTurns: "max_user_turns",
  llmProvider: "llm_provider",
  llmModel: "llm_model",
  ollamaBaseUrl: "ollama_base_url",
};

// Provider-spezifische Modell-Hints + Datalist-Werte
const PROVIDER_MODELS = {
  anthropic: {
    hint: "Modelle: claude-opus-4-7 / claude-sonnet-4-6 / claude-haiku-4-5",
    placeholder: "claude-opus-4-7",
    options: [
      ["claude-opus-4-7", "claude-opus-4-7 (Default, am stärksten für Tool-Use)"],
      ["claude-sonnet-4-6", "claude-sonnet-4-6 (günstiger)"],
      ["claude-haiku-4-5", "claude-haiku-4-5 (schnell, günstig)"],
    ],
  },
  openai: {
    hint: "Modelle: gpt-4o / gpt-4o-mini / o1-mini",
    placeholder: "gpt-4o-mini",
    options: [
      ["gpt-4o", "gpt-4o"],
      ["gpt-4o-mini", "gpt-4o-mini (günstiger)"],
      ["o1-mini", "o1-mini (reasoning)"],
    ],
  },
  ollama: {
    hint: "Modelle (vorher pullen: ollama pull <name>): llama3.1:8b / qwen2.5:7b / mistral-nemo",
    placeholder: "llama3.1:8b",
    options: [
      ["llama3.1:8b", "llama3.1:8b (tool-fähig)"],
      ["qwen2.5:7b", "qwen2.5:7b (tool-fähig)"],
      ["mistral-nemo", "mistral-nemo"],
    ],
  },
  mistral: {
    hint: "Modelle: mistral-large-latest / mistral-small-latest",
    placeholder: "mistral-large-latest",
    options: [
      ["mistral-large-latest", "mistral-large-latest"],
      ["mistral-small-latest", "mistral-small-latest (günstiger)"],
    ],
  },
};

function updateProviderUI(provider) {
  document.querySelectorAll(".provider-field").forEach((el) => {
    el.classList.toggle("hidden", el.dataset.provider !== provider);
  });

  const cfg = PROVIDER_MODELS[provider] || PROVIDER_MODELS.anthropic;
  const hint = document.getElementById("llmModelHint");
  if (hint) hint.textContent = cfg.hint;
  const modelInput = document.getElementById("llmModel");
  if (modelInput) modelInput.placeholder = cfg.placeholder;
  const dl = document.getElementById("llmModelList");
  if (dl) {
    dl.replaceChildren();
    for (const [value, label] of cfg.options) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      dl.append(o);
    }
  }
}

function setApiKeyBadge(provider, isSet) {
  const badge = document.getElementById(`${provider}ApiKeyStatus`);
  if (!badge) return;
  if (isSet) {
    badge.textContent = "(gesetzt — leer lassen, um nicht zu ändern)";
    badge.style.color = "#22c55e";
  } else {
    badge.textContent = "(noch nicht gesetzt)";
    badge.style.color = "#ef4444";
  }
}

function el(tag, props = {}) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  return node;
}

function httpBaseFromWs(url) {
  return (url || "ws://localhost:9988/ws")
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/ws$/, "");
}

async function getHttpBase() {
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  return httpBaseFromWs(serverUrl);
}

async function jfetch(path, opts = {}) {
  const base = await getHttpBase();
  const res = await fetch(`${base}${path}`, opts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) {
    const msg = data?.detail || text || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ----- Server settings (notes_path, chat_model, max_user_turns, api_key) -----

async function loadServerSettings() {
  try { return await jfetch("/settings"); } catch { return null; }
}

async function saveServerSettings(values) {
  return jfetch("/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(values),
  });
}

// ----- Vault management -----

async function loadVaults() {
  try {
    const data = await jfetch("/vaults");
    return data?.vaults || [];
  } catch { return []; }
}

async function createVault({ name, path, system_prompt }) {
  return jfetch("/vaults", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, path, system_prompt }),
  });
}

async function updateVault(id, patch) {
  return jfetch(`/vaults/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

async function deleteVault(id) {
  return jfetch(`/vaults/${id}`, { method: "DELETE" });
}

async function generatePrompt(path) {
  return jfetch("/vaults/generate-prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

async function previewClaudeMd(path) {
  return jfetch("/vaults/preview-claude-md", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

// ----- Render vault list -----

const vaultsContainer = document.getElementById("vaults-container");

async function refreshVaults() {
  vaultsContainer.replaceChildren();
  const vaults = await loadVaults();
  if (!vaults.length) {
    vaultsContainer.append(el("div", { className: "empty-vaults", textContent: "Noch kein Vault verbunden." }));
    return;
  }
  for (const v of vaults) {
    vaultsContainer.append(renderVaultCard(v));
  }
}

function renderVaultCard(vault) {
  const card = el("div", { className: "vault-card" });

  const header = el("div", { className: "vault-header" });
  const title = el("div", { className: "vault-title" });
  const titleStrong = el("strong", { textContent: vault.name });
  const pathSummary = el("div", { className: "vault-path-summary", textContent: vault.path });
  title.append(titleStrong, pathSummary);
  const toggle = el("button", { type: "button", className: "vault-toggle", textContent: "▾" });
  header.append(title, toggle);

  const body = el("div", { className: "vault-body" });

  const nameField = el("div", { className: "field" });
  nameField.append(el("label", { textContent: "Name" }));
  const nameInput = el("input", { type: "text", value: vault.name });
  nameField.append(nameInput);

  const pathField = el("div", { className: "field" });
  pathField.append(el("label", { textContent: "Pfad" }));
  const pathInput = el("input", { type: "text", value: vault.path });
  pathField.append(pathInput);

  const promptField = el("div", { className: "field" });
  promptField.append(el("label", { textContent: "System-Prompt (optional Override)" }));
  const claudeMdHint = vault.has_claude_md
    ? "✓ <code>CLAUDE.md</code> im Vault gefunden — Feld leer lassen, dann wird sie automatisch als System-Prompt verwendet. Schreib hier nur was rein wenn du die CLAUDE.md überschreiben willst."
    : "✗ Keine <code>CLAUDE.md</code> im Vault. Wenn dieses Feld leer bleibt nutzt der Bot einen minimalen Default — leg eine CLAUDE.md im Vault an oder schreib hier einen Prompt.";
  const promptHint = el("div", { className: "hint" });
  promptHint.innerHTML = claudeMdHint;
  const promptArea = el("textarea", { value: vault.system_prompt || "" });
  promptField.append(promptHint, promptArea);

  const permsField = el("div", { className: "field" });
  permsField.append(el("label", { textContent: "Berechtigungen für EwtosBrain in diesem Vault" }));
  const permsHint = el("div", { className: "hint" });
  permsHint.innerHTML = "Standard: nur Lese-Zugriff auf <code>wiki/</code> + <code>raw/</code> sowie Schreiben in der globalen Notiz-Inbox <code>notes/</code>. Hier zusätzlich Schreibrechte freischalten.";
  const writeRawLabel = el("label", { className: "checkbox-row" });
  const writeRawCheckbox = el("input", { type: "checkbox" });
  writeRawCheckbox.checked = !!(vault.permissions && vault.permissions.write_raw);
  const writeRawText = el("span", { textContent: "EwtosBrain darf in raw/ schreiben (Promote-to-raw-Tool)" });
  writeRawLabel.append(writeRawCheckbox, writeRawText);

  const writePlaylistsLabel = el("label", { className: "checkbox-row" });
  const writePlaylistsCheckbox = el("input", { type: "checkbox" });
  writePlaylistsCheckbox.checked = !!(vault.permissions && vault.permissions.write_playlists);
  const writePlaylistsText = el("span", { textContent: "EwtosBrain darf Playlists in wiki/ki/playlists/ verwalten" });
  writePlaylistsLabel.append(writePlaylistsCheckbox, writePlaylistsText);

  permsField.append(permsHint, writeRawLabel, writePlaylistsLabel);

  const actions = el("div", { className: "vault-actions" });
  const genBtn = el("button", { type: "button", textContent: "Neu generieren" });
  const copyBtn = el("button", { type: "button", className: "secondary", textContent: "Anweisung kopieren" });
  const saveBtn = el("button", { type: "button", textContent: "Speichern" });
  const delBtn = el("button", { type: "button", className: "danger", textContent: "Löschen" });
  actions.append(genBtn, copyBtn, saveBtn, delBtn);

  const status = el("div", { className: "vault-status" });

  body.append(nameField, pathField, promptField, permsField, actions, status);
  card.append(header, body);

  function setStatus(msg, level = "") {
    status.textContent = msg;
    status.className = "vault-status" + (level ? " " + level : "");
  }

  header.addEventListener("click", (e) => {
    if (e.target === toggle || toggle.contains(e.target)) return;
    card.classList.toggle("editing");
    toggle.textContent = card.classList.contains("editing") ? "▴" : "▾";
  });
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    card.classList.toggle("editing");
    toggle.textContent = card.classList.contains("editing") ? "▴" : "▾";
  });

  genBtn.addEventListener("click", async () => {
    const path = pathInput.value.trim();
    if (!path) { setStatus("Pfad fehlt", "error"); return; }
    genBtn.disabled = true;
    setStatus("generiere... (paar Sekunden)");
    try {
      const result = await generatePrompt(path);
      promptArea.value = result.prompt;
      setStatus(`fertig — überprüfe und speichere`, "success");
    } catch (err) {
      setStatus("Fehler: " + err.message, "error");
    } finally {
      genBtn.disabled = false;
    }
  });

  copyBtn.addEventListener("click", async () => {
    const path = pathInput.value.trim();
    if (!path) { setStatus("Pfad fehlt", "error"); return; }
    try {
      const result = await previewClaudeMd(path);
      await navigator.clipboard.writeText(result.generator_instruction);
      setStatus("Anweisung in Zwischenablage — füg sie in einem beliebigen LLM ein", "success");
    } catch (err) {
      setStatus("Fehler: " + err.message, "error");
    }
  });

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      const updated = await updateVault(vault.id, {
        name: nameInput.value.trim(),
        path: pathInput.value.trim(),
        system_prompt: promptArea.value,
        permissions: {
          write_raw: writeRawCheckbox.checked,
          write_playlists: writePlaylistsCheckbox.checked,
        },
      });
      titleStrong.textContent = updated.name;
      pathSummary.textContent = updated.path;
      setStatus("gespeichert", "success");
    } catch (err) {
      setStatus("Fehler: " + err.message, "error");
    } finally {
      saveBtn.disabled = false;
    }
  });

  delBtn.addEventListener("click", async () => {
    if (!confirm(`Vault "${vault.name}" wirklich löschen? Auch der Chat-Verlauf wird gelöscht.`)) return;
    try {
      await deleteVault(vault.id);
      card.remove();
      // If list empty after removal, show placeholder
      if (!vaultsContainer.querySelector(".vault-card")) {
        vaultsContainer.append(el("div", { className: "empty-vaults", textContent: "Noch kein Vault verbunden." }));
      }
    } catch (err) {
      setStatus("Fehler: " + err.message, "error");
    }
  });

  return card;
}

// ----- New-vault form -----

const addToggleBtn = document.getElementById("add-vault-toggle");
const addForm = document.getElementById("add-vault-form");
const newName = document.getElementById("newVaultName");
const newPath = document.getElementById("newVaultPath");
const newPrompt = document.getElementById("newVaultPrompt");
const newGenBtn = document.getElementById("newVaultGenerate");
const newCopyBtn = document.getElementById("newVaultCopyInstr");
const newSaveBtn = document.getElementById("newVaultSave");
const newCancelBtn = document.getElementById("newVaultCancel");
const newStatus = document.getElementById("newVaultStatus");

function setNewStatus(msg, level = "") {
  newStatus.textContent = msg;
  newStatus.className = "vault-status" + (level ? " " + level : "");
}

function resetNewForm() {
  newName.value = "";
  newPath.value = "";
  newPrompt.value = "";
  setNewStatus("");
}

addToggleBtn.addEventListener("click", () => {
  addForm.classList.toggle("hidden");
  if (!addForm.classList.contains("hidden")) newName.focus();
});

newCancelBtn.addEventListener("click", () => {
  addForm.classList.add("hidden");
  resetNewForm();
});

newGenBtn.addEventListener("click", async () => {
  const path = newPath.value.trim();
  if (!path) { setNewStatus("Pfad fehlt", "error"); return; }
  newGenBtn.disabled = true;
  setNewStatus("generiere... (paar Sekunden)");
  try {
    const result = await generatePrompt(path);
    newPrompt.value = result.prompt;
    setNewStatus("fertig — überprüfe und speichere", "success");
  } catch (err) {
    setNewStatus("Fehler: " + err.message, "error");
  } finally {
    newGenBtn.disabled = false;
  }
});

newCopyBtn.addEventListener("click", async () => {
  const path = newPath.value.trim();
  if (!path) { setNewStatus("Pfad fehlt", "error"); return; }
  try {
    const result = await previewClaudeMd(path);
    await navigator.clipboard.writeText(result.generator_instruction);
    setNewStatus("Anweisung in Zwischenablage — füg sie in einem beliebigen LLM ein", "success");
  } catch (err) {
    setNewStatus("Fehler: " + err.message, "error");
  }
});

newSaveBtn.addEventListener("click", async () => {
  const name = newName.value.trim();
  const path = newPath.value.trim();
  if (!name) { setNewStatus("Name fehlt", "error"); return; }
  if (!path) { setNewStatus("Pfad fehlt", "error"); return; }
  newSaveBtn.disabled = true;
  try {
    await createVault({ name, path, system_prompt: newPrompt.value });
    addForm.classList.add("hidden");
    resetNewForm();
    refreshVaults();
  } catch (err) {
    setNewStatus("Fehler: " + err.message, "error");
  } finally {
    newSaveBtn.disabled = false;
  }
});

// ----- Initial load -----

(async () => {
  const stored = await chrome.storage.local.get([...CLIENT_FIELDS, "theme", "darkMode"]);
  for (const key of CLIENT_FIELDS) {
    const e = document.getElementById(key);
    if (e && stored[key] !== undefined) e.value = stored[key];
  }

  const theme = stored.theme || "neutral";
  setActiveSwatch(theme);
  applyThemeToPage(theme, stored.darkMode || false);

  const server = await loadServerSettings();
  if (server) {
    for (const fieldId of SERVER_FIELDS) {
      const e = document.getElementById(fieldId);
      const value = server[SERVER_KEY_MAP[fieldId]];
      if (e && value !== undefined && value !== null) e.value = value;
    }
    setApiKeyBadge("anthropic", server.anthropic_api_key_set);
    setApiKeyBadge("openai", server.openai_api_key_set);
    setApiKeyBadge("mistral", server.mistral_api_key_set);
  }

  const providerEl = document.getElementById("llmProvider");
  updateProviderUI(providerEl.value || "anthropic");
  providerEl.addEventListener("change", (e) => {
    updateProviderUI(e.target.value);
  });

  await refreshVaults();
})();

document.getElementById("save").addEventListener("click", async () => {
  const previous = await chrome.storage.local.get(CLIENT_FIELDS);
  const clientPayload = {};
  for (const key of CLIENT_FIELDS) {
    const e = document.getElementById(key);
    if (e) clientPayload[key] = e.value.trim();
  }
  await chrome.storage.local.set(clientPayload);
  const serverUrlChanged = (previous.serverUrl || "") !== (clientPayload.serverUrl || "");

  const serverPayload = {};
  for (const fieldId of SERVER_FIELDS) {
    const e = document.getElementById(fieldId);
    if (!e) continue;
    const v = e.value.trim();
    if (!v) continue;
    serverPayload[SERVER_KEY_MAP[fieldId]] = fieldId === "maxUserTurns" ? parseInt(v, 10) : v;
  }
  const apiKeyInputs = [
    ["anthropicApiKey", "anthropic_api_key"],
    ["openaiApiKey", "openai_api_key"],
    ["mistralApiKey", "mistral_api_key"],
  ];
  for (const [elId, payloadKey] of apiKeyInputs) {
    const el = document.getElementById(elId);
    if (el && el.value.trim()) serverPayload[payloadKey] = el.value.trim();
  }

  let serverError = null;
  if (Object.keys(serverPayload).length) {
    try {
      const updated = await saveServerSettings(serverPayload);
      for (const [elId] of apiKeyInputs) {
        const el = document.getElementById(elId);
        if (el) el.value = "";
      }
      setApiKeyBadge("anthropic", updated.anthropic_api_key_set);
      setApiKeyBadge("openai", updated.openai_api_key_set);
      setApiKeyBadge("mistral", updated.mistral_api_key_set);
    } catch (err) {
      serverError = err.message || String(err);
    }
  }

  const saved = document.getElementById("saved");
  saved.hidden = false;
  saved.textContent = serverError ? `lokal gespeichert (Server: ${serverError})` : "gespeichert";
  saved.style.color = serverError ? "#ef4444" : "#22c55e";
  setTimeout(() => (saved.hidden = true), serverError ? 4000 : 1500);

  if (serverUrlChanged) {
    chrome.runtime.sendMessage({ type: "reconnect" }).catch(() => {});
  }
});
