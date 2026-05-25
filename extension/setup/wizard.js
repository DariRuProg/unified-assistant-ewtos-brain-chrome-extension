// EwtosBrain Setup Wizard | ewtos.com

const TOTAL = 5;
let current = 1;
let connOk = false;
let selectedProvider = 'anthropic';
let vaultMode = 'new';
let savedVaultId = null;

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
    footer.style.display = step === 5 ? 'none' : 'flex';
    btnBack.style.display = 'none';
    btnSkip.style.display = 'none';
    btnNext.textContent = 'Vault speichern';
    btnNext.disabled = false;
    return;
  }

  footer.style.display = step === 5 ? 'none' : 'flex';
  btnBack.style.display = step > 1 ? 'inline-flex' : 'none';
  btnSkip.style.display = step === 4 ? 'inline-flex' : 'none';

  if (step === 1) { btnNext.textContent = "Los geht's"; btnNext.disabled = false; }
  else if (step === 2) { btnNext.textContent = 'Weiter'; btnNext.disabled = !connOk; }
  else { btnNext.textContent = 'Weiter'; btnNext.disabled = false; }
}

// ── Navigation ────────────────────────────────────────────────────────────
async function navigate(dir) {
  if (dir > 0) {
    const ok = await validateStep(current);
    if (!ok) return;
  }

  const next = current + dir;
  if (next < 1 || next > TOTAL) return;

  document.getElementById('step-' + current).classList.remove('active');
  const nextEl = document.getElementById('step-' + next);
  nextEl.className = 'step' + (dir < 0 ? ' back' : '');
  nextEl.classList.add('active');

  current = next;
  updateProgress(current);
  updateFooter(current);

  if (current === 5) {
    const pathSelector = isAddVaultMode ? '.checkmark-path-addvault' : '.checkmark-path';
    const path = document.querySelector(pathSelector);
    path.style.animation = 'none';
    path.offsetHeight;
    path.style.animation = '';

    if (isAddVaultMode) {
      chrome.runtime.sendMessage({ type: 'vault-added' }).catch(() => {});
    }
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
      const scaffoldRes = await fetch(httpBase() + '/vaults/' + vaultId + '/scaffold', { method: 'POST' });
      if (scaffoldRes.ok) {
        const scaffoldData = await scaffoldRes.json();
        const created = scaffoldData.created || [];
        status.className = 'info-box success';
        status.textContent = `Vault angelegt. ${created.length} Dateien erstellt.`;
        status.style.display = 'block';
      }
    }
    return true;
  } catch (e) {
    status.className = 'info-box error';
    status.textContent = e.message;
    status.style.display = 'block';
    return false;
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

// ── Vault Mode Toggle ─────────────────────────────────────────────────────
document.getElementById('mode-new').addEventListener('click', () => {
  vaultMode = 'new';
  document.getElementById('mode-new').classList.add('active');
  document.getElementById('mode-existing').classList.remove('active');
  document.getElementById('vault-new-hint').style.display = 'block';
});
document.getElementById('mode-existing').addEventListener('click', () => {
  vaultMode = 'existing';
  document.getElementById('mode-existing').classList.add('active');
  document.getElementById('mode-new').classList.remove('active');
  document.getElementById('vault-new-hint').style.display = 'none';
});

// ── Footer buttons ────────────────────────────────────────────────────────
document.getElementById('btn-next').addEventListener('click', () => navigate(1));
document.getElementById('btn-back').addEventListener('click', () => navigate(-1));
document.getElementById('btn-skip').addEventListener('click', () => {
  current++;
  document.getElementById('step-4').classList.remove('active');
  document.getElementById('step-5').classList.add('active');
  updateProgress(5);
  updateFooter(5);
  const path = document.querySelector('.checkmark-path');
  path.style.animation = 'none'; path.offsetHeight; path.style.animation = '';
});

// ── Step 5 buttons ────────────────────────────────────────────────────────
document.getElementById('btn-open-extension').addEventListener('click', () => {
  chrome.tabs.getCurrent(tab => { if (tab) chrome.tabs.remove(tab.id); });
});
document.getElementById('btn-open-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
['qc-youtube', 'qc-chat', 'qc-notes'].forEach(id => {
  document.getElementById(id).addEventListener('click', () => {
    chrome.tabs.getCurrent(tab => { if (tab) chrome.tabs.remove(tab.id); });
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
