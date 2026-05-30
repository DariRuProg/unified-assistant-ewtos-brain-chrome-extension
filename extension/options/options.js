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
const SERVER_FIELDS = ["notesPath", "maxUserTurns", "llmProvider", "llmModel", "ollamaBaseUrl", "imageGenModel", "setupAgentProvider", "setupAgentModel"];
const SERVER_KEY_MAP = {
  notesPath: "notes_path",
  maxUserTurns: "max_user_turns",
  llmProvider: "llm_provider",
  llmModel: "llm_model",
  ollamaBaseUrl: "ollama_base_url",
  imageGenModel: "image_gen_model",
  setupAgentProvider: "setup_agent_provider",
  setupAgentModel: "setup_agent_model",
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

  const writeFilesLabel = el("label", { className: "checkbox-row" });
  const writeFilesCheckbox = el("input", { type: "checkbox" });
  writeFilesCheckbox.checked = !!(vault.permissions && vault.permissions.write_files);
  const writeFilesText = el("span", { textContent: "EwtosBrain darf .md-Dateien bearbeiten und neue anlegen (Editor im Vault-Explorer)" });
  writeFilesLabel.append(writeFilesCheckbox, writeFilesText);

  const localNotesLabel = el("label", { className: "checkbox-row" });
  const localNotesCheckbox = el("input", { type: "checkbox" });
  localNotesCheckbox.checked = !!vault.use_local_notes;
  const localNotesText = el("span", { textContent: "Eigene Notes-Inbox in diesem Vault (Scratchpad/Todos/Bookmarks in <vault>/notes/)" });
  localNotesLabel.append(localNotesCheckbox, localNotesText);

  permsField.append(permsHint, writeRawLabel, writePlaylistsLabel, writeFilesLabel, localNotesLabel);

  const actions = el("div", { className: "vault-actions" });
  const genBtn = el("button", { type: "button", textContent: "Neu generieren" });
  const copyBtn = el("button", { type: "button", className: "secondary", textContent: "Anweisung kopieren" });
  const saveBtn = el("button", { type: "button", textContent: "Speichern" });
  const setupBtn = el("button", { type: "button", className: "secondary", textContent: "Setup-Agent erneut starten" });
  const exportBtn = el("button", { type: "button", className: "secondary", textContent: "Blueprint exportieren" });
  const delBtn = el("button", { type: "button", className: "danger", textContent: "Löschen" });
  actions.append(genBtn, copyBtn, saveBtn, setupBtn, exportBtn, delBtn);

  setupBtn.addEventListener("click", () => {
    const url = chrome.runtime.getURL(`setup/agent.html?vault_id=${encodeURIComponent(vault.id)}&mode=extend`);
    chrome.tabs.create({ url });
  });

  exportBtn.addEventListener("click", async () => {
    try {
      const bp = await jfetch(`/vaults/${vault.id}/blueprint`);
      const blob = new Blob([JSON.stringify(bp, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const safeName = (vault.name || "vault").replace(/[^a-z0-9_-]/gi, "_");
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeName}-blueprint.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setStatus("Blueprint exportiert", "success");
    } catch (err) {
      const msg = err.status === 404
        ? "Kein Blueprint für diesen Vault — Setup-Agent zuerst durchlaufen"
        : "Export-Fehler: " + err.message;
      setStatus(msg, "error");
    }
  });

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
          write_files: writeFilesCheckbox.checked,
        },
        use_local_notes: localNotesCheckbox.checked,
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

// ----- Add new vault: open wizard in dedicated tab -----

document.getElementById("add-vault-toggle").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("setup/wizard.html?mode=add-vault") });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "vault-added") refreshVaults();
});

// ----- Briefing profiles -----

async function loadBriefingProfiles() {
  const base = await getHttpBase();
  try {
    const res = await fetch(`${base}/tools/briefing/profiles`);
    const json = await res.json();
    renderBriefingProfiles((json.data || json).profiles || []);
  } catch {
    document.getElementById("briefing-profiles-list").textContent = "Server nicht erreichbar";
  }
}

const BRIEFING_SOURCE_LABELS = {
  wetter: "Wetter",
  todos: "Todos",
  fristen: "Fristen",
  lernstreak: "Lernstreak",
  vertrags_fristen: "Vertrags-Fristen",
  kampagnen_kickoffs: "Kampagnen-Kickoffs",
  youtube_trending: "YouTube-Trending",
  competitor_videos: "Konkurrenz-Videos",
  playlist_trending: "Playlist-Trending",
  recommendations: "Empfehlungen",
};

let briefingEditId = null;

function renderBriefingProfiles(profiles) {
  const list = document.getElementById("briefing-profiles-list");
  list.replaceChildren();
  if (!profiles.length) {
    list.append(el("div", { className: "empty-vaults", textContent: "Keine Profile vorhanden." }));
    return;
  }
  for (const p of profiles) {
    const card = el("div", { className: "vault-card" });

    const header = el("div", { className: "vault-header", style: "cursor: default;" });
    const title = el("div", { className: "vault-title" });
    title.append(el("strong", { textContent: p.name }));

    const sourceTags = el("div", { className: "source-tags" });
    for (const s of (p.sources || [])) {
      sourceTags.append(el("span", { className: "source-tag", textContent: BRIEFING_SOURCE_LABELS[s] || s }));
    }
    title.append(sourceTags);

    if (p.sources?.includes("wetter") && p.standorte?.length) {
      title.append(el("div", { className: "vault-path-summary", textContent: p.standorte.join(", ") }));
    }

    const actions = el("div", { style: "display:flex; gap:6px;" });
    const editBtn = el("button", { type: "button", className: "secondary", textContent: "Bearbeiten" });
    editBtn.addEventListener("click", () => openBriefingEditor(p));
    actions.append(editBtn);

    const deleteBtn = el("button", { type: "button", className: "danger", textContent: "Löschen" });
    deleteBtn.disabled = p.id === "default";
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(`Profil "${p.name}" löschen?`)) return;
      const base = await getHttpBase();
      await fetch(`${base}/tools/briefing/profiles/${p.id}`, { method: "DELETE" });
      loadBriefingProfiles();
    });
    actions.append(deleteBtn);

    header.append(title, actions);
    card.append(header);
    list.append(card);
  }
}

function updateBriefingConditionalFields() {
  const form = document.getElementById("briefing-new-form");
  if (!form) return;
  const checked = (val) => !!form.querySelector(`input[type='checkbox'][value='${val}']:checked`);
  const toggle = (id, show) => { document.getElementById(id).style.display = show ? "" : "none"; };
  toggle("briefing-standorte-field", checked("wetter"));
  toggle("briefing-nische-field", checked("youtube_trending"));
  toggle("briefing-competitor-field", checked("competitor_videos"));
  toggle("briefing-recommendations-field", checked("recommendations"));
}

function resetBriefingForm() {
  briefingEditId = null;
  document.getElementById("briefing-new-name").value = "";
  document.getElementById("briefing-new-standorte").value = "";
  document.getElementById("briefing-new-nische").value = "";
  document.getElementById("briefing-new-competitor").value = "";
  document.getElementById("briefing-new-recommendations-days").value = "14";
  const form = document.getElementById("briefing-new-form");
  form.querySelectorAll("input[type='checkbox']").forEach(cb => {
    cb.checked = ["wetter", "todos", "fristen", "lernstreak"].includes(cb.value);
  });
  const saveBtn = document.getElementById("briefing-save-new");
  if (saveBtn) saveBtn.textContent = "Profil speichern";
  updateBriefingConditionalFields();
}

function openBriefingEditor(profile) {
  briefingEditId = profile.id;
  document.getElementById("briefing-new-name").value = profile.name || "";
  const sources = profile.sources || [];
  const form = document.getElementById("briefing-new-form");
  form.querySelectorAll("input[type='checkbox']").forEach(cb => {
    cb.checked = sources.includes(cb.value);
  });
  document.getElementById("briefing-new-standorte").value = (profile.standorte || []).join(", ");
  document.getElementById("briefing-new-nische").value = profile.youtube_nische || "";
  document.getElementById("briefing-new-competitor").value = (profile.competitor_channels || []).join("\n");
  document.getElementById("briefing-new-recommendations-days").value = profile.recommendations_lookback_days || 14;
  const saveBtn = document.getElementById("briefing-save-new");
  if (saveBtn) saveBtn.textContent = "Änderungen speichern";
  updateBriefingConditionalFields();
  form.style.display = "block";
  document.getElementById("briefing-add-btn").style.display = "none";
  form.scrollIntoView({ behavior: "smooth", block: "center" });
}

document.getElementById("briefing-add-btn")?.addEventListener("click", () => {
  resetBriefingForm();
  document.getElementById("briefing-new-form").style.display = "block";
  document.getElementById("briefing-add-btn").style.display = "none";
});

document.getElementById("briefing-cancel-new")?.addEventListener("click", () => {
  document.getElementById("briefing-new-form").style.display = "none";
  document.getElementById("briefing-add-btn").style.display = "";
  resetBriefingForm();
});

document.querySelectorAll("#briefing-new-form input[type='checkbox']").forEach(cb => {
  cb.addEventListener("change", updateBriefingConditionalFields);
});

document.getElementById("briefing-save-new")?.addEventListener("click", async () => {
  const name = document.getElementById("briefing-new-name").value.trim();
  if (!name) return;
  const sources = [...document.querySelectorAll("#briefing-new-form input[type='checkbox']:checked")].map(c => c.value);
  const standorteRaw = document.getElementById("briefing-new-standorte").value;
  const standorte = standorteRaw.split(",").map(s => s.trim()).filter(Boolean);
  const youtubeNische = document.getElementById("briefing-new-nische").value.trim();
  const competitorRaw = document.getElementById("briefing-new-competitor").value;
  const competitorChannels = competitorRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const recommendationsLookbackDays = parseInt(document.getElementById("briefing-new-recommendations-days").value, 10) || 14;

  const payload = { name, sources, standorte };
  if (briefingEditId) payload.id = briefingEditId;
  if (sources.includes("youtube_trending") && youtubeNische) payload.youtube_nische = youtubeNische;
  if (sources.includes("competitor_videos") && competitorChannels.length) payload.competitor_channels = competitorChannels;
  if (sources.includes("recommendations")) payload.recommendations_lookback_days = recommendationsLookbackDays;

  const base = await getHttpBase();
  await fetch(`${base}/tools/briefing/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  document.getElementById("briefing-new-form").style.display = "none";
  document.getElementById("briefing-add-btn").style.display = "";
  resetBriefingForm();
  loadBriefingProfiles();
});

// ----- Initial load -----

(async () => {
  const stored = await chrome.storage.local.get([...CLIENT_FIELDS, "theme", "darkMode", "hideQuickRowOnTool"]);
  for (const key of CLIENT_FIELDS) {
    const e = document.getElementById(key);
    if (e && stored[key] !== undefined) e.value = stored[key];
  }

  const theme = stored.theme || "neutral";
  setActiveSwatch(theme);
  applyThemeToPage(theme, stored.darkMode || false);

  const hideQR = document.getElementById("hideQuickRowOnTool");
  hideQR.checked = !!stored.hideQuickRowOnTool;
  hideQR.addEventListener("change", () => {
    chrome.storage.local.set({ hideQuickRowOnTool: hideQR.checked });
  });

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
    setApiKeyBadge("gemini", server.gemini_api_key_set);
    setApiKeyBadge("youtube", server.youtube_api_key_set);
  }

  const providerEl = document.getElementById("llmProvider");
  updateProviderUI(providerEl.value || "anthropic");
  providerEl.addEventListener("change", (e) => {
    updateProviderUI(e.target.value);
  });

  await refreshVaults();
  await loadBriefingProfiles();
  await refreshBlueprints();
})();

// ----- Blueprints -----

async function refreshBlueprints() {
  const list = document.getElementById("blueprint-list");
  if (!list) return;
  list.replaceChildren();
  let blueprints = [];
  try {
    const data = await jfetch("/blueprints");
    blueprints = Array.isArray(data) ? data : (data.blueprints || []);
  } catch (err) {
    list.append(el("div", { className: "empty-vaults", textContent: "Server nicht erreichbar." }));
    return;
  }
  if (!blueprints.length) {
    list.append(el("div", { className: "empty-vaults", textContent: "Keine Blueprints vorhanden." }));
    return;
  }
  for (const bp of blueprints) {
    list.append(renderBlueprintCard(bp));
  }
}

function renderBlueprintCard(bp) {
  const card = el("div", { className: "vault-card" });
  const header = el("div", { className: "vault-header", style: "cursor: default;" });

  const title = el("div", { className: "vault-title" });
  const strong = el("strong", { textContent: bp.name + (bp.version ? ` (${bp.version})` : "") });
  title.append(strong);

  const tags = el("div", { className: "source-tags" });
  const sourceTag = el("span", {
    className: "source-tag",
    textContent: bp.source === "builtin" ? "Built-in" : "Importiert",
  });
  tags.append(sourceTag);
  if (bp.trusted) {
    tags.append(el("span", { className: "source-tag", textContent: "✓ Signiert" }));
  } else if (bp.source !== "builtin") {
    tags.append(el("span", { className: "source-tag", textContent: "⚠ Unsigniert" }));
  }
  title.append(tags);

  if (bp.description) {
    title.append(el("div", { className: "vault-path-summary", textContent: bp.description }));
  }

  header.append(title);

  if (bp.source !== "builtin") {
    const delBtn = el("button", { type: "button", className: "danger", textContent: "Löschen" });
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Blueprint "${bp.name}" wirklich löschen?`)) return;
      try {
        await jfetch(`/blueprints/${encodeURIComponent(bp.id)}`, { method: "DELETE" });
        refreshBlueprints();
      } catch (err) {
        alert("Fehler: " + err.message);
      }
    });
    header.append(delBtn);
  }

  card.append(header);
  return card;
}

document.getElementById("btn-blueprint-import")?.addEventListener("click", async () => {
  const fileInput = document.getElementById("blueprint-import-file");
  const status = document.getElementById("blueprint-import-status");
  status.textContent = "";
  status.className = "vault-status";

  const file = fileInput.files?.[0];
  if (!file) {
    status.textContent = "Keine Datei gewählt.";
    status.className = "vault-status error";
    return;
  }

  let blueprint;
  try {
    const text = await file.text();
    blueprint = JSON.parse(text);
  } catch (err) {
    status.textContent = "Datei ist kein gültiges JSON: " + err.message;
    status.className = "vault-status error";
    return;
  }

  try {
    const res = await jfetch("/blueprints/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blueprint }),
    });
    if (res && res.trusted === false) {
      const proceed = confirm(
        "Dieses Blueprint ist nicht signiert. Es kann beliebige Dateien in deinem Vault anlegen.\n\nTrotzdem importieren?"
      );
      if (!proceed) {
        if (res.blueprint_id) {
          await jfetch(`/blueprints/${encodeURIComponent(res.blueprint_id)}`, { method: "DELETE" }).catch(() => {});
        }
        status.textContent = "Import abgebrochen.";
        status.className = "vault-status";
        return;
      }
    }
    status.textContent = `Importiert: ${res.blueprint_id || "ok"}`;
    status.className = "vault-status success";
    fileInput.value = "";
    refreshBlueprints();
  } catch (err) {
    status.textContent = "Import-Fehler: " + err.message;
    status.className = "vault-status error";
  }
});

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
    ["geminiApiKey", "gemini_api_key"],
    ["youtubeApiKey", "youtube_api_key"],
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
      setApiKeyBadge("gemini", updated.gemini_api_key_set);
      setApiKeyBadge("youtube", updated.youtube_api_key_set);
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
