// EwtosBrain Setup Wizard | ewtos.com

const TOTAL = 6;
let current = 1;
let connOk = false;
let selectedProvider = 'anthropic';
let vaultMode = 'new';
let savedVaultId = null;
const selectedTemplates = new Set();

const isAddVaultMode = new URLSearchParams(location.search).get('mode') === 'add-vault';

const providerModels = {
  anthropic: [
    { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6 (Standard)' },
    { value: 'claude-opus-4-7',   label: 'claude-opus-4-7' },
    { value: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5 (Schnell)' },
  ],
  openai: [
    { value: 'gpt-4o',      label: 'gpt-4o (Standard)' },
    { value: 'gpt-4o-mini', label: 'gpt-4o-mini (Schnell)' },
  ],
  ollama: [
    { value: 'llama3',   label: 'llama3 (Standard)' },
    { value: 'mistral',  label: 'mistral' },
    { value: 'gemma2',   label: 'gemma2' },
    { value: 'phi3',     label: 'phi3' },
  ],
  mistral: [
    { value: 'mistral-small-latest',  label: 'mistral-small (Standard)' },
    { value: 'mistral-medium-latest', label: 'mistral-medium' },
    { value: 'mistral-large-latest',  label: 'mistral-large' },
  ],
};

const keyLinks = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai:    'https://platform.openai.com/api-keys',
  mistral:   'https://console.mistral.ai/api-keys/',
};

function httpBase() {
  const url = document.getElementById('server-url').value.trim() || 'ws://localhost:9988/ws';
  return url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/ws$/, '');
}

// ── Progress ──────────────────────────────────────────────────────────────
function updateProgress(step) {
  const pct = ((step - 1) / (TOTAL - 1)) * 90 + 10;
  document.getElementById('progress-fill').style.width = pct + '%';
  for (let i = 1; i <= TOTAL; i++) {
    const dot  = document.getElementById('dot-' + i);
    const conn = document.getElementById('conn-' + i);
    if (!dot) continue;
    dot.className = 'step-dot';
    if (i < step)  dot.classList.add('done');
    if (i === step) dot.classList.add('active');
    if (conn) {
      conn.className = 'step-connector';
      if (i < step)  conn.classList.add('done');
      if (i === step && step < TOTAL) conn.classList.add('active');
    }
  }
}

function updateFooter(step) {
  const btnBack = document.getElementById('btn-back');
  const btnNext = document.getElementById('btn-next');
  const btnSkip = document.getElementById('btn-skip');
  const footer  = document.getElementById('step-footer');

  if (isAddVaultMode) {
    footer.style.display = step === TOTAL ? 'none' : 'flex';
    btnBack.style.display = 'none';
    btnSkip.style.display = 'none';
    btnNext.textContent = 'Vault speichern';
    btnNext.disabled = false;
    return;
  }

  // Step 5 (Template-Picker) hat eigene Buttons — Footer ausblenden
  if (step === 5) {
    footer.style.display = 'none';
    return;
  }
  footer.style.display = step === TOTAL ? 'none' : 'flex';
  btnBack.style.display = step > 1 ? 'inline-flex' : 'none';
  btnSkip.style.display = step === 4 ? 'inline-flex' : 'none';

  if (step === 1) { btnNext.textContent = "Los geht's"; btnNext.disabled = false; }
  else if (step === 2) { btnNext.textContent = 'Weiter'; btnNext.disabled = !connOk; }
  else if (step === 4) { btnNext.textContent = vaultMode === 'new' ? 'Weiter zu Templates' : 'Vault verbinden'; btnNext.disabled = false; }
  else { btnNext.textContent = 'Weiter'; btnNext.disabled = false; }
}

// ── Navigation ────────────────────────────────────────────────────────────
async function navigate(dir) {
  if (dir > 0) {
    const ok = await validateStep(current);
    if (!ok) return;
  }

  let next = current + dir;

  // Existing-Vault-Mode: Step 5 (Template-Picker) ueberspringen — User connectet
  // einen bereits befuellten Vault, wir wollen nichts drueberscaffolden.
  if (vaultMode === 'existing' && dir > 0 && current === 4) {
    next = 6;
  }
  if (vaultMode === 'existing' && dir < 0 && current === 6) {
    next = 4;
  }

  if (next < 1 || next > TOTAL) return;

  document.getElementById('step-' + current).classList.remove('active');
  const nextEl = document.getElementById('step-' + next);
  nextEl.className = 'step' + (dir < 0 ? ' back' : '');
  nextEl.classList.add('active');

  current = next;
  updateProgress(current);
  updateFooter(current);

  // Bei Eintritt in den Template-Schritt: Templates laden
  if (current === 5 && vaultMode === 'new') {
    loadTemplates();
  }

  if (current === TOTAL) {
    const pathSelector = isAddVaultMode ? '.checkmark-path-addvault' : '.checkmark-path';
    const path = document.querySelector(pathSelector);
    if (path) {
      path.style.animation = 'none';
      path.offsetHeight;
      path.style.animation = '';
    }

    if (isAddVaultMode) {
      chrome.runtime.sendMessage({ type: 'vault-added' }).catch(() => {});
    }

    // Existing-Vault: Extend-Agent als Opt-in anbieten (überschreibt nichts).
    const showExtend = vaultMode === 'existing' && !isAddVaultMode;
    document.getElementById('btn-extend-agent').style.display = showExtend ? 'inline-flex' : 'none';
    document.getElementById('btn-scaffold-base').style.display = showExtend ? 'inline-flex' : 'none';
    document.getElementById('extend-hint').style.display = showExtend ? 'block' : 'none';
  }
}

// ── Validation / Save per step ────────────────────────────────────────────
async function validateStep(step) {
  if (step === 2) return await saveServerUrl();
  if (step === 3) return await saveLlmSettings();
  if (step === 4) return await saveVault();
  return true;
}

// Step 2: save server URL to chrome.storage
async function saveServerUrl() {
  if (!connOk) {
    setStatus('conn-dot', 'conn-text', 'error', 'Bitte zuerst die Verbindung testen');
    return false;
  }
  const url = document.getElementById('server-url').value.trim();
  await chrome.storage.local.set({ serverUrl: url });
  return true;
}

// Step 3: POST /settings with LLM config
async function saveLlmSettings() {
  const status = document.getElementById('step3-status');
  status.style.display = 'none';
  const provider = selectedProvider;
  const model    = document.getElementById('model-select').value;
  const body = { llm_provider: provider, llm_model: model };

  if (provider === 'anthropic') {
    const key = document.getElementById('api-key').value.trim();
    if (key) body.anthropic_api_key = key;
  } else if (provider === 'openai') {
    const key = document.getElementById('api-key').value.trim();
    if (key) body.openai_api_key = key;
  } else if (provider === 'mistral') {
    const key = document.getElementById('api-key').value.trim();
    if (key) body.mistral_api_key = key;
  } else if (provider === 'ollama') {
    body.ollama_base_url = document.getElementById('ollama-url').value.trim() || 'http://localhost:11434';
  }

  try {
    const res = await fetch(httpBase() + '/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return true;
  } catch (e) {
    status.className = 'info-box error';
    status.textContent = 'Fehler beim Speichern: ' + e.message;
    status.style.display = 'block';
    return false;
  }
}

// Step 4: POST /vaults + optionally scaffold
async function saveVault() {
  const name = document.getElementById('vault-name').value.trim();
  const path = document.getElementById('vault-path').value.trim();
  const status = document.getElementById('step4-status');
  status.style.display = 'none';

  if (!name || !path) {
    status.className = 'info-box error';
    status.textContent = 'Name und Pfad sind Pflichtfelder.';
    status.style.display = 'block';
    return false;
  }

  const useLocalNotes = document.getElementById('vault-local-notes').checked;

  try {
    const createBody = { name, path };
    if (vaultMode === 'new') {
      createBody.use_local_notes = true;
    } else {
      createBody.use_local_notes = useLocalNotes;
    }
    const createRes = await fetch(httpBase() + '/vaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody),
    });
    if (!createRes.ok) throw new Error('Vault anlegen fehlgeschlagen: HTTP ' + createRes.status);
    const createData = await createRes.json();
    const vaultId = createData.id;
    savedVaultId = vaultId;

    const writeRaw       = document.getElementById('vault-write-raw').checked;
    const writePlaylists = document.getElementById('vault-write-playlists').checked;
    await fetch(httpBase() + '/vaults/' + vaultId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        permissions: { write_raw: writeRaw, write_playlists: writePlaylists },
        use_local_notes: useLocalNotes,
      }),
    });

    if (vaultMode === 'new') {
      status.className = 'info-box success';
      status.textContent = 'Vault-Eintrag angelegt. Im naechsten Schritt waehlst du den Aufbau.';
      status.style.display = 'block';
    }
    return true;
  } catch (e) {
    status.className = 'info-box error';
    status.textContent = e.message;
    status.style.display = 'block';
    return false;
  }
}

// ── Template-Picker ───────────────────────────────────────────────────────
async function loadTemplates() {
  const list = document.getElementById('template-list');
  list.replaceChildren();
  list.innerHTML = '<div class="info-box neutral">Lade Templates…</div>';

  try {
    const res = await fetch(httpBase() + '/blueprints');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const blueprints = Array.isArray(data) ? data : (data.blueprints || []);
    renderTemplates(blueprints);

    // Default-Auswahl: kontext-base (Kontext-Profil als gemeinsame Basis)
    if (selectedTemplates.size === 0) {
      const def = blueprints.find(b => b.id === 'kontext-base') || blueprints[0];
      if (def) {
        selectedTemplates.add(def.id);
        const card = list.querySelector(`[data-template-id="${def.id}"]`);
        if (card) card.classList.add('selected');
      }
    }
    updateTemplatesNextBtn();
  } catch (e) {
    list.replaceChildren();
    const err = document.createElement('div');
    err.className = 'info-box error';
    err.textContent = 'Fehler beim Laden der Templates: ' + e.message;
    list.append(err);
    // Back-Button damit User trotzdem zurückkann
    const actions = document.createElement('div');
    actions.className = 'step-actions';
    const back = document.createElement('button');
    back.className = 'btn btn-secondary btn-sm';
    back.textContent = 'Zurück';
    back.addEventListener('click', () => navigate(-1));
    actions.append(back);
    list.append(actions);
  }
}

function renderTemplates(blueprints) {
  const list = document.getElementById('template-list');
  list.replaceChildren();

  if (!blueprints.length) {
    const empty = document.createElement('div');
    empty.className = 'info-box neutral';
    empty.textContent = 'Keine Templates gefunden.';
    list.append(empty);
    return;
  }

  const makeCard = (bp) => {
    const card = document.createElement('div');
    card.className = 'template-card';
    card.dataset.templateId = bp.id;
    if (selectedTemplates.has(bp.id)) card.classList.add('selected');

    const check = document.createElement('div');
    check.className = 'template-check';

    const body = document.createElement('div');
    body.className = 'template-body';

    const name = document.createElement('div');
    name.className = 'template-name';
    name.textContent = bp.name + (bp.version ? ` (${bp.version})` : '');

    const desc = document.createElement('div');
    desc.className = 'template-desc';
    desc.textContent = bp.when_to_use || bp.description || 'Keine Beschreibung.';

    body.append(name, desc);
    card.append(check, body);

    card.addEventListener('click', () => {
      if (selectedTemplates.has(bp.id)) {
        selectedTemplates.delete(bp.id);
        card.classList.remove('selected');
      } else {
        selectedTemplates.add(bp.id);
        card.classList.add('selected');
      }
      updateTemplatesNextBtn();
    });
    return card;
  };

  const cat = (bp) => bp.category || ((bp.extends && bp.extends.length) ? 'addon' : 'base');
  const bases = blueprints.filter((b) => cat(b) === 'base');
  const addons = blueprints.filter((b) => cat(b) === 'addon');
  const groupHeader = (text) => {
    const h = document.createElement('div');
    h.className = 'template-group-header';
    h.textContent = text;
    h.style.cssText = 'font-weight:600;opacity:0.7;font-size:13px;margin:14px 0 6px;';
    list.append(h);
  };
  if (bases.length) {
    groupHeader('Basis — der Grundaufbau');
    for (const bp of bases) list.append(makeCard(bp));
  }
  if (addons.length) {
    groupHeader('Erweiterungen — optional dazu');
    for (const bp of addons) list.append(makeCard(bp));
  }

  // Buttons-Row anhängen
  const actions = document.createElement('div');
  actions.className = 'step-actions';
  const backBtn = document.createElement('button');
  backBtn.className = 'btn btn-secondary btn-sm';
  backBtn.id = 'btn-templates-back';
  backBtn.textContent = 'Zurück';
  backBtn.addEventListener('click', () => navigate(-1));

  const spacer = document.createElement('div');
  spacer.className = 'footer-spacer';

  const nextBtn = document.createElement('button');
  nextBtn.className = 'btn btn-primary btn-sm';
  nextBtn.id = 'btn-templates-next';
  nextBtn.textContent = 'Weiter mit Setup-Agent';
  nextBtn.disabled = selectedTemplates.size === 0;
  nextBtn.addEventListener('click', () => openSetupAgent('fresh'));

  actions.append(backBtn, spacer, nextBtn);
  list.append(actions);
}

function updateTemplatesNextBtn() {
  const btn = document.getElementById('btn-templates-next');
  if (btn) btn.disabled = selectedTemplates.size === 0;
}

async function openSetupAgent(mode = 'fresh') {
  if (!savedVaultId) return;
  if (mode === 'fresh' && selectedTemplates.size === 0) return;
  const templates = [...selectedTemplates].join(',');
  await chrome.storage.local.set({
    setupAgentContext: {
      vault_id: savedVaultId,
      templates: [...selectedTemplates],
      mode,
      opened_at: Date.now(),
    },
  });
  const url = chrome.runtime.getURL(`setup/agent.html?vault_id=${encodeURIComponent(savedVaultId)}&mode=${mode}&templates=${encodeURIComponent(templates)}`);
  chrome.tabs.create({ url });
  // Wizard-Tab nach kurzer Verzögerung schließen
  setTimeout(() => {
    chrome.tabs.getCurrent(tab => { if (tab) chrome.tabs.remove(tab.id); });
  }, 400);
}

async function skipSetupAgent() {
  const status = document.getElementById('step5-status');
  status.style.display = 'none';
  if (!savedVaultId) {
    status.className = 'info-box error';
    status.textContent = 'Vault-ID fehlt — bitte zurück zu Schritt 4.';
    status.style.display = 'block';
    return;
  }
  const chosen = [...selectedTemplates];
  if (!chosen.length) chosen.push('kontext-base');
  status.className = 'info-box neutral';
  status.textContent = 'Wende gewählte Module an…';
  status.style.display = 'block';
  try {
    // Jedes gewählte Blueprint non-destruktiv anwenden (löst extends selbst auf).
    for (const blueprint_id of chosen) {
      const res = await fetch(httpBase() + `/vaults/${savedVaultId}/apply_blueprint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blueprint_id }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Anwenden von ${blueprint_id} fehlgeschlagen: ` + errText);
      }
    }
    // Weiter zu Step 6 (Fertig)
    document.getElementById('step-5').classList.remove('active');
    document.getElementById('step-6').classList.add('active');
    current = 6;
    updateProgress(6);
    updateFooter(6);
    const path = document.querySelector('.checkmark-path');
    if (path) { path.style.animation = 'none'; path.offsetHeight; path.style.animation = ''; }
  } catch (e) {
    status.className = 'info-box error';
    status.textContent = 'Fehler: ' + e.message;
    status.style.display = 'block';
  }
}

// ── Connection Test ───────────────────────────────────────────────────────
document.getElementById('btn-test-conn').addEventListener('click', async () => {
  const btn = document.getElementById('btn-test-conn');
  btn.disabled = true;
  btn.textContent = 'Verbinde...';
  setStatus('conn-dot', 'conn-text', 'connecting', 'Verbinde...');
  connOk = false;
  document.getElementById('btn-next').disabled = true;

  try {
    const res = await fetch(httpBase() + '/health', { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      setStatus('conn-dot', 'conn-text', 'ok', 'Verbunden — Server erreichbar');
      connOk = true;
      document.getElementById('btn-next').disabled = false;
    } else {
      throw new Error('HTTP ' + res.status);
    }
  } catch {
    setStatus('conn-dot', 'conn-text', 'error', 'Verbindung fehlgeschlagen. Ist der Server gestartet?');
  }

  btn.disabled = false;
  btn.textContent = 'Nochmal testen';
});

function setStatus(dotId, textId, state, msg) {
  const dot  = document.getElementById(dotId);
  const text = document.getElementById(textId);
  dot.className  = 'status-dot ' + (state !== 'ok' && state !== 'error' ? state : state);
  text.className = 'status-text ' + (state === 'ok' || state === 'error' ? state : '');
  text.textContent = msg;
}

// ── Provider Selection ────────────────────────────────────────────────────
document.querySelectorAll('.provider-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.provider-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    selectedProvider = card.dataset.provider;

    const cloudFields  = document.getElementById('provider-fields-cloud');
    const ollamaFields = document.getElementById('provider-fields-ollama');
    const keyLink      = document.getElementById('key-gen-link');
    const apiKeyInput  = document.getElementById('api-key');
    const modelSel     = document.getElementById('model-select');

    if (selectedProvider === 'ollama') {
      cloudFields.style.display  = 'none';
      ollamaFields.style.display = 'block';
    } else {
      cloudFields.style.display  = 'block';
      ollamaFields.style.display = 'none';
      apiKeyInput.placeholder = selectedProvider === 'anthropic' ? 'sk-ant-...' : selectedProvider === 'openai' ? 'sk-...' : 'API-Key';
      if (keyLinks[selectedProvider]) {
        keyLink.href = keyLinks[selectedProvider];
        keyLink.style.display = 'inline';
      } else {
        keyLink.style.display = 'none';
      }
    }

    modelSel.replaceChildren();
    (providerModels[selectedProvider] || []).forEach(m => {
      modelSel.append(new Option(m.label, m.value));
    });
  });
});

// Default-Provider beim Laden setzen (Anthropic ist vorausgewählt, ohne Klick
// wäre der Key-Link sonst leer).
if (keyLinks[selectedProvider]) {
  document.getElementById('key-gen-link').href = keyLinks[selectedProvider];
}

// Fenster-ID vorab holen, damit der Quick-Start das Side-Panel synchron öffnen kann.
let wizardWindowId = null;
chrome.windows.getCurrent().then(w => { wizardWindowId = w.id; }).catch(() => {});

// ── Vault-Pfad durchsuchen (nativer Ordner-Dialog via Server) ─────────────
document.getElementById('btn-browse-vault').addEventListener('click', async () => {
  const btn = document.getElementById('btn-browse-vault');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Wähle…';
  try {
    const res = await fetch(httpBase() + '/pick_folder');
    const data = await res.json();
    if (data.ok && data.path) {
      document.getElementById('vault-path').value = data.path;
    }
  } catch { /* Dialog abgebrochen oder Server offline — Eingabefeld bleibt */ }
  finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

// ── Vault Mode Toggle ─────────────────────────────────────────────────────
document.getElementById('mode-new').addEventListener('click', () => {
  vaultMode = 'new';
  document.getElementById('mode-new').classList.add('active');
  document.getElementById('mode-existing').classList.remove('active');
  document.getElementById('vault-new-hint').style.display = 'block';
  updateFooter(current);
});
document.getElementById('mode-existing').addEventListener('click', () => {
  vaultMode = 'existing';
  document.getElementById('mode-existing').classList.add('active');
  document.getElementById('mode-new').classList.remove('active');
  document.getElementById('vault-new-hint').style.display = 'none';
  updateFooter(current);
});

// ── Footer buttons ────────────────────────────────────────────────────────
document.getElementById('btn-next').addEventListener('click', () => navigate(1));
document.getElementById('btn-back').addEventListener('click', () => navigate(-1));
document.getElementById('btn-skip').addEventListener('click', () => {
  // Skip-Button überspringt Vault komplett → direkt zu Step 6
  document.getElementById('step-' + current).classList.remove('active');
  document.getElementById('step-6').classList.add('active');
  current = 6;
  updateProgress(6);
  updateFooter(6);
  const path = document.querySelector('.checkmark-path');
  if (path) { path.style.animation = 'none'; path.offsetHeight; path.style.animation = ''; }
});

// ── Setup-Agent-Überspringen-Link ─────────────────────────────────────────
document.getElementById('skip-setup-agent').addEventListener('click', (e) => {
  e.preventDefault();
  skipSetupAgent();
});

// ── Step 6 (Fertig) buttons ───────────────────────────────────────────────
document.getElementById('btn-open-extension').addEventListener('click', () => {
  chrome.tabs.getCurrent(tab => { if (tab) chrome.tabs.remove(tab.id); });
});
document.getElementById('btn-open-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
document.getElementById('btn-extend-agent').addEventListener('click', () => openSetupAgent('extend'));
document.getElementById('btn-scaffold-base').addEventListener('click', async () => {
  if (!savedVaultId) return;
  const btn = document.getElementById('btn-scaffold-base');
  const hint = document.getElementById('extend-hint');
  btn.disabled = true;
  try {
    const res = await fetch(httpBase() + `/vaults/${encodeURIComponent(savedVaultId)}/scaffold`, { method: 'POST' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const created = (data.created || []).length;
    const skills = (data.copied_skills || []).length;
    hint.className = 'info-box success';
    hint.innerHTML = `<strong>Basis-Struktur angelegt.</strong> ${created} Eintraege erstellt, ${skills} Skills. CLAUDE.md, index, kontext/ und .claude/skills/ liegen jetzt im Vault. Fuer persoenliche Inhalte den Setup-Agenten starten.`;
    hint.style.display = 'block';
  } catch (e) {
    hint.className = 'info-box error';
    hint.textContent = 'Fehler: ' + e.message;
    hint.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
});
const QC_TOOL = { 'qc-youtube': 'youtube_transcript', 'qc-chat': 'chat', 'qc-notes': 'scratchpad' };
Object.keys(QC_TOOL).forEach(id => {
  document.getElementById(id).addEventListener('click', () => {
    // sidePanel.open MUSS synchron in der User-Geste laufen (kein await davor).
    try { if (wizardWindowId != null) chrome.sidePanel.open({ windowId: wizardWindowId }); } catch {}
    chrome.storage.local.set({ startTool: QC_TOOL[id] });
    setTimeout(() => chrome.tabs.getCurrent(tab => { if (tab) chrome.tabs.remove(tab.id); }), 150);
  });
});

// ── Add-Vault-Modus: nur Step 4 zeigen, Server-URL aus Storage laden ──────
document.getElementById('btn-addvault-close').addEventListener('click', () => {
  chrome.tabs.getCurrent(tab => { if (tab) chrome.tabs.remove(tab.id); });
});

if (isAddVaultMode) {
  document.title = 'EwtosBrain — Vault hinzufügen';
  document.querySelector('.progress-header').style.display = 'none';
  document.getElementById('step-1').classList.remove('active');
  document.getElementById('step-4').classList.add('active');
  document.getElementById('step5-default').style.display = 'none';
  document.getElementById('step5-addvault').style.display = 'block';
  current = 4;
  chrome.storage.local.get('serverUrl', ({ serverUrl }) => {
    if (serverUrl) document.getElementById('server-url').value = serverUrl;
  });
  updateFooter(4);
}
