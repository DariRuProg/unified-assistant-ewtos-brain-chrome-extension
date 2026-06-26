// Chat Renderer (Vault- + Seiten-Chat). ewtos.com
import { el } from '../dom.js';
import { state } from '../state.js';
import { getHttpBase } from '../modules/api.js';
import { renderMarkdown } from '../markdown.js';
import { openTool } from '../modules/tool-runner.js';
import { t } from '../../i18n/i18n.js';

// Vault-relativer Pfad der Chat-Quelle (für "im Vault-Explorer öffnen"). null = kein File-Backing (z.B. Seite).
function sourceFilePath(src) {
  if (!src || !src.ref) return null;
  if (src.type === "video" && src.ref.slug) return `wiki/resources/videos/${src.ref.slug}.md`;
  if ((src.type === "vault_file" || src.type === "transcript") && src.ref.rel_path) {
    const rp = src.ref.rel_path;
    return rp.endsWith(".md") ? rp : rp + ".md";
  }
  return null;
}

export async function renderChat() {
  state.panelTitle.textContent = t("chat.title_vault");

  const initialSource = state.pendingToolOptions?.sourceType && state.pendingToolOptions?.sourceRef
    ? { type: state.pendingToolOptions.sourceType, ref: state.pendingToolOptions.sourceRef, title: state.pendingToolOptions.sourceTitle || "" }
    : null;
  // pendingToolOptions VOR dem ersten await lesen — openTool() nullt es, sobald renderChat pausiert.
  const startMode = state.pendingToolOptions?.startMode || null;

  function updateChatTitle(mode, sourceTitle) {
    if (mode === "transcript") state.panelTitle.textContent = sourceTitle ? `Chat: ${sourceTitle}` : t("chat.title_transcript");
    else if (mode === "video") state.panelTitle.textContent = sourceTitle ? `Chat: ${sourceTitle}` : t("chat.title_video");
    else if (mode === "page") state.panelTitle.textContent = sourceTitle ? `Chat: ${sourceTitle}` : t("chat.title_page");
    else if (mode === "vault_file") state.panelTitle.textContent = sourceTitle ? `Chat: ${sourceTitle}` : t("chat.title_file");
    else state.panelTitle.textContent = t("chat.title_vault");
  }

  const httpBase = await getHttpBase();

  // Header: vault picker + meta line
  const header = el("div", { className: "chat-header" });
  const vaultSelect = el("select", { className: "vault-picker" });
  header.append(vaultSelect);
  const meta = el("div", { className: "tool-status", textContent: t("chat.loading_vaults") });

  const log = el("div", { className: "chat-log" });
  const inputWrap = el("form", { className: "chat-input" });
  const inputArea = el("textarea", { placeholder: t("chat.placeholder"), rows: 2 });
  const sendBtn = el("button", { type: "submit", textContent: "→" });
  const micBtn = el("button", { type: "button", textContent: "🎙", title: t("chat.mic_title") });
  micBtn.classList.add("mic-btn");
  inputWrap.append(inputArea, micBtn, sendBtn);

  const toolbar = el("div", { className: "chat-toolbar" });
  const clearBtn = el("button", { type: "button", textContent: t("chat.clear") });
  clearBtn.classList.add("secondary");

  // Search toggle
  const searchToggleRow = el("div", { className: "checkbox-row", title: t("chat.search_toggle_title") });
  const searchToggle = el("input", { type: "checkbox", id: "vaultSearchToggle" });
  searchToggle.checked = true; // default until loaded from server
  const searchToggleLabel = el("label", { htmlFor: "vaultSearchToggle", textContent: t("chat.search_toggle") });
  searchToggleRow.append(searchToggle, searchToggleLabel);

  // Activity toggle — zeigt Tool-Aufrufe sichtbar im Verlauf
  let showActivity = true;
  const activityToggleRow = el("div", { className: "checkbox-row", title: t("chat.activity_toggle_title") });
  const activityToggle = el("input", { type: "checkbox", id: "chatActivityToggle" });
  activityToggle.checked = true;
  const activityToggleLabel = el("label", { htmlFor: "chatActivityToggle", textContent: t("chat.activity_toggle") });
  activityToggleRow.append(activityToggle, activityToggleLabel);

  // Load initial state from server
  let ttsEnabled = false;
  try {
    const settingsRes = await fetch(`${httpBase}/settings`);
    if (settingsRes.ok) {
      const settingsData = await settingsRes.json();
      if (typeof settingsData.vault_search_enabled === "boolean") {
        searchToggle.checked = settingsData.vault_search_enabled;
      }
      if (typeof settingsData.chat_show_activity === "boolean") {
        showActivity = settingsData.chat_show_activity;
        activityToggle.checked = showActivity;
      }
      ttsEnabled = settingsData.chat_tts_enabled === true;
    }
  } catch (_) {}

  searchToggle.addEventListener("change", async () => {
    try {
      await fetch(`${httpBase}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vault_search_enabled: searchToggle.checked }),
      });
    } catch (_) {}
  });

  activityToggle.addEventListener("change", async () => {
    showActivity = activityToggle.checked;
    log.classList.toggle("hide-activity", !showActivity);
    try {
      await fetch(`${httpBase}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_show_activity: showActivity }),
      });
    } catch (_) {}
  });

  toolbar.append(clearBtn, searchToggleRow, activityToggleRow);
  log.classList.toggle("hide-activity", !showActivity);

  const status = el("div", { className: "tool-status" });
  const pageUrlRow = el("div", { className: "page-url-row", style: "display:none" });

  let chatMode = "vault";
  let scrapedPage = null;
  let pageChatHistory = [];
  let sourceChatHistory = [];
  let activeSource = null; // {type: "transcript"|"video", ref: {...}, title: string}

  // Scrape-Umfang (nur Seiten-Chat): Hauptinhalt (sauber) vs. ganze Seite (tief, inkl. Nav/Links).
  let scrapeMode = "content"; // "content" | "full"
  const scrapeModeRow = el("div", { className: "scrape-mode-row", style: "display:none" });
  function makeScrapeBtn(value, label, title) {
    const btn = el("button", { type: "button", className: "scrape-mode-btn" + (value === scrapeMode ? " active" : ""), textContent: label, title });
    btn.dataset.value = value;
    btn.addEventListener("click", async () => {
      if (scrapeMode === value) return;
      scrapeMode = value;
      scrapeModeRow.querySelectorAll(".scrape-mode-btn").forEach(b => b.classList.toggle("active", b.dataset.value === value));
      if (chatMode === "page") await scrapeCurrentPage();
    });
    return btn;
  }
  scrapeModeRow.append(
    makeScrapeBtn("content", t("chat.scrape_content"), t("chat.scrape_content_title")),
    makeScrapeBtn("full", t("chat.scrape_full"), t("chat.scrape_full_title")),
  );

  function setPageUrlRow(state, text) {
    if (state === "hide") { pageUrlRow.style.display = "none"; return; }
    pageUrlRow.style.display = "";
    pageUrlRow.className = "page-url-row" + (state === "error" ? " error" : state === "loading" ? " loading" : "");
    pageUrlRow.textContent = text;
  }

  async function scrapeCurrentPage() {
    setPageUrlRow("loading", t("chat.loading_page"));
    setStatus(t("chat.scrape_starting"));
    try {
      const hb = await getHttpBase();
      const scrape = async (mode) => {
        const r = await fetch(`${hb}/tools/page_scrape`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      };
      // "Ganze Seite" → direkt tief scrapen. "Hauptinhalt" → sauber, aber bei zu wenig
      // Ergebnis (Heuristik verfehlt den Content-Root / JS-lastige Seite) automatisch auf
      // "alles" hochstufen und das umfangreichere Ergebnis nehmen.
      const MIN_CONTENT = 600; // Zeichen — darunter gilt der Inhalt-Scrape als zu mager
      let data;
      if (scrapeMode === "full") {
        data = await scrape("full");
      } else {
        data = await scrape("content");
        const contentLen = (data.markdown || "").trim().length;
        if (contentLen < MIN_CONTENT) {
          try {
            const full = await scrape("full");
            if ((full.markdown || "").trim().length > contentLen) data = full;
          } catch (_) {}
        }
      }
      if (!data.markdown) throw new Error(t("chat.no_page_content"));
      scrapedPage = { title: data.title || "", url: data.url || "", markdown: data.markdown };
      // Dedizierter Seiten-Chat: Titel im Header, URL im Kontext-Banner (auch nach Tab-Wechsel aktuell halten).
      if (chatMode === "page" && !activeSource) {
        state.panelTitle.textContent = scrapedPage.title || t("chat.title_page");
        sourceBanner.textContent = `🌐 ${scrapedPage.url || scrapedPage.title || ""}`;
        setPageUrlRow("hide");
      } else {
        setPageUrlRow("ok", scrapedPage.title || scrapedPage.url);
      }
      setStatus("");
    } catch (err) {
      scrapedPage = null;
      setPageUrlRow("error", t("chat.error_prefix", { error: err.message || err }));
      setStatus(t("chat.page_failed", { error: err.message || err }), "error");
    }
  }

  const webHint = el("div", { className: "chat-web-hint", textContent: t("chat.web_hint") });

  // Dezenter Datei-Chat-Hinweis (nur Vault-Modus) — der eigentliche Datei-Chat lebt im Explorer.
  const fileHint = el("div", { className: "chat-file-hint" });
  const fileHintLink = el(“a”, { href: “#”, textContent: t(“chat.file_hint”) });
  fileHintLink.addEventListener("click", (e) => {
    e.preventDefault();
    openTool("vault_explorer", { vaultId: currentVaultId });
  });
  fileHint.append(fileHintLink);

  // Kontext-Banner (Text) — zeigt immer klar, womit gechattet wird (Seite / Datei / Transcript).
  const sourceBanner = el("div", { className: "chat-source-banner-text" });
  const bannerRow = el("div", { className: "chat-source-banner", style: "display:none" });
  bannerRow.append(sourceBanner);

  // Modus-Tabs (Vault / Seite / Datei) — sichtbarer Umschalter im offenen Chat.
  const modeTabsRow = el("div", { className: "chat-mode-row" });
  const modeBtns = {};
  function makeModeTab(label, mode) {
    const btn = el("button", { type: "button", className: "chat-mode-btn", textContent: label });
    btn.addEventListener("click", () => switchMode(mode));
    modeBtns[mode] = btn;
    return btn;
  }
  modeTabsRow.append(makeModeTab(t("chat.mode_vault"), "vault"), makeModeTab(t("chat.mode_page"), "page"), makeModeTab(t("chat.mode_file"), "datei"));
  function updateModeTabs() {
    const active = chatMode === "vault" ? "vault"
      : chatMode === "page" ? "page"
      : chatMode === "vault_file" ? "datei" : null;
    for (const [m, b] of Object.entries(modeBtns)) b.classList.toggle("active", m === active);
  }
  function switchMode(mode) {
    if (mode === "vault") { if (chatMode === "vault") return; openTool("chat", {}); }
    else if (mode === "page") { if (chatMode === "page") return; openTool("chat", { startMode: "page" }); }
    else if (mode === "datei") {
      if (chatMode === "vault_file" && activeSource) return;
      openTool("vault_explorer", { vaultId: effectiveVaultId() });
    }
  }

  state.panelBody.append(modeTabsRow, header, bannerRow, scrapeModeRow, pageUrlRow, meta, log, status, inputWrap, webHint, fileHint, toolbar);
  updateModeTabs();

  function updateWebHintVisibility() {
    const vault = chatMode === "vault";
    webHint.style.display = vault ? "" : "none";
    fileHint.style.display = vault ? "" : "none";
  }
  updateWebHintVisibility();

  function applySourceMode(src) {
    chatMode = src.type;
    activeSource = src;
    sourceChatHistory = [];
    state._chatPageModeScrape = null;
    header.style.display = "none";
    meta.style.display = "none";
    scrapeModeRow.style.display = "none";
    setPageUrlRow("hide");
    bannerRow.style.display = "";
    inputArea.placeholder = t("chat.placeholder_source");
    if (src.type === "transcript") {
      sourceBanner.textContent = t("chat.source_transcript", { title: src.title || src.ref?.rel_path || "" });
    } else if (src.type === "video") {
      sourceBanner.textContent = t("chat.source_video", { title: src.title || src.ref?.slug || "" });
    } else if (src.type === "vault_file") {
      sourceBanner.textContent = t("chat.source_file", { title: src.title || src.ref?.rel_path || "" });
    } else {
      sourceBanner.textContent = `🌐 ${src.title || ""}`;
    }
    // Quelle anklickbar machen, wenn sie eine echte Vault-Datei ist → im Vault-Explorer öffnen.
    const relPath = sourceFilePath(src);
    sourceBanner.classList.toggle("clickable", !!relPath);
    sourceBanner.title = relPath ? t("chat.open_in_explorer") : "";
    sourceBanner.onclick = relPath
      ? () => openTool("vault_explorer", { initialFile: relPath, vaultId: src.ref?.vault_id })
      : null;
    if (src.type === "vault_file") {
      inputArea.placeholder = t("chat.placeholder_file");
    }
    updateChatTitle(src.type, src.title);
    updateWebHintVisibility();
    meta.textContent = "";
    log.replaceChildren();
    const emptyHint = src.type === "vault_file"
      ? t("chat.empty_file")
      : t("chat.empty_source");
    log.append(el("div", { className: "chat-empty", textContent: emptyHint }));
    updateModeTabs();
  }

  // Dedizierter Seiten-Chat (über die "Chat mit Seite"-Kachel) — kein Vault sichtbar.
  async function applyPageMode() {
    chatMode = "page";
    state._chatPageModeScrape = scrapeCurrentPage;
    header.style.display = "none";   // Vault-Picker weg
    meta.style.display = "none";     // Vault-Meta weg
    webHint.style.display = "none";
    fileHint.style.display = "none";
    bannerRow.style.display = "";
    scrapeModeRow.style.display = "";
    sourceBanner.textContent = t("chat.page_scraping");
    inputArea.placeholder = t("chat.placeholder_page");
    updateModeTabs();
    renderActiveLog();
    await scrapeCurrentPage(); // setzt bei Erfolg Titel + URL-Banner
    if (!scrapedPage) sourceBanner.textContent = t("chat.page_load_failed_banner");
  }

  // Wenn über "💬 Chat" auf Datei/Video/Transcript geöffnet
  if (initialSource) {
    applySourceMode(initialSource);
  } else if (startMode === "page") {
    await applyPageMode();
  }


  let busy = false;
  let currentVaultId = null;
  let pageToolVaultId = null; // im Seiten-Chat lazy ermittelter Vault (für Tools + Bild-Assets)

  // Vault-ID des aktiven Chats (für lokale Bild-Assets). Source-Chat (Datei/Video) bringt
  // die Vault-ID in der ref mit, sonst der gewählte bzw. im Seiten-Chat genutzte Vault.
  function effectiveVaultId() {
    return activeSource?.ref?.vault_id || currentVaultId || pageToolVaultId;
  }

  // Lokale Vault-Bilder (![alt](assets/..)) im gerenderten Markdown über den Asset-Endpoint
  // laden — analog zum Vault-Explorer, damit generierte Bilder direkt im Chat erscheinen.
  function wireVaultImages(container) {
    const vid = effectiveVaultId();
    if (!vid) return;
    container.querySelectorAll("img.md-image[data-vault-src]").forEach((img) => {
      if (img.getAttribute("src")) return;
      const rel = img.getAttribute("data-vault-src");
      img.src = `${httpBase}/tools/vault_asset/${encodeURIComponent(vid)}/${rel.split("/").map(encodeURIComponent).join("/")}`;
      img.addEventListener("error", () => { img.replaceWith(document.createTextNode(`[${rel}]`)); });
    });
  }

  function renderLog(messages, emptyMsg = t("chat.empty")) {
    log.replaceChildren();
    const visible = messages.filter((m) => typeof m.content === "string");
    if (!visible.length) {
      log.append(el("div", { className: "chat-empty", textContent: emptyMsg }));
      return;
    }
    for (const m of visible) {
      const bubble = el("div", { className: "chat-msg " + m.role });
      if (m.role === "assistant") {
        bubble.innerHTML = renderMarkdown(m.content);
        wireVaultImages(bubble);
        addTtsButton(bubble);
      } else {
        bubble.textContent = m.content;
      }
      log.append(bubble);
    }
    log.scrollTop = log.scrollHeight;
  }

  function setStatus(text, level = "") {
    status.textContent = text;
    status.className = "tool-status" + (level ? " " + level : "");
  }

  // Zeigt im sichtbaren Log nur die Nachrichten des aktiven Modus — Chats bleiben getrennt.
  async function renderActiveLog() {
    if (chatMode === "vault") {
      if (!currentVaultId) { renderLog([]); return; }
      const history = await loadVaultHistory(currentVaultId);
      renderLog(history);
    } else if (chatMode === "page") {
      const hist = (activeSource && activeSource.type === "page") ? sourceChatHistory : pageChatHistory;
      renderLog(hist, t("chat.empty_page"));
    } else {
      renderLog(sourceChatHistory, t("chat.empty_source"));
    }
  }

  function showEmptyState(message, withOptionsLink = true) {
    state.panelBody.replaceChildren();
    const wrap = el("div", { className: "chat-empty-state" });
    wrap.append(el("p", { textContent: message }));
    if (withOptionsLink) {
      const btn = el("button", { type: "button", textContent: t("chat.open_settings") });
      btn.addEventListener("click", () => chrome.runtime.openOptionsPage());
      wrap.append(btn);
    }
    state.panelBody.append(wrap);
  }

  async function loadVaultHistory(vaultId) {
    try {
      const res = await fetch(`${httpBase}/vaults/${encodeURIComponent(vaultId)}/chat/history`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.messages || [];
    } catch { return []; }
  }

  async function loadVaultChat(vaultId) {
    currentVaultId = vaultId;
    await chrome.storage.local.set({ selectedVaultId: vaultId });
    setStatus(t("chat.lade"));
    try {
      const res = await fetch(`${httpBase}/tools/chat/${vaultId}`);
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
      const sourceLabel = {
        claude_md: t("chat.prompt_claude_md"),
        override: t("chat.prompt_override"),
        default: t("chat.prompt_default"),
      }[data.prompt_source] || data.prompt_source || "?";
      meta.textContent = t("chat.meta_info", { name: data.vault?.name || vaultId, model: data.model, turns: data.max_user_turns, source: sourceLabel });
      const history = await loadVaultHistory(vaultId);
      renderLog(history.length ? history : (data.messages || []));
      setStatus("");
      inputArea.focus();
    } catch (err) {
      setStatus(t("chat.load_failed", { error: err.message || err }), "error");
    }
  }

  function appendBubble(role, text = "") {
    // Remove "noch keine nachrichten" placeholder if present
    const empty = log.querySelector(".chat-empty");
    if (empty) empty.remove();
    const bubble = el("div", { className: "chat-msg " + role });
    if (text) bubble.textContent = text;
    log.append(bubble);
    log.scrollTop = log.scrollHeight;
    return bubble;
  }

  // Gemeinsam genutztes Audio-Handle und Web-Speech-Poll aller TTS-Buttons
  // dieser Chat-Instanz — damit ein neuer Klick das vorherige Audio stoppt.
  let _activeAudio = null;
  let _speechPoll = null;

  function _stopAllTts() {
    if (_activeAudio) { _activeAudio.pause(); _activeAudio = null; }
    if (_speechPoll) { clearInterval(_speechPoll); _speechPoll = null; }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  // 🔊 Vorlesen-Button: Server-TTS (ElevenLabs, gecacht) wenn aktiviert,
  // sonst Web Speech API als kostenloser Fallback.
  // Während des Sprechens zeigt der Button ⏹ — Klick stoppt sofort.
  function addTtsButton(bubble) {
    if (!bubble) return;
    const speakText = (bubble.textContent || "").trim();
    if (!speakText) return;
    const b = el("button", { type: "button", className: "tts-btn", textContent: "🔊", title: t("chat.tts_speak") });

    function setIdle() { b.textContent = "🔊"; b.title = t("chat.tts_speak"); b.disabled = false; }
    function setSpeaking() { b.textContent = "⏹"; b.title = t("chat.tts_stop"); b.disabled = false; }

    b.addEventListener("click", async () => {
      if (b.textContent === "⏹") { _stopAllTts(); setIdle(); return; }
      _stopAllTts();
      b.disabled = true;
      b.textContent = "…";
      try {
        if (ttsEnabled) {
          const r = await fetch(`${httpBase}/tools/tts`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: speakText.slice(0, 5000) }),
          });
          if (r.ok) {
            const audio = new Audio(URL.createObjectURL(await r.blob()));
            _activeAudio = audio;
            audio.onended = () => { _activeAudio = null; setIdle(); };
            audio.onerror = () => { _activeAudio = null; setIdle(); };
            try { await audio.play(); } catch { _activeAudio = null; setIdle(); return; }
            setSpeaking();
            return;
          }
          // Server-TTS fehlgeschlagen → Web Speech Fallback
        }
        if (!window.speechSynthesis) throw new Error(t("chat.mic_unavailable"));
        window.speechSynthesis.cancel();
        const utt = new SpeechSynthesisUtterance(speakText.slice(0, 5000));
        utt.lang = "de-DE";
        window.speechSynthesis.speak(utt);
        setSpeaking();
        // Chrome-Extension-Bug: speechSynthesis.onend feuert manchmal sofort,
        // bevor der Browser tatsächlich fertig ist. Statt Events → poll.
        _speechPoll = setInterval(() => {
          if (!window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
            clearInterval(_speechPoll); _speechPoll = null; setIdle();
          }
        }, 300);
      } catch (err) {
        setStatus(t("chat.tts_error", { error: err.message || err }), "error");
        setIdle();
      }
    });
    bubble.appendChild(b);
  }

  async function send(message) {
    if (busy) return;
    if (chatMode === "vault" && !currentVaultId) {
      setStatus(t("chat.no_vault_selected"), "error");
      return;
    }
    if (chatMode === "page" && !activeSource && !scrapedPage?.markdown) {
      setStatus(t("chat.page_loading"), "error");
      return;
    }
    if ((chatMode === "transcript" || chatMode === "video" || chatMode === "vault_file") && !activeSource) {
      setStatus(t("chat.no_source"), "error");
      return;
    }
    busy = true;
    sendBtn.disabled = true;
    inputArea.disabled = true;
    micBtn.disabled = true;
    vaultSelect.disabled = true;

    // Echo user message immediately
    appendBubble("user", message);
    const assistantBubble = appendBubble("assistant");
    assistantBubble.classList.add("streaming");
    let assistantText = "";

    // Tool-Aktivität als persistente Einträge im Verlauf (zwischen Frage und Antwort).
    let currentActivity = null;
    function activityLabel(tool, input) {
      const ref = input?.path || input?.url || input?.rel_path || input?.name || input?.q || input?.prompt || "";
      const suffix = typeof ref === "string" && ref ? ` ${ref.slice(0, 60)}` : "";
      return `${tool}${suffix}`;
    }
    function pushActivity(tool, input) {
      const entry = el("div", { className: "chat-activity running" });
      entry.append(
        el("span", { className: "chat-activity-icon", textContent: "⚙" }),
        el("span", { className: "chat-activity-text", textContent: activityLabel(tool, input) }),
      );
      if (assistantBubble && assistantBubble.parentNode === log) log.insertBefore(entry, assistantBubble);
      else log.append(entry);
      log.scrollTop = log.scrollHeight;
      return entry;
    }

    setStatus(t("chat.thinking"));
    try {
      let res;
      if (chatMode === "page") {
        const fixed = activeSource && activeSource.type === "page";
        const pageText = fixed
          ? (activeSource.ref.content || "")
          : (scrapedPage ? `Titel: ${scrapedPage.title}\nURL: ${scrapedPage.url}\n\n${scrapedPage.markdown}` : "");
        // Seiten-Chat: isoliert (eigene Historie, kein Vault-Verlauf), aber tool-fähig.
        // Vault für die Tools lazy ermitteln; ohne Vault → read-only Fallback.
        let vid = currentVaultId;
        if (!vid) {
          try {
            const sv = await chrome.storage.local.get("selectedVaultId");
            vid = sv.selectedVaultId;
            if (!vid) { const vr = await fetch(`${httpBase}/vaults`); const vd = await vr.json(); vid = vd.vaults?.[0]?.id; }
          } catch (_) {}
        }
        pageToolVaultId = vid || null; // für Bild-Rendering im Seiten-Chat
        res = await fetch(`${httpBase}/tools/chat/source/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({
            source_type: "page",
            source_ref: { content: pageText.slice(0, 80000), title: fixed ? activeSource.ref.title : scrapedPage?.title },
            message,
            history: fixed ? sourceChatHistory : pageChatHistory,
            strict_source: false,
            include_tools: !!vid,
            vault_id: vid || null,
          }),
        });
      } else if (chatMode === "vault_file") {
        // Datei-Chat: voller tool-fähiger Vault-Stream, an die offene Datei angeheftet (schreibfähig).
        const vid = activeSource.ref?.vault_id;
        res = await fetch(`${httpBase}/tools/chat/${vid}/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({
            message,
            pinned_file: { vault_id: vid, rel_path: activeSource.ref?.rel_path },
          }),
        });
      } else if (chatMode === "transcript" || chatMode === "video") {
        res = await fetch(`${httpBase}/tools/chat/source/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({
            source_type: chatMode,
            source_ref: activeSource.ref,
            message,
            history: sourceChatHistory,
            strict_source: true,
          }),
        });
      } else {
        res = await fetch(`${httpBase}/tools/chat/${currentVaultId}/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({ message }),
        });
      }
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(errText || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let pendingEvent = null;

      function dispatch(event, data) {
        if (event === "text_delta") {
          assistantText += data.text;
          assistantBubble.innerHTML = renderMarkdown(assistantText);
          wireVaultImages(assistantBubble);
          log.scrollTop = log.scrollHeight;
        } else if (event === "tool_start") {
          const path = data.input?.path ? ` ${data.input.path}` : "";
          setStatus(`${data.tool}${path}...`);
          currentActivity = pushActivity(data.tool, data.input);
        } else if (event === "tool_end") {
          if (currentActivity) {
            currentActivity.classList.remove("running");
            currentActivity.classList.add(data.ok ? "ok" : "fail");
            const icon = currentActivity.querySelector(".chat-activity-icon");
            if (icon) icon.textContent = data.ok ? "✓" : "✗";
            currentActivity = null;
          }
          if (!data.ok) setStatus(t("chat.tool_failed", { tool: data.tool }), "error");
        } else if (event === "done") {
          assistantBubble.classList.remove("streaming");
          if (assistantText.trim()) {
            assistantBubble.innerHTML = renderMarkdown(assistantText);
            wireVaultImages(assistantBubble);
            addTtsButton(assistantBubble);
          } else {
            assistantBubble.textContent = t("chat.no_response");
          }
          if (chatMode === "page" && data.messages) {
            if (activeSource && activeSource.type === "page") sourceChatHistory = data.messages;
            else pageChatHistory = data.messages;
          }
          if ((chatMode === "transcript" || chatMode === "video" || chatMode === "vault_file") && data.messages) sourceChatHistory = data.messages;
          const u = data.usage || {};
          const cached = u.cache_read_input_tokens ? t("chat.done_status_cached", { tokens: u.cache_read_input_tokens }) : "";
          const baseText = t("chat.done_status", { input: u.input_tokens || 0, output: u.output_tokens || 0, cached });
          status.replaceChildren();
          status.className = "tool-status success";
          status.append(document.createTextNode(baseText));
          if (data.consulted?.length && chatMode === "vault" && currentVaultId) {
            status.append(document.createTextNode(t("chat.consulted")));
            data.consulted.forEach((relPath, i) => {
              if (i > 0) status.append(document.createTextNode(", "));
              const a = el("a", { href: "#", textContent: relPath, className: "chat-citation" });
              a.addEventListener("click", (e) => {
                e.preventDefault();
                openTool("vault_explorer", { initialFile: relPath, vaultId: currentVaultId });
              });
              status.append(a);
            });
          } else if (data.consulted?.length) {
            status.append(document.createTextNode(t("chat.consulted") + data.consulted.join(", ")));
          }
        } else if (event === "error") {
          assistantBubble.classList.remove("streaming");
          assistantBubble.textContent = t("chat.error_prefix", { error: data.message || "?" });
          assistantBubble.classList.add("error");
          setStatus(t("chat.error_prefix", { error: data.message || "?" }), "error");
        }
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by blank lines
        const events = buffer.split(/\n\n/);
        buffer = events.pop(); // keep incomplete trailing
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
          dispatch(eventName, parsed);
        }
      }
    } catch (err) {
      assistantBubble.classList.remove("streaming");
      assistantBubble.classList.add("error");
      assistantBubble.textContent = t("chat.error_prefix", { error: err.message || err });
      setStatus(t("chat.error_prefix", { error: err.message || err }), "error");
    } finally {
      busy = false;
      sendBtn.disabled = false;
      inputArea.disabled = false;
      micBtn.disabled = false;
      vaultSelect.disabled = false;
      inputArea.focus();
    }
  }

  // Spracheingabe via Content-Script-Injection — ewtos.com
  // SpeechRecognition läuft im Tab-Kontext (dort ist getUserMedia erlaubt),
  // Ergebnisse kommen per chrome.runtime.sendMessage zurück.
  let recording = false;
  let baseText = "";

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "transcript_result") {
      inputArea.value = baseText + msg.text;
    } else if (msg.type === "transcript_end") {
      baseText = inputArea.value;
      recording = false;
      micBtn.classList.remove("recording");
      micBtn.title = t("chat.mic_title");
    } else if (msg.type === "transcript_error") {
      recording = false;
      micBtn.classList.remove("recording");
      micBtn.title = t("chat.mic_title");
      if (msg.error !== "aborted") setStatus(t("chat.mic_error", { error: msg.error }), "error");
    }
  });

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
      micBtn.title = t("chat.mic_title");
      return;
    }

    if (!tab?.id || !tab.url?.startsWith("http")) {
      setStatus(t("chat.mic_no_http"), "error");
      return;
    }

    baseText = inputArea.value;
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
          r.onend = () => {
            window.__ewtosMic = null;
            chrome.runtime.sendMessage({ type: "transcript_end" });
          };
          r.onerror = (ev) => {
            window.__ewtosMic = null;
            chrome.runtime.sendMessage({ type: "transcript_error", error: ev.error });
          };
          r.start();
          return { ok: true };
        },
      });
      if (results?.[0]?.result?.error === "not_supported") {
        setStatus(t("chat.mic_unavailable"), "error");
        return;
      }
      recording = true;
      micBtn.classList.add("recording");
      micBtn.title = t("chat.mic_stop");
    } catch (err) {
      setStatus(t("chat.mic_start_error", { error: err.message }), "error");
    }
  });

  vaultSelect.addEventListener("change", () => {
    if (vaultSelect.value && vaultSelect.value !== currentVaultId) {
      loadVaultChat(vaultSelect.value);
    }
  });

  inputWrap.addEventListener("submit", (e) => {
    e.preventDefault();
    const msg = inputArea.value.trim();
    if (!msg) return;
    inputArea.value = "";
    send(msg);
  });

  inputArea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      inputWrap.requestSubmit();
    }
  });

  clearBtn.addEventListener("click", async () => {
    // Nur den Verlauf des aktiven Modus leeren — die anderen Chats bleiben unberührt.
    if (chatMode === "vault") {
      if (!currentVaultId) return;
      if (!confirm(t("chat.confirm_clear_vault"))) return;
      try {
        const res = await fetch(`${httpBase}/tools/chat/${currentVaultId}/clear`, { method: "POST" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        setStatus(t("chat.error_prefix", { error: err.message || err }), "error");
        return;
      }
    } else if (chatMode === "page") {
      if (!confirm(t("chat.confirm_clear_page"))) return;
      if (activeSource && activeSource.type === "page") sourceChatHistory = [];
      else pageChatHistory = [];
    } else {
      if (!confirm(t("chat.confirm_clear_source"))) return;
      sourceChatHistory = [];
    }
    await renderActiveLog();
    setStatus(t("chat.cleared"), "success");
  });

  // Initial load: get vault list, populate dropdown, restore last selection
  // Skip when chat was opened with a specific source (Datei/Video/Transcript) oder als reiner Seiten-Chat.
  if (activeSource || chatMode === "page") {
    inputArea.focus();
    return;
  }
  try {
    const res = await fetch(`${httpBase}/vaults`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const vaults = data.vaults || [];
    if (!vaults.length) {
      showEmptyState(t("chat.no_vault_empty"));
      return;
    }
    vaultSelect.replaceChildren();
    for (const v of vaults) {
      vaultSelect.append(el("option", { value: v.id, textContent: v.name }));
    }
    const { selectedVaultId } = await chrome.storage.local.get("selectedVaultId");
    const startId = vaults.some((v) => v.id === selectedVaultId) ? selectedVaultId : vaults[0].id;
    vaultSelect.value = startId;
    await loadVaultChat(startId);
  } catch (err) {
    setStatus(t("chat.vault_load_error", { error: err.message || err }), "error");
  }
}
