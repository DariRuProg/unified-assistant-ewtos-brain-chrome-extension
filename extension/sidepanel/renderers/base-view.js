// Obsidian-.base als Tabellen/Karten-Ansicht rendern. ewtos.com
// Holt die serverseitig ausgewertete Base (Views/Spalten/Zeilen/Gruppen) und
// baut daraus eine echte Tabelle bzw. Karten — analog zur Obsidian-Bases-Ansicht.
import { el } from '../dom.js';

function buildTable(columns, rows, onOpenFile) {
  const wrap = el('div', { className: 'base-table-wrap' });
  const table = el('table', { className: 'base-table' });
  const thead = el('thead');
  const htr = el('tr');
  for (const col of columns) htr.append(el('th', { textContent: col.label }));
  thead.append(htr);
  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    tr.title = row.path || '';
    for (const col of columns) {
      tr.append(el('td', { textContent: row.cells[col.id] || '—' }));
    }
    if (row.path && onOpenFile) tr.addEventListener('click', () => onOpenFile(row.path));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

function buildCards(columns, rows, onOpenFile) {
  const grid = el('div', { className: 'base-cards' });
  const titleCol = columns[0];
  const rest = columns.slice(1);
  for (const row of rows) {
    const card = el('div', { className: 'base-card' });
    card.append(el('div', { className: 'base-card-title', textContent: titleCol ? (row.cells[titleCol.id] || row.name || '—') : (row.name || '—') }));
    for (const col of rest) {
      const v = row.cells[col.id];
      if (!v) continue;
      const line = el('div', { className: 'base-card-field' });
      line.append(el('span', { className: 'k', textContent: col.label }), el('span', { textContent: v }));
      card.append(line);
    }
    if (row.path && onOpenFile) card.addEventListener('click', () => onOpenFile(row.path));
    grid.append(card);
  }
  return grid;
}

function renderOneView(container, view, onOpenFile) {
  const n = view.rows.length;
  container.append(el('div', { className: 'base-view-meta', textContent: `${n} ${n === 1 ? 'Eintrag' : 'Einträge'}` }));
  if (!n) {
    container.append(el('div', { className: 'vault-empty', textContent: 'Keine Einträge entsprechen den Filtern.' }));
    return;
  }
  const builder = view.type === 'cards' ? buildCards : buildTable;
  if (view.groups && view.groups.length) {
    for (const g of view.groups) {
      container.append(el('div', { className: 'base-group-head', textContent: `${view.groupBy}: ${g.key} (${g.rows.length})` }));
      container.append(builder(view.columns, g.rows.map((i) => view.rows[i]), onOpenFile));
    }
  } else {
    container.append(builder(view.columns, view.rows, onOpenFile));
  }
}

// Rendert die Base in `container`. onOpenFile(relPath) wird beim Klick auf eine
// Zeile/Karte aufgerufen (Zieldatei öffnen). Gibt true bei Erfolg zurück.
export async function renderBaseInto(container, httpBase, vaultId, relPath, onOpenFile) {
  container.replaceChildren();
  container.classList.add('base-view');
  const status = el('div', { className: 'tool-status', textContent: 'werte Base aus…' });
  container.append(status);

  let data;
  try {
    const url = `${httpBase}/tools/vault_base/${encodeURIComponent(vaultId)}?rel_path=${encodeURIComponent(relPath)}`;
    const res = await fetch(url);
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || `HTTP ${res.status}`); }
    data = await res.json();
  } catch (err) {
    status.className = 'tool-status error';
    status.textContent = 'Base konnte nicht ausgewertet werden: ' + (err.message || err);
    return false;
  }
  container.replaceChildren();

  const views = data.views || [];
  container.append(el('div', { className: 'base-title', textContent: data.title || relPath }));
  if (!views.length) {
    container.append(el('div', { className: 'vault-empty', textContent: 'Keine Views in dieser Base definiert.' }));
    return true;
  }

  const tabBar = el('div', { className: 'base-tabs' });
  const body = el('div', { className: 'base-body' });
  container.append(tabBar, body);

  function show(i) {
    Array.from(tabBar.children).forEach((t, idx) => t.classList.toggle('active', idx === i));
    body.replaceChildren();
    renderOneView(body, views[i], onOpenFile);
  }
  views.forEach((v, i) => {
    const tab = el('button', { type: 'button', className: 'base-tab', textContent: v.name || `View ${i + 1}` });
    tab.addEventListener('click', () => show(i));
    tabBar.append(tab);
  });
  if (views.length <= 1) tabBar.style.display = 'none';
  show(0);
  return true;
}
