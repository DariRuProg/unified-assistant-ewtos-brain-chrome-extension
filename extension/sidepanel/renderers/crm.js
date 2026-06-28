// CRM-Kundentabelle: liest crm/kunden/ via vault_query, sortier-/filterbar. ewtos.com
import { el } from '../dom.js';
import { state } from '../state.js';
import { getHttpBase } from '../modules/api.js';
import { openTool } from '../modules/tool-runner.js';

const COLUMNS = [
  { key: "name",        label: "Kunde" },
  { key: "firma",       label: "Firma" },
  { key: "branche",     label: "Branche" },
  { key: "status",      label: "Status" },
  { key: "vertrag_bis", label: "Vertrag bis" },
  { key: "kontakt",     label: "Kontakt" },
  { key: "email",       label: "E-Mail" },
  { key: "telefon",     label: "Telefon" },
];

const IMPORT_FIELDS = [
  ["titel",       "Name / Titel"],
  ["firma",       "Firma"],
  ["branche",     "Branche"],
  ["status",      "Status"],
  ["vertrag_bis", "Vertrag bis"],
  ["kontakt",     "Kontakt"],
  ["email",       "E-Mail"],
  ["telefon",     "Telefon"],
  ["website",     "Website"],
];

function csvEscape(val, delim) {
  const s = val == null ? "" : String(val);
  if (s.includes(delim) || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export async function renderCrmTable() {
  state.panelTitle.textContent = "CRM — Kundenstamm";
  const httpBase = await getHttpBase();

  const header = el("div", { className: "chat-header" });
  const vaultSelect = el("select", { className: "vault-picker" });
  header.append(vaultSelect);

  const toolbar = el("div", { className: "crm-toolbar" });
  const filterInput = el("input", { type: "text", className: "vault-search-input crm-filter", placeholder: "Kunden filtern…" });
  const importOpenBtn = el("button", { type: "button", className: "crm-import-open", textContent: "CSV importieren" });
  const exportBtn = el("button", { type: "button", className: "crm-import-open", textContent: "CSV export" });
  exportBtn.disabled = true;
  toolbar.append(filterInput, importOpenBtn, exportBtn);

  const tableWrap = el("div", { className: "crm-table-wrap" });
  const status = el("div", { className: "tool-status" });
  state.panelBody.append(header, toolbar, tableWrap, status);

  let currentVaultId = null;
  let records = [];
  let sortKey = "name";
  let sortDir = "asc";

  function setStatus(text, level = "") {
    status.textContent = text;
    status.className = "tool-status" + (level ? " " + level : "");
  }

  function val(rec, key) {
    if (key === "name") return rec.name || "";
    const v = rec.frontmatter ? rec.frontmatter[key] : "";
    if (Array.isArray(v)) return v.join(", ");
    return v == null ? "" : String(v);
  }

  function visibleRecords() {
    const q = filterInput.value.trim().toLowerCase();
    let rows = records;
    if (q) {
      rows = rows.filter((r) => {
        const fm = r.frontmatter || {};
        const hay = [r.name, ...Object.values(fm).map((v) => Array.isArray(v) ? v.join(" ") : v)]
          .join(" ").toLowerCase();
        return hay.includes(q);
      });
    }
    return rows.slice().sort((a, b) => {
      const av = val(a, sortKey).toLowerCase();
      const bv = val(b, sortKey).toLowerCase();
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
  }

  function toggleSort(key) {
    if (sortKey === key) { sortDir = sortDir === "asc" ? "desc" : "asc"; }
    else { sortKey = key; sortDir = "asc"; }
    renderTable();
  }

  function indicator(key) {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  }

  function renderTable() {
    tableWrap.replaceChildren();
    exportBtn.disabled = !records.length;
    if (!records.length) {
      tableWrap.append(el("div", { className: "vault-empty", textContent: "Noch keine Kunden in crm/kunden/." }));
      return;
    }
    const rows = visibleRecords();
    const table = el("table", { className: "crm-table" });
    const thead = el("thead");
    const htr = el("tr");
    for (const col of COLUMNS) {
      const th = el("th", { className: "crm-th", textContent: col.label + indicator(col.key) });
      th.addEventListener("click", () => toggleSort(col.key));
      htr.append(th);
    }
    thead.append(htr);
    const tbody = el("tbody");
    if (!rows.length) {
      const tr = el("tr");
      tr.append(el("td", { className: "crm-empty-cell", colSpan: String(COLUMNS.length), textContent: "Kein Treffer." }));
      tbody.append(tr);
    }
    for (const rec of rows) {
      const tr = el("tr", { className: "crm-row" });
      tr.title = "Kundenkarte öffnen";
      for (const col of COLUMNS) {
        tr.append(el("td", { textContent: val(rec, col.key) || "—" }));
      }
      tr.addEventListener("click", () => {
        openTool("vault_explorer", { initialFile: rec.rel_path, vaultId: currentVaultId });
      });
      tbody.append(tr);
    }
    table.append(thead, tbody);
    tableWrap.append(table);
  }

  async function loadRecords() {
    if (!currentVaultId) return;
    records = [];
    tableWrap.replaceChildren();
    setStatus("lade Kunden...");
    try {
      const url = `${httpBase}/tools/vault_query/${encodeURIComponent(currentVaultId)}?folder=crm/kunden&typ=kunde`;
      const res = await fetch(url);
      if (res.status === 404) {
        setStatus("");
        tableWrap.append(el("div", {
          className: "vault-empty",
          textContent: "Kein CRM in diesem Vault. Über die Vault-Einrichtung das Modul „crm-base“ hinzufügen.",
        }));
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      records = data.records || [];
      setStatus("");
      renderTable();
    } catch (err) {
      setStatus("Kunden konnten nicht geladen werden: " + (err.message || err), "error");
    }
  }

  filterInput.addEventListener("input", () => { if (records.length) renderTable(); });

  function openImportPanel() {
    if (!currentVaultId) return;
    tableWrap.replaceChildren();
    const panel = el("div", { className: "crm-import" });
    panel.append(el("div", { className: "crm-import-title", textContent: "Kundenliste aus CSV importieren" }));
    const fileInput = el("input", { type: "file", accept: ".csv,text/csv" });
    const info = el("div", { className: "tool-status" });
    const mapBox = el("div", { className: "crm-import-map" });
    const sensRow = el("label", { className: "crm-import-sens" });
    const sensCb = el("input", { type: "checkbox" });
    sensCb.checked = true;
    sensRow.append(sensCb, el("span", { textContent: "Kundendaten als sensibel kennzeichnen (DSGVO — nur freigegebenes LLM)" }));
    const actions = el("div", { className: "crm-import-actions" });
    const runBtn = el("button", { type: "button", textContent: "Importieren" });
    runBtn.disabled = true;
    const cancelBtn = el("button", { type: "button", textContent: "Abbrechen" });
    actions.append(runBtn, cancelBtn);
    panel.append(fileInput, info, mapBox, sensRow, actions);
    tableWrap.append(panel);

    let csvText = "";
    let headers = [];
    const selects = {};

    function renderMapping(suggested) {
      mapBox.replaceChildren();
      mapBox.append(el("div", { className: "crm-import-hint", textContent: "Kartenfelder den CSV-Spalten zuordnen:" }));
      for (const [field, label] of IMPORT_FIELDS) {
        const row = el("div", { className: "crm-import-row" });
        const sel = el("select");
        sel.append(el("option", { value: "", textContent: "— ignorieren" }));
        for (const h of headers) sel.append(el("option", { value: h, textContent: h }));
        if (suggested[field]) sel.value = suggested[field];
        selects[field] = sel;
        row.append(el("span", { className: "crm-import-label", textContent: label }), sel);
        mapBox.append(row);
      }
    }

    cancelBtn.addEventListener("click", () => { loadRecords(); });

    fileInput.addEventListener("change", async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      info.textContent = "lese CSV…";
      info.className = "tool-status";
      mapBox.replaceChildren();
      runBtn.disabled = true;
      try {
        csvText = await f.text();
        const res = await fetch(`${httpBase}/tools/crm/import_preview`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ csv_text: csvText }),
        });
        if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || `HTTP ${res.status}`); }
        const data = await res.json();
        headers = data.headers || [];
        info.textContent = `${data.total} Zeilen, ${headers.length} Spalten erkannt`;
        renderMapping(data.suggested_mapping || {});
        runBtn.disabled = headers.length === 0;
      } catch (err) {
        info.textContent = "CSV-Fehler: " + (err.message || err);
        info.className = "tool-status error";
      }
    });

    runBtn.addEventListener("click", async () => {
      const mapping = {};
      for (const [field] of IMPORT_FIELDS) {
        const v = selects[field] && selects[field].value;
        if (v) mapping[field] = v;
      }
      if (!Object.keys(mapping).length) {
        info.textContent = "Mindestens ein Feld zuordnen (z.B. Firma).";
        info.className = "tool-status error";
        return;
      }
      runBtn.disabled = true;
      info.textContent = "importiere…";
      info.className = "tool-status";
      try {
        const res = await fetch(`${httpBase}/tools/crm/import/${encodeURIComponent(currentVaultId)}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ csv_text: csvText, mapping, sensitive: sensCb.checked }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          throw new Error(e.detail || (res.status === 403 ? "Kein Schreibrecht (write_files) für diesen Vault." : `HTTP ${res.status}`));
        }
        const data = await res.json();
        info.textContent = `${data.created} Karten angelegt, ${data.skipped} übersprungen (von ${data.total}).`;
        info.className = "tool-status success";
        setTimeout(() => loadRecords(), 1000);
      } catch (err) {
        info.textContent = "Import fehlgeschlagen: " + (err.message || err);
        info.className = "tool-status error";
        runBtn.disabled = false;
      }
    });
  }

  importOpenBtn.addEventListener("click", openImportPanel);

  function exportCsv() {
    if (!records.length) return;
    const DELIM = ";";
    const preferred = ["titel", "firma", "branche", "status", "vertrag_bis", "kontakt", "email", "telefon", "website"];
    const keySet = new Set();
    for (const r of records) for (const k of Object.keys(r.frontmatter || {})) keySet.add(k);
    const rest = [...keySet].filter((k) => !preferred.includes(k)).sort();
    const cols = ["name", ...preferred.filter((k) => keySet.has(k)), ...rest];

    const lines = [cols.map((c) => csvEscape(c, DELIM)).join(DELIM)];
    for (const r of records) {
      const fm = r.frontmatter || {};
      lines.push(cols.map((c) => {
        if (c === "name") return csvEscape(r.name, DELIM);
        const v = fm[c];
        return csvEscape(Array.isArray(v) ? v.join(", ") : v, DELIM);
      }).join(DELIM));
    }
    const csv = "﻿" + lines.join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "kunden-export.csv";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  exportBtn.addEventListener("click", exportCsv);

  vaultSelect.addEventListener("change", async () => {
    currentVaultId = vaultSelect.value;
    await chrome.storage.local.set({ selectedVaultId: currentVaultId });
    await loadRecords();
  });

  try {
    const res = await fetch(`${httpBase}/vaults`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const vaults = (await res.json()).vaults || [];
    if (!vaults.length) {
      state.panelBody.replaceChildren();
      const wrap = el("div", { className: "chat-empty-state" });
      wrap.append(el("p", { textContent: "Noch kein Vault verbunden. Lege in den Einstellungen einen an." }));
      const btn = el("button", { type: "button", textContent: "Einstellungen öffnen" });
      btn.addEventListener("click", () => chrome.runtime.openOptionsPage());
      wrap.append(btn);
      state.panelBody.append(wrap);
      return;
    }
    vaultSelect.replaceChildren();
    for (const v of vaults) vaultSelect.append(el("option", { value: v.id, textContent: v.name }));
    const { selectedVaultId } = await chrome.storage.local.get("selectedVaultId");
    currentVaultId = vaults.some((v) => v.id === selectedVaultId) ? selectedVaultId : vaults[0].id;
    vaultSelect.value = currentVaultId;
    await loadRecords();
  } catch (err) {
    setStatus("Vault-Liste konnte nicht geladen werden: " + (err.message || err), "error");
  }
}
