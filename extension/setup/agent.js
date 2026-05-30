// @author Dario | ewtos.com
// EwtosBrain Setup-Agent — Chat-UI für interaktiven Vault-Blueprint-Aufbau.

const params = new URLSearchParams(location.search);
const VAULT_ID = params.get('vault_id');
const MODE = params.get('mode') || 'fresh';
const TEMPLATES = (params.get('templates') || '').split(',').map(s => s.trim()).filter(Boolean);
const USE_CASE_HINT = params.get('use_case_hint') || null;

let sessionId = null;
let workingBlueprint = null;
let lastDiffPreview = null;
let sending = false;

const chatEl  = document.getElementById('agent-chat');
const inputEl = document.getElementById('agent-input');
const sendBtn = document.getElementById('btn-send');
const previewBtn = document.getElementById('btn-preview');
const commitBtn  = document.getElementById('btn-commit');
const vaultInfoEl = document.getElementById('agent-vault-info');
const summaryEl = document.getElementById('bp-summary');
const sectionsEl = document.getElementById('bp-sections');
const jsonEl = document.getElementById('bp-json');
const toastEl = document.getElementById('toast');
const diffDialog = document.getElementById('diff-dialog');
const diffBodyEl = document.getElementById('diff-body');

// ── HTTP base ─────────────────────────────────────────────────────────────
async function httpBase() {
  const { serverUrl } = await chrome.storage.local.get('serverUrl');
  const url = serverUrl || 'ws://localhost:9988/ws';
  return url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/ws$/, '');
}

async function jfetch(path, opts = {}) {
  const base = await httpBase();
  const res = await fetch(base + path, opts);
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

// ── Toast ─────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(message, level = '') {
  clearTimeout(toastTimer);
  toastEl.className = 'toast' + (level ? ' ' + level : '');
  toastEl.textContent = message;
  toastEl.classList.add('show');
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4000);
}

// ── Chat-Rendering ────────────────────────────────────────────────────────
function appendMessage(text, role = 'assistant') {
  const node = document.createElement('div');
  node.className = 'msg ' + role;
  node.textContent = text;
  chatEl.append(node);
  scrollToBottom();
  return node;
}

function appendToolCall(name, input, result) {
  const wrap = document.createElement('details');
  wrap.className = 'tool-call';
  const summary = document.createElement('summary');
  const args = formatToolArgs(input);
  summary.innerHTML = `<span class="tool-icon">⚙</span><span class="tool-name">${escapeHtml(name)}</span><span class="tool-args">${escapeHtml(args)}</span>`;
  wrap.append(summary);

  const pre = document.createElement('pre');
  let payload = '';
  if (input !== undefined) payload += 'input:\n' + safeJson(input) + '\n\n';
  if (result !== undefined) payload += 'result:\n' + safeJson(result);
  pre.textContent = payload.trim();
  wrap.append(pre);

  chatEl.append(wrap);
  scrollToBottom();
}

function formatToolArgs(input) {
  if (!input || typeof input !== 'object') return '';
  const keys = Object.keys(input);
  if (!keys.length) return '()';
  const previews = keys.slice(0, 2).map(k => {
    const v = input[k];
    const s = typeof v === 'string' ? `"${v}"` : JSON.stringify(v);
    return `${k}=${truncate(s, 30)}`;
  });
  if (keys.length > 2) previews.push('…');
  return '(' + previews.join(', ') + ')';
}

function safeJson(v) {
  try { return JSON.stringify(v, null, 2); }
  catch { return String(v); }
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function scrollToBottom() {
  requestAnimationFrame(() => { chatEl.scrollTop = chatEl.scrollHeight; });
}

// ── Blueprint-Sidebar-Rendering ──────────────────────────────────────────
let blueprintView = 'tree'; // wird durch initBlueprintViewSwitch ueberschrieben

function renderBlueprint(bp) {
  workingBlueprint = bp;
  if (!bp) {
    summaryEl.textContent = 'Noch keine Daten.';
    sectionsEl.replaceChildren();
    jsonEl.textContent = '{}';
    return;
  }

  const folders = bp.folders || [];
  const files   = bp.files || [];
  const bases   = bp.bases || [];
  const sections = bp.claude_md_sections || bp.claude_md?.sections || [];
  const briefing = bp.briefing_sources || [];

  summaryEl.innerHTML = `
    <strong>${folders.length}</strong> Ordner ·
    <strong>${files.length}</strong> Dateien ·
    <strong>${bases.length}</strong> Bases ·
    <strong>${briefing.length}</strong> Briefing-Sources
  `;

  sectionsEl.replaceChildren();

  if (blueprintView === 'tree') {
    const tree = buildBlueprintTree(folders, files, bases);
    sectionsEl.append(renderTreeRoot(tree));
    sectionsEl.append(renderSection('CLAUDE.md-Sections', sections, (s) => s.id || s.title || String(s)));
    sectionsEl.append(renderSection('Briefing-Sources', briefing, (s) => s.name || s.type || s.id || String(s)));
  } else {
    sectionsEl.append(renderSection('Ordner', folders, (f) => f.path || f.name || String(f)));
    sectionsEl.append(renderSection('Dateien', files, (f) => f.path || f.name || String(f)));
    sectionsEl.append(renderSection('Bases', bases, (b) => b.path || b.name || String(b)));
    sectionsEl.append(renderSection('CLAUDE.md-Sections', sections, (s) => s.id || s.title || String(s)));
    sectionsEl.append(renderSection('Briefing-Sources', briefing, (s) => s.name || s.type || s.id || String(s)));
  }

  jsonEl.textContent = safeJson(bp);
}

// Hierarchischer Baum aus flachen Pfad-Arrays. Erzeugt Zwischenknoten
// implizit, wenn Files/Bases in nicht-deklarierten Ordnern liegen.
function buildBlueprintTree(folders, files, bases) {
  const makeNode = (name) => ({ name, children: new Map(), files: [], bases: [], folderDef: null, implicit: true });
  const root = makeNode('');
  const ensure = (parts) => {
    let node = root;
    for (const p of parts) {
      if (!node.children.has(p)) node.children.set(p, makeNode(p));
      node = node.children.get(p);
    }
    return node;
  };
  for (const f of folders || []) {
    if (!f || !f.path) continue;
    const node = ensure(String(f.path).split('/').filter(Boolean));
    node.folderDef = f;
    node.implicit = false;
  }
  for (const f of files || []) {
    if (!f || !f.path) continue;
    const parts = String(f.path).split('/').filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) continue;
    const node = parts.length ? ensure(parts) : root;
    node.files.push({ name: fileName, def: f });
  }
  for (const b of bases || []) {
    if (!b || !b.path) continue;
    const parts = String(b.path).split('/').filter(Boolean);
    const baseName = parts.pop();
    if (!baseName) continue;
    const node = parts.length ? ensure(parts) : root;
    node.bases.push({ name: baseName, def: b });
  }
  return root;
}

function iconForFolder(node) {
  const kind = node.folderDef?.kind;
  switch (kind) {
    case 'system': return '📥';
    case 'raw': return '📦';
    case 'bucket': return '🪣';
    case 'area': return '🔁';
    case 'asset': return '🎬';
    case 'journal': return '📅';
    default: return '📁';
  }
}

function renderTreeRoot(root) {
  const wrap = document.createElement('div');
  wrap.className = 'bp-tree';
  const hasAnything = root.children.size || root.files.length || root.bases.length;
  if (!hasAnything) {
    const empty = document.createElement('div');
    empty.className = 'bp-tree-empty';
    empty.textContent = 'Noch keine Ordner / Dateien.';
    wrap.append(empty);
    return wrap;
  }
  // Root-Inhalte direkt rendern (keine Wrapper-Wurzel)
  const childNames = [...root.children.keys()].sort((a, b) => a.localeCompare(b, 'de'));
  for (const name of childNames) {
    wrap.append(renderTreeNode(root.children.get(name), 1));
  }
  for (const f of root.files) wrap.append(renderTreeLeaf('📄', f.name));
  for (const b of root.bases) wrap.append(renderTreeLeaf('🗂', b.name));
  return wrap;
}

function renderTreeNode(node, depth) {
  const det = document.createElement('details');
  det.className = 'bp-tree-node' + (node.implicit ? ' implicit' : '');
  if (depth <= 1) det.setAttribute('open', '');

  const sum = document.createElement('summary');
  const icon = document.createElement('span');
  icon.className = 'bp-tree-icon';
  icon.textContent = iconForFolder(node);
  const name = document.createElement('span');
  name.className = 'bp-tree-name';
  name.textContent = node.name + '/';
  const childCount = node.children.size + node.files.length + node.bases.length;
  const count = document.createElement('span');
  count.style.color = 'var(--text-dim)';
  count.style.fontSize = '10.5px';
  count.style.marginLeft = '6px';
  count.textContent = childCount ? `(${childCount})` : '';
  sum.append(icon, name, count);
  sum.title = node.folderDef?.path || node.name;
  det.append(sum);

  const children = document.createElement('div');
  children.className = 'bp-tree-children';
  const childNames = [...node.children.keys()].sort((a, b) => a.localeCompare(b, 'de'));
  for (const cn of childNames) {
    children.append(renderTreeNode(node.children.get(cn), depth + 1));
  }
  const sortedFiles = [...node.files].sort((a, b) => a.name.localeCompare(b.name, 'de'));
  for (const f of sortedFiles) children.append(renderTreeLeaf('📄', f.name));
  const sortedBases = [...node.bases].sort((a, b) => a.name.localeCompare(b.name, 'de'));
  for (const b of sortedBases) children.append(renderTreeLeaf('🗂', b.name));
  if (!children.childNodes.length) {
    const empty = document.createElement('div');
    empty.className = 'bp-tree-empty';
    empty.style.paddingLeft = '4px';
    empty.textContent = 'leer';
    children.append(empty);
  }
  det.append(children);
  return det;
}

function renderTreeLeaf(icon, label) {
  const row = document.createElement('div');
  row.className = 'bp-tree-item';
  row.title = label;
  const ico = document.createElement('span');
  ico.className = 'bp-tree-icon';
  ico.textContent = icon;
  const name = document.createElement('span');
  name.className = 'bp-tree-name';
  name.textContent = label;
  row.append(ico, name);
  return row;
}

async function initBlueprintViewSwitch() {
  try {
    const stored = await chrome.storage.local.get('setupAgentBlueprintView');
    const v = stored?.setupAgentBlueprintView;
    if (v === 'flat' || v === 'tree') blueprintView = v;
  } catch (_) {}
  document.querySelectorAll('.bp-view-btn').forEach((btn) => {
    if (btn.dataset.view === blueprintView) btn.classList.add('active');
    else btn.classList.remove('active');
    btn.setAttribute('aria-selected', btn.dataset.view === blueprintView ? 'true' : 'false');
    btn.addEventListener('click', () => setBlueprintView(btn.dataset.view));
  });
}

function setBlueprintView(view) {
  if (view !== 'tree' && view !== 'flat') return;
  blueprintView = view;
  document.querySelectorAll('.bp-view-btn').forEach((btn) => {
    const active = btn.dataset.view === view;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  try { chrome.storage.local.set({ setupAgentBlueprintView: view }); } catch (_) {}
  if (workingBlueprint) renderBlueprint(workingBlueprint);
}

function renderSection(title, items, labelFn) {
  const det = document.createElement('details');
  det.className = 'bp-section';
  if (items.length) det.setAttribute('open', '');
  const sum = document.createElement('summary');
  sum.textContent = `${title} (${items.length})`;
  det.append(sum);
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Leer';
    det.append(empty);
  } else {
    const ul = document.createElement('ul');
    for (const it of items) {
      const li = document.createElement('li');
      li.textContent = labelFn(it);
      li.title = labelFn(it);
      ul.append(li);
    }
    det.append(ul);
  }
  return det;
}

// ── Session-Start ─────────────────────────────────────────────────────────
async function startSession() {
  if (!VAULT_ID) {
    appendMessage('Fehler: vault_id fehlt in URL.', 'error');
    return false;
  }

  try {
    const body = { mode: MODE };
    if (TEMPLATES.length) body.templates = TEMPLATES;
    if (USE_CASE_HINT) body.use_case_hint = USE_CASE_HINT;

    const res = await jfetch(`/vaults/${encodeURIComponent(VAULT_ID)}/setup_agent/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    sessionId = res.session_id;
    workingBlueprint = res.working_blueprint;
    renderBlueprint(workingBlueprint);

    await chrome.storage.local.set({
      setupAgentSession: {
        vault_id: VAULT_ID,
        session_id: sessionId,
        opened_at: Date.now(),
      },
    });

    vaultInfoEl.textContent = `Vault: ${VAULT_ID} · Modus: ${MODE}${TEMPLATES.length ? ' · ' + TEMPLATES.join(', ') : ''}`;

    if (res.opening_assistant_message) {
      appendMessage(res.opening_assistant_message, 'assistant');
    } else {
      appendMessage('Hi! Lass uns deinen Vault einrichten. Was brauchst du?', 'assistant');
    }
    inputEl.focus();
    return true;
  } catch (e) {
    appendMessage('Konnte Setup-Agent-Session nicht starten: ' + e.message, 'error');
    return false;
  }
}

async function tryRestoreSession() {
  const { setupAgentSession } = await chrome.storage.local.get('setupAgentSession');
  if (!setupAgentSession || !setupAgentSession.session_id) return false;
  if (VAULT_ID && setupAgentSession.vault_id !== VAULT_ID) return false;
  try {
    const res = await jfetch(
      `/vaults/${encodeURIComponent(setupAgentSession.vault_id)}/setup_agent/state?session_id=${encodeURIComponent(setupAgentSession.session_id)}`
    );
    sessionId = setupAgentSession.session_id;
    workingBlueprint = res.working_blueprint;
    renderBlueprint(workingBlueprint);
    vaultInfoEl.textContent = `Vault: ${setupAgentSession.vault_id} · fortgesetzt`;
    appendMessage('Session fortgesetzt.', 'system');
    const messages = res.messages || [];
    for (const m of messages) {
      if (m.role === 'user' || m.role === 'assistant') {
        appendMessage(m.content || '', m.role);
      }
    }
    inputEl.focus();
    return true;
  } catch {
    return false;
  }
}

// ── Send-Message ──────────────────────────────────────────────────────────
async function send() {
  if (sending) return;
  const text = inputEl.value.trim();
  if (!text || !sessionId) return;

  sending = true;
  sendBtn.disabled = true;
  inputEl.disabled = true;

  appendMessage(text, 'user');
  inputEl.value = '';

  const pending = appendMessage('Agent denkt…', 'system');

  try {
    const res = await jfetch(`/vaults/${encodeURIComponent(VAULT_ID)}/setup_agent/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, message: text }),
    });

    pending.remove();

    const toolCalls = res.tool_calls || [];
    for (const tc of toolCalls) {
      appendToolCall(tc.name || tc.tool || 'tool', tc.input || tc.args, tc.result);
    }

    if (res.reply) {
      appendMessage(res.reply, 'assistant');
    }

    if (res.working_blueprint) {
      renderBlueprint(res.working_blueprint);
    }

    if (res.diff_preview) {
      lastDiffPreview = res.diff_preview;
      commitBtn.disabled = false;
      toast('Bereit zum Commit. Klick auf "Commit" wenn alles passt.', 'success');
    }
  } catch (e) {
    pending.remove();
    appendMessage('Fehler: ' + e.message, 'error');
  } finally {
    sending = false;
    sendBtn.disabled = false;
    inputEl.disabled = false;
    inputEl.focus();
  }
}

// ── Preview / Commit ──────────────────────────────────────────────────────
async function fetchPreview() {
  if (!workingBlueprint) {
    toast('Noch kein Blueprint.', 'error');
    return null;
  }
  try {
    const res = await jfetch(`/vaults/${encodeURIComponent(VAULT_ID)}/blueprint/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blueprint: workingBlueprint }),
    });
    lastDiffPreview = res;
    return res;
  } catch (e) {
    toast('Preview-Fehler: ' + e.message, 'error');
    return null;
  }
}

function renderDiff(diff) {
  diffBodyEl.replaceChildren();
  if (!diff) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Keine Daten.';
    diffBodyEl.append(empty);
    return;
  }

  function section(title, items, cls = '') {
    const h = document.createElement('h4');
    h.textContent = title + (items?.length ? ` (${items.length})` : '');
    diffBodyEl.append(h);
    if (!items || !items.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'Keine.';
      diffBodyEl.append(e);
      return;
    }
    const ul = document.createElement('ul');
    for (const it of items) {
      const li = document.createElement('li');
      if (cls) li.className = cls;
      const label = typeof it === 'string' ? it : (it.path || it.id || it.name || safeJson(it));
      li.textContent = label;
      ul.append(li);
    }
    diffBodyEl.append(ul);
  }

  section('Wird erstellt', diff.would_create || []);
  section('Wird übersprungen (existiert bereits)', diff.would_skip || [], 'skip');
  section('CLAUDE.md-Sections wird gemergt', diff.would_update_claude_md || []);
  section('Warnungen', diff.warnings || [], 'warning');
}

async function openDiffDialog() {
  const diff = lastDiffPreview || await fetchPreview();
  if (!diff) return;
  renderDiff(diff);
  diffDialog.showModal();
}

async function commitNow() {
  try {
    const res = await jfetch(`/vaults/${encodeURIComponent(VAULT_ID)}/setup_agent/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    });
    diffDialog.close();
    toast(`Setup abgeschlossen — ${(res.created || []).length} Items erstellt.`, 'success');
    appendMessage('Blueprint wurde committet. Du kannst dieses Fenster jetzt schließen.', 'system');
    commitBtn.disabled = true;
    inputEl.disabled = true;
    sendBtn.disabled = true;
    await chrome.storage.local.remove(['setupAgentSession', 'setupAgentContext']);
    setTimeout(() => {
      try {
        chrome.tabs.getCurrent(tab => { if (tab) chrome.tabs.remove(tab.id); });
      } catch {}
    }, 3000);
  } catch (e) {
    const errEl = document.createElement('div');
    errEl.className = 'msg error';
    errEl.style.alignSelf = 'stretch';
    errEl.style.maxWidth = '100%';
    errEl.textContent = 'Commit-Fehler: ' + e.message;
    diffBodyEl.append(errEl);
  }
}

// ── Event-Bindings ────────────────────────────────────────────────────────
sendBtn.addEventListener('click', send);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

previewBtn.addEventListener('click', openDiffDialog);
commitBtn.addEventListener('click', openDiffDialog);
document.getElementById('btn-diff-close').addEventListener('click', () => diffDialog.close());
document.getElementById('btn-diff-cancel').addEventListener('click', () => diffDialog.close());
document.getElementById('btn-diff-confirm').addEventListener('click', commitNow);

// ── Init ──────────────────────────────────────────────────────────────────
(async () => {
  await initBlueprintViewSwitch();
  if (!VAULT_ID) {
    const restored = await tryRestoreSession();
    if (!restored) {
      appendMessage('Fehler: vault_id fehlt in URL und keine fortsetzbare Session gefunden.', 'error');
    }
    return;
  }
  await startSession();
})();
