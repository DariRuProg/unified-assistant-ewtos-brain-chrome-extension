// Web-Tools Renderer (Scrape, SEO, Image, Color, Screenshot, URL, ImageGen). ewtos.com
import { el } from '../dom.js';
import { state } from '../state.js';
import { getHttpBase, getActiveVaultId } from '../modules/api.js';
import { openTool } from '../sidepanel.js';

const IMAGE_GEN_MODELS = [
  ["gemini-2.5-flash-image", "Nano Banana (2.5 Flash) — schnell"],
  ["gemini-3.1-flash-image-preview", "Nano Banana 2 (3.1 Flash) — Qualität"],
  ["gemini-3-pro-image-preview", "Nano Banana Pro (3 Pro) — 4K"],
];
const MAX_INPUT_IMAGES = 3;
const imageGenState = {
  // inputs: {base64, mime, name} fuer Uploads ODER {file, name} fuer Server-Pfade
  inputs: [],
  model: null,
  lastOutputFile: null, // Server-relativer Pfad
  gallery: [],          // Index vom Server
};

export function renderPageScrape() {
  state.panelTitle.textContent = "Page-Scrape";
  const pendingAction = state.pendingToolOptions?.action;

  let scrapeMode = pendingAction === "scrape_full" ? "full" : "content";

  // URL-Anzeige des aktiven Browser-Tabs (analog YouTube-Tab)
  const urlRow = el("div", { className: "page-url-row" });
  urlRow.style.cssText = "display:flex;gap:6px;align-items:center;font-size:12px;color:var(--muted,#888);margin-bottom:6px;";
  const urlLabel = el("span", { textContent: "(kein Tab erkannt)" });
  urlLabel.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  const refreshUrlBtn = el("button", {
    type: "button", textContent: "↻", title: "URL aus aktivem Tab übernehmen", className: "secondary",
  });
  refreshUrlBtn.style.cssText = "padding:2px 8px;flex:0 0 auto;";
  urlRow.append(urlLabel, refreshUrlBtn);

  const scrapeModeRow = el("div", { className: "scrape-mode-row" });
  function makeScrapeRadio(value, label) {
    const btn = el("button", { type: "button", className: "scrape-mode-btn" + (value === scrapeMode ? " active" : ""), textContent: label });
    btn.dataset.value = value;
    btn.addEventListener("click", () => {
      if (scrapeMode === value) return;
      scrapeMode = value;
      scrapeModeRow.querySelectorAll(".scrape-mode-btn").forEach(b => b.classList.toggle("active", b.dataset.value === value));
    });
    return btn;
  }
  scrapeModeRow.append(makeScrapeRadio("content", "Nur Inhalt"), makeScrapeRadio("full", "Alles"));

  const runBtn = el("button", { textContent: "Aktiven Tab scrapen" });
  const status = el("div", { className: "tool-status" });
  const output = el("textarea", { readOnly: true, placeholder: "Ergebnis erscheint hier..." });
  const copyBtn = el("button", { textContent: "Kopieren" });
  copyBtn.classList.add("secondary");

  let lastMarkdown = "";
  let lastUrl = "";

  function updateUrlFromActiveTab() {
    if (!chrome?.tabs?.query) return;
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      const u = tab?.url || "";
      urlLabel.textContent = u || "(kein Tab erkannt)";
      urlLabel.title = u;
    });
  }

  async function runScrape() {
    runBtn.disabled = true;
    status.textContent = "scrapt...";
    status.className = "tool-status";
    output.value = "";
    lastMarkdown = "";
    try {
      const httpBase = await getHttpBase();
      const res = await fetch(`${httpBase}/tools/page_scrape`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: scrapeMode }),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
      lastMarkdown = data.markdown || "";
      lastUrl = data.url || "";
      if (lastUrl) { urlLabel.textContent = lastUrl; urlLabel.title = lastUrl; }
      output.value = lastMarkdown;
      status.textContent = `${data.title || ""} — ${data.wordCount || 0} Wörter`;
      status.className = "tool-status success";
      if (data.title && !promoteTitle.value) promoteTitle.value = data.title;
      chatBtn.style.display = "";
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
    } finally {
      runBtn.disabled = false;
    }
  }

  runBtn.addEventListener("click", runScrape);
  refreshUrlBtn.addEventListener("click", updateUrlFromActiveTab);

  // Auto: URL erkennen + einmal scrapen beim Öffnen des Tabs.
  // Bei Browser-Tab-Wechsel wird NICHT neu gescrapt — User muss manuell drücken.
  updateUrlFromActiveTab();
  // Defer Scrape damit alle DOM-Elemente schon im Body sind (promoteTitle etc).
  setTimeout(() => { runScrape(); }, 0);

  copyBtn.addEventListener("click", () => {
    if (output.value) navigator.clipboard.writeText(output.value);
  });

  // ── Ins Brain ────────────────────────────────────────────────────────────
  const promoteBtn = el("button", { textContent: "Ins Brain", className: "secondary" });
  promoteBtn.style.marginTop = "6px";

  const promoteForm = el("div");
  promoteForm.style.cssText = "display:none;margin-top:8px;padding:10px;border:1px solid var(--border,#ddd);border-radius:6px;background:var(--bg-subtle);";

  const promoteTitle = el("input", { type: "text", placeholder: "Titel (Pflichtfeld)" });
  const promoteSub = el("select");
  ["artikel", "eigene-notizen", "chat-archive"].forEach(s => promoteSub.append(new Option(s, s)));
  const promoteDesc = el("textarea", { placeholder: "Beschreibung (optional)" });
  promoteDesc.style.cssText = "min-height:52px;resize:vertical;margin-top:6px;font-size:12px;";

  const promoteTags = el("input", { type: "text", placeholder: "Tags (kommagetrennt, optional)" });
  promoteTags.className = "promote-tags-input";
  promoteTags.style.marginTop = "6px";

  const seoCheckboxRow = el("div");
  seoCheckboxRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-top:8px;font-size:12px;";
  const seoCheckbox = el("input", { type: "checkbox" });
  seoCheckbox.checked = true;
  seoCheckboxRow.append(seoCheckbox, el("span", { textContent: "SEO-Metadaten hinzufügen" }));

  const promoteHint = el("div", { className: "tool-status" });
  const promoteSubBtn = el("button", { textContent: "Speichern" });
  const promoteCancelBtn = el("button", { textContent: "Abbrechen", className: "secondary" });
  promoteCancelBtn.style.marginLeft = "6px";

  const promoteSubLabel = el("label", { textContent: "Ziel-Ordner:" });
  promoteSubLabel.style.cssText = "margin-top:6px;display:block;";
  const promoteActRow = el("div");
  promoteActRow.style.marginTop = "8px";
  promoteActRow.append(promoteSubBtn, promoteCancelBtn);

  promoteForm.append(promoteTitle, promoteSubLabel, promoteSub, promoteDesc, promoteTags, seoCheckboxRow, promoteHint, promoteActRow);

  promoteBtn.addEventListener("click", async () => {
    const opening = promoteForm.style.display === "none";
    promoteForm.style.display = opening ? "block" : "none";
    if (opening && !promoteDesc.value.trim()) {
      try {
        const httpBase = await getHttpBase();
        const sres = await fetch(`${httpBase}/tools/seo_check`, { method: "POST" });
        if (sres.ok) {
          const sd = await sres.json();
          if (sd.description && !promoteDesc.value.trim()) promoteDesc.value = sd.description;
        }
      } catch {}
    }
  });
  promoteCancelBtn.addEventListener("click", () => {
    promoteForm.style.display = "none";
  });
  promoteSubBtn.addEventListener("click", async () => {
    const title = promoteTitle.value.trim();
    if (!title) { promoteHint.textContent = "Titel erforderlich"; promoteHint.className = "tool-status error"; return; }
    if (!lastMarkdown) { promoteHint.textContent = "Erst Seite scrapen"; promoteHint.className = "tool-status error"; return; }
    promoteSubBtn.disabled = true;
    promoteHint.textContent = "speichere...";
    promoteHint.className = "tool-status";
    try {
      const httpBase = await getHttpBase();
      const vaultId = await getActiveVaultId(httpBase);
      if (!vaultId) throw new Error("Kein Vault konfiguriert");
      let seoData = null;
      if (seoCheckbox.checked) {
        try {
          const seoRes = await fetch(`${httpBase}/tools/seo_check`, { method: "POST" });
          if (seoRes.ok) seoData = await seoRes.json();
        } catch {}
      }
      const res = await fetch(`${httpBase}/tools/raw/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vault_id: vaultId,
          title,
          content: lastMarkdown,
          target_subfolder: promoteSub.value,
          description: promoteDesc.value.trim() || null,
          url: seoData?.url || lastUrl || null,
          meta_title: seoData?.title || null,
          meta_beschreibung: seoData?.description || null,
          og_bild: seoData?.og_image || null,
          canonical: seoData?.canonical || null,
          h1: seoData?.h1?.[0] || null,
          tags: (promoteTags.value || "").split(",").map(t => t.trim()).filter(Boolean),
        }),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) {
        if (res.status === 403) throw new Error(`Fehlende Berechtigung. <a href="#" class="open-options-link">In Options aktivieren</a>`);
        throw new Error(data?.detail || text || `HTTP ${res.status}`);
      }
      promoteHint.textContent = `Gespeichert: ${data.data?.raw_path || "OK"}`;
      promoteHint.className = "tool-status success";
      promoteTitle.value = "";
      promoteDesc.value = "";
      promoteTags.value = "";
      promoteForm.style.display = "none";
    } catch (err) {
      promoteHint.innerHTML = err.message || String(err);
      promoteHint.className = "tool-status error";
      promoteHint.querySelector(".open-options-link")?.addEventListener("click", e => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
    } finally {
      promoteSubBtn.disabled = false;
    }
  });

  const promoteSection = el("div");
  promoteSection.append(promoteBtn, promoteForm);

  const chatBtn = el("button", { type: "button", className: "secondary", textContent: "🌐 Mit Seite chatten" });
  chatBtn.style.display = "none";
  chatBtn.addEventListener("click", () => {
    const title = promoteTitle.value || "Page-Scrape";
    const content = `Titel: ${title}\nURL: ${lastUrl}\n\n${output.value || ""}`;
    openTool("chat", {
      sourceType: "page",
      sourceRef: { content, title },
      sourceTitle: title,
    });
  });

  state.panelBody.append(urlRow, scrapeModeRow, runBtn, status, chatBtn, output, copyBtn, promoteSection);
}

export function renderSeoCheck() {
  state.panelTitle.textContent = "SEO-Check";

  const runBtn = el("button", { textContent: "Aktiven Tab analysieren" });
  const status = el("div", { className: "tool-status" });
  const output = el("div");
  output.style.cssText = "margin-top:8px;font-size:13px;line-height:1.6;";

  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    status.textContent = "analysiere...";
    status.className = "tool-status";
    output.replaceChildren();
    try {
      const httpBase = await getHttpBase();
      const res = await fetch(`${httpBase}/tools/seo_check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);

      const row = (label, value) => {
        if (!value && value !== 0) return null;
        const wrap = el("div");
        wrap.style.cssText = "padding:3px 0;border-bottom:1px solid var(--border,#eee);";
        const lbl = el("span", { textContent: label + ": " });
        lbl.style.cssText = "font-weight:600;color:var(--muted,#888);margin-right:4px;";
        wrap.append(lbl, document.createTextNode(value));
        return wrap;
      };

      const headingRow = (items, label) => {
        if (!items?.length) return null;
        const wrap = el("div");
        wrap.style.cssText = "padding:3px 0;border-bottom:1px solid var(--border,#eee);";
        const lbl = el("span", { textContent: `${label} (${items.length}): ` });
        lbl.style.cssText = "font-weight:600;color:var(--muted,#888);margin-right:4px;";
        const ul = el("ul");
        ul.style.cssText = "margin:2px 0 0 16px;padding:0;";
        items.slice(0, 5).forEach((t) => ul.append(el("li", { textContent: t })));
        if (items.length > 5) ul.append(el("li", { textContent: `… +${items.length - 5} weitere` }));
        wrap.append(lbl, ul);
        return wrap;
      };

      [
        row("URL", data.url),
        row("Title", data.title),
        row("Description", data.description),
        row("Canonical", data.canonical),
        row("Robots", data.robots),
        headingRow(data.h1, "H1"),
        headingRow(data.h2, "H2"),
        headingRow(data.h3, "H3"),
        row("OG Title", data.og_title),
        row("OG Description", data.og_description),
        row("OG Image", data.og_image),
        row("Twitter Card", data.twitter_card),
        row("Viewport", data.viewport),
        row("Favicon", data.favicon),
      ].forEach((node) => { if (node) output.append(node); });

      status.textContent = "fertig";
      status.className = "tool-status success";
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
    } finally {
      runBtn.disabled = false;
    }
  });

  state.panelBody.append(runBtn, status, output);
}

export function renderImageAnalyse() {
  state.panelTitle.textContent = "Image-Analyse";

  const runBtn = el("button", { textContent: "Bilder analysieren" });
  const status = el("div", { className: "tool-status" });
  const summary = el("div", { className: "tool-status" });
  const list = el("div");
  list.style.cssText = "overflow-y:auto;max-height:420px;display:flex;flex-direction:column;gap:6px;margin-top:8px;";

  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    status.textContent = "analysiere...";
    status.className = "tool-status";
    summary.textContent = "";
    list.replaceChildren();
    try {
      const httpBase = await getHttpBase();
      const res = await fetch(`${httpBase}/tools/image_analyse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);

      const { images = [], total = 0, missing_alt = 0 } = data;
      status.textContent = "fertig";
      status.className = "tool-status success";
      summary.textContent = `${total} Bilder${missing_alt > 0 ? `, ${missing_alt} ohne Alt-Text` : ""}`;

      for (const img of images) {
        const card = el("div");
        card.style.cssText = "display:flex;gap:8px;align-items:flex-start;padding:6px;border:1px solid var(--border,#ddd);border-radius:4px;";
        const thumb = el("img");
        thumb.src = img.src;
        thumb.style.cssText = "width:72px;height:72px;object-fit:cover;flex-shrink:0;border-radius:3px;";
        const info = el("div");
        info.style.cssText = "font-size:12px;line-height:1.5;overflow:hidden;min-width:0;";
        const dims = el("div", { textContent: `${img.width} × ${img.height}` });
        dims.style.color = "var(--muted,#888)";
        const altEl = el("div");
        if (img.alt === null) {
          altEl.textContent = "kein alt-Attribut";
          altEl.style.cssText = "color:var(--error,#c00);font-weight:600;";
        } else if (img.alt === "") {
          altEl.textContent = "(leeres alt)";
          altEl.style.color = "var(--muted,#888)";
        } else {
          altEl.textContent = img.alt;
        }
        info.append(dims, altEl);
        const dlBtn = el("button", { type: "button", className: "secondary", textContent: "Download" });
        dlBtn.style.cssText = "margin-top:4px;font-size:11px;padding:2px 8px;";
        dlBtn.addEventListener("click", () => {
          const filename = (img.src || img.url || "").split("/").pop().split("?")[0] || "image.jpg";
          chrome.downloads.download({ url: img.src || img.url, filename });
        });
        info.append(dims, altEl, dlBtn);
        card.append(thumb, info);
        list.append(card);
      }

      if (images.length > 1) {
        const dlAllBtn = el("button", { type: "button", className: "secondary", textContent: "Alle herunterladen" });
        dlAllBtn.style.marginTop = "6px";
        dlAllBtn.addEventListener("click", () => {
          for (const img of images) {
            const filename = (img.src || img.url || "").split("/").pop().split("?")[0] || "image.jpg";
            chrome.downloads.download({ url: img.src || img.url, filename });
          }
        });
        list.append(dlAllBtn);
      }
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
    } finally {
      runBtn.disabled = false;
    }
  });

  state.panelBody.append(runBtn, status, summary, list);
}

export function renderColorPicker() {
  state.panelTitle.textContent = "Color-Picker";

  const runBtn = el("button", { textContent: "Farben extrahieren" });
  const status = el("div", { className: "tool-status" });
  const output = el("div");
  output.style.cssText = "margin-top:8px;font-size:12px;";

  const swatch = (value) => {
    const s = el("span");
    s.style.cssText = `display:inline-block;width:16px;height:16px;border:1px solid var(--border,#ccc);background:${value};vertical-align:middle;margin-right:6px;border-radius:2px;flex-shrink:0;`;
    return s;
  };

  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    status.textContent = "extrahiere...";
    status.className = "tool-status";
    output.replaceChildren();
    try {
      const httpBase = await getHttpBase();
      const res = await fetch(`${httpBase}/tools/color_picker`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);

      if (data.has_design_system && Object.keys(data.css_vars || {}).length > 0) {
        const sec = el("div");
        sec.append(el("strong", { textContent: "CSS-Variablen" }));
        for (const [name, value] of Object.entries(data.css_vars)) {
          const row = el("div");
          row.style.cssText = "display:flex;align-items:center;margin:3px 0;";
          row.append(swatch(value), document.createTextNode(`${name}: ${value}`));
          sec.append(row);
        }
        output.append(sec);
      }

      if (data.computed?.length > 0) {
        const sec = el("div");
        sec.style.marginTop = "10px";
        sec.append(el("strong", { textContent: "Key-Elemente" }));
        for (const item of data.computed) {
          const row = el("div");
          row.style.cssText = "display:flex;align-items:center;gap:4px;margin:3px 0;";
          const lbl = el("span", { textContent: item.selector });
          lbl.style.cssText = "width:90px;color:var(--muted,#888);flex-shrink:0;";
          row.append(lbl);
          if (item.color) row.append(swatch(item.color));
          if (item.background) row.append(swatch(item.background));
          sec.append(row);
        }
        output.append(sec);
      }

      if (!data.has_design_system && !data.computed?.length) {
        status.textContent = "Keine Farben gefunden";
        status.className = "tool-status";
        return;
      }
      status.textContent = "fertig";
      status.className = "tool-status success";
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
    } finally {
      runBtn.disabled = false;
    }
  });

  const eyeBtn = el("button", { type: "button", className: "secondary", textContent: "🎨 Aus Seite" });
  const eyeResult = el("div");
  eyeResult.style.cssText = "margin-top:6px;font-size:12px;";

  eyeBtn.addEventListener("click", async () => {
    if (!window.EyeDropper) {
      eyeBtn.disabled = true;
      eyeBtn.textContent = "Nicht verfügbar";
      return;
    }
    try {
      const dropper = new EyeDropper();
      const { sRGBHex } = await dropper.open();
      eyeResult.replaceChildren();
      const row = el("div");
      row.style.cssText = "display:flex;align-items:center;gap:6px;margin:3px 0;";
      const hexCopy = el("span", { textContent: sRGBHex });
      hexCopy.style.cssText = "cursor:pointer;";
      hexCopy.title = "Kopieren";
      hexCopy.addEventListener("click", () => navigator.clipboard.writeText(sRGBHex));
      row.append(swatch(sRGBHex), hexCopy);
      eyeResult.append(row);
    } catch {
      // ESC gedrückt — kein Fehler zeigen
    }
  });

  const btnRow = el("div");
  btnRow.style.cssText = "display:flex;gap:8px;";
  btnRow.append(runBtn, eyeBtn);
  state.panelBody.append(btnRow, eyeResult, status, output);
}

export function renderScreenshot() {
  state.panelTitle.textContent = "Screenshot + Annotation";
  const pendingAction = state.pendingToolOptions?.action;
  const initialShotMode = pendingAction === "shot_area" ? "area"
    : pendingAction === "shot_full" ? "full"
    : "visible";
  const autoRun = pendingAction && pendingAction.startsWith("shot_");

  // ── Mode row ──────────────────────────────────────────────────────────────
  let screenshotMode = initialShotMode;
  const modeRow = el("div", { className: "scrape-mode-row" });
  [["visible", "Sichtbar"], ["area", "Bereich"], ["full", "Ganze Seite"]].forEach(([value, label]) => {
    const btn = el("button", { type: "button",
      className: "scrape-mode-btn" + (value === initialShotMode ? " active" : ""),
      textContent: label });
    btn.dataset.value = value;
    btn.addEventListener("click", () => {
      if (screenshotMode === value) return;
      screenshotMode = value;
      modeRow.querySelectorAll(".scrape-mode-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.value === value));
    });
    modeRow.append(btn);
  });

  const runBtn = el("button", { textContent: "Screenshot erstellen" });
  const status = el("div", { className: "tool-status" });

  // ── Annotation-Toolbar ────────────────────────────────────────────────────
  const toolbar = el("div", { className: "annot-toolbar" });
  toolbar.style.display = "none";

  const toolBtns = {};
  const annotToolDefs = [
    { id: "pen",  label: "✏ Stift" },
    { id: "rect", label: "□ Rechteck" },
    { id: "arrow", label: "→ Pfeil" },
    { id: "text", label: "T Text" },
  ];
  let drawTool = "pen";

  annotToolDefs.forEach(({ id, label }) => {
    const btn = el("button", { textContent: label });
    btn.classList.add("secondary", "annot-tool-btn");
    btn.dataset.tool = id;
    btn.addEventListener("click", () => {
      if (cropMode) return;
      drawTool = id;
      Object.values(toolBtns).forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    });
    toolBtns[id] = btn;
    toolbar.append(btn);
  });
  toolBtns["pen"].classList.add("active");

  const colorPicker = document.createElement("input");
  colorPicker.type = "color";
  colorPicker.value = "#ff0000";
  colorPicker.className = "annot-color-picker";
  colorPicker.title = "Farbe";

  const sizeSelect = document.createElement("select");
  sizeSelect.className = "annot-size-select";
  [["2px", "2"], ["4px", "4"], ["6px", "6"]].forEach(([label, val]) => {
    const opt = document.createElement("option");
    opt.textContent = label;
    opt.value = val;
    sizeSelect.append(opt);
  });
  sizeSelect.value = "2";

  const undoBtn = el("button", { textContent: "↩ Undo" });
  undoBtn.classList.add("secondary", "annot-tool-btn");
  toolbar.append(colorPicker, sizeSelect, undoBtn);

  // ── Canvas ────────────────────────────────────────────────────────────────
  const canvas = document.createElement("canvas");
  canvas.className = "annot-canvas";
  canvas.style.display = "none";
  const ctx = canvas.getContext("2d");

  // ── Crop-Mode actions ─────────────────────────────────────────────────────
  const cropActions = el("div");
  cropActions.style.cssText = "display:none;gap:8px;margin-top:6px;flex-wrap:wrap;";
  const confirmCropBtn = el("button", { textContent: "Ausschnitt bestätigen" });
  const cancelCropBtn = el("button", { textContent: "Abbrechen", className: "secondary" });
  cropActions.append(confirmCropBtn, cancelCropBtn);

  // ── Download/Copy actions ─────────────────────────────────────────────────
  const actions = el("div");
  actions.style.cssText = "display:none;gap:8px;margin-top:6px;";
  const copyBtn = el("button", { textContent: "Kopieren" });
  const dlBtn = el("button", { textContent: "Download" });
  copyBtn.classList.add("secondary");
  dlBtn.classList.add("secondary");
  actions.append(copyBtn, dlBtn);

  // ── Drawing state ─────────────────────────────────────────────────────────
  const undoStack = [];
  let drawing = false;
  let startX = 0, startY = 0;
  let snapshot = null;

  // ── Crop state ────────────────────────────────────────────────────────────
  let cropMode = false;
  let cropStart = null;
  let cropRect = null;
  let originalImageData = null;

  function saveUndo() {
    if (undoStack.length >= 20) undoStack.shift();
    undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  }

  function getPos(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (canvas.width / r.width),
      y: (e.clientY - r.top) * (canvas.height / r.height),
    };
  }

  function drawArrow(x1, y1, x2, y2) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const headLen = Math.max(12, ctx.lineWidth * 4);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
  }

  function activateCropMode() {
    cropMode = true;
    cropRect = null;
    cropStart = null;
    originalImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    canvas.style.cursor = "crosshair";
    toolbar.style.display = "none";
    actions.style.display = "none";
    cropActions.style.display = "flex";
    status.textContent = "Bereich aufziehen, dann 'Ausschnitt bestätigen'";
    status.className = "tool-status";
  }

  confirmCropBtn.addEventListener("click", () => {
    if (!cropRect || cropRect.w < 4 || cropRect.h < 4) {
      status.textContent = "Bitte erst einen Bereich aufziehen";
      status.className = "tool-status error";
      return;
    }
    const { x, y, w, h } = cropRect;
    const cropped = ctx.getImageData(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    canvas.width = Math.round(w);
    canvas.height = Math.round(h);
    ctx.putImageData(cropped, 0, 0);
    cropMode = false;
    cropRect = null;
    originalImageData = null;
    canvas.style.cursor = "default";
    cropActions.style.display = "none";
    toolbar.style.display = "flex";
    actions.style.display = "flex";
    undoStack.length = 0;
    status.textContent = "Ausschnitt gesetzt — Annotation möglich";
    status.className = "tool-status success";
  });

  cancelCropBtn.addEventListener("click", () => {
    if (originalImageData) ctx.putImageData(originalImageData, 0, 0);
    cropMode = false;
    cropRect = null;
    originalImageData = null;
    canvas.style.cursor = "default";
    cropActions.style.display = "none";
    toolbar.style.display = "flex";
    actions.style.display = "flex";
    status.textContent = "fertig — Annotation möglich";
    status.className = "tool-status success";
  });

  // ── Canvas mouse events ───────────────────────────────────────────────────
  canvas.addEventListener("mousedown", (e) => {
    const pos = getPos(e);
    if (cropMode) { cropStart = pos; cropRect = null; return; }

    startX = pos.x;
    startY = pos.y;
    drawing = true;
    ctx.strokeStyle = colorPicker.value;
    ctx.fillStyle = colorPicker.value;
    ctx.lineWidth = parseInt(sizeSelect.value, 10);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (drawTool === "text") {
      drawing = false;
      const text = prompt("Text eingeben:");
      if (!text) return;
      saveUndo();
      ctx.font = `${14 + parseInt(sizeSelect.value, 10) * 2}px sans-serif`;
      ctx.fillText(text, pos.x, pos.y);
      return;
    }
    saveUndo();
    if (drawTool === "pen") {
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
    } else {
      snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    }
  });

  canvas.addEventListener("mousemove", (e) => {
    const pos = getPos(e);

    if (cropMode && cropStart) {
      const x = Math.min(cropStart.x, pos.x);
      const y = Math.min(cropStart.y, pos.y);
      const w = Math.abs(pos.x - cropStart.x);
      const h = Math.abs(pos.y - cropStart.y);
      ctx.putImageData(originalImageData, 0, 0);
      ctx.save();
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = "rgba(59,130,246,0.15)";
      ctx.fillRect(x, y, w, h);
      ctx.restore();
      cropRect = { x, y, w, h };
      return;
    }

    if (!drawing) return;
    if (drawTool === "pen") {
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
      return;
    }
    ctx.putImageData(snapshot, 0, 0);
    ctx.strokeStyle = colorPicker.value;
    ctx.lineWidth = parseInt(sizeSelect.value, 10);
    ctx.lineCap = "round";
    if (drawTool === "rect") {
      ctx.strokeRect(startX, startY, pos.x - startX, pos.y - startY);
    } else if (drawTool === "arrow") {
      drawArrow(startX, startY, pos.x, pos.y);
    }
  });

  canvas.addEventListener("mouseup", () => {
    if (cropMode) return;
    if (!drawing) return;
    drawing = false;
    if (drawTool === "pen") ctx.closePath();
    snapshot = null;
  });

  canvas.addEventListener("mouseleave", () => {
    if (cropMode) return;
    if (drawing && drawTool === "pen") { drawing = false; ctx.closePath(); }
  });

  undoBtn.addEventListener("click", () => {
    if (cropMode || !undoStack.length) return;
    ctx.putImageData(undoStack.pop(), 0, 0);
  });

  // ── Helpers ───────────────────────────────────────────────────────────────
  function loadImageToCanvas(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        ctx.drawImage(img, 0, 0);
        canvas.style.display = "block";
        undoStack.length = 0;
        resolve();
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  function loadImg(dataUrl) {
    return new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = dataUrl;
    });
  }

  async function captureVisible() {
    const httpBase = await getHttpBase();
    const res = await fetch(`${httpBase}/tools/screenshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
    return data.dataUrl;
  }

  function captureFullPage() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "full_page_screenshot" }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp?.ok) return reject(new Error(resp?.error || "Full-page capture fehlgeschlagen"));
        resolve(resp);
      });
    });
  }

  function captureRegion() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "capture_region" }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp?.ok) return reject(new Error(resp?.error || "Region capture fehlgeschlagen"));
        resolve(resp.dataUrl);
      });
    });
  }

  // ── Run button ────────────────────────────────────────────────────────────
  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    cropMode = false;
    cropRect = null;
    originalImageData = null;
    status.textContent = "erstelle Screenshot...";
    status.className = "tool-status";
    canvas.style.display = "none";
    toolbar.style.display = "none";
    cropActions.style.display = "none";
    actions.style.display = "none";
    undoStack.length = 0;

    try {
      if (screenshotMode === "full") {
        status.textContent = "scrollt durch Seite...";
        const resp = await captureFullPage();
        const dpr = resp.dpr || 1;
        const totalH = Math.round(resp.totalHeight * dpr);
        const frameW = Math.round(resp.clientWidth * dpr);

        const offscreen = document.createElement("canvas");
        offscreen.width = frameW;
        offscreen.height = totalH;
        const octx = offscreen.getContext("2d");

        for (const frame of resp.frames) {
          const img = await loadImg(frame.dataUrl);
          const destY = Math.round(frame.y * dpr);
          const remaining = totalH - destY;
          const copyH = Math.min(img.naturalHeight, remaining);
          if (copyH > 0) octx.drawImage(img, 0, 0, img.naturalWidth, copyH, 0, destY, img.naturalWidth, copyH);
        }

        canvas.width = offscreen.width;
        canvas.height = offscreen.height;
        ctx.drawImage(offscreen, 0, 0);
        canvas.style.display = "block";
        toolbar.style.display = "flex";
        actions.style.display = "flex";
        status.textContent = `fertig — ${resp.frames.length} Abschnitte, ${resp.totalHeight}px Gesamthöhe`;
        status.className = "tool-status success";
      } else if (screenshotMode === "area") {
        status.textContent = "Bereich auf der Seite aufziehen...";
        const dataUrl = await captureRegion();
        await loadImageToCanvas(dataUrl);
        toolbar.style.display = "flex";
        actions.style.display = "flex";
        status.textContent = "fertig — Annotation möglich";
        status.className = "tool-status success";
      } else {
        const dataUrl = await captureVisible();
        await loadImageToCanvas(dataUrl);
        toolbar.style.display = "flex";
        actions.style.display = "flex";
        status.textContent = "fertig — Annotation möglich";
        status.className = "tool-status success";
      }
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
    } finally {
      runBtn.disabled = false;
    }
  });

  copyBtn.addEventListener("click", async () => {
    canvas.toBlob(async (blob) => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        copyBtn.textContent = "Kopiert!";
        setTimeout(() => { copyBtn.textContent = "Kopieren"; }, 1500);
      } catch {
        copyBtn.textContent = "Fehler";
        setTimeout(() => { copyBtn.textContent = "Kopieren"; }, 1500);
      }
    }, "image/png");
  });

  dlBtn.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `screenshot-${screenshotMode}-${Date.now()}.png`;
    a.click();
  });

  state.panelBody.append(modeRow, runBtn, status, cropActions, toolbar, canvas, actions);

  if (autoRun) setTimeout(() => runBtn.click(), 0);
}

export function renderUrlExtractor() {
  state.panelTitle.textContent = "URL-Extraktor";

  const filterRow = el("label", { className: "checkbox-row" });
  const filterCb = el("input", { type: "checkbox" });
  filterCb.checked = true;
  filterRow.append(filterCb, el("span", { textContent: "Nur diese Domain" }));

  const runBtn = el("button", { textContent: "URLs extrahieren" });
  const status = el("div", { className: "tool-status" });

  const formatTabs = el("div", { className: "format-tabs" });
  const formats = ["Liste", "Komma", "JSON"];
  let activeFormat = "Liste";
  let lastUrls = [];

  const output = el("textarea", { readOnly: true, className: "url-extractor-output", placeholder: "URLs erscheinen hier..." });

  function renderOutput() {
    if (!lastUrls.length) return;
    if (activeFormat === "Liste") output.value = lastUrls.join("\n");
    else if (activeFormat === "Komma") output.value = lastUrls.join(", ");
    else output.value = JSON.stringify(lastUrls, null, 2);
  }

  for (const fmt of formats) {
    const btn = el("button", { type: "button", textContent: fmt, className: "format-tab-btn" + (fmt === activeFormat ? " active" : "") });
    btn.addEventListener("click", () => {
      activeFormat = fmt;
      for (const b of formatTabs.querySelectorAll(".format-tab-btn")) b.classList.remove("active");
      btn.classList.add("active");
      renderOutput();
    });
    formatTabs.append(btn);
  }

  const copyBtn = el("button", { textContent: "Kopieren" });
  copyBtn.classList.add("secondary");

  let lastBaseUrl = "";

  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    status.textContent = "extrahiere...";
    status.className = "tool-status";
    output.value = "";
    lastUrls = [];
    try {
      const httpBase = await getHttpBase();
      const res = await fetch(`${httpBase}/tools/url_extractor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter_domain: filterCb.checked }),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
      lastUrls = data.urls || [];
      lastBaseUrl = data.base_url || "";
      renderOutput();
      status.textContent = `${data.count || 0} URLs gefunden`;
      status.className = "tool-status success";
      state.panelBody.querySelector(".url-source-row")?.remove();
      const sourceRow = el("div", { className: "url-source-row" });
      sourceRow.append(el("span", { className: "url-source-label", textContent: "Quelle:" }));
      try {
        const hostname = new URL(data.base_url).hostname;
        const link = el("a", { href: data.base_url, textContent: hostname, target: "_blank", className: "url-source-link" });
        sourceRow.append(link);
        if (!promoteTitle.value) promoteTitle.value = hostname;
      } catch {
        sourceRow.append(el("span", { textContent: data.base_url }));
      }
      output.before(sourceRow);
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
    } finally {
      runBtn.disabled = false;
    }
  });

  copyBtn.addEventListener("click", () => {
    if (output.value) navigator.clipboard.writeText(output.value);
  });

  // ── Ins Brain ────────────────────────────────────────────────────────────
  const promoteBtn = el("button", { textContent: "Ins Brain", className: "secondary" });
  promoteBtn.style.marginTop = "6px";

  const promoteForm = el("div");
  promoteForm.style.cssText = "display:none;margin-top:8px;padding:10px;border:1px solid var(--border,#ddd);border-radius:6px;background:var(--bg-subtle);";

  const promoteTitle = el("input", { type: "text", placeholder: "Titel (Pflichtfeld)" });
  const promoteSub = el("select");
  ["eigene-notizen", "artikel", "chat-archive"].forEach(s => promoteSub.append(new Option(s, s)));
  const promoteDesc = el("textarea", { placeholder: "Beschreibung (optional)" });
  promoteDesc.style.cssText = "min-height:52px;resize:vertical;margin-top:6px;font-size:12px;";
  const promoteHint = el("div", { className: "tool-status" });
  const promoteSubBtn = el("button", { textContent: "Speichern" });
  const promoteCancelBtn = el("button", { textContent: "Abbrechen", className: "secondary" });
  promoteCancelBtn.style.marginLeft = "6px";

  const promoteSubLabel = el("label", { textContent: "Ziel-Ordner:" });
  promoteSubLabel.style.cssText = "margin-top:6px;display:block;";
  const promoteActRow = el("div");
  promoteActRow.style.marginTop = "8px";
  promoteActRow.append(promoteSubBtn, promoteCancelBtn);

  promoteForm.append(promoteTitle, promoteSubLabel, promoteSub, promoteDesc, promoteHint, promoteActRow);

  promoteBtn.addEventListener("click", () => {
    promoteForm.style.display = promoteForm.style.display === "none" ? "block" : "none";
  });
  promoteCancelBtn.addEventListener("click", () => {
    promoteForm.style.display = "none";
  });
  promoteSubBtn.addEventListener("click", async () => {
    const title = promoteTitle.value.trim();
    if (!title) { promoteHint.textContent = "Titel erforderlich"; promoteHint.className = "tool-status error"; return; }
    if (!lastUrls.length) { promoteHint.textContent = "Erst URLs extrahieren"; promoteHint.className = "tool-status error"; return; }
    promoteSubBtn.disabled = true;
    promoteHint.textContent = "speichere...";
    promoteHint.className = "tool-status";
    try {
      const httpBase = await getHttpBase();
      const vaultId = await getActiveVaultId(httpBase);
      if (!vaultId) throw new Error("Kein Vault konfiguriert");
      const content = lastUrls.map(u => `- ${u}`).join("\n");
      const res = await fetch(`${httpBase}/tools/raw/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vault_id: vaultId,
          title,
          content,
          target_subfolder: promoteSub.value,
          description: promoteDesc.value.trim() || null,
        }),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) {
        if (res.status === 403) throw new Error(`Fehlende Berechtigung. <a href="#" class="open-options-link">In Options aktivieren</a>`);
        throw new Error(data?.detail || text || `HTTP ${res.status}`);
      }
      promoteHint.textContent = `Gespeichert: ${data.data?.raw_path || "OK"}`;
      promoteHint.className = "tool-status success";
      promoteTitle.value = "";
      promoteDesc.value = "";
      promoteForm.style.display = "none";
    } catch (err) {
      promoteHint.innerHTML = err.message || String(err);
      promoteHint.className = "tool-status error";
      promoteHint.querySelector(".open-options-link")?.addEventListener("click", e => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
    } finally {
      promoteSubBtn.disabled = false;
    }
  });

  const promoteSection = el("div");
  promoteSection.append(promoteBtn, promoteForm);

  state.panelBody.append(filterRow, runBtn, status, formatTabs, output, copyBtn, promoteSection);
}

function imggenLabelForEntry(entry) {
  const p = (entry.prompt || "").trim();
  if (p) return p;
  const base = (entry.file || "").split("/").pop().replace(/\.png$/, "");
  const slug = base.replace(/^\d+-/, "").replace(/-/g, " ");
  return slug || "(ohne Prompt)";
}

function fileToInput(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Datei konnte nicht gelesen werden"));
    reader.onload = () => {
      const result = reader.result || "";
      const comma = result.indexOf(",");
      const base64 = comma >= 0 ? result.slice(comma + 1) : result;
      resolve({ name: file.name, mime: file.type || "image/png", base64 });
    };
    reader.readAsDataURL(file);
  });
}

export async function renderImageGenerator() {
  state.panelTitle.textContent = "Image-Generator";

  const httpBase = await getHttpBase();
  const imgUrl = (rel) => `${httpBase}/tools/image_generated/${rel}`;

  // Modell aus Server-Settings holen (Default fallback)
  try {
    const res = await fetch(`${httpBase}/settings`);
    const data = await res.json();
    imageGenState.model = data.image_gen_model || IMAGE_GEN_MODELS[0][0];
  } catch {
    imageGenState.model = imageGenState.model || IMAGE_GEN_MODELS[0][0];
  }

  // Modell-Dropdown
  const modelRow = el("div", { className: "imggen-row" });
  modelRow.append(el("label", { className: "imggen-label", textContent: "Modell" }));
  const modelSelect = el("select", { className: "imggen-model" });
  for (const [value, label] of IMAGE_GEN_MODELS) {
    const opt = new Option(label, value);
    if (value === imageGenState.model) opt.selected = true;
    modelSelect.append(opt);
  }
  modelSelect.addEventListener("change", () => {
    imageGenState.model = modelSelect.value;
  });
  modelRow.append(modelSelect);

  // Prompt
  const promptArea = el("textarea", {
    className: "imggen-prompt",
    placeholder: "Was soll das Bild zeigen?\nBei Editing: 'mach den Hut blau', 'gleiche Person auf Motorrad'...",
    rows: 3,
  });

  // Input-Thumbnails
  const inputsStrip = el("div", { className: "imggen-inputs" });
  function renderInputs() {
    inputsStrip.replaceChildren();
    if (!imageGenState.inputs.length) {
      inputsStrip.append(el("span", { className: "imggen-inputs-empty", textContent: "Keine Input-Bilder. Optional bis zu " + MAX_INPUT_IMAGES + " hinzufügen." }));
    }
    imageGenState.inputs.forEach((img, idx) => {
      const card = el("div", { className: "imggen-thumb" });
      const i = el("img");
      i.src = img.file ? imgUrl(img.file) : `data:${img.mime};base64,${img.base64}`;
      i.title = img.name || "";
      const x = el("button", { type: "button", className: "imggen-thumb-x", textContent: "×", title: "Entfernen" });
      x.addEventListener("click", () => {
        imageGenState.inputs.splice(idx, 1);
        renderInputs();
      });
      card.append(i, x);
      inputsStrip.append(card);
    });
  }

  const inputControls = el("div", { className: "imggen-input-controls" });
  const fileInput = el("input", { type: "file", accept: "image/*", multiple: true });
  fileInput.style.display = "none";
  const addBtn = el("button", { type: "button", className: "secondary", textContent: "+ Bild hinzufügen" });
  addBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const files = Array.from(fileInput.files || []);
    for (const f of files) {
      if (imageGenState.inputs.length >= MAX_INPUT_IMAGES) break;
      try {
        imageGenState.inputs.push(await fileToInput(f));
      } catch (err) {
        status.textContent = "Bild laden fehlgeschlagen: " + (err.message || err);
        status.className = "tool-status error";
      }
    }
    fileInput.value = "";
    renderInputs();
  });

  function pushInputFromGallery(entry, idx) {
    if (imageGenState.inputs.length >= MAX_INPUT_IMAGES) {
      status.textContent = `Maximal ${MAX_INPUT_IMAGES} Inputs erlaubt`;
      status.className = "tool-status error";
      return false;
    }
    imageGenState.inputs.push({
      name: imggenLabelForEntry(entry).slice(0, 40),
      file: entry.file,
    });
    renderInputs();
    return true;
  }

  const continueBtn = el("button", { type: "button", className: "secondary", textContent: "↻ Letztes Ergebnis als Input" });
  continueBtn.title = "Output des letzten Calls als Input weitergeben (Editing-Modus)";
  continueBtn.addEventListener("click", () => {
    if (!imageGenState.lastOutputFile) {
      status.textContent = "Noch kein Ergebnis zum Weiterverwenden";
      status.className = "tool-status error";
      return;
    }
    if (pushInputFromGallery({ file: imageGenState.lastOutputFile, prompt: "letztes Ergebnis" })) {
      status.textContent = "als Input übernommen";
      status.className = "tool-status success";
    }
  });
  inputControls.append(addBtn, continueBtn, fileInput);

  const genBtn = el("button", { textContent: "Generieren" });
  const status = el("div", { className: "tool-status" });

  // Output
  const outputWrap = el("div", { className: "imggen-output hidden" });
  const outputImg = el("img", { className: "imggen-output-img" });
  const outputActions = el("div", { className: "imggen-output-actions" });
  const dlBtn = el("button", { type: "button", className: "secondary", textContent: "Download" });
  const editBtn = el("button", { type: "button", className: "secondary", textContent: "Bearbeiten" });
  editBtn.title = "Dieses Bild als Input für nächste Anweisung";
  const resetBtn = el("button", { type: "button", className: "secondary", textContent: "Neu starten" });
  outputActions.append(dlBtn, editBtn, resetBtn);
  outputWrap.append(outputImg, outputActions);

  // Galerie-Toolbar (Header + Ordner-öffnen + Reload)
  const galleryHeader = el("div", { className: "imggen-history-title" });
  const galleryLabel = el("span", { textContent: "Galerie" });
  const openFolderBtn = el("button", { type: "button", className: "imggen-toolbar-btn", title: "Im Datei-Explorer öffnen", textContent: "📂 Ordner" });
  const reloadBtn = el("button", { type: "button", className: "imggen-toolbar-btn", title: "Galerie neu laden", textContent: "↺" });
  galleryHeader.append(galleryLabel, reloadBtn, openFolderBtn);

  openFolderBtn.addEventListener("click", async () => {
    try {
      const res = await fetch(`${httpBase}/tools/image_gallery/open`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`);
      status.textContent = "Ordner geöffnet: " + data.path;
      status.className = "tool-status success";
    } catch (err) {
      status.textContent = "Ordner-Öffnen fehlgeschlagen: " + (err.message || err);
      status.className = "tool-status error";
    }
  });

  // Galerie aus Server-Index
  const historyWrap = el("div", { className: "imggen-history" });
  function renderHistory() {
    historyWrap.replaceChildren();
    historyWrap.append(galleryHeader);
    if (!imageGenState.gallery.length) {
      historyWrap.append(el("div", { className: "imggen-inputs-empty", textContent: "Noch keine Bilder. Generiere eins ↑" }));
      return;
    }
    const grid = el("div", { className: "imggen-history-grid" });
    imageGenState.gallery.forEach((entry, idx) => {
      const card = el("div", { className: "imggen-history-card" });
      const url = imgUrl(entry.file);
      const label = imggenLabelForEntry(entry);

      const img = el("img");
      img.src = url;
      img.title = label + "\n(Klick: Lightbox öffnen)";
      img.addEventListener("click", () => {
        const qs = new URLSearchParams({ file: entry.file, server: httpBase });
        chrome.tabs.create({
          url: chrome.runtime.getURL("lightbox/lightbox.html") + "?" + qs.toString(),
        });
      });

      const p = el("div", { className: "imggen-history-prompt", textContent: label });
      p.title = label;

      const actions = el("div", { className: "imggen-history-actions" });
      const dl = el("button", { type: "button", title: "Download", textContent: "⬇" });
      dl.addEventListener("click", (e) => {
        e.stopPropagation();
        const a = document.createElement("a");
        a.href = url;
        a.download = entry.file.split("/").pop();
        a.click();
      });
      const reuse = el("button", { type: "button", title: "Als Input weiterverwenden", textContent: "↻" });
      reuse.addEventListener("click", (e) => {
        e.stopPropagation();
        if (pushInputFromGallery(entry, idx)) {
          status.textContent = "als Input übernommen";
          status.className = "tool-status success";
        }
      });
      const del = el("button", { type: "button", title: "In Papierkorb verschieben", textContent: "×", className: "imggen-del" });
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Bild in den Papierkorb verschieben?\n" + entry.file)) return;
        try {
          const res = await fetch(`${httpBase}/tools/image_gallery/${entry.file}`, { method: "DELETE" });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`);
          if (imageGenState.lastOutputFile === entry.file) {
            imageGenState.lastOutputFile = null;
            outputWrap.classList.add("hidden");
          }
          await loadGallery();
        } catch (err) {
          status.textContent = "Löschen fehlgeschlagen: " + (err.message || err);
          status.className = "tool-status error";
        }
      });
      actions.append(dl, reuse, del);

      card.append(img, p, actions);
      grid.append(card);
    });
    historyWrap.append(grid);
  }

  async function loadGallery() {
    try {
      const res = await fetch(`${httpBase}/tools/image_gallery`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`);
      imageGenState.gallery = data.items || [];
      renderHistory();
    } catch (err) {
      status.textContent = "Galerie laden fehlgeschlagen: " + (err.message || err);
      status.className = "tool-status error";
    }
  }
  reloadBtn.addEventListener("click", loadGallery);

  dlBtn.addEventListener("click", () => {
    if (!imageGenState.lastOutputFile) return;
    const a = document.createElement("a");
    a.href = imgUrl(imageGenState.lastOutputFile);
    a.download = imageGenState.lastOutputFile.split("/").pop();
    a.click();
  });
  editBtn.addEventListener("click", () => continueBtn.click());
  resetBtn.addEventListener("click", () => {
    imageGenState.inputs = [];
    imageGenState.lastOutputFile = null;
    outputWrap.classList.add("hidden");
    promptArea.value = "";
    status.textContent = "";
    status.className = "tool-status";
    renderInputs();
  });

  genBtn.addEventListener("click", async () => {
    const prompt = promptArea.value.trim();
    if (!prompt) {
      status.textContent = "Prompt fehlt";
      status.className = "tool-status error";
      return;
    }
    genBtn.disabled = true;
    status.textContent = imageGenState.inputs.length
      ? `generiere mit ${imageGenState.inputs.length} Input-Bild(ern)...`
      : "generiere...";
    status.className = "tool-status";
    try {
      const inputImages = imageGenState.inputs.filter((x) => x.base64).map((x) => x.base64);
      const inputFiles = imageGenState.inputs.filter((x) => x.file).map((x) => x.file);
      const res = await fetch(`${httpBase}/tools/image_generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          input_images: inputImages,
          input_files: inputFiles,
          model: imageGenState.model,
        }),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || data?.error || text || `HTTP ${res.status}`);
      if (!data?.ok) throw new Error(data?.error || "Fehler beim Generieren");

      imageGenState.lastOutputFile = data.image_path;
      outputImg.src = imgUrl(data.image_path) + "?t=" + Date.now();
      outputWrap.classList.remove("hidden");
      await loadGallery();
      status.textContent = `fertig (${data.model})`;
      status.className = "tool-status success";
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
    } finally {
      genBtn.disabled = false;
    }
  });

  state.panelBody.append(modelRow, promptArea, inputsStrip, inputControls, genBtn, status, outputWrap, historyWrap);
  renderInputs();
  renderHistory();
  await loadGallery();

  async function consumeImageGenPick() {
    const { imgGenPick } = await chrome.storage.local.get("imgGenPick");
    if (!imgGenPick || !imgGenPick.file) return;
    // stale pick (>5min) ignorieren
    if (imgGenPick.ts && Date.now() - imgGenPick.ts > 5 * 60 * 1000) {
      chrome.storage.local.remove("imgGenPick");
      return;
    }
    chrome.storage.local.remove("imgGenPick");
    if (pushInputFromGallery({ file: imgGenPick.file, prompt: "aus Lightbox" })) {
      status.textContent = "aus Lightbox als Input übernommen";
      status.className = "tool-status success";
    }
  }
  await consumeImageGenPick();

  // Listener fuer den Fall, dass Sidepanel+Tool schon offen sind, waehrend
  // die Lightbox "Bearbeiten" anstoesst.
  const pickListener = (changes, area) => {
    if (area === "local" && changes.imgGenPick && changes.imgGenPick.newValue) {
      consumeImageGenPick();
    }
  };
  chrome.storage.onChanged.addListener(pickListener);
  state.currentToolCleanup = () => chrome.storage.onChanged.removeListener(pickListener);
}
