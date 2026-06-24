// YouTube-Transcript Renderer. ewtos.com
import { el } from '../dom.js';
import { state } from '../state.js';
import { getHttpBase } from '../modules/api.js';
import { openTool } from '../modules/tool-runner.js';

export function renderYoutubeTranscript() {
  state.panelTitle.textContent = "YouTube-Transcript";

  const urlRow = el("div");
  urlRow.style.cssText = "display:flex;gap:6px;align-items:stretch;";
  const urlInput = el("input", { type: "url", placeholder: "https://www.youtube.com/watch?v=..." });
  urlInput.style.flex = "1";
  const refreshBtn = el("button", {
    type: "button", textContent: "↻", title: "URL aus aktivem Tab übernehmen",
    className: "secondary",
  });
  refreshBtn.style.cssText = "padding:4px 10px;flex:0 0 auto;";
  urlRow.append(urlInput, refreshBtn);

  let lastAutoUrl = "";
  function loadFromActiveTab(force = false) {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      const u = tab?.url || "";
      if (!/youtube\.com\/watch/.test(u)) return;
      // Auto-update nur wenn Feld leer ist, das letzte Auto-Loaded entspricht
      // oder explizit ueber Refresh-Button getriggert — so wird kein manuell
      // editierter URL ueberschrieben.
      if (force || !urlInput.value.trim() || urlInput.value === lastAutoUrl) {
        urlInput.value = u;
        lastAutoUrl = u;
      }
    });
  }
  loadFromActiveTab(true);
  refreshBtn.addEventListener("click", () => loadFromActiveTab(true));

  // Auto-Detect Tab-Wechsel + URL-Aenderung im aktiven Tab
  const onActivated = () => loadFromActiveTab(false);
  const onUpdated = (tabId, changeInfo, tab) => {
    if (changeInfo.url && tab.active) loadFromActiveTab(false);
  };
  chrome.tabs.onActivated.addListener(onActivated);
  chrome.tabs.onUpdated.addListener(onUpdated);
  state.currentToolCleanup = () => {
    chrome.tabs.onActivated.removeListener(onActivated);
    chrome.tabs.onUpdated.removeListener(onUpdated);
  };
  const runBtn = el("button", { textContent: "Transcript holen" });
  const status = el("div", { className: "tool-status" });
  const metaCard = el("div", { className: "yt-meta-card hidden" });
  const output = el("textarea", { placeholder: "Ergebnis erscheint hier...", readOnly: true });

  // Fallback-Row: erscheint nur, wenn Browser + Server-Fallback beide fail liefern
  const fallbackRow = el("div", { className: "tool-fallback hidden" });
  fallbackRow.style.cssText = "margin-top:8px;padding:10px;border:1px solid var(--border,#ddd);border-radius:6px;background:var(--bg-subtle,#f5f5f5);";
  const fallbackHint = el("div", { className: "tool-status" });
  fallbackHint.style.cssText = "margin-bottom:6px;font-size:12px;";
  fallbackHint.textContent = "Beide Auto-Pfade fehlgeschlagen. Tab öffnen, Drei-Punkte-Menü → 'Transkript anzeigen', Liste markieren + kopieren, dann hier einfügen.";
  const openTabBtn = el("button", { textContent: "Im YouTube-Tab öffnen", className: "secondary" });
  const manualArea = el("textarea", { placeholder: "Manuell kopiertes Transcript hier einfügen..." });
  manualArea.style.cssText = "margin-top:8px;min-height:80px;";
  const useManualBtn = el("button", { textContent: "Übernehmen", className: "secondary" });
  useManualBtn.style.marginTop = "6px";
  fallbackRow.append(fallbackHint, openTabBtn, manualArea, useManualBtn);

  openTabBtn.addEventListener("click", () => {
    const url = urlInput.value.trim();
    if (!url) return;
    chrome.tabs.create({ url, active: true });
  });

  useManualBtn.addEventListener("click", () => {
    const txt = manualArea.value.trim();
    if (!txt) {
      status.textContent = "Bitte erst Transcript einfügen";
      status.className = "tool-status error";
      return;
    }
    output.value = txt;
    status.textContent = "manuell übernommen";
    status.className = "tool-status success";
    fallbackRow.classList.add("hidden");
  });

  async function fetchTranscript() {
    const url = urlInput.value.trim();
    if (!url) {
      status.textContent = "URL angeben";
      status.className = "tool-status error";
      return null;
    }
    runBtn.disabled = true;
    status.textContent = "läuft... (Server-API zuerst, Browser als Fallback)";
    status.className = "tool-status";
    output.value = "";
    fallbackRow.classList.add("hidden");
    try {
      const httpBase = await getHttpBase();
      const res = await fetch(`${httpBase}/tools/youtube_transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
      output.value = data?.transcript || "";
      state.lastFetchData = data;
      // Metadaten-Karte befüllen
      metaCard.replaceChildren();
      const rows = [
        data?.title ? ["Titel", el("b", { textContent: data.title })] : null,
        data?.channel ? ["Kanal", data.channel] : null,
        (data?.duration || data?.views || data?.likes)
          ? ["Info", [data?.duration, data?.views ? `${data.views} Aufrufe` : null, data?.likes ? `${data.likes} Likes` : null].filter(Boolean).join(" · ")]
          : null,
        data?.upload_date ? ["Upload", data.upload_date] : null,
      ].filter(Boolean);
      for (const [label, val] of rows) {
        const row = el("div", { className: "yt-meta-row" });
        const lspan = el("span", { textContent: label + ":" });
        row.append(lspan, " ");
        if (typeof val === "string") row.append(val);
        else row.append(val);
        metaCard.append(row);
      }
      if (data?.description) {
        const descRow = el("div", { className: "yt-meta-row yt-meta-desc" });
        descRow.append(el("span", { textContent: "Beschreibung:" }), el("div", { className: "yt-desc-text", textContent: data.description }));
        metaCard.append(descRow);
      }
      metaCard.classList.remove("hidden");
      let src;
      if (data?.source === "server_api") src = `fertig (Server-API${data?.lang ? ", " + data.lang : ""})`;
      else if (data?.source === "extension") src = "fertig (Browser-Fallback)";
      else src = "fertig";
      status.textContent = src;
      status.className = "tool-status success";
      return data;
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
      fallbackRow.classList.remove("hidden");
      return null;
    } finally {
      runBtn.disabled = false;
    }
  }

  runBtn.addEventListener("click", fetchTranscript);

  const chatBtn = el("button", { textContent: "💬 Chat mit Transcript", className: "secondary" });
  chatBtn.style.marginLeft = "6px";
  chatBtn.title = "Direkt mit dem geholten Transcript chatten (ohne ins Brain zu speichern)";
  chatBtn.addEventListener("click", () => {
    const transcript = (output.value || "").trim();
    if (!transcript) {
      status.textContent = "Erst Transcript holen";
      status.className = "tool-status error";
      return;
    }
    const url = urlInput.value.trim();
    openTool("chat", {
      sourceType: "page",
      sourceRef: { content: `URL: ${url}\n\n${transcript}`, title: url },
      sourceTitle: "YouTube-Transcript",
    });
  });

  const tagsInput = el("input", { type: "text", placeholder: "Tags (kommagetrennt, optional)" });
  tagsInput.className = "yt-tags-input";
  const parseTags = (s) => (s || "").split(",").map(t => t.trim()).filter(Boolean);

  const saveRawBtn = el("button", { textContent: "📥 In Raw speichern", className: "secondary" });
  saveRawBtn.style.marginLeft = "6px";
  saveRawBtn.title = "Transcript als Raw-Datei im aktiven Vault speichern";
  saveRawBtn.addEventListener("click", async () => {
    if (!state.lastFetchData || !urlInput.value.trim()) {
      status.textContent = "Erst Transcript holen";
      status.className = "tool-status error";
      return;
    }
    const { selectedVaultId } = await chrome.storage.local.get("selectedVaultId");
    if (!selectedVaultId) {
      status.textContent = "Kein Vault ausgewählt — zuerst in den Einstellungen einen Vault verbinden";
      status.className = "tool-status error";
      return;
    }
    saveRawBtn.disabled = true;
    status.textContent = "speichere...";
    status.className = "tool-status";
    try {
      const httpBase = await getHttpBase();
      const res = await fetch(`${httpBase}/tools/raw/save_video`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vault_id: selectedVaultId,
          url: urlInput.value.trim(),
          title: state.lastFetchData.title || "",
          transcript: state.lastFetchData.transcript || output.value || "",
          channel: state.lastFetchData.channel || null,
          duration: state.lastFetchData.duration || null,
          views: state.lastFetchData.views || null,
          likes: state.lastFetchData.likes || null,
          upload_date: state.lastFetchData.upload_date || null,
          thumbnail_url: state.lastFetchData.thumbnail_url || null,
          description: state.lastFetchData.description || null,
          tags: parseTags(tagsInput.value),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403) {
        status.textContent = "Kein Schreibrecht auf raw/ — in den Einstellungen aktivieren";
        status.className = "tool-status error";
      } else if (!res.ok) {
        throw new Error(data?.detail || `HTTP ${res.status}`);
      } else {
        status.textContent = `In Raw gespeichert: ${data.raw_path || ""}`;
        status.className = "tool-status success";
      }
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
    } finally {
      saveRawBtn.disabled = false;
    }
  });

  const batchToggle = el("button", { textContent: "Batch", className: "secondary" });
  batchToggle.style.marginLeft = "6px";
  batchToggle.title = "Zwischen Einzel- und Batch-Modus umschalten";

  const batchArea = el("textarea", { placeholder: "Eine URL pro Zeile\nhttps://youtube.com/watch?v=..." });
  batchArea.style.cssText = "display:none;min-height:100px;resize:vertical;margin-top:8px;";

  const farmAllBtn = el("button", { textContent: "Farm All" });
  farmAllBtn.style.display = "none";

  const batchResults = el("div");
  batchResults.style.marginTop = "8px";

  let batchMode = false;
  batchToggle.addEventListener("click", () => {
    batchMode = !batchMode;
    urlRow.style.display = batchMode ? "none" : "";
    runBtn.style.display = batchMode ? "none" : "";
    batchArea.style.display = batchMode ? "" : "none";
    farmAllBtn.style.display = batchMode ? "" : "none";
    batchToggle.textContent = batchMode ? "Einzeln" : "Batch";
    if (!batchMode) batchResults.replaceChildren();
  });

  farmAllBtn.addEventListener("click", async () => {
    const urls = batchArea.value.split("\n").map(u => u.trim()).filter(u => u.startsWith("http"));
    if (!urls.length) { status.textContent = "Keine URLs"; status.className = "tool-status error"; return; }
    const { selectedVaultId } = await chrome.storage.local.get("selectedVaultId");
    if (!selectedVaultId) { status.textContent = "Kein Vault gewählt"; status.className = "tool-status error"; return; }
    const httpBase = await getHttpBase();
    const results = [];
    batchResults.replaceChildren();
    farmAllBtn.disabled = true;
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      status.textContent = `${i + 1}/${urls.length}: ziehe Transcript...`;
      status.className = "tool-status";
      try {
        const transcRes = await fetch(`${httpBase}/tools/youtube_transcript`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        if (!transcRes.ok) throw new Error(`HTTP ${transcRes.status}`);
        const data = await transcRes.json();
        const saveRes = await fetch(`${httpBase}/tools/raw/save_video`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vault_id: selectedVaultId, url,
            title: data.title || "", transcript: data.transcript || "",
            channel: data.channel || null, duration: data.duration || null,
            views: data.views || null, likes: data.likes || null,
            upload_date: data.upload_date || null, thumbnail_url: data.thumbnail_url || null,
            description: data.description || null,
            tags: parseTags(tagsInput.value),
          }),
        });
        const saveData = await saveRes.json();
        if (!saveRes.ok) throw new Error(saveData.detail || `HTTP ${saveRes.status}`);
        const row = el("div", { className: "batch-result-row success", textContent: `✓ ${saveData.data?.raw_path || url}` });
        batchResults.append(row);
        results.push({ url, ok: true });
      } catch (err) {
        const row = el("div", { className: "batch-result-row error", textContent: `✗ ${url}: ${err.message}` });
        batchResults.append(row);
        results.push({ url, ok: false });
      }
    }
    const ok = results.filter(r => r.ok).length;
    status.textContent = `${ok}/${urls.length} erfolgreich`;
    status.className = ok === urls.length ? "tool-status success" : "tool-status";
    farmAllBtn.disabled = false;
  });

  const btnRow = el("div");
  btnRow.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;";
  btnRow.append(runBtn, chatBtn, saveRawBtn, batchToggle);

  state.panelBody.append(urlRow, btnRow, status, metaCard, tagsInput, output, fallbackRow, batchArea, farmAllBtn, batchResults);
}
