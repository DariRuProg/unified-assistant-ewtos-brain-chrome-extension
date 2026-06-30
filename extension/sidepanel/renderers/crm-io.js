// CRM CSV-Import/-Export für die Kundenstamm-Base im Workspace-Tab. State-frei,
// deutsche Strings (der Tab initialisiert i18n nicht), nur dom.js als Abhängigkeit
// — damit die Workspace-Seite nicht den ganzen Sidepanel-Graphen lädt. ewtos.com
import { el } from '../dom.js';

export const CRM_BASE_PATH = "crm/kunden/kundenstamm.base";
const CRM_FOLDER = "crm/kunden";

// Feld → Label für den Import-Mapping-Dialog.
const IMPORT_FIELDS = [
  ["titel",       "Name"],
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

// Import/Export-Toolbar für die CRM-Base im Workspace-Tab. onChanged() lädt nach
// erfolgreichem Import neu.
export function mountCrmIo(container, httpBase, vaultId, onChanged) {
  if (!container || !vaultId) return;

  const toolbar = el("div", { className: "crm-tab-toolbar" });
  const importBtn = el("button", { type: "button", className: "ws-btn", textContent: "CSV importieren" });
  const exportBtn = el("button", { type: "button", className: "ws-btn", textContent: "CSV exportieren" });
  toolbar.append(importBtn, exportBtn);
  container.prepend(toolbar);

  let panel = null;
  function closePanel() {
    if (panel) { panel.remove(); panel = null; }
  }

  importBtn.addEventListener("click", () => {
    closePanel();
    panel = el("div", { className: "crm-import" });
    panel.append(el("div", { className: "crm-import-title", textContent: "Kunden aus CSV importieren" }));
    const fileInput = el("input", { type: "file", accept: ".csv,text/csv" });
    const info = el("div", { className: "tool-status" });
    const mapBox = el("div", { className: "crm-import-map" });
    const sensRow = el("label", { className: "crm-import-sens" });
    const sensCb = el("input", { type: "checkbox" });
    sensCb.checked = true;
    sensRow.append(sensCb, el("span", { textContent: "Importierte Kunden als sensibel markieren" }));
    const actions = el("div", { className: "crm-import-actions" });
    const runBtn = el("button", { type: "button", textContent: "Importieren" });
    runBtn.disabled = true;
    const cancelBtn = el("button", { type: "button", textContent: "Abbrechen" });
    actions.append(runBtn, cancelBtn);
    panel.append(fileInput, info, mapBox, sensRow, actions);
    toolbar.after(panel);

    let csvText = "";
    let headers = [];
    const selects = {};

    function renderMapping(suggested) {
      mapBox.replaceChildren();
      mapBox.append(el("div", { className: "crm-import-hint", textContent: "Ordne die CSV-Spalten den Feldern zu:" }));
      for (const [field, label] of IMPORT_FIELDS) {
        const row = el("div", { className: "crm-import-row" });
        const sel = el("select");
        sel.append(el("option", { value: "", textContent: "— ignorieren —" }));
        for (const h of headers) sel.append(el("option", { value: h, textContent: h }));
        if (suggested[field]) sel.value = suggested[field];
        selects[field] = sel;
        row.append(el("span", { className: "crm-import-label", textContent: label }), sel);
        mapBox.append(row);
      }
    }

    cancelBtn.addEventListener("click", closePanel);

    fileInput.addEventListener("change", async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      info.textContent = "CSV wird gelesen…";
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
        info.textContent = `${data.total} Zeilen, ${headers.length} Spalten erkannt.`;
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
        info.textContent = "Mindestens ein Feld muss zugeordnet sein.";
        info.className = "tool-status error";
        return;
      }
      runBtn.disabled = true;
      info.textContent = "Import läuft…";
      info.className = "tool-status";
      try {
        const res = await fetch(`${httpBase}/tools/crm/import/${encodeURIComponent(vaultId)}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ csv_text: csvText, mapping, sensitive: sensCb.checked }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          throw new Error(e.detail || (res.status === 403 ? "Kein Schreibrecht (write_files)." : `HTTP ${res.status}`));
        }
        const data = await res.json();
        info.textContent = `${data.created} angelegt, ${data.skipped} übersprungen (von ${data.total}).`;
        info.className = "tool-status success";
        setTimeout(() => { closePanel(); if (onChanged) onChanged(); }, 1000);
      } catch (err) {
        info.textContent = "Import fehlgeschlagen: " + (err.message || err);
        info.className = "tool-status error";
        runBtn.disabled = false;
      }
    });
  });

  exportBtn.addEventListener("click", async () => {
    let records = [];
    try {
      const res = await fetch(`${httpBase}/tools/vault_query/${encodeURIComponent(vaultId)}?folder=${encodeURIComponent(CRM_FOLDER)}&typ=kunde`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      records = (await res.json()).records || [];
    } catch (_) {
      return;
    }
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
    a.download = "crm-export.csv";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
