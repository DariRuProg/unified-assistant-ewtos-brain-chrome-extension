// Chat Renderer (Vault- + Seiten-Chat). ewtos.com
import { el } from '../dom.js';
import { state } from '../state.js';
import { getHttpBase } from '../modules/api.js';
import { renderMarkdown } from '../markdown.js';
import { openTool } from '../modules/tool-runner.js';

export async function renderChat() {
  state.panelTitle.textContent = "Chat mit Vault";

  const initialSource = state.pendingToolOptions?.sourceType && state.pendingToolOptions?.sourceRef
    ? { type: state.pendingToolOptions.sourceType, ref: state.pendingToolOptions.sourceRef, title: state.pendingToolOptions.sourceTitle || "" }
    : null;

  function updateChatTitle(mode, sourceTitle) {
    if (mode === "transcript") state.panelTitle.textContent = sourceTitle ? `Chat: ${sourceTitle}` : "Chat mit Transcript";
    else if (mode === "video") state.panelTitle.textContent = sourceTitle ? `Chat: ${sourceTitle}` : "Chat mit Video";
    else if (mode === "page") state.panelTitle.textContent = sourceTitle ? `Chat: ${sourceTitle}` : "Chat mit Seite";
    else if (mode === "vault_file") state.panelTitle.textContent = sourceTitle ? `Chat: ${sourceTitle}` : "Chat mit Datei";
    else state.panelTitle.textContent = "Chat mit Vault";
  }

  const httpBase = await getHttpBase();

  // Header: vault picker + meta line
  const header = el("div", { className: "chat-header" });
  const vaultSelect = el("select", { className: "vault-picker" });
  header.append(vaultSelect);
  const meta = el("div", { className: "tool-status", textContent: "lade Vaults..." });

  const log = el("div", { className: "chat-log" });
  const inputWrap = el("form", { className: "chat-input" });
  const inputArea = el("textarea", { placeholder: "Frage an den Vault... (Enter = senden, Shift+Enter = Zeilenumbruch)", rows: 2 });
  const sendBtn = el("button", { type: "submit", textContent: "→" });
  const micBtn = el("button", { type: "button", textContent: "🎙", title: "Spracheingabe" });
  micBtn.classList.add("mic-btn");
  inputWrap.append(inputArea, micBtn, sendBtn);

  const toolbar = el("div", { className: "chat-toolbar" });
  const clearBtn = el("button", { type: "button", textContent: "Verlauf löschen" });
  clearBtn.classList.add("secondary");

  // Search toggle
  const searchToggleRow = el("div", { className: "checkbox-row", title: "Volltextsuche über alle .md-Dateien (inkl. raw/) — ermöglicht gezielte Stichwort-Suche" });
  const searchToggle = el("input", { type: "checkbox", id: "vaultSearchToggle" });
  searchToggle.checked = true; // default until loaded from server
  const searchToggleLabel = el("label", { htmlFor: "vaultSearchToggle", textContent: "Volltextsuche" });
  searchToggleRow.append(searchToggle, searchToggleLabel);

  // Load initial state from server
  let ttsEnabled = false;
  try {
    const settingsRes = await fetch(`${httpBase}/settings`);
    if (settingsRes.ok) {
      const settingsData = await settingsRes.json();
      if (typeof settingsData.vault_search_enabled === "boolean") {
        searchToggle.checked = settingsData.vault_search_enabled;
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

  toolbar.append(clearBtn, searchToggleRow);

  const status = el("div", { className: "tool-status" });
  const pageUrlRow = el("div", { className: "page-url-row", style: "display:none" });

  const startMode = state.pendingToolOptions?.startMode || null;
  let chatMode = "vault";
  let scrapeMode = "content"; // "content" | "full"
  let strictPage = true;
  let scrapedPage = state.pendingToolOptions?.pageContent || null;
  let pageChatHistory = [];
  let sourceChatHistory = [];
  let activeSource = null; // {type: "transcript"|"video", ref: {...}, title: string}

  // --- Scrape-Mode Radio-Buttons ---
  const scrapeModeRow = el("div", { className: "scrape-mode-row", style: "display:none" });
  function makeScrapeRadio(value, label) {
    const btn = el("button", { type: "button", className: "scrape-mode-btn" + (value === "content" ? " active" : ""), textContent: label });
    btn.dataset.value = value;
    btn.addEventListener("click", async () => {
      if (scrapeMode === value) return;
      scrapeMode = value;
      scrapeModeRow.querySelectorAll(".scrape-mode-btn").forEach(b => b.classList.toggle("active", b.dataset.value === value));
      if (chatMode === "page") await scrapeCurrentPage();
    });
    return btn;
  }
  scrapeModeRow.append(makeScrapeRadio("content", "Nur Inhalt"), makeScrapeRadio("full", "Alles"));

  // --- Strict-Page Toggle ---
  const strictRow = el("div", { className: "scrape-mode-row", style: "display:none" });
  const strictOnBtn  = el("button", { type: "button", className: "scrape-mode-btn active", textContent: "Nur Seite" });
  const strictOffBtn = el("button", { type: "button", className: "scrape-mode-btn", textContent: "Seite + Wissen" });
  strictOnBtn.title  = "Antwortet ausschließlich aus dem Seiteninhalt";
  strictOffBtn.title = "Ergänzt mit allgemeinem Wissen, kennzeichnet es aber";
  strictOnBtn.addEventListener("click", () => {
    if (strictPage) return;
    strictPage = true;
    pageChatHistory = [];
    strictOnBtn.classList.add("active");
    strictOffBtn.classList.remove("active");
  });
  strictOffBtn.addEventListener("click", () => {
    if (!strictPage) return;
    strictPage = false;
    pageChatHistory = [];
    strictOffBtn.classList.add("active");
    strictOnBtn.classList.remove("active");
  });
  strictRow.append(strictOnBtn, strictOffBtn);

  function setPageUrlRow(state, text) {
    if (state === "hide") { pageUrlRow.style.display = "none"; return; }
    pageUrlRow.style.display = "";
    pageUrlRow.className = "page-url-row" + (state === "error" ? " error" : state === "loading" ? " loading" : "");
    pageUrlRow.textContent = text;
  }

  async function scrapeCurrentPage() {
    setPageUrlRow("loading", "Lese Seite...");
    setStatus("lese Seite...");
    try {
      const hb = await getHttpBase();
      const res = await fetch(`${hb}/tools/page_scrape`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: scrapeMode }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.markdown) throw new Error("Kein Seiteninhalt");
      scrapedPage = { title: data.title || "", url: data.url || "", markdown: data.markdown };
      setPageUrlRow("ok", scrapedPage.title || scrapedPage.url);
      setStatus("");
    } catch (err) {
      scrapedPage = null;
      setPageUrlRow("error", "Fehler: " + (err.message || err));
      setStatus("Seite konnte nicht gelesen werden: " + (err.message || err), "error");
    }
  }

  const modeRow = el("div", { className: "chat-mode-row" });
  const vaultBtn = el("button", { type: "button", className: "chat-mode-btn active", textContent: "📚 Vault" });
  const pageBtn  = el("button", { type: "button", className: "chat-mode-btn", textContent: "🌐 Seite" });
  modeRow.append(vaultBtn, pageBtn);

  vaultBtn.addEventListener("click", () => {
    chatMode = "vault";
    vaultBtn.classList.add("active");
    pageBtn.classList.remove("active");
    state._chatPageModeScrape = null;
    scrapeModeRow.style.display = "none";
    strictRow.style.display = "none";
    setPageUrlRow("hide");
    setStatus("");
    updateChatTitle("vault");
  });

  pageBtn.addEventListener("click", async () => {
    chatMode = "page";
    pageBtn.classList.add("active");
    vaultBtn.classList.remove("active");
    pageChatHistory = [];
    scrapeModeRow.style.display = "";
    strictRow.style.display = "";
    state._chatPageModeScrape = scrapeCurrentPage;
    updateChatTitle("page");
    await scrapeCurrentPage();
  });

  const webHint = el("div", { className: "chat-web-hint", textContent: "Hinweis: Internet-Recherche im Chat ist noch nicht aktiv (geplant für später)." });

  const sourceBanner = el("div", { className: "chat-source-banner", style: "display:none" });

  state.panelBody.append(header, modeRow, scrapeModeRow, strictRow, pageUrlRow, sourceBanner, meta, log, status, inputWrap, webHint, toolbar);

  function updateWebHintVisibility() {
    webHint.style.display = chatMode === "vault" ? "" : "none";
  }
  updateWebHintVisibility();
  vaultBtn.addEventListener("click", updateWebHintVisibility);
  pageBtn.addEventListener("click", updateWebHintVisibility);

  function applySourceMode(src) {
    chatMode = src.type;
    activeSource = src;
    sourceChatHistory = [];
    state._chatPageModeScrape = null;
    header.style.display = "none";
    modeRow.style.display = "none";
    scrapeModeRow.style.display = "none";
    strictRow.style.display = "none";
    setPageUrlRow("hide");
    sourceBanner.style.display = "";
    if (src.type === "transcript") {
      sourceBanner.textContent = `📜 Quelle: Transcript "${src.title || src.ref?.rel_path || ""}"`;
    } else if (src.type === "video") {
      sourceBanner.textContent = `🎬 Quelle: Video "${src.title || src.ref?.slug || ""}"`;
    } else if (src.type === "vault_file") {
      sourceBanner.textContent = `📄 Quelle: Datei ${src.title || src.ref?.rel_path || ""}`;
    } else {
      sourceBanner.textContent = `🌐 Quelle: ${src.title || "Seiteninhalt"}`;
    }
    updateChatTitle(src.type, src.title);
    updateWebHintVisibility();
    meta.textContent = "";
    log.replaceChildren();
    log.append(el("div", { className: "chat-empty", textContent: "Stell deine Frage zu diesem Inhalt." }));
  }

  // Wenn über "Mit Seite chatten" geöffnet: direkt in Page-Modus springen
  if (scrapedPage?.markdown) {
    chatMode = "page";
    pageBtn.classList.add("active");
    vaultBtn.classList.remove("active");
    scrapeModeRow.style.display = "";
    strictRow.style.display = "";
    state._chatPageModeScrape = scrapeCurrentPage;
    setPageUrlRow("ok", scrapedPage.title || scrapedPage.url);
    updateChatTitle("page");
  }

  // Wenn über "💬 Chat" auf Video oder Transcript geöffnet
  if (initialSource) {
    applySourceMode(initialSource);
  }

  // Über die "Chat mit Seite"-Kachel geöffnet: direkt in Seiten-Modus
  if (!scrapedPage?.markdown && !initialSource && startMode === "page") {
    pageBtn.click();
  }


  let busy = false;
  let currentVaultId = null;

  function renderLog(messages) {
    log.replaceChildren();
    const visible = messages.filter((m) => typeof m.content === "string");
    if (!visible.length) {
      log.append(el("div", { className: "chat-empty", textContent: "Noch keine Nachrichten. Frag den Vault was!" }));
      return;
    }
    for (const m of visible) {
      const bubble = el("div", { className: "chat-msg " + m.role });
      if (m.role === "assistant") {
        bubble.innerHTML = renderMarkdown(m.content);
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

  function showEmptyState(message, withOptionsLink = true) {
    state.panelBody.replaceChildren();
    const wrap = el("div", { className: "chat-empty-state" });
    wrap.append(el("p", { textContent: message }));
    if (withOptionsLink) {
      const btn = el("button", { type: "button", textContent: "Einstellungen öffnen" });
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
    setStatus("lade...");
    try {
      const res = await fetch(`${httpBase}/tools/chat/${vaultId}`);
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!res.ok) throw new Error(data?.detail || text || `HTTP ${res.status}`);
      const sourceLabel = {
        claude_md: "CLAUDE.md aktiv",
        override: "Override aktiv",
        default: "Default-Prompt (keine CLAUDE.md)",
      }[data.prompt_source] || data.prompt_source || "?";
      meta.textContent = `${data.vault?.name || vaultId} · Modell: ${data.model} · max ${data.max_user_turns} Paare · ${sourceLabel}`;
      const history = await loadVaultHistory(vaultId);
      renderLog(history.length ? history : (data.messages || []));
      setStatus("");
      inputArea.focus();
    } catch (err) {
      setStatus("Laden fehlgeschlagen: " + (err.message || err), "error");
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

  // 🔊 Vorlesen-Button (ElevenLabs) auf Assistant-Bubbles, wenn aktiviert
  function addTtsButton(bubble) {
    if (!ttsEnabled || !bubble) return;
    const speakText = (bubble.textContent || "").trim();
    if (!speakText) return;
    const b = el("button", { type: "button", className: "tts-btn", textContent: "🔊", title: "Vorlesen" });
    b.addEventListener("click", async () => {
      b.disabled = true;
      const prev = b.textContent;
      b.textContent = "…";
      try {
        const r = await fetch(`${httpBase}/tools/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: speakText.slice(0, 5000) }),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.detail || `HTTP ${r.status}`);
        }
        const audio = new Audio(URL.createObjectURL(await r.blob()));
        audio.play();
      } catch (err) {
        setStatus("Vorlesen fehlgeschlagen: " + (err.message || err), "error");
      } finally {
        b.disabled = false;
        b.textContent = prev;
      }
    });
    bubble.appendChild(b);
  }

  async function send(message) {
    if (busy) return;
    if (chatMode === "vault" && !currentVaultId) {
      setStatus("Bitte zuerst einen Vault auswählen", "error");
      return;
    }
    if (chatMode === "page" && !activeSource && !scrapedPage?.markdown) {
      setStatus("Seite wird noch geladen — kurz warten", "error");
      return;
    }
    if ((chatMode === "transcript" || chatMode === "video" || chatMode === "vault_file") && !activeSource) {
      setStatus("Keine Quelle ausgewählt", "error");
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

    setStatus("denkt...");
    try {
      let res;
      if (chatMode === "page") {
        let sourceRef;
        let historyForRequest;
        let strict;
        if (activeSource && activeSource.type === "page") {
          // Came in via "Chat mit ..." button — fixed source content, no auto-rescrape.
          sourceRef = activeSource.ref;
          historyForRequest = sourceChatHistory;
          strict = true;
        } else {
          // Came in via Mode-Buttons — live-scraped tab content.
          const pageText = `Titel: ${scrapedPage.title}\nURL: ${scrapedPage.url}\n\n${scrapedPage.markdown}`;
          sourceRef = { content: pageText.slice(0, 80000), title: scrapedPage.title };
          historyForRequest = pageChatHistory;
          strict = strictPage;
        }
        res = await fetch(`${httpBase}/tools/chat/source/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({
            source_type: "page",
            source_ref: sourceRef,
            message,
            history: historyForRequest,
            strict_source: strict,
          }),
        });
      } else if (chatMode === "transcript" || chatMode === "video" || chatMode === "vault_file") {
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
          log.scrollTop = log.scrollHeight;
        } else if (event === "tool_start") {
          const path = data.input?.path ? ` ${data.input.path}` : "";
          setStatus(`${data.tool}${path}...`);
        } else if (event === "tool_end") {
          // optional: subtle ack — keep status as "denkt..." until next event
          if (!data.ok) setStatus(`${data.tool} fehlgeschlagen`, "error");
        } else if (event === "done") {
          assistantBubble.classList.remove("streaming");
          if (assistantText.trim()) {
            assistantBubble.innerHTML = renderMarkdown(assistantText);
            addTtsButton(assistantBubble);
          } else {
            assistantBubble.textContent = "(keine Textantwort)";
          }
          if (chatMode === "page" && data.messages) {
            if (activeSource && activeSource.type === "page") sourceChatHistory = data.messages;
            else pageChatHistory = data.messages;
          }
          if ((chatMode === "transcript" || chatMode === "video" || chatMode === "vault_file") && data.messages) sourceChatHistory = data.messages;
          const u = data.usage || {};
          const cached = u.cache_read_input_tokens ? ` · cache-hit ${u.cache_read_input_tokens}` : "";
          const baseText = `fertig (${u.input_tokens || 0} in / ${u.output_tokens || 0} out${cached})`;
          status.replaceChildren();
          status.className = "tool-status success";
          status.append(document.createTextNode(baseText));
          if (data.consulted?.length && chatMode === "vault" && currentVaultId) {
            status.append(document.createTextNode(" · gelesen: "));
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
            status.append(document.createTextNode(` · gelesen: ${data.consulted.join(", ")}`));
          }
        } else if (event === "error") {
          assistantBubble.classList.remove("streaming");
          assistantBubble.textContent = "Fehler: " + (data.message || "unbekannt");
          assistantBubble.classList.add("error");
          setStatus("Fehler: " + (data.message || "unbekannt"), "error");
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
      assistantBubble.textContent = "Fehler: " + (err.message || err);
      setStatus("Fehler: " + (err.message || err), "error");
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
      micBtn.title = "Spracheingabe";
    } else if (msg.type === "transcript_error") {
      recording = false;
      micBtn.classList.remove("recording");
      micBtn.title = "Spracheingabe";
      if (msg.error !== "aborted") setStatus("Mikrofon-Fehler: " + msg.error, "error");
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
      micBtn.title = "Spracheingabe";
      return;
    }

    if (!tab?.id || !tab.url?.startsWith("http")) {
      setStatus("Spracheingabe braucht eine http(s)-Seite im aktiven Tab", "error");
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
        setStatus("SpeechRecognition nicht verfügbar", "error");
        return;
      }
      recording = true;
      micBtn.classList.add("recording");
      micBtn.title = "Aufnahme stoppen";
    } catch (err) {
      setStatus("Spracheingabe-Fehler: " + err.message, "error");
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
    if (!currentVaultId) return;
    if (!confirm("Verlauf für diesen Vault löschen?")) return;
    try {
      const res = await fetch(`${httpBase}/tools/chat/${currentVaultId}/clear`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      renderLog([]);
      setStatus("Verlauf geleert", "success");
    } catch (err) {
      setStatus("Fehler: " + (err.message || err), "error");
    }
  });

  // Initial load: get vault list, populate dropdown, restore last selection
  // Skip when chat was opened with a specific source (video/transcript) — no vault context needed.
  if (activeSource) {
    inputArea.focus();
    return;
  }
  try {
    const res = await fetch(`${httpBase}/vaults`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const vaults = data.vaults || [];
    if (!vaults.length) {
      showEmptyState("Noch kein Vault verbunden. Lege in den Einstellungen einen an, dann kannst du chatten.");
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
    setStatus("Vault-Liste konnte nicht geladen werden: " + (err.message || err), "error");
  }
}
