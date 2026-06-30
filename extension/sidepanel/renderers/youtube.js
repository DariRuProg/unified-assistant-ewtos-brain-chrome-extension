// YouTube-Transcript Renderer. ewtos.com
import { el } from '../dom.js';
import { state } from '../state.js';
import { getHttpBase } from '../modules/api.js';
import { openTool } from '../modules/tool-runner.js';
import { t } from '../../i18n/i18n.js';

const YT_STORE_KEY = "ytLastResult";
// Letztes gezogenes Transcript — überlebt Tool-Wechsel (Modul-Variable) und
// Browser-Neustart (chrome.storage.local). Form: { url, title, data }.
let lastResult = null;

export function renderYoutubeTranscript() {
  state.panelTitle.textContent = t("youtube.title");

  const urlRow = el("div");
  urlRow.style.cssText = "display:flex;gap:6px;align-items:stretch;";
  const urlInput = el("input", { type: "url", placeholder: t("youtube.url_placeholder") });
  urlInput.style.flex = "1";
  const refreshBtn = el("button", {
    type: "button", textContent: "↻", title: t("youtube.refresh_hint"),
    className: "secondary",
  });
  refreshBtn.style.cssText = "padding:4px 10px;flex:0 0 auto;";
  urlRow.append(urlInput, refreshBtn);

  const runBtn = el("button", { textContent: t("youtube.fetch"), className: "yt-fetch-btn" });
  const status = el("div", { className: "tool-status" });
  const sourceInfo = el("div", { className: "sc-source-info" });
  const metaCard = el("div", { className: "yt-meta-card hidden" });

  // Transcript-Accordion — eingeklappt, Inhalt erst auf Aufklappen
  const transcriptWrap = el("div", { className: "scrape-preview-wrap" });
  const transcriptToggle = el("button", { type: "button", className: "scrape-preview-toggle", textContent: "▸ " + t("youtube.show_transcript") });
  transcriptToggle.style.display = "none";
  const output = el("textarea", { placeholder: t("youtube.result_placeholder"), readOnly: true });
  output.style.display = "none";
  let transcriptExpanded = false;
  function setTranscriptExpanded(expanded) {
    transcriptExpanded = expanded;
    output.style.display = expanded ? "" : "none";
    transcriptToggle.textContent = (expanded ? "▾ " : "▸ ") + t(expanded ? "youtube.hide_transcript" : "youtube.show_transcript");
  }
  transcriptToggle.addEventListener("click", () => setTranscriptExpanded(!transcriptExpanded));
  transcriptWrap.append(transcriptToggle, output);

  // ── Quell-Info + Metadaten aus einer Fetch-Antwort aufbauen ─────────────────
  function setSource(url, title) {
    sourceInfo.replaceChildren(
      el("span", { className: "sc-source-label", textContent: t("youtube.last_fetched") + ": " }),
      el("span", { className: "sc-source-page", textContent: title || url }),
    );
    sourceInfo.title = url;
  }

  function populateMeta(data) {
    metaCard.replaceChildren();
    const rows = [
      data?.title ? [t("youtube.meta_title"), el("b", { textContent: data.title })] : null,
      data?.channel ? [t("youtube.meta_channel"), data.channel] : null,
      (data?.duration || data?.views || data?.likes)
        ? [t("youtube.meta_info"), [data?.duration, data?.views ? t("youtube.views", { count: data.views }) : null, data?.likes ? t("youtube.likes", { count: data.likes }) : null].filter(Boolean).join(" · ")]
        : null,
      data?.upload_date ? [t("youtube.meta_upload"), data.upload_date] : null,
    ].filter(Boolean);
    for (const [label, val] of rows) {
      const row = el("div", { className: "yt-meta-row" });
      row.append(el("span", { textContent: label + ":" }), " ");
      row.append(val);
      metaCard.append(row);
    }
    if (data?.description) {
      const descRow = el("div", { className: "yt-meta-row yt-meta-desc" });
      descRow.append(el("span", { textContent: t("youtube.meta_desc") + ":" }), el("div", { className: "yt-desc-text", textContent: data.description }));
      metaCard.append(descRow);
    }
    metaCard.classList.toggle("hidden", rows.length === 0 && !data?.description);
  }

  // Ergebnis in die UI spiegeln. `expand` = Transcript-Accordion aufgeklappt zeigen.
  function applyResult(data, url, expand) {
    lastResult = { url, title: data?.title || "", data };
    state.lastFetchData = data;
    output.value = data?.transcript || "";
    populateMeta(data);
    setSource(url, data?.title || "");
    if (output.value) {
      transcriptToggle.style.display = "";
      setTranscriptExpanded(!!expand);
    } else {
      transcriptToggle.style.display = "none";
    }
  }

  // ── Aktiver-Tab-URL: Auto-Fill + needs-fetch-Highlight ──────────────────────
  let lastAutoUrl = "";
  function updateFetchHint(activeUrl) {
    const isWatch = /youtube\.com\/watch/.test(activeUrl || "");
    const different = isWatch && (!lastResult || activeUrl !== lastResult.url);
    runBtn.classList.toggle("needs-fetch", different);
  }
  function loadFromActiveTab(force = false) {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      const u = tab?.url || "";
      updateFetchHint(u);
      if (!/youtube\.com\/watch/.test(u)) return;
      // Auto-update nur wenn Feld leer ist, das letzte Auto-Loaded entspricht
      // oder explizit über Refresh-Button getriggert — kein manuell editierter URL.
      if (force || !urlInput.value.trim() || urlInput.value === lastAutoUrl) {
        urlInput.value = u;
        lastAutoUrl = u;
      }
    });
  }
  loadFromActiveTab(true);
  refreshBtn.addEventListener("click", () => loadFromActiveTab(true));

  // Restore letztes Transcript (Modul-Variable oder persistenter Storage)
  if (lastResult?.data) {
    applyResult(lastResult.data, lastResult.url, false);
    status.textContent = t("youtube.restored");
  } else {
    chrome.storage.local.get(YT_STORE_KEY).then((res) => {
      const saved = res?.[YT_STORE_KEY];
      if (saved?.data) {
        applyResult(saved.data, saved.url, false);
        status.textContent = t("youtube.restored");
        loadFromActiveTab(false);
      }
    });
  }

  // Auto-Detect Tab-Wechsel + URL-Änderung im aktiven Tab
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

  // Fallback-Row: erscheint nur, wenn Browser + Server-Fallback beide fail liefern
  const fallbackRow = el("div", { className: "tool-fallback hidden" });
  fallbackRow.style.cssText = "margin-top:8px;padding:10px;border:1px solid var(--border,#ddd);border-radius:6px;background:var(--bg-subtle,#f5f5f5);";
  const fallbackHint = el("div", { className: "tool-status" });
  fallbackHint.style.cssText = "margin-bottom:6px;font-size:12px;";
  fallbackHint.textContent = t("youtube.fallback_hint");
  const openTabBtn = el("button", { textContent: t("youtube.fallback_open"), className: "secondary" });
  const manualArea = el("textarea", { placeholder: t("youtube.fallback_paste") });
  manualArea.style.cssText = "margin-top:8px;min-height:80px;";
  const useManualBtn = el("button", { textContent: t("youtube.fallback_use"), className: "secondary" });
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
      status.textContent = t("youtube.fallback_required");
      status.className = "tool-status error";
      return;
    }
    applyResult({ transcript: txt }, urlInput.value.trim(), true);
    chrome.storage.local.set({ [YT_STORE_KEY]: lastResult });
    status.textContent = t("youtube.fallback_adopted");
    status.className = "tool-status success";
    fallbackRow.classList.add("hidden");
  });

  async function fetchTranscript() {
    const url = urlInput.value.trim();
    if (!url) {
      status.textContent = t("youtube.url_required");
      status.className = "tool-status error";
      return null;
    }
    runBtn.disabled = true;
    status.textContent = t("youtube.running");
    status.className = "tool-status";
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
      applyResult(data, url, true);
      chrome.storage.local.set({ [YT_STORE_KEY]: lastResult });
      runBtn.classList.remove("needs-fetch");
      let src;
      if (data?.source === "server_api") src = t("youtube.done_api", { lang: data?.lang ? ", " + data.lang : "" });
      else if (data?.source === "extension") src = t("youtube.done_browser");
      else src = t("common.done");
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

  const chatBtn = el("button", { textContent: t("youtube.chat"), className: "secondary" });
  chatBtn.style.marginLeft = "6px";
  chatBtn.title = t("youtube.chat_hint");
  chatBtn.addEventListener("click", () => {
    const transcript = (lastResult?.data?.transcript || output.value || "").trim();
    if (!transcript) {
      status.textContent = t("youtube.transcript_required");
      status.className = "tool-status error";
      return;
    }
    const url = lastResult?.url || urlInput.value.trim();
    openTool("chat", {
      sourceType: "page",
      sourceRef: { content: `URL: ${url}\n\n${transcript}`, title: url },
      sourceTitle: t("youtube.title"),
    });
  });

  const tagsInput = el("input", { type: "text", placeholder: t("youtube.tags_hint") });
  tagsInput.className = "yt-tags-input";
  const parseTags = (s) => (s || "").split(",").map(t => t.trim()).filter(Boolean);

  const saveRawBtn = el("button", { textContent: t("youtube.save_raw"), className: "secondary" });
  saveRawBtn.style.marginLeft = "6px";
  saveRawBtn.title = t("youtube.save_raw_hint");
  saveRawBtn.addEventListener("click", async () => {
    if (!lastResult?.data || !lastResult.url) {
      status.textContent = t("youtube.transcript_required");
      status.className = "tool-status error";
      return;
    }
    const { selectedVaultId } = await chrome.storage.local.get("selectedVaultId");
    if (!selectedVaultId) {
      status.textContent = t("youtube.no_vault");
      status.className = "tool-status error";
      return;
    }
    const fd = lastResult.data;
    saveRawBtn.disabled = true;
    status.textContent = t("common.saving");
    status.className = "tool-status";
    try {
      const httpBase = await getHttpBase();
      const res = await fetch(`${httpBase}/tools/raw/save_video`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vault_id: selectedVaultId,
          url: lastResult.url,
          title: fd.title || "",
          transcript: fd.transcript || output.value || "",
          channel: fd.channel || null,
          duration: fd.duration || null,
          views: fd.views || null,
          likes: fd.likes || null,
          upload_date: fd.upload_date || null,
          thumbnail_url: fd.thumbnail_url || null,
          description: fd.description || null,
          tags: parseTags(tagsInput.value),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403) {
        status.textContent = t("youtube.no_write_perm");
        status.className = "tool-status error";
      } else if (!res.ok) {
        throw new Error(data?.detail || `HTTP ${res.status}`);
      } else {
        status.textContent = t("youtube.saved_raw", { path: data.raw_path || "" });
        status.className = "tool-status success";
      }
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
    } finally {
      saveRawBtn.disabled = false;
    }
  });

  const batchToggle = el("button", { textContent: t("youtube.batch"), className: "secondary" });
  batchToggle.style.marginLeft = "6px";
  batchToggle.title = t("youtube.batch_hint");

  const batchArea = el("textarea", { placeholder: t("youtube.batch_placeholder") });
  batchArea.style.cssText = "display:none;min-height:100px;resize:vertical;margin-top:8px;";

  const farmAllBtn = el("button", { textContent: t("youtube.farm_all") });
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
    batchToggle.textContent = batchMode ? t("youtube.single") : t("youtube.batch");
    if (!batchMode) batchResults.replaceChildren();
  });

  farmAllBtn.addEventListener("click", async () => {
    const urls = batchArea.value.split("\n").map(u => u.trim()).filter(u => u.startsWith("http"));
    if (!urls.length) { status.textContent = t("youtube.no_urls"); status.className = "tool-status error"; return; }
    const { selectedVaultId } = await chrome.storage.local.get("selectedVaultId");
    if (!selectedVaultId) { status.textContent = t("youtube.no_vault_batch"); status.className = "tool-status error"; return; }
    const httpBase = await getHttpBase();
    const results = [];
    batchResults.replaceChildren();
    farmAllBtn.disabled = true;
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      status.textContent = t("youtube.batch_progress", { i: i + 1, total: urls.length });
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
    status.textContent = t("youtube.batch_result", { ok, total: urls.length });
    status.className = ok === urls.length ? "tool-status success" : "tool-status";
    farmAllBtn.disabled = false;
  });

  const btnRow = el("div");
  btnRow.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;";
  btnRow.append(runBtn, chatBtn, saveRawBtn, batchToggle);

  state.panelBody.append(urlRow, btnRow, status, sourceInfo, metaCard, tagsInput, transcriptWrap, fallbackRow, batchArea, farmAllBtn, batchResults);
}
