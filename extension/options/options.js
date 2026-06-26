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
const SERVER_FIELDS = ["notesPath", "maxUserTurns", "llmProvider", "llmModel", "ollamaBaseUrl", "openrouterBaseUrl", "imageGenModel", "setupAgentProvider", "setupAgentModel", "chatHeavyOpsMode", "elevenlabsVoiceId", "videoBrainSupabaseUrl", "videoBrainSupabaseUserId"];
const SERVER_KEY_MAP = {
  notesPath: "notes_path",
  maxUserTurns: "max_user_turns",
  llmProvider: "llm_provider",
  llmModel: "llm_model",
  ollamaBaseUrl: "ollama_base_url",
  openrouterBaseUrl: "openrouter_base_url",
  imageGenModel: "image_gen_model",
  setupAgentProvider: "setup_agent_provider",
  setupAgentModel: "setup_agent_model",
  chatHeavyOpsMode: "chat_heavy_ops_mode",
  elevenlabsVoiceId: "elevenlabs_voice_id",
  videoBrainSupabaseUrl: "video_brain_supabase_url",
  videoBrainSupabaseUserId: "video_brain_supabase_user_id",
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
  openrouter: {
    hint: "Beliebiges Modell als Slug (provider/model), z.B. anthropic/claude-sonnet-4.6 / openai/gpt-4o / google/gemini-2.0-flash",
    placeholder: "anthropic/claude-sonnet-4.6",
    options: [
      ["anthropic/claude-sonnet-4.6", "anthropic/claude-sonnet-4.6"],
      ["openai/gpt-4o", "openai/gpt-4o"],
      ["google/gemini-2.0-flash", "google/gemini-2.0-flash"],
      ["meta-llama/llama-3.3-70b-instruct", "meta-llama/llama-3.3-70b-instruct"],
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

let _blueprintCatalog = null;
function loadBlueprintCatalog() {
  if (!_blueprintCatalog) {
    _blueprintCatalog = jfetch("/blueprints")
      .then((d) => (Array.isArray(d) ? d : d.blueprints || []))
      .catch(() => []);
  }
  return _blueprintCatalog;
}
function computeActiveBlueprints(applied, catalog) {
  const byId = {};
  for (const b of catalog) byId[b.id] = b;
  const active = new Set();
  const walk = (id) => {
    const b = byId[id];
    if (!b || active.has(id)) return;
    active.add(id);
    for (const e of (b.extends || [])) walk(e);
  };
  for (const id of (applied || [])) walk(id);
  return active;
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
  const promptLinks = el("div", { className: "vault-prompt-links", style: "display:flex;gap:8px;margin-top:6px;" });
  const genBtn = el("button", { type: "button", className: "secondary btn-sm", textContent: "KI-Prompt generieren" });
  const copyBtn = el("button", { type: "button", className: "secondary btn-sm", textContent: "Anweisung kopieren" });
  promptLinks.append(genBtn, copyBtn);
  promptField.append(promptHint, promptArea, promptLinks);

  // --- Module-Sektion: Katalog-getriebener Aufbau + Erweiterungen ---
  const moduleSection = el("div", { className: "field" });
  moduleSection.append(el("label", { textContent: "Module — Aufbau & Erweiterungen" }));
  const modHint = el("div", { className: "hint" });
  modHint.innerHTML = 'Wähle, was dieser Vault können soll — alles non-destruktiv (bestehende Dateien bleiben). Oder <a href="#" class="vault-interview-link">per Interview einrichten/erweitern</a>.';
  modHint.querySelector(".vault-interview-link").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL(`setup/agent.html?vault_id=${encodeURIComponent(vault.id)}&mode=extend`) });
  });
  const moduleList = el("div", { className: "vault-modules" });
  moduleSection.append(modHint, moduleList);
  const appliedLocal = [...(vault.applied_blueprints || [])];

  async function applyModule(blueprintId, meta, btn) {
    btn.disabled = true;
    setStatus(`wende „${meta.name}" an…`);
    try {
      const res = blueprintId
        ? await jfetch(`/vaults/${vault.id}/apply_blueprint`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ blueprint_id: blueprintId }),
          })
        : await jfetch(`/vaults/${vault.id}/scaffold`, { method: "POST" });
      const created = (res.created || []).length;
      if (!appliedLocal.includes(meta.id)) appliedLocal.push(meta.id);
      setStatus(`„${meta.name}" angewandt — ${created} neu angelegt (non-destruktiv).`, "success");
      await renderModules();
    } catch (err) {
      setStatus("Fehler: " + err.message, "error");
      btn.disabled = false;
    }
  }

  async function renderModules() {
    moduleList.replaceChildren(el("div", { className: "hint", textContent: "lade Module…" }));
    const catalog = await loadBlueprintCatalog();
    const active = computeActiveBlueprints(appliedLocal, catalog);
    moduleList.replaceChildren();
    const mkRow = (b, isBase) => {
      const row = el("div", { className: "vault-module-row", style: "display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid var(--border,rgba(0,0,0,0.08));" });
      const info = el("div", { style: "flex:1;min-width:0;" });
      info.append(el("strong", { textContent: b.name }));
      info.append(el("div", { className: "hint", textContent: b.when_to_use || b.description || "" }));
      const right = el("div", { style: "white-space:nowrap;display:flex;gap:6px;align-items:center;" });
      if (active.has(b.id)) {
        right.append(el("span", { textContent: "✓ aktiv", style: "color:#22c55e;font-weight:600;font-size:12px;" }));
        if (isBase) {
          const r = el("button", { type: "button", className: "secondary btn-sm", textContent: "auffrischen" });
          r.addEventListener("click", () => applyModule(null, b, r));
          right.append(r);
        }
      } else {
        const add = el("button", { type: "button", className: "btn-sm", textContent: isBase ? "Basis anlegen" : "Hinzufügen" });
        add.addEventListener("click", () => applyModule(isBase ? null : b.id, b, add));
        right.append(add);
      }
      row.append(info, right);
      return row;
    };
    for (const b of catalog.filter((x) => x.category === "base" && x.id !== "empty")) moduleList.append(mkRow(b, true));
    const addons = catalog.filter((x) => x.category === "addon");
    if (addons.length) moduleList.append(el("div", { textContent: "Erweiterungen", style: "margin-top:10px;font-weight:600;opacity:0.7;font-size:12px;" }));
    for (const b of addons) moduleList.append(mkRow(b, false));
  }

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

  const saveBtn = el("button", { type: "button", textContent: "Speichern" });
  const exportBtn = el("button", { type: "button", className: "secondary btn-sm", textContent: "Blueprint exportieren" });
  const delBtn = el("button", { type: "button", className: "danger", textContent: "Löschen" });

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

  // Erweitert: Berechtigungen + Export ausklappbar
  const advanced = el("details", { className: "vault-advanced", style: "margin:6px 0;" });
  advanced.append(el("summary", { textContent: "Erweitert — Berechtigungen & Export", style: "cursor:pointer;font-weight:600;" }));
  const exportRow = el("div", { className: "field" });
  exportRow.append(exportBtn);
  advanced.append(permsField, exportRow);

  // Hauptaktionen schlank
  const actions = el("div", { className: "vault-actions" });
  actions.append(saveBtn, delBtn);

  body.append(nameField, pathField, promptField, moduleSection, advanced, actions, status);
  card.append(header, body);

  function setStatus(msg, level = "") {
    status.textContent = msg;
    status.className = "vault-status" + (level ? " " + level : "");
  }

  renderModules();

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

// ----- Briefing profiles (Baustein-Komposer) -----

// Quellen-Spec: Label + konfigurierbare Parameter je Baustein.
const BRIEFING_SOURCE_SPECS = {
  wetter:             { label: "Wetter", params: [{ key: "standorte", label: "Standorte (kommagetrennt)", type: "csv", placeholder: "Paderborn, Kavala" }] },
  todos:              { label: "Offene Todos", params: [] },
  recent_videos:      { label: "Neueste Videos", params: [{ key: "limit", label: "Anzahl", type: "number", default: 5 }] },
  recent_pages:       { label: "Zuletzt geändert", params: [{ key: "limit", label: "Anzahl", type: "number", default: 5 }, { key: "bucket", label: "Ordner (optional)", type: "text", placeholder: "z.B. areas" }] },
  active_projects:    { label: "Aktive Projekte", params: [{ key: "limit", label: "Anzahl", type: "number", default: 5 }] },
  scratchpad:         { label: "Scratchpad", params: [{ key: "limit", label: "Zeilen", type: "number", default: 10 }] },
  last_journal:       { label: "Letztes Journal", params: [] },
  fristen:            { label: "Fristen & Deadlines", params: [] },
  lernstreak:         { label: "Lernstreak", params: [] },
  vertrags_fristen:   { label: "Vertrags-Fristen", params: [] },
  kampagnen_kickoffs: { label: "Kampagnen-Kickoffs", params: [] },
  workshops:          { label: "Workshops", params: [{ key: "within", label: "Zeitfenster (Tage)", type: "number", default: 60 }] },
  anniversaries:      { label: "Jahrestage", params: [{ key: "within", label: "Zeitfenster (Tage)", type: "number", default: 30 }] },
  youtube_trending:   { label: "YouTube-Trending", params: [{ key: "youtube_nische", label: "Nische (Suchbegriffe)", type: "text", placeholder: "n8n automation tutorial" }, { key: "limit", label: "Anzahl", type: "number", default: 5 }] },
  competitor_videos:  { label: "Konkurrenz-Videos", params: [{ key: "competitor_channels", label: "Channel-IDs (eine pro Zeile)", type: "lines", placeholder: "UCxxxxxxxxxxxxxxxxxxxxxx" }, { key: "limit", label: "Anzahl", type: "number", default: 5 }] },
  playlist_trending:  { label: "Playlist-Trending", params: [{ key: "limit", label: "Anzahl", type: "number", default: 5 }] },
  recommendations:    { label: "Empfehlungen", params: [{ key: "recommendations_lookback_days", label: "Lookback (Tage)", type: "number", default: 14 }] },
};

// Spiegelt den Backend-Shim _params_for: alte flache Felder als Fallback.
const BRIEFING_LEGACY_FIELDS = {
  wetter: ["standorte"],
  youtube_trending: ["youtube_nische"],
  competitor_videos: ["competitor_channels"],
  recommendations: ["recommendations_lookback_days"],
};

let briefingEditId = null;
let briefingBlocks = []; // [{ source, params }]

async function loadBriefingProfiles() {
  const base = await getHttpBase();
  try {
    const res = await fetch(`${base}/tools/briefing/profiles`);
    const json = await res.json();
    const profiles = Array.isArray(json.data) ? json.data : (json.data?.profiles || []);
    renderBriefingProfiles(profiles);
  } catch {
    document.getElementById("briefing-profiles-list").textContent = "Server nicht erreichbar";
  }
}

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
      sourceTags.append(el("span", { className: "source-tag", textContent: BRIEFING_SOURCE_SPECS[s]?.label || s }));
    }
    title.append(sourceTags);

    const standorte = p.params?.wetter?.standorte || p.standorte;
    if (p.sources?.includes("wetter") && standorte?.length) {
      title.append(el("div", { className: "vault-path-summary", textContent: standorte.join(", ") }));
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

function _specDefaults(source) {
  const out = {};
  for (const pr of (BRIEFING_SOURCE_SPECS[source]?.params || [])) {
    if (pr.default !== undefined) out[pr.key] = pr.default;
  }
  return out;
}

function _paramsFromProfile(profile, source) {
  const p = { ...(profile.params?.[source] || {}) };
  for (const f of (BRIEFING_LEGACY_FIELDS[source] || [])) {
    if (p[f] === undefined && profile[f] !== undefined) p[f] = profile[f];
  }
  for (const pr of (BRIEFING_SOURCE_SPECS[source]?.params || [])) {
    if (p[pr.key] === undefined && pr.default !== undefined) p[pr.key] = pr.default;
  }
  return p;
}

function _paramToInput(pr, val) {
  if (pr.type === "csv") return (val || []).join(", ");
  if (pr.type === "lines") return (val || []).join("\n");
  return val ?? (pr.default ?? "");
}

function _inputToParam(pr, raw) {
  if (pr.type === "csv") return raw.split(",").map(s => s.trim()).filter(Boolean);
  if (pr.type === "lines") return raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (pr.type === "number") return parseInt(raw, 10) || pr.default || 0;
  return raw.trim();
}

function renderBriefingBlocks() {
  const list = document.getElementById("briefing-blocks-list");
  if (!list) return;
  list.replaceChildren();
  briefingBlocks.forEach((block, idx) => {
    const spec = BRIEFING_SOURCE_SPECS[block.source] || { label: block.source, params: [] };
    const row = el("div", { className: "briefing-block" });

    const head = el("div", { className: "briefing-block-head" });
    const up = el("button", { type: "button", className: "briefing-block-btn", textContent: "↑", title: "nach oben" });
    up.disabled = idx === 0;
    up.addEventListener("click", () => { [briefingBlocks[idx - 1], briefingBlocks[idx]] = [briefingBlocks[idx], briefingBlocks[idx - 1]]; renderBriefingBlocks(); });
    const down = el("button", { type: "button", className: "briefing-block-btn", textContent: "↓", title: "nach unten" });
    down.disabled = idx === briefingBlocks.length - 1;
    down.addEventListener("click", () => { [briefingBlocks[idx + 1], briefingBlocks[idx]] = [briefingBlocks[idx], briefingBlocks[idx + 1]]; renderBriefingBlocks(); });
    const label = el("strong", { textContent: spec.label, style: "flex:1;" });
    const rm = el("button", { type: "button", className: "briefing-block-btn danger", textContent: "×", title: "entfernen" });
    rm.addEventListener("click", () => { briefingBlocks.splice(idx, 1); renderBriefingBlocks(); refreshSourcePicker(); });
    head.append(up, down, label, rm);
    row.append(head);

    if (spec.params.length) {
      const pbox = el("div", { className: "briefing-block-params" });
      for (const pr of spec.params) {
        const field = el("label", { className: "briefing-param" });
        field.append(el("span", { textContent: pr.label || pr.key }));
        const input = pr.type === "lines" ? el("textarea", { rows: 2 }) : el("input", { type: pr.type === "number" ? "number" : "text" });
        if (pr.placeholder) input.placeholder = pr.placeholder;
        if (pr.type === "number") input.min = "1";
        input.value = _paramToInput(pr, block.params[pr.key]);
        input.addEventListener("input", () => { block.params[pr.key] = _inputToParam(pr, input.value); });
        field.append(input);
        pbox.append(field);
      }
      row.append(pbox);
    }
    list.append(row);
  });
}

function refreshSourcePicker() {
  const picker = document.getElementById("briefing-source-picker");
  const addBtn = document.getElementById("briefing-add-source");
  if (!picker) return;
  const used = new Set(briefingBlocks.map(b => b.source));
  picker.replaceChildren();
  let any = false;
  for (const [src, spec] of Object.entries(BRIEFING_SOURCE_SPECS)) {
    if (used.has(src)) continue;
    picker.append(el("option", { value: src, textContent: spec.label }));
    any = true;
  }
  picker.disabled = !any;
  if (addBtn) addBtn.disabled = !any;
}

function resetBriefingForm() {
  briefingEditId = null;
  document.getElementById("briefing-new-name").value = "";
  briefingBlocks = ["wetter", "todos", "recent_pages", "fristen"].map(s => ({ source: s, params: _specDefaults(s) }));
  const w = briefingBlocks.find(b => b.source === "wetter");
  if (w) w.params.standorte = ["Paderborn"];
  renderBriefingBlocks();
  refreshSourcePicker();
  const saveBtn = document.getElementById("briefing-save-new");
  if (saveBtn) saveBtn.textContent = "Profil speichern";
}

function openBriefingEditor(profile) {
  briefingEditId = profile.id;
  document.getElementById("briefing-new-name").value = profile.name || "";
  briefingBlocks = (profile.sources || []).map(src => ({ source: src, params: _paramsFromProfile(profile, src) }));
  renderBriefingBlocks();
  refreshSourcePicker();
  const saveBtn = document.getElementById("briefing-save-new");
  if (saveBtn) saveBtn.textContent = "Änderungen speichern";
  const form = document.getElementById("briefing-new-form");
  form.style.display = "block";
  document.getElementById("briefing-add-btn").style.display = "none";
  form.scrollIntoView({ behavior: "smooth", block: "center" });
}

document.getElementById("briefing-add-source")?.addEventListener("click", () => {
  const picker = document.getElementById("briefing-source-picker");
  const src = picker?.value;
  if (!src || briefingBlocks.some(b => b.source === src)) return;
  briefingBlocks.push({ source: src, params: _specDefaults(src) });
  renderBriefingBlocks();
  refreshSourcePicker();
});

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

document.getElementById("briefing-save-new")?.addEventListener("click", async () => {
  const name = document.getElementById("briefing-new-name").value.trim();
  if (!name || !briefingBlocks.length) return;
  const sources = briefingBlocks.map(b => b.source);
  const params = {};
  for (const b of briefingBlocks) {
    if (b.params && Object.keys(b.params).length) params[b.source] = b.params;
  }
  const payload = { name, sources, params };
  if (briefingEditId) payload.id = briefingEditId;

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
  const stored = await chrome.storage.local.get([...CLIENT_FIELDS, "theme", "darkMode", "showQuickRow", "uiIconScale", "uiFontScale", "explorerShowHidden", "explorerAllowDelete"]);
  for (const key of CLIENT_FIELDS) {
    const e = document.getElementById(key);
    if (e && stored[key] !== undefined) e.value = stored[key];
  }

  const theme = stored.theme || "neutral";
  setActiveSwatch(theme);
  applyThemeToPage(theme, stored.darkMode || false);

  const showQR = document.getElementById("showQuickRow");
  showQR.checked = !!stored.showQuickRow;
  showQR.addEventListener("change", () => {
    chrome.storage.local.set({ showQuickRow: showQR.checked });
  });

  const iconScale = document.getElementById("uiIconScale");
  if (iconScale) {
    iconScale.value = String(stored.uiIconScale ?? 1.15);
    iconScale.addEventListener("change", () => {
      chrome.storage.local.set({ uiIconScale: parseFloat(iconScale.value) });
    });
  }

  const fontScale = document.getElementById("uiFontScale");
  if (fontScale) {
    fontScale.value = String(stored.uiFontScale ?? 1);
    fontScale.addEventListener("change", () => {
      chrome.storage.local.set({ uiFontScale: parseFloat(fontScale.value) });
    });
  }

  const showHidden = document.getElementById("explorerShowHidden");
  if (showHidden) {
    showHidden.checked = !!stored.explorerShowHidden;
    showHidden.addEventListener("change", () => {
      chrome.storage.local.set({ explorerShowHidden: showHidden.checked });
    });
  }

  const allowDelete = document.getElementById("explorerAllowDelete");
  if (allowDelete) {
    allowDelete.checked = !!stored.explorerAllowDelete;
    allowDelete.addEventListener("change", () => {
      chrome.storage.local.set({ explorerAllowDelete: allowDelete.checked });
    });
  }

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
    setApiKeyBadge("openrouter", server.openrouter_api_key_set);
    setApiKeyBadge("gemini", server.gemini_api_key_set);
    setApiKeyBadge("youtube", server.youtube_api_key_set);
    setApiKeyBadge("elevenlabs", server.elevenlabs_api_key_set);
    setApiKeyBadge("videoBrainSupabaseAnonKey", server.video_brain_supabase_anon_key_set);
    setApiKeyBadge("videoBrainSupabaseServiceKey", server.video_brain_supabase_service_key_set);
    setApiKeyBadge("videoBrainLicense", server.video_brain_license_key_set);
    const ttsToggle = document.getElementById("chatTtsEnabled");
    if (ttsToggle) ttsToggle.checked = !!server.chat_tts_enabled;
    const chatShowSources = document.getElementById("chatShowSources");
    if (chatShowSources && typeof server.chat_show_sources === "boolean") {
      chatShowSources.checked = server.chat_show_sources;
    }
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
    ["openrouterApiKey", "openrouter_api_key"],
    ["geminiApiKey", "gemini_api_key"],
    ["youtubeApiKey", "youtube_api_key"],
    ["elevenlabsApiKey", "elevenlabs_api_key"],
    ["videoBrainSupabaseAnonKey", "video_brain_supabase_anon_key"],
    ["videoBrainSupabaseServiceKey", "video_brain_supabase_service_key"],
    ["videoBrainLicenseKey", "video_brain_license_key"],
  ];
  const ttsToggleEl = document.getElementById("chatTtsEnabled");
  if (ttsToggleEl) serverPayload.chat_tts_enabled = ttsToggleEl.checked;
  const chatShowSourcesEl = document.getElementById("chatShowSources");
  if (chatShowSourcesEl) serverPayload.chat_show_sources = chatShowSourcesEl.checked;
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
      setApiKeyBadge("openrouter", updated.openrouter_api_key_set);
      setApiKeyBadge("gemini", updated.gemini_api_key_set);
      setApiKeyBadge("youtube", updated.youtube_api_key_set);
      setApiKeyBadge("elevenlabs", updated.elevenlabs_api_key_set);
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

// ── video-brain QR-Pairing ──────────────────────────────────────────────────

document.getElementById("generateVideoBrainQrBtn")?.addEventListener("click", async () => {
  const hint = document.getElementById("videoBrainQrHint");
  const container = document.getElementById("videoBrainQrCanvas");
  const wrapper = document.getElementById("videoBrainQrContainer");
  hint.textContent = "";

  try {
    const data = await jfetch("/tools/video-brain/pair-config");
    if (!data.supabase_url || !data.supabase_anon_key || !data.user_id) {
      hint.textContent = "Supabase-URL, Anon-Key und User-ID müssen zuerst gespeichert sein.";
      return;
    }
    const payload = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
    const appUrl = `https://video-brain.ewtos.com/setup?c=${payload}`;
    container.innerHTML = "";
    new QRCode(container, { text: appUrl, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });
    wrapper.style.display = "block";
    hint.textContent = appUrl;
  } catch (e) {
    hint.textContent = `Fehler: ${e.message}`;
  }
});
