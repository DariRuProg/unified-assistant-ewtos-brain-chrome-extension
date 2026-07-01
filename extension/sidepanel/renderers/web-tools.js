// Web-Tools Renderer (Scrape, SEO, Image, Color, Screenshot, URL, ImageGen). ewtos.com
import { el } from '../dom.js';
import { state } from '../state.js';
import { getHttpBase, getActiveVaultId } from '../modules/api.js';
import { openTool } from '../modules/tool-runner.js';
import { renderMarkdown } from '../markdown.js';
import { t } from '../../i18n/i18n.js';

// Bekannte Fehlercodes aus extension/tools/page_scrape.js → lokalisierte Meldung.
function scrapeErrorMessage(raw) {
  const code = String(raw || "").trim();
  const map = {
    ERR_NO_TAB: "web_tools.scrape_no_tab",
    ERR_UNSUPPORTED_PAGE: "web_tools.scrape_unsupported",
    ERR_FILE_PERMISSION: "web_tools.scrape_file_permission",
    ERR_NO_RESULT: "web_tools.scrape_no_result",
  };
  return map[code] ? t(map[code]) : code;
}

const IMAGE_GEN_MODELS = [
  ["gemini-2.5-flash-image", "img_gen_model_flash"],
  ["gemini-3.1-flash-image-preview", "img_gen_model_flash2"],
  ["gemini-3-pro-image-preview", "img_gen_model_pro"],
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
  state.panelTitle.textContent = t("web_tools.scrape_title");
  const pendingAction = state.pendingToolOptions?.action;

  let scrapeMode = pendingAction === "scrape_full" ? "full" : "content";

  // URL-Anzeige des aktiven Browser-Tabs (analog YouTube-Tab)
  const urlRow = el("div", { className: "page-url-row" });
  urlRow.style.cssText = "display:flex;gap:6px;align-items:center;font-size:12px;color:var(--muted,#888);margin-bottom:6px;";
  const urlLabel = el("span", { textContent: t("web_tools.no_tab_detected") });
  urlLabel.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  const refreshUrlBtn = el("button", {
    type: "button", textContent: "↻", title: t("web_tools.refresh_url_title"), className: "secondary",
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
  scrapeModeRow.append(makeScrapeRadio("content", t("web_tools.scrape_mode_content")), makeScrapeRadio("full", t("web_tools.scrape_mode_full")));

  const runBtn = el("button", { textContent: t("web_tools.scrape_run") });
  const status = el("div", { className: "tool-status" });
  const output = el("textarea", { readOnly: true, placeholder: t("web_tools.result_placeholder") });
  const copyBtn = el("button", { textContent: t("web_tools.scrape_copy") });
  copyBtn.classList.add("secondary");

  let lastMarkdown = "";
  let lastUrl = "";

  function updateUrlFromActiveTab() {
    if (!chrome?.tabs?.query) return;
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      const u = tab?.url || "";
      urlLabel.textContent = u || t("web_tools.no_tab_detected");
      urlLabel.title = u;
    });
  }

  async function runScrape() {
    runBtn.disabled = true;
    status.textContent = t("web_tools.scrape_loading");
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
      status.textContent = `${data.title || ""} — ${t("web_tools.scrape_words", { count: data.wordCount || 0 })}`;
      status.className = "tool-status success";
      if (data.title && !promoteTitle.value) promoteTitle.value = data.title;
      chatBtn.style.display = "";
    } catch (err) {
      status.textContent = scrapeErrorMessage(err.message || String(err));
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
  const promoteBtn = el("button", { textContent: t("web_tools.promote_to_brain"), className: "secondary" });
  promoteBtn.style.marginTop = "6px";

  const promoteForm = el("div");
  promoteForm.style.cssText = "display:none;margin-top:8px;padding:10px;border:1px solid var(--border,#ddd);border-radius:6px;background:var(--bg-subtle);";

  const promoteTitle = el("input", { type: "text", placeholder: t("web_tools.promote_title_placeholder") });
  const promoteSub = el("select");
  ["artikel", "eigene-notizen", "chat-archive"].forEach(s => promoteSub.append(new Option(s, s)));
  const promoteDesc = el("textarea", { placeholder: t("web_tools.promote_desc_placeholder") });
  promoteDesc.style.cssText = "min-height:52px;resize:vertical;margin-top:6px;font-size:12px;";

  const promoteTags = el("input", { type: "text", placeholder: t("web_tools.promote_tags_placeholder") });
  promoteTags.className = "promote-tags-input";
  promoteTags.style.marginTop = "6px";

  const seoCheckboxRow = el("div");
  seoCheckboxRow.style.cssText = "display:flex;align-items:center;gap:6px;margin-top:8px;font-size:12px;";
  const seoCheckbox = el("input", { type: "checkbox" });
  seoCheckbox.checked = true;
  seoCheckboxRow.append(seoCheckbox, el("span", { textContent: t("web_tools.promote_add_seo") }));

  const promoteHint = el("div", { className: "tool-status" });
  const promoteSubBtn = el("button", { textContent: t("common.save") });
  const promoteCancelBtn = el("button", { textContent: t("common.cancel"), className: "secondary" });
  promoteCancelBtn.style.marginLeft = "6px";

  const promoteSubLabel = el("label", { textContent: t("web_tools.promote_target_folder") });
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
    if (!title) { promoteHint.textContent = t("web_tools.promote_title_required"); promoteHint.className = "tool-status error"; return; }
    if (!lastMarkdown) { promoteHint.textContent = t("web_tools.promote_scrape_first"); promoteHint.className = "tool-status error"; return; }
    promoteSubBtn.disabled = true;
    promoteHint.textContent = t("web_tools.promote_saving");
    promoteHint.className = "tool-status";
    try {
      const httpBase = await getHttpBase();
      const vaultId = await getActiveVaultId(httpBase);
      if (!vaultId) throw new Error(t("web_tools.promote_no_vault"));
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
        if (res.status === 403) throw new Error(t("web_tools.promote_no_permission"));
        throw new Error(data?.detail || text || `HTTP ${res.status}`);
      }
      promoteHint.textContent = t("web_tools.promote_saved", { path: data.data?.raw_path || "OK" });
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

  const chatBtn = el("button", { type: "button", className: "secondary", textContent: t("web_tools.chat_with_page") });
  chatBtn.style.display = "none";
  chatBtn.addEventListener("click", () => {
    const title = promoteTitle.value || t("web_tools.page_scrape_default_title");
    const content = `Titel: ${title}\nURL: ${lastUrl}\n\n${output.value || ""}`;
    openTool("chat", {
      sourceType: "page",
      sourceRef: { content, title },
      sourceTitle: title,
    });
  });

  state.panelBody.append(urlRow, scrapeModeRow, runBtn, status, chatBtn, output, copyBtn, promoteSection);
}

export async function renderScrapeChat() {
  state.panelTitle.textContent = t("web_tools.sc_title");
  const pendingAction = state.pendingToolOptions?.action;
  let scrapeMode = pendingAction === "scrape_full" ? "full" : "content";

  const httpBase = await getHttpBase();
  let ttsEnabled = false;
  try {
    const sr = await fetch(`${httpBase}/settings`);
    if (sr.ok) ttsEnabled = (await sr.json()).chat_tts_enabled === true;
  } catch (_) {}

  // Scrape-Mode Toggle. "Body-Content" = sauberer Hauptinhalt; "Inkl. Header & Footer"
  // ist der Fallback wenn der erste Scraper zu wenig zieht (JS-Seiten, ungewöhnliches Layout).
  const scrapeModeRow = el("div", { className: "scrape-mode-row" });
  function makeScrapeBtn(value, label, title) {
    const btn = el("button", { type: "button", title, className: "scrape-mode-btn" + (value === scrapeMode ? " active" : ""), textContent: label });
    btn.dataset.value = value;
    btn.addEventListener("click", async () => {
      if (scrapeMode === value) return;
      scrapeMode = value;
      scrapeModeRow.querySelectorAll(".scrape-mode-btn").forEach(b => b.classList.toggle("active", b.dataset.value === value));
      await doScrape();
    });
    return btn;
  }
  scrapeModeRow.append(
    makeScrapeBtn("content", t("web_tools.sc_mode_body"), t("web_tools.sc_mode_body_title")),
    makeScrapeBtn("full", t("web_tools.sc_mode_full"), t("web_tools.sc_mode_full_title")),
  );

  // Aktive Seite + manueller Scrape-Button. Highlight, sobald der Tab auf eine
  // noch nicht gescrapte Seite gewechselt ist (kein Auto-Scrape bei Wechsel).
  const pageBar = el("div", { className: "sc-page-bar" });
  const pageTitleEl = el("div", { className: "sc-page-title" });
  const scrapeBtn = el("button", { type: "button", className: "sc-scrape-btn", textContent: t("web_tools.sc_scrape_this") });
  pageBar.append(pageTitleEl, scrapeBtn);

  // Scrape-Preview — Quell-Info + eingeklapptes Accordion (Inhalt nur auf Aufklappen)
  const previewWrap = el("div", { className: "scrape-preview-wrap" });
  const sourceInfo = el("div", { className: "sc-source-info" });
  const previewHead = el("div", { className: "scrape-preview-head" });
  const previewToggle = el("button", { type: "button", className: "scrape-preview-toggle", textContent: "▸ " + t("web_tools.sc_show_content") });
  previewToggle.style.display = "none";
  const copyBtn = el("button", { type: "button", className: "scrape-preview-copy", textContent: "⧉ " + t("web_tools.copy"), title: t("web_tools.sc_copy_text") });
  copyBtn.style.display = "none";
  previewHead.append(previewToggle, copyBtn);
  const previewText = el("div", { className: "scrape-preview" });
  previewText.style.display = "none";
  let previewExpanded = false;
  previewToggle.addEventListener("click", () => {
    previewExpanded = !previewExpanded;
    previewText.style.display = previewExpanded ? "" : "none";
    previewToggle.textContent = previewExpanded ? "▾ " + t("web_tools.sc_hide_content") : "▸ " + t("web_tools.sc_show_content");
  });
  copyBtn.addEventListener("click", async () => {
    if (!scrapedPage?.markdown) return;
    try {
      await navigator.clipboard.writeText(scrapedPage.markdown);
      copyBtn.textContent = "✓ " + t("web_tools.copied_short");
      setTimeout(() => { copyBtn.textContent = "⧉ " + t("web_tools.copy"); }, 1500);
    } catch (_) {}
  });
  previewWrap.append(sourceInfo, previewHead, previewText);

  // Chat
  const chatLog = el("div", { className: "sc-chat-log" });
  const chatStatus = el("div", { className: "tool-status" });
  const chatInputRow = el("div", { className: "chat-input" });
  const chatTextarea = el("textarea", { placeholder: t("web_tools.sc_ask_placeholder"), rows: 2 });
  chatTextarea.style.cssText = "flex:1;min-height:44px;max-height:120px;resize:vertical;font-family:inherit;font-size:13px;";
  const micBtn = el("button", { type: "button", textContent: "🎙", title: t("web_tools.sc_voice_input") });
  micBtn.classList.add("mic-btn");
  const sendBtn = el("button", { type: "button", textContent: "➤" });
  sendBtn.disabled = true;
  chatInputRow.append(chatTextarea, micBtn, sendBtn);
  const chatOfflineHint = el("div", { className: "sc-chat-offline", textContent: t("web_tools.sc_chat_needs_server") });
  chatOfflineHint.style.display = "none";

  let scrapedPage = null;
  let chatHistory = [];
  let busy = false;
  let currentTab = null;

  function setChatStatus(text, cls) {
    chatStatus.textContent = text;
    chatStatus.className = "tool-status" + (cls ? " " + cls : "");
  }

  async function getActiveTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab || null;
    } catch { return null; }
  }
  function refreshPageBar() {
    const url = currentTab?.url || "";
    const isWeb = /^https?:\/\//.test(url);
    const isNew = isWeb && url !== scrapedPage?.url;
    pageTitleEl.textContent = currentTab?.title || url || "—";
    pageTitleEl.title = url;
    scrapeBtn.disabled = !isWeb;
    scrapeBtn.classList.toggle("needs-scrape", isNew);
  }
  async function onTabChange() {
    currentTab = await getActiveTab();
    refreshPageBar();
  }
  const onTabActivated = () => onTabChange();
  const onTabUpdated = (_id, info) => { if (info.status === "complete") onTabChange(); };

  // ── TTS (Vorlesen): Server-TTS wenn aktiviert, sonst Web Speech als Fallback ──
  let _activeAudio = null, _speechPoll = null;
  function stopAllTts() {
    if (_activeAudio) { _activeAudio.pause(); _activeAudio = null; }
    if (_speechPoll) { clearInterval(_speechPoll); _speechPoll = null; }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }
  function addTtsButton(bubble) {
    if (!bubble) return;
    const speakText = (bubble.textContent || "").trim();
    if (!speakText) return;
    const b = el("button", { type: "button", className: "tts-btn", textContent: "🔊", title: t("web_tools.sc_read_aloud") });
    const setIdle = () => { b.textContent = "🔊"; b.title = t("web_tools.sc_read_aloud"); b.disabled = false; };
    const setSpeaking = () => { b.textContent = "⏹"; b.title = t("web_tools.sc_stop"); b.disabled = false; };
    b.addEventListener("click", async () => {
      if (b.textContent === "⏹") { stopAllTts(); setIdle(); return; }
      stopAllTts();
      b.disabled = true; b.textContent = "…";
      try {
        if (ttsEnabled) {
          const r = await fetch(`${httpBase}/tools/tts`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: speakText.slice(0, 5000) }),
          });
          if (r.ok) {
            const blob = await r.blob();
            const audio = new Audio(URL.createObjectURL(blob));
            _activeAudio = audio;
            audio.onended = () => { _activeAudio = null; setIdle(); };
            audio.onerror = () => { _activeAudio = null; setIdle(); };
            try { await audio.play(); setSpeaking(); return; } catch { _activeAudio = null; }
          }
        }
        if (!window.speechSynthesis) { setIdle(); return; }
        window.speechSynthesis.cancel();
        const utt = new SpeechSynthesisUtterance(speakText.slice(0, 5000));
        utt.lang = "de-DE";
        window.speechSynthesis.speak(utt);
        setSpeaking();
        _speechPoll = setInterval(() => {
          if (!window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
            clearInterval(_speechPoll); _speechPoll = null; setIdle();
          }
        }, 300);
      } catch (err) {
        setChatStatus("Vorlesen fehlgeschlagen: " + (err.message || err), "error");
        setIdle();
      }
    });
    bubble.append(b);
  }

  async function doScrape() {
    sourceInfo.textContent = t("web_tools.scrape_loading");
    sourceInfo.className = "sc-source-info";
    previewText.textContent = "";
    previewText.style.display = "none";
    previewToggle.style.display = "none";
    previewToggle.textContent = "▸ " + t("web_tools.sc_show_content");
    copyBtn.style.display = "none";
    previewExpanded = false;
    scrapeBtn.disabled = true;
    sendBtn.disabled = true;
    try {
      const scrape = async (mode) => {
        let r;
        try {
          r = await fetch(`${httpBase}/tools/page_scrape`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode }),
          });
        } catch {
          // Server nicht erreichbar (fetch() selbst wirft) — direkt im Browser scrapen.
          const resp = await chrome.runtime.sendMessage({ type: "run_tool_direct", tool: "page_scrape", params: { mode } });
          if (!resp?.ok) throw new Error(resp?.error || t("web_tools.server_unreachable"));
          return resp.data;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      };
      const MIN_CONTENT = 600;
      let data;
      if (scrapeMode === "full") {
        data = await scrape("full");
      } else {
        data = await scrape("content");
        const len = (data.markdown || "").trim().length;
        if (len < MIN_CONTENT) {
          try {
            const full = await scrape("full");
            if ((full.markdown || "").trim().length > len) data = full;
          } catch (_) {}
        }
      }
      if (!data.markdown) throw new Error(t("web_tools.sc_no_content"));
      scrapedPage = { title: data.title || "", url: data.url || "", markdown: data.markdown };
      previewText.textContent = data.markdown;
      sourceInfo.innerHTML = "";
      sourceInfo.append(
        el("span", { className: "sc-source-label", textContent: t("web_tools.sc_last_scraped") }),
        el("span", { className: "sc-source-page", textContent: data.title || data.url || t("web_tools.color_page") }),
        el("span", { className: "sc-source-meta", textContent: " — " + t("web_tools.scrape_words", { count: data.wordCount || 0 }) }),
      );
      sourceInfo.className = "sc-source-info success";
      previewToggle.style.display = "";
      copyBtn.style.display = "";
      applyChatOnline(state.serverConnected !== false);
      currentTab = await getActiveTab();
      refreshPageBar();
    } catch (err) {
      scrapedPage = null;
      sourceInfo.textContent = err.message || String(err);
      sourceInfo.className = "sc-source-info error";
    } finally {
      scrapeBtn.disabled = false;
    }
  }

  // Chat braucht Server (LLM) — Scrapen läuft offline weiter. Bei fehlender
  // Verbindung Hinweis zeigen + Senden sperren; Live-Update über onRuntimeMsg.
  function applyChatOnline(online) {
    chatOfflineHint.style.display = online ? "none" : "";
    sendBtn.disabled = online ? (!scrapedPage || busy) : true;
  }

  async function sendMsg() {
    const message = chatTextarea.value.trim();
    if (!message || busy || !scrapedPage || state.serverConnected === false) return;
    busy = true;
    sendBtn.disabled = true;
    chatTextarea.disabled = true;
    micBtn.disabled = true;
    chatTextarea.value = "";

    const userBubble = el("div", { className: "chat-msg user", textContent: message });
    chatLog.append(userBubble);
    const assistantBubble = el("div", { className: "chat-msg assistant streaming" });
    chatLog.append(assistantBubble);
    chatLog.scrollTop = chatLog.scrollHeight;
    setChatStatus(t("web_tools.sc_thinking"));

    try {
      const pageText = `Titel: ${scrapedPage.title}\nURL: ${scrapedPage.url}\n\n${scrapedPage.markdown}`;
      const res = await fetch(`${httpBase}/tools/chat/source/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          source_type: "page",
          source_ref: { content: pageText.slice(0, 80000), title: scrapedPage.title },
          message,
          history: chatHistory,
          strict_source: false,
          tool_level: "lite",
          vault_id: null,
        }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      let accumulated = "";
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\n\n/);
        buffer = events.pop();
        for (const block of events) {
          let eventName = "message";
          const dataLines = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          if (!dataLines.length) continue;
          let parsed = null;
          try { parsed = JSON.parse(dataLines.join("\n")); } catch { continue; }
          if (eventName === "text_delta") {
            accumulated += parsed.text;
            assistantBubble.innerHTML = renderMarkdown(accumulated);
            chatLog.scrollTop = chatLog.scrollHeight;
          } else if (eventName === "done") {
            assistantBubble.classList.remove("streaming");
            if (accumulated.trim()) addTtsButton(assistantBubble);
            else assistantBubble.textContent = t("web_tools.sc_no_answer");
            if (parsed.messages) chatHistory = parsed.messages;
            const u = parsed.usage || {};
            setChatStatus(t("web_tools.sc_tokens", { in: u.input_tokens || 0, out: u.output_tokens || 0 }));
          } else if (eventName === "error") {
            assistantBubble.classList.remove("streaming");
            assistantBubble.classList.add("error");
            assistantBubble.textContent = t("common.error_msg", { message: parsed.message || "?" });
            setChatStatus("");
          }
        }
      }
    } catch (err) {
      assistantBubble.classList.remove("streaming");
      assistantBubble.classList.add("error");
      assistantBubble.textContent = t("common.error_msg", { message: err.message || err });
      setChatStatus("");
    }
    busy = false;
    sendBtn.disabled = false;
    chatTextarea.disabled = false;
    micBtn.disabled = false;
    chatTextarea.focus();
  }

  // ── Spracheingabe via Content-Script-Injection (getUserMedia ist im Sidepanel
  // gesperrt, läuft daher im Tab-Kontext; Ergebnisse kommen per runtime-Message) ──
  let recording = false;
  let baseText = "";
  function onRuntimeMsg(msg) {
    if (msg?.type === "connection_status") {
      applyChatOnline(!!msg.connected && !msg.incompatible);
      return;
    }
    if (msg.type === "transcript_result") {
      chatTextarea.value = baseText + msg.text;
    } else if (msg.type === "transcript_end") {
      baseText = chatTextarea.value;
      recording = false;
      micBtn.classList.remove("recording");
      micBtn.title = t("web_tools.sc_voice_input");
    } else if (msg.type === "transcript_error") {
      recording = false;
      micBtn.classList.remove("recording");
      micBtn.title = t("web_tools.sc_voice_input");
      if (msg.error !== "aborted") setChatStatus(t("web_tools.sc_mic_error", { error: msg.error }), "error");
    }
  }
  chrome.runtime.onMessage.addListener(onRuntimeMsg);
  chrome.tabs.onActivated.addListener(onTabActivated);
  chrome.tabs.onUpdated.addListener(onTabUpdated);
  state.currentToolCleanup = () => {
    stopAllTts();
    try { chrome.runtime.onMessage.removeListener(onRuntimeMsg); } catch (_) {}
    try { chrome.tabs.onActivated.removeListener(onTabActivated); } catch (_) {}
    try { chrome.tabs.onUpdated.removeListener(onTabUpdated); } catch (_) {}
  };

  micBtn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (recording) {
      if (tab?.id) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => { if (window.__ewtosMic) { window.__ewtosMic.stop(); } },
        }).catch(() => {});
      }
      recording = false;
      micBtn.classList.remove("recording");
      micBtn.title = t("web_tools.sc_voice_input");
      return;
    }
    if (!tab?.id || !tab.url?.startsWith("http")) {
      setChatStatus(t("web_tools.sc_voice_http_only"), "error");
      return;
    }
    baseText = chatTextarea.value;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          if (window.__ewtosMic) { window.__ewtosMic.stop(); window.__ewtosMic = null; }
          const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
          if (!SR) return { error: "not_supported" };
          const r = new SR();
          r.lang = "de-DE";
          r.interimResults = true;
          r.continuous = false;
          window.__ewtosMic = r;
          r.onresult = (e) => {
            let text = "";
            for (const res of e.results) text += res[0].transcript;
            chrome.runtime.sendMessage({ type: "transcript_result", text });
          };
          r.onend = () => { window.__ewtosMic = null; chrome.runtime.sendMessage({ type: "transcript_end" }); };
          r.onerror = (ev) => { window.__ewtosMic = null; chrome.runtime.sendMessage({ type: "transcript_error", error: ev.error }); };
          r.start();
          return { ok: true };
        },
      });
      if (results?.[0]?.result?.error === "not_supported") {
        setChatStatus(t("web_tools.sc_voice_unavailable"), "error");
        return;
      }
      recording = true;
      micBtn.classList.add("recording");
      micBtn.title = t("web_tools.sc_stop_recording");
    } catch (err) {
      setChatStatus(t("web_tools.sc_mic_start_failed", { message: err.message || err }), "error");
    }
  });

  sendBtn.addEventListener("click", sendMsg);
  scrapeBtn.addEventListener("click", () => doScrape());
  chatTextarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(); }
  });

  state.panelBody.append(pageBar, scrapeModeRow, previewWrap, chatLog, chatStatus, chatOfflineHint, chatInputRow);
  applyChatOnline(state.serverConnected !== false);
  (async () => { currentTab = await getActiveTab(); refreshPageBar(); })();
  setTimeout(() => doScrape(), 0);
}

export function renderSeoCheck() {
  state.panelTitle.textContent = t("web_tools.seo_title");

  const refreshBtn = el("button", { type: "button", className: "secondary", textContent: "↻ " + t("web_tools.seo_reanalyze") });
  const status = el("div", { className: "tool-status" });
  const output = el("div");
  output.style.cssText = "margin-top:8px;font-size:13px;line-height:1.6;";

  let hMode = "level"; // "level" | "chrono"

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
    items.slice(0, 5).forEach((item) => ul.append(el("li", { textContent: item })));
    if (items.length > 5) ul.append(el("li", { textContent: t("web_tools.seo_more", { count: items.length - 5 }) }));
    wrap.append(lbl, ul);
    return wrap;
  };

  function renderHeadingBlock(data, container) {
    container.replaceChildren();
    const toggle = el("div", { className: "scrape-mode-row" });
    toggle.style.margin = "4px 0";
    const levelBtn = el("button", { type: "button", className: "scrape-mode-btn" + (hMode === "level" ? " active" : ""), textContent: t("web_tools.seo_by_level") });
    const chronoBtn = el("button", { type: "button", className: "scrape-mode-btn" + (hMode === "chrono" ? " active" : ""), textContent: t("web_tools.seo_chronological") });
    levelBtn.addEventListener("click", () => { if (hMode !== "level") { hMode = "level"; renderHeadingBlock(data, container); } });
    chronoBtn.addEventListener("click", () => { if (hMode !== "chrono") { hMode = "chrono"; renderHeadingBlock(data, container); } });
    toggle.append(levelBtn, chronoBtn);
    container.append(toggle);

    if (hMode === "level") {
      [headingRow(data.h1, "H1"), headingRow(data.h2, "H2"), headingRow(data.h3, "H3")]
        .forEach((node) => { if (node) container.append(node); });
    } else {
      const headings = data.headings || [];
      if (!headings.length) {
        container.append(el("div", { textContent: t("web_tools.seo_no_headings"), style: "color:var(--muted,#888);padding:3px 0;" }));
        return;
      }
      for (const h of headings) {
        const r = el("div");
        r.style.cssText = `padding:2px 0;padding-left:${(h.level - 1) * 14}px;border-bottom:1px solid var(--border,#eee);`;
        const lvl = el("span", { textContent: `H${h.level}` });
        lvl.style.cssText = "font-weight:600;color:var(--muted,#888);margin-right:6px;font-size:11px;";
        r.append(lvl, document.createTextNode(h.text));
        container.append(r);
      }
    }
  }

  async function runSeo() {
    refreshBtn.disabled = true;
    status.textContent = t("web_tools.seo_loading");
    status.className = "tool-status";
    output.replaceChildren();
    try {
      const httpBase = await getHttpBase();
      let res, data;
      try {
        res = await fetch(`${httpBase}/tools/seo_check`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
      } catch {
        const resp = await chrome.runtime.sendMessage({ type: "run_tool_direct", tool: "seo_check", params: {} });
        if (!resp?.ok) throw new Error(resp?.error || t("web_tools.server_unreachable"));
        data = resp.data;
      }
      if (res) {
        const text = await res.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        if (!res.ok) throw new Error(parsed?.detail || text || `HTTP ${res.status}`);
        data = parsed;
      }

      [row("URL", data.url), row("Title", data.title), row("Description", data.description), row("Canonical", data.canonical), row("Robots", data.robots)]
        .forEach((node) => { if (node) output.append(node); });

      const hBlock = el("div");
      output.append(hBlock);
      renderHeadingBlock(data, hBlock);

      [
        row("OG Title", data.og_title),
        row("OG Description", data.og_description),
        row("OG Image", data.og_image),
        row("Twitter Card", data.twitter_card),
        row("Viewport", data.viewport),
        row("Favicon", data.favicon),
      ].forEach((node) => { if (node) output.append(node); });

      status.textContent = t("web_tools.done");
      status.className = "tool-status success";
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
    } finally {
      refreshBtn.disabled = false;
    }
  }

  refreshBtn.addEventListener("click", runSeo);
  state.panelBody.append(refreshBtn, status, output);
  runSeo();
}

export function renderImageAnalyse() {
  state.panelTitle.textContent = t("web_tools.img_title");

  let currentImages = [];

  const downloadAll = () => {
    for (const img of currentImages) {
      const filename = (img.src || img.url || "").split("/").pop().split("?")[0] || "image.jpg";
      chrome.downloads.download({ url: img.src || img.url, filename });
    }
  };

  const refreshBtn = el("button", { type: "button", className: "secondary", textContent: "↻ " + t("web_tools.refresh") });
  const dlAllBtn = el("button", { type: "button", className: "secondary", textContent: t("web_tools.img_download_all"), style: "display:none" });
  dlAllBtn.addEventListener("click", downloadAll);
  const headerRow = el("div");
  headerRow.style.cssText = "display:flex;gap:8px;flex:0 0 auto;";
  headerRow.append(refreshBtn, dlAllBtn);

  const status = el("div", { className: "tool-status", style: "flex:0 0 auto;" });
  const summary = el("div", { className: "tool-status", style: "flex:0 0 auto;" });
  const list = el("div");
  list.style.cssText = "overflow-y:auto;flex:1;min-height:0;display:flex;flex-direction:column;gap:6px;margin-top:8px;";

  async function runImages() {
    refreshBtn.disabled = true;
    status.textContent = t("web_tools.img_loading");
    status.className = "tool-status";
    summary.textContent = "";
    dlAllBtn.style.display = "none";
    list.replaceChildren();
    try {
      const httpBase = await getHttpBase();
      let res, data;
      try {
        res = await fetch(`${httpBase}/tools/image_analyse`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
      } catch {
        const resp = await chrome.runtime.sendMessage({ type: "run_tool_direct", tool: "image_analyse", params: {} });
        if (!resp?.ok) throw new Error(resp?.error || t("web_tools.server_unreachable"));
        data = resp.data;
      }
      if (res) {
        const text = await res.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        if (!res.ok) throw new Error(parsed?.detail || text || `HTTP ${res.status}`);
        data = parsed;
      }

      const { images = [], total = 0, missing_alt = 0 } = data;
      currentImages = images;
      status.textContent = t("web_tools.done");
      status.className = "tool-status success";
      summary.textContent = missing_alt > 0
        ? t("web_tools.img_summary_missing", { total, missing: missing_alt })
        : t("web_tools.img_summary", { total });
      dlAllBtn.style.display = images.length > 1 ? "" : "none";

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
        const altWrap = el("div");
        const badge = el("div", { className: "img-alt-badge" });
        if (img.alt === null) {
          badge.classList.add("missing");
          badge.textContent = "✗ " + t("web_tools.img_no_alt");
          altWrap.append(badge);
        } else if (img.alt === "") {
          badge.classList.add("empty");
          badge.textContent = "⚠ " + t("web_tools.img_empty_alt");
          altWrap.append(badge);
        } else {
          badge.classList.add("present");
          badge.textContent = "✓ " + t("web_tools.img_has_alt");
          const altText = el("div", { className: "img-alt-text", textContent: img.alt });
          altWrap.append(badge, altText);
        }
        const dlBtn = el("button", { type: "button", className: "secondary", textContent: t("web_tools.img_gen_download") });
        dlBtn.style.cssText = "margin-top:4px;font-size:11px;padding:2px 8px;";
        dlBtn.addEventListener("click", () => {
          const filename = (img.src || img.url || "").split("/").pop().split("?")[0] || "image.jpg";
          chrome.downloads.download({ url: img.src || img.url, filename });
        });
        info.append(dims, altWrap, dlBtn);
        card.append(thumb, info);
        list.append(card);
      }
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = "tool-status error";
    } finally {
      refreshBtn.disabled = false;
    }
  }

  refreshBtn.addEventListener("click", runImages);
  state.panelBody.append(headerRow, status, summary, list);
  runImages();
}

const COLOR_STORE_KEY = "colorExtractions";
const COLOR_FORMAT_KEY = "colorCopyFormat";
const COLOR_MAX = 8;

// Beliebigen CSS-Farbstring zu {r,g,b} normalisieren (Canvas-basiert).
const _colorCanvas = document.createElement("canvas");
const _colorCtx = _colorCanvas.getContext("2d", { willReadFrequently: true });
function isValidColor(input) {
  if (!input || typeof input !== "string") return false;
  _colorCtx.fillStyle = "#000"; _colorCtx.fillStyle = input; const a = _colorCtx.fillStyle;
  _colorCtx.fillStyle = "#fff"; _colorCtx.fillStyle = input; const b = _colorCtx.fillStyle;
  return a === b;
}
function parseRgb(input) {
  _colorCtx.clearRect(0, 0, 1, 1);
  _colorCtx.fillStyle = input;
  _colorCtx.fillRect(0, 0, 1, 1);
  const d = _colorCtx.getImageData(0, 0, 1, 1).data;
  return { r: d[0], g: d[1], b: d[2] };
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const dd = max - min;
    s = l > 0.5 ? dd / (2 - max - min) : dd / (max + min);
    if (max === r) h = (g - b) / dd + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / dd + 2;
    else h = (r - g) / dd + 4;
    h /= 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}
function formatColor(input, fmt) {
  if (!isValidColor(input)) return input; // z.B. Nicht-Farb-CSS-Variable: roh kopieren
  const { r, g, b } = parseRgb(input);
  if (fmt === "rgb") return `rgb(${r}, ${g}, ${b})`;
  if (fmt === "hsl") { const { h, s, l } = rgbToHsl(r, g, b); return `hsl(${h}, ${s}%, ${l}%)`; }
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

const PICKED_STORE_KEY = "pickedColors";
const PICKED_MAX = 24;
// Pipette-Icon (inline SVG, CSP-konform — kein externes Asset).
const PIPETTE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></svg>';

export function renderColorPicker() {
  state.panelTitle.textContent = t("web_tools.color_title");

  let extractions = [];
  let pickedColors = [];
  let copyFormat = "hex";

  const runBtn = el("button", { textContent: t("web_tools.color_extract") });
  const eyeBtn = el("button", { type: "button", className: "secondary color-pick-btn" });
  eyeBtn.innerHTML = PIPETTE_SVG;
  eyeBtn.append(el("span", { textContent: t("web_tools.color_from_page") }));
  const status = el("div", { className: "tool-status" });

  // Format-Umschalter (HEX / RGB / HSL) — gilt für die Extraktions-Swatches
  const fmtRow = el("div", { className: "scrape-mode-row" });
  fmtRow.style.margin = "6px 0";
  const fmtBtns = {};
  ["hex", "rgb", "hsl"].forEach((fmt) => {
    const b = el("button", { type: "button", className: "scrape-mode-btn", textContent: fmt.toUpperCase() });
    b.addEventListener("click", () => {
      if (copyFormat === fmt) return;
      copyFormat = fmt;
      chrome.storage.local.set({ [COLOR_FORMAT_KEY]: fmt });
      Object.entries(fmtBtns).forEach(([k, btn]) => btn.classList.toggle("active", k === fmt));
    });
    fmtBtns[fmt] = b;
    fmtRow.append(b);
  });

  // Gepickte Farben — neueste oben, je Zeile HEX/RGB/HSL kopierbar.
  const pickedList = el("div", { className: "color-picked-list" });

  // Sammlung — horizontal, neueste Extraktion links
  const collection = el("div");
  collection.style.cssText = "display:flex;gap:10px;overflow-x:auto;margin-top:10px;padding-bottom:6px;align-items:flex-start;";

  function flashCopied(value) {
    status.textContent = t("web_tools.color_copied", { value });
    status.className = "tool-status success";
  }

  function savePicked() {
    chrome.storage.local.set({ [PICKED_STORE_KEY]: pickedColors });
  }

  function buildPickedRow(hex) {
    const row = el("div", { className: "color-row" });
    const sw = el("span", { className: "color-row-swatch" });
    sw.style.background = hex;
    const cells = el("div", { className: "color-row-cells" });
    for (const fmt of ["hex", "rgb", "hsl"]) {
      const val = formatColor(hex, fmt);
      const cell = el("button", { type: "button", className: "color-cell", textContent: val, title: t("web_tools.color_click_copy") });
      cell.addEventListener("click", () => { navigator.clipboard.writeText(val); flashCopied(val); });
      cells.append(cell);
    }
    const del = el("button", { type: "button", className: "color-row-del secondary", textContent: "×", title: t("web_tools.color_remove") });
    del.addEventListener("click", () => { pickedColors = pickedColors.filter((c) => c !== hex); savePicked(); renderPicked(); });
    row.append(sw, cells, del);
    return row;
  }

  function renderPicked() {
    pickedList.replaceChildren();
    for (const hex of pickedColors) pickedList.append(buildPickedRow(hex));
  }

  // Swatch, der bei Klick die Farbe im gewählten Format kopiert.
  function copySwatch(value) {
    const s = el("span");
    s.style.cssText = `display:inline-block;width:16px;height:16px;border:1px solid var(--border,#ccc);background:${value};vertical-align:middle;margin-right:6px;border-radius:2px;flex-shrink:0;cursor:pointer;`;
    s.title = t("web_tools.color_click_copy");
    s.addEventListener("click", () => {
      const out = formatColor(value, copyFormat);
      navigator.clipboard.writeText(out);
      flashCopied(out);
    });
    return s;
  }

  function saveExtractions() {
    chrome.storage.local.set({ [COLOR_STORE_KEY]: extractions });
  }

  function buildCard(ex) {
    const card = el("div");
    card.style.cssText = "flex:0 0 auto;min-width:200px;max-width:260px;border:1px solid var(--border,#ddd);border-radius:6px;padding:8px;background:var(--bg-card,transparent);";

    const head = el("div");
    head.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px;";
    const titleWrap = el("div");
    titleWrap.style.cssText = "min-width:0;overflow:hidden;";
    const host = el("div", { textContent: ex.hostname || t("web_tools.color_page") });
    host.style.cssText = "font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    const when = el("div", { textContent: new Date(ex.ts).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) });
    when.style.cssText = "font-size:10px;color:var(--muted,#888);";
    titleWrap.append(host, when);
    const delBtn = el("button", { type: "button", className: "secondary", textContent: "×", title: t("web_tools.color_remove") });
    delBtn.style.cssText = "font-size:12px;padding:0 8px;flex-shrink:0;align-self:flex-start;";
    delBtn.addEventListener("click", () => {
      extractions = extractions.filter((e) => e !== ex);
      saveExtractions();
      renderCollection();
    });
    head.append(titleWrap, delBtn);
    card.append(head);

    const cssVars = ex.css_vars || {};
    if (Object.keys(cssVars).length > 0) {
      const sec = el("div");
      sec.append(el("strong", { textContent: t("web_tools.color_css_vars"), style: "font-size:11px;" }));
      for (const [name, value] of Object.entries(cssVars)) {
        const row = el("div");
        row.style.cssText = "display:flex;align-items:center;margin:3px 0;font-size:11px;";
        const lbl = el("span", { textContent: `${name}: ${value}` });
        lbl.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
        row.append(copySwatch(value), lbl);
        sec.append(row);
      }
      card.append(sec);
    }

    if (ex.computed?.length > 0) {
      const sec = el("div");
      sec.style.marginTop = "8px";
      sec.append(el("strong", { textContent: t("web_tools.color_key_elements"), style: "font-size:11px;" }));
      for (const item of ex.computed) {
        const row = el("div");
        row.style.cssText = "display:flex;align-items:center;gap:4px;margin:3px 0;font-size:11px;";
        const lbl = el("span", { textContent: item.selector });
        lbl.style.cssText = "width:80px;color:var(--muted,#888);flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
        row.append(lbl);
        if (item.color) row.append(copySwatch(item.color));
        if (item.background) row.append(copySwatch(item.background));
        sec.append(row);
      }
      card.append(sec);
    }
    return card;
  }

  function renderCollection() {
    collection.replaceChildren();
    if (!extractions.length) {
      collection.append(el("div", { textContent: t("web_tools.color_empty"), style: "color:var(--muted,#888);font-size:12px;" }));
      return;
    }
    for (const ex of extractions) collection.append(buildCard(ex));
  }

  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    status.textContent = t("web_tools.color_loading");
    status.className = "tool-status";
    try {
      const httpBase = await getHttpBase();
      let res, data;
      try {
        res = await fetch(`${httpBase}/tools/color_picker`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
      } catch {
        const resp = await chrome.runtime.sendMessage({ type: "run_tool_direct", tool: "color_picker", params: {} });
        if (!resp?.ok) throw new Error(resp?.error || t("web_tools.server_unreachable"));
        data = resp.data;
      }
      if (res) {
        const text = await res.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        if (!res.ok) throw new Error(parsed?.detail || text || `HTTP ${res.status}`);
        data = parsed;
      }

      if (!data.has_design_system && !data.computed?.length) {
        status.textContent = t("web_tools.color_none");
        status.className = "tool-status";
        return;
      }

      const ex = {
        hostname: data.hostname || t("web_tools.color_page"),
        ts: Date.now(),
        css_vars: data.css_vars || {},
        computed: data.computed || [],
      };
      // Pro Domain nur eine Karte: bestehende ersetzen, neueste nach vorn.
      extractions = [ex, ...extractions.filter((e) => e.hostname !== ex.hostname)].slice(0, COLOR_MAX);
      saveExtractions();
      renderCollection();
      status.textContent = t("web_tools.color_done");
      status.className = "tool-status success";
    } catch (err) {
      status.textContent = t("web_tools.color_error", { error: err.message || err });
      status.className = "tool-status error";
    } finally {
      runBtn.disabled = false;
    }
  });

  eyeBtn.addEventListener("click", async () => {
    if (!window.EyeDropper) {
      eyeBtn.disabled = true;
      eyeBtn.replaceChildren(el("span", { textContent: t("web_tools.color_unavailable") }));
      return;
    }
    try {
      const dropper = new EyeDropper();
      const { sRGBHex } = await dropper.open();
      const hex = formatColor(sRGBHex, "hex");
      // Neueste oben, Duplikate nach vorn ziehen.
      pickedColors = [hex, ...pickedColors.filter((c) => c !== hex)].slice(0, PICKED_MAX);
      savePicked();
      renderPicked();
      flashCopied(formatColor(hex, copyFormat));
      navigator.clipboard.writeText(formatColor(hex, copyFormat));
    } catch {
      // ESC gedrückt — kein Fehler zeigen
    }
  });

  const btnRow = el("div");
  btnRow.style.cssText = "display:flex;gap:8px;";
  btnRow.append(runBtn, eyeBtn);
  state.panelBody.append(btnRow, fmtRow, pickedList, status, collection);

  // Gespeicherten Zustand laden und Sammlung aufbauen.
  chrome.storage.local.get([COLOR_STORE_KEY, COLOR_FORMAT_KEY, PICKED_STORE_KEY]).then((stored) => {
    extractions = Array.isArray(stored[COLOR_STORE_KEY]) ? stored[COLOR_STORE_KEY] : [];
    pickedColors = Array.isArray(stored[PICKED_STORE_KEY]) ? stored[PICKED_STORE_KEY] : [];
    copyFormat = ["hex", "rgb", "hsl"].includes(stored[COLOR_FORMAT_KEY]) ? stored[COLOR_FORMAT_KEY] : "hex";
    Object.entries(fmtBtns).forEach(([k, btn]) => btn.classList.toggle("active", k === copyFormat));
    renderPicked();
    renderCollection();
  });
}

export function renderScreenshot() {
  state.panelTitle.textContent = t("web_tools.screenshot_title_annot");
  const pendingAction = state.pendingToolOptions?.action;
  const initialShotMode = pendingAction === "shot_area" ? "area"
    : pendingAction === "shot_full" ? "full"
    : "visible";
  const autoRun = pendingAction && pendingAction.startsWith("shot_");

  // ── Mode row ──────────────────────────────────────────────────────────────
  let screenshotMode = initialShotMode;
  const modeRow = el("div", { className: "scrape-mode-row" });
  [["visible", t("nav.shot_visible")], ["area", t("nav.shot_area")], ["full", t("nav.shot_full")]].forEach(([value, label]) => {
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

  const runBtn = el("button", { textContent: t("web_tools.screenshot_create") });
  const status = el("div", { className: "tool-status" });

  // ── Annotation-Toolbar ────────────────────────────────────────────────────
  const toolbar = el("div", { className: "annot-toolbar" });
  toolbar.style.display = "none";

  const toolBtns = {};
  const annotToolDefs = [
    { id: "pen",  label: "✏ " + t("web_tools.annot_pen") },
    { id: "rect", label: "□ " + t("web_tools.annot_rect") },
    { id: "arrow", label: "→ " + t("web_tools.annot_arrow") },
    { id: "text", label: "T " + t("web_tools.annot_text") },
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
  colorPicker.title = t("web_tools.annot_color");

  const sizeSelect = document.createElement("select");
  sizeSelect.className = "annot-size-select";
  [["2px", "2"], ["4px", "4"], ["6px", "6"]].forEach(([label, val]) => {
    const opt = document.createElement("option");
    opt.textContent = label;
    opt.value = val;
    sizeSelect.append(opt);
  });
  sizeSelect.value = "2";

  const undoBtn = el("button", { textContent: "↩ " + t("web_tools.annot_undo") });
  undoBtn.classList.add("secondary", "annot-tool-btn");
  toolbar.append(colorPicker, sizeSelect, undoBtn);

  // ── Canvas ────────────────────────────────────────────────────────────────
  const canvas = document.createElement("canvas");
  canvas.className = "annot-canvas";
  canvas.style.display = "none";
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  // ── Crop-Mode actions ─────────────────────────────────────────────────────
  const cropActions = el("div");
  cropActions.style.cssText = "display:none;gap:8px;margin-top:6px;flex-wrap:wrap;";
  const confirmCropBtn = el("button", { textContent: t("web_tools.crop_confirm") });
  const cancelCropBtn = el("button", { textContent: t("common.cancel"), className: "secondary" });
  cropActions.append(confirmCropBtn, cancelCropBtn);

  // ── Download/Copy actions ─────────────────────────────────────────────────
  const actions = el("div");
  actions.style.cssText = "display:none;gap:8px;margin-top:6px;";
  const copyBtn = el("button", { textContent: t("web_tools.copy") });
  const dlBtn = el("button", { textContent: t("web_tools.img_gen_download") });
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
    status.textContent = t("web_tools.crop_hint");
    status.className = "tool-status";
  }

  confirmCropBtn.addEventListener("click", () => {
    if (!cropRect || cropRect.w < 4 || cropRect.h < 4) {
      status.textContent = t("web_tools.crop_select_first");
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
    status.textContent = t("web_tools.crop_set");
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
    status.textContent = t("web_tools.shot_done_annot");
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
      const text = prompt(t("web_tools.annot_text_prompt"));
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
    let res, data;
    try {
      res = await fetch(`${httpBase}/tools/screenshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    } catch {
      const resp = await chrome.runtime.sendMessage({ type: "run_tool_direct", tool: "screenshot", params: {} });
      if (!resp?.ok) throw new Error(resp?.error || t("web_tools.server_unreachable"));
      return resp.data.dataUrl;
    }
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error(parsed?.detail || text || `HTTP ${res.status}`);
    data = parsed;
    return data.dataUrl;
  }

  function captureFullPage() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "full_page_screenshot" }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp?.ok) return reject(new Error(resp?.error || t("web_tools.shot_fullpage_failed")));
        resolve(resp);
      });
    });
  }

  function captureRegion() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "capture_region" }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp?.ok) return reject(new Error(resp?.error || t("web_tools.shot_region_failed")));
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
    status.textContent = t("web_tools.screenshot_loading");
    status.className = "tool-status";
    canvas.style.display = "none";
    toolbar.style.display = "none";
    cropActions.style.display = "none";
    actions.style.display = "none";
    undoStack.length = 0;

    try {
      if (screenshotMode === "full") {
        status.textContent = t("web_tools.shot_scrolling");
        const resp = await captureFullPage();
        const dpr = resp.dpr || 1;
        const totalH = Math.round(resp.totalHeight * dpr);
        const frameW = Math.round(resp.clientWidth * dpr);

        const offscreen = document.createElement("canvas");
        offscreen.width = frameW;
        offscreen.height = totalH;
        const octx = offscreen.getContext("2d", { willReadFrequently: true });

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
        status.textContent = t("web_tools.shot_done_full", { frames: resp.frames.length, height: resp.totalHeight });
        status.className = "tool-status success";
      } else if (screenshotMode === "area") {
        status.textContent = t("web_tools.shot_area_hint");
        const dataUrl = await captureRegion();
        await loadImageToCanvas(dataUrl);
        toolbar.style.display = "flex";
        actions.style.display = "flex";
        status.textContent = t("web_tools.shot_done_annot");
        status.className = "tool-status success";
      } else {
        const dataUrl = await captureVisible();
        await loadImageToCanvas(dataUrl);
        toolbar.style.display = "flex";
        actions.style.display = "flex";
        status.textContent = t("web_tools.shot_done_annot");
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
        copyBtn.textContent = t("web_tools.copied_short");
        setTimeout(() => { copyBtn.textContent = t("web_tools.copy"); }, 1500);
      } catch {
        copyBtn.textContent = t("common.error");
        setTimeout(() => { copyBtn.textContent = t("web_tools.copy"); }, 1500);
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
  state.panelTitle.textContent = t("web_tools.url_title");

  const filterRow = el("label", { className: "checkbox-row" });
  const filterCb = el("input", { type: "checkbox" });
  filterCb.checked = true;
  filterRow.append(filterCb, el("span", { textContent: t("web_tools.url_same_domain") }));

  const runBtn = el("button", { textContent: t("web_tools.url_extract") });
  const status = el("div", { className: "tool-status" });

  const formatTabs = el("div", { className: "format-tabs" });
  const formats = [["list", t("web_tools.url_format_list")], ["comma", t("web_tools.url_format_comma")], ["json", "JSON"]];
  let activeFormat = "list";
  let lastUrls = [];

  const output = el("textarea", { readOnly: true, className: "url-extractor-output", placeholder: t("web_tools.url_placeholder") });

  function renderOutput() {
    if (!lastUrls.length) return;
    if (activeFormat === "list") output.value = lastUrls.join("\n");
    else if (activeFormat === "comma") output.value = lastUrls.join(", ");
    else output.value = JSON.stringify(lastUrls, null, 2);
  }

  for (const [fmt, fmtLabel] of formats) {
    const btn = el("button", { type: "button", textContent: fmtLabel, className: "format-tab-btn" + (fmt === activeFormat ? " active" : "") });
    btn.addEventListener("click", () => {
      activeFormat = fmt;
      for (const b of formatTabs.querySelectorAll(".format-tab-btn")) b.classList.remove("active");
      btn.classList.add("active");
      renderOutput();
    });
    formatTabs.append(btn);
  }

  const copyBtn = el("button", { textContent: t("web_tools.copy") });
  copyBtn.classList.add("secondary");

  let lastBaseUrl = "";

  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    status.textContent = t("web_tools.url_loading");
    status.className = "tool-status";
    output.value = "";
    lastUrls = [];
    try {
      const httpBase = await getHttpBase();
      let res, data;
      try {
        res = await fetch(`${httpBase}/tools/url_extractor`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filter_domain: filterCb.checked }),
        });
      } catch {
        const resp = await chrome.runtime.sendMessage({ type: "run_tool_direct", tool: "url_extractor", params: { filter_domain: filterCb.checked } });
        if (!resp?.ok) throw new Error(resp?.error || t("web_tools.server_unreachable"));
        data = resp.data;
      }
      if (res) {
        const text = await res.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        if (!res.ok) throw new Error(parsed?.detail || text || `HTTP ${res.status}`);
        data = parsed;
      }
      lastUrls = data.urls || [];
      lastBaseUrl = data.base_url || "";
      renderOutput();
      status.textContent = t("web_tools.url_count", { count: data.count || 0 });
      status.className = "tool-status success";
      state.panelBody.querySelector(".url-source-row")?.remove();
      const sourceRow = el("div", { className: "url-source-row" });
      sourceRow.append(el("span", { className: "url-source-label", textContent: t("web_tools.url_source") }));
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
  const promoteBtn = el("button", { textContent: t("web_tools.promote_to_brain"), className: "secondary" });
  promoteBtn.style.marginTop = "6px";

  const promoteForm = el("div");
  promoteForm.style.cssText = "display:none;margin-top:8px;padding:10px;border:1px solid var(--border,#ddd);border-radius:6px;background:var(--bg-subtle);";

  const promoteTitle = el("input", { type: "text", placeholder: t("web_tools.promote_title_placeholder") });
  const promoteSub = el("select");
  ["eigene-notizen", "artikel", "chat-archive"].forEach(s => promoteSub.append(new Option(s, s)));
  const promoteDesc = el("textarea", { placeholder: t("web_tools.promote_desc_placeholder") });
  promoteDesc.style.cssText = "min-height:52px;resize:vertical;margin-top:6px;font-size:12px;";
  const promoteHint = el("div", { className: "tool-status" });
  const promoteSubBtn = el("button", { textContent: t("common.save") });
  const promoteCancelBtn = el("button", { textContent: t("common.cancel"), className: "secondary" });
  promoteCancelBtn.style.marginLeft = "6px";

  const promoteSubLabel = el("label", { textContent: t("web_tools.promote_target_folder") });
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
    if (!title) { promoteHint.textContent = t("web_tools.promote_title_required"); promoteHint.className = "tool-status error"; return; }
    if (!lastUrls.length) { promoteHint.textContent = t("web_tools.promote_extract_first"); promoteHint.className = "tool-status error"; return; }
    promoteSubBtn.disabled = true;
    promoteHint.textContent = t("web_tools.promote_saving");
    promoteHint.className = "tool-status";
    try {
      const httpBase = await getHttpBase();
      const vaultId = await getActiveVaultId(httpBase);
      if (!vaultId) throw new Error(t("web_tools.promote_no_vault"));
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
        if (res.status === 403) throw new Error(t("web_tools.promote_no_permission"));
        throw new Error(data?.detail || text || `HTTP ${res.status}`);
      }
      promoteHint.textContent = t("web_tools.promote_saved", { path: data.data?.raw_path || "OK" });
      promoteHint.className = "tool-status success";
      promoteTitle.value = "";
      promoteDesc.value = "";
      promoteForm.style.display = "none";
    } catch (err) {
      if (err instanceof TypeError || /Failed to fetch/i.test(err.message || "")) {
        promoteHint.textContent = t("web_tools.promote_offline");
        promoteHint.className = "tool-status error";
      } else {
        promoteHint.innerHTML = err.message || String(err);
        promoteHint.className = "tool-status error";
        promoteHint.querySelector(".open-options-link")?.addEventListener("click", e => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
      }
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
  return slug || t("web_tools.img_gen_no_prompt");
}

function fileToInput(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t("web_tools.img_gen_read_failed")));
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
  state.panelTitle.textContent = t("web_tools.img_gen_title");

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
  modelRow.append(el("label", { className: "imggen-label", textContent: t("web_tools.img_gen_model_label") }));
  const modelSelect = el("select", { className: "imggen-model" });
  for (const [value, labelKey] of IMAGE_GEN_MODELS) {
    const opt = new Option(t("web_tools." + labelKey), value);
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
    placeholder: t("web_tools.img_gen_prompt_placeholder"),
    rows: 3,
  });

  // Input-Thumbnails
  const inputsStrip = el("div", { className: "imggen-inputs" });
  function renderInputs() {
    inputsStrip.replaceChildren();
    if (!imageGenState.inputs.length) {
      inputsStrip.append(el("span", { className: "imggen-inputs-empty", textContent: t("web_tools.img_gen_no_inputs", { max: MAX_INPUT_IMAGES }) }));
    }
    imageGenState.inputs.forEach((img, idx) => {
      const card = el("div", { className: "imggen-thumb" });
      const i = el("img");
      i.src = img.file ? imgUrl(img.file) : `data:${img.mime};base64,${img.base64}`;
      i.title = img.name || "";
      const x = el("button", { type: "button", className: "imggen-thumb-x", textContent: "×", title: t("web_tools.img_gen_remove") });
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
  const addBtn = el("button", { type: "button", className: "secondary", textContent: t("web_tools.img_gen_add_image") });
  addBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const files = Array.from(fileInput.files || []);
    for (const f of files) {
      if (imageGenState.inputs.length >= MAX_INPUT_IMAGES) break;
      try {
        imageGenState.inputs.push(await fileToInput(f));
      } catch (err) {
        status.textContent = t("web_tools.img_gen_load_failed", { error: err.message || err });
        status.className = "tool-status error";
      }
    }
    fileInput.value = "";
    renderInputs();
  });

  function pushInputFromGallery(entry, idx) {
    if (imageGenState.inputs.length >= MAX_INPUT_IMAGES) {
      status.textContent = t("web_tools.img_gen_max_inputs", { max: MAX_INPUT_IMAGES });
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

  const continueBtn = el("button", { type: "button", className: "secondary", textContent: "↻ " + t("web_tools.img_gen_last_as_input") });
  continueBtn.title = t("web_tools.img_gen_last_as_input_title");
  continueBtn.addEventListener("click", () => {
    if (!imageGenState.lastOutputFile) {
      status.textContent = t("web_tools.img_gen_no_result_yet");
      status.className = "tool-status error";
      return;
    }
    if (pushInputFromGallery({ file: imageGenState.lastOutputFile, prompt: t("web_tools.img_gen_last_result") })) {
      status.textContent = t("web_tools.img_gen_taken_as_input");
      status.className = "tool-status success";
    }
  });
  inputControls.append(addBtn, continueBtn, fileInput);

  const genBtn = el("button", { textContent: t("web_tools.img_gen_generate") });
  const status = el("div", { className: "tool-status" });

  // Output
  const outputWrap = el("div", { className: "imggen-output hidden" });
  const outputImg = el("img", { className: "imggen-output-img" });
  const outputActions = el("div", { className: "imggen-output-actions" });
  const dlBtn = el("button", { type: "button", className: "secondary", textContent: t("web_tools.img_gen_download") });
  const editBtn = el("button", { type: "button", className: "secondary", textContent: t("web_tools.img_gen_edit") });
  editBtn.title = t("web_tools.img_gen_edit_title");
  const resetBtn = el("button", { type: "button", className: "secondary", textContent: t("web_tools.img_gen_restart") });
  outputActions.append(dlBtn, editBtn, resetBtn);
  outputWrap.append(outputImg, outputActions);

  // Galerie-Toolbar (Header + Ordner-öffnen + Reload)
  const galleryHeader = el("div", { className: "imggen-history-title" });
  const galleryLabel = el("span", { textContent: t("web_tools.img_gen_gallery") });
  const openFolderBtn = el("button", { type: "button", className: "imggen-toolbar-btn", title: t("web_tools.img_gen_open_folder_title"), textContent: "📂 " + t("web_tools.img_gen_folder") });
  const reloadBtn = el("button", { type: "button", className: "imggen-toolbar-btn", title: t("web_tools.img_gen_reload_gallery"), textContent: "↺" });
  galleryHeader.append(galleryLabel, reloadBtn, openFolderBtn);

  openFolderBtn.addEventListener("click", async () => {
    try {
      const res = await fetch(`${httpBase}/tools/image_gallery/open`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`);
      status.textContent = t("web_tools.img_gen_folder_opened", { path: data.path });
      status.className = "tool-status success";
    } catch (err) {
      status.textContent = t("web_tools.img_gen_folder_failed", { error: err.message || err });
      status.className = "tool-status error";
    }
  });

  // Galerie aus Server-Index
  const historyWrap = el("div", { className: "imggen-history" });
  function renderHistory() {
    historyWrap.replaceChildren();
    historyWrap.append(galleryHeader);
    if (!imageGenState.gallery.length) {
      historyWrap.append(el("div", { className: "imggen-inputs-empty", textContent: t("web_tools.img_gen_no_images") }));
      return;
    }
    const grid = el("div", { className: "imggen-history-grid" });
    imageGenState.gallery.forEach((entry, idx) => {
      const card = el("div", { className: "imggen-history-card" });
      const url = imgUrl(entry.file);
      const label = imggenLabelForEntry(entry);

      const img = el("img");
      img.src = url;
      img.title = label + "\n" + t("web_tools.img_gen_click_lightbox");
      img.addEventListener("click", () => {
        const qs = new URLSearchParams({ file: entry.file, server: httpBase });
        chrome.tabs.create({
          url: chrome.runtime.getURL("lightbox/lightbox.html") + "?" + qs.toString(),
        });
      });

      const p = el("div", { className: "imggen-history-prompt", textContent: label });
      p.title = label;

      const actions = el("div", { className: "imggen-history-actions" });
      const dl = el("button", { type: "button", title: t("web_tools.img_gen_download"), textContent: "⬇" });
      dl.addEventListener("click", (e) => {
        e.stopPropagation();
        const a = document.createElement("a");
        a.href = url;
        a.download = entry.file.split("/").pop();
        a.click();
      });
      const reuse = el("button", { type: "button", title: t("web_tools.img_gen_reuse_input"), textContent: "↻" });
      reuse.addEventListener("click", (e) => {
        e.stopPropagation();
        if (pushInputFromGallery(entry, idx)) {
          status.textContent = t("web_tools.img_gen_taken_as_input");
          status.className = "tool-status success";
        }
      });
      const del = el("button", { type: "button", title: t("web_tools.img_gen_move_trash"), textContent: "×", className: "imggen-del" });
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(t("web_tools.img_gen_trash_confirm", { file: entry.file }))) return;
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
          status.textContent = t("web_tools.img_gen_delete_failed", { error: err.message || err });
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
      status.textContent = t("web_tools.img_gen_gallery_failed", { error: err.message || err });
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
      status.textContent = t("web_tools.img_gen_prompt_missing");
      status.className = "tool-status error";
      return;
    }
    genBtn.disabled = true;
    status.textContent = imageGenState.inputs.length
      ? t("web_tools.img_gen_generating_inputs", { count: imageGenState.inputs.length })
      : t("web_tools.img_gen_generating");
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
      if (!data?.ok) throw new Error(data?.error || t("web_tools.img_gen_failed_generic"));

      imageGenState.lastOutputFile = data.image_path;
      outputImg.src = imgUrl(data.image_path) + "?t=" + Date.now();
      outputWrap.classList.remove("hidden");
      await loadGallery();
      status.textContent = t("web_tools.img_gen_done", { model: data.model });
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
    if (pushInputFromGallery({ file: imgGenPick.file, prompt: t("web_tools.img_gen_from_lightbox") })) {
      status.textContent = t("web_tools.img_gen_lightbox_taken");
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
