// EwtosBrain background service worker
// - Connects to local Python server via WebSocket
// - Receives tool_call messages, dispatches to handlers, returns tool_result
// - Keeps service worker alive via chrome.alarms

import { runYoutubeTranscript } from "./tools/youtube_transcript.js";
import { runTabCapture } from "./tools/tab_capture.js";
import { runSelectionCapture } from "./tools/selection_capture.js";
import { runYoutubeMeta } from "./tools/youtube_meta.js";
import { runPageScrape } from "./tools/page_scrape.js";
import { runSeoCheck } from "./tools/seo_check.js";
import { runImageAnalyse } from "./tools/image_analyse.js";
import { runColorPicker } from "./tools/color_picker.js";
import { runScreenshot } from "./tools/screenshot.js";
import { runUrlExtractor } from "./tools/url_extractor.js";
import { runAutoBrain } from "./tools/auto_brain.js";

const DEFAULT_SERVER_URL = "ws://localhost:9988/ws";
const DEFAULT_HTTP_BASE = "http://localhost:9988";
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_FACTOR = 1.7;
const PING_MS = 25000;
const KEEPALIVE_NAME = "ewtos-keepalive";

let socket = null;
let reconnectTimer = null;
let pingTimer = null;
let connecting = false;
let reconnectDelay = RECONNECT_MIN_MS;

const TOOL_HANDLERS = {
  youtube_transcript: runYoutubeTranscript,
  tab_capture: runTabCapture,
  selection_capture: runSelectionCapture,
  youtube_meta: runYoutubeMeta,
  page_scrape: runPageScrape,
  seo_check: runSeoCheck,
  image_analyse: runImageAnalyse,
  color_picker: runColorPicker,
  screenshot: runScreenshot,
  url_extractor: runUrlExtractor,
  auto_brain: runAutoBrain,
};

const CONTEXT_MENU_IDS = {
  url: "ewtos_url",
  selection: "ewtos_selection",
  youtube: "ewtos_youtube",
  multitab: "ewtos_multitab",
  brain: "ewtos_brain",
};

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_IDS.url,
      title: "EwtosBrain: URL merken",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_IDS.selection,
      title: "EwtosBrain: Auswahl als Notiz",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_IDS.youtube,
      title: "EwtosBrain: zu Playlist hinzufügen…",
      contexts: ["page"],
      documentUrlPatterns: ["*://*.youtube.com/watch*"],
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_IDS.multitab,
      title: "EwtosBrain: markierte Tabs erfassen",
      // Chrome hat keinen "tab"-Context für contextMenus.create — nur die
      // hier gelisteten Werte. Multi-Tab via Body-Rechtsklick ist
      // unzuverlässig (Chrome verliert die Markierung). Sauberer Pfad:
      // Tastenkürzel (siehe manifest.json:commands + chrome.commands).
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_IDS.brain,
      title: "EwtosBrain: Ins Brain speichern",
      contexts: ["page"],
      documentUrlPatterns: ["*://*.youtube.com/watch*"],
    });
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  chrome.alarms.create(KEEPALIVE_NAME, { periodInMinutes: 0.5 });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  setupContextMenus();
  connect();
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("setup/wizard.html") });
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(KEEPALIVE_NAME, { periodInMinutes: 0.5 });
  setupContextMenus();
  connect();
  checkAndOpenWizard();
});

async function checkAndOpenWizard() {
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  if (!serverUrl) {
    chrome.tabs.create({ url: chrome.runtime.getURL("setup/wizard.html") });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_NAME) {
    if (!isOpen(socket)) connect();
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "get_connection_status") {
    sendResponse({ connected: isOpen(socket) });
    return false;
  }
  if (msg?.type === "reconnect") {
    forceReconnect();
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "auto_pull_video") {
    runAutoPull(msg.payload).catch((err) => {
      notifyError("Auto-Pull: " + (err?.message || err));
    });
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "full_page_screenshot") {
    const MAX_FRAMES = 15;
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error("Kein aktiver Tab");

        const [{ result: dims }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => ({
            scrollY: window.scrollY,
            scrollHeight: document.documentElement.scrollHeight,
            clientHeight: window.innerHeight,
            clientWidth: window.innerWidth,
            dpr: window.devicePixelRatio || 1,
          }),
        });

        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => window.scrollTo(0, 0),
        });
        await new Promise(r => setTimeout(r, 200));

        const frames = [];
        let y = 0;
        while (y < dims.scrollHeight && frames.length < MAX_FRAMES) {
          const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
          frames.push({ dataUrl, y });
          y += dims.clientHeight;
          if (y < dims.scrollHeight) {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: (sy) => window.scrollTo(0, sy),
              args: [y],
            });
            await new Promise(r => setTimeout(r, 600));
          }
        }

        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sy) => window.scrollTo(0, sy),
          args: [dims.scrollY],
        });

        sendResponse({
          ok: true,
          frames,
          totalHeight: dims.scrollHeight,
          clientHeight: dims.clientHeight,
          clientWidth: dims.clientWidth,
          dpr: dims.dpr,
          truncated: dims.scrollHeight > dims.clientHeight * MAX_FRAMES,
        });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  if (msg?.type === "capture_region") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error("Kein aktiver Tab");

        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["tools/screenshot_overlay.js"],
        });

        const [{ result: dpr }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => window.devicePixelRatio || 1,
        });

        const rect = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            chrome.runtime.onMessage.removeListener(handler);
            reject(new Error("Timeout: kein Bereich gewählt"));
          }, 60000);

          function handler(m, sender) {
            if (sender.tab?.id !== tab.id) return;
            if (m?.type === "region_selected") {
              clearTimeout(timer);
              chrome.runtime.onMessage.removeListener(handler);
              resolve(m.rect);
            } else if (m?.type === "region_cancelled") {
              clearTimeout(timer);
              chrome.runtime.onMessage.removeListener(handler);
              reject(new Error("Abgebrochen"));
            }
          }
          chrome.runtime.onMessage.addListener(handler);
        });

        await new Promise(r => setTimeout(r, 80));
        const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
        const croppedUrl = await cropToRegion(dataUrl, rect, dpr);
        sendResponse({ ok: true, dataUrl: croppedUrl });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  return false;
});

async function cropToRegion(dataUrl, rect, dpr) {
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);
  const sx = Math.round(rect.x * dpr);
  const sy = Math.round(rect.y * dpr);
  const sw = Math.max(1, Math.round(rect.w * dpr));
  const sh = Math.max(1, Math.round(rect.h * dpr));
  const offscreen = new OffscreenCanvas(sw, sh);
  const ctx = offscreen.getContext("2d");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  const outBlob = await offscreen.convertToBlob({ type: "image/png" });
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(outBlob);
  });
}

async function runAutoPull({ httpBase, vaultId, slug, url, withTimestamps }) {
  notify("Transcript", "ziehe Transcript…");
  let transcriptText = "";
  try {
    const result = await runYoutubeTranscript({ url, with_timestamps: withTimestamps });
    transcriptText = result?.transcript || "";
  } catch (err) {
    throw new Error("Transcript-Pull fehlgeschlagen: " + (err?.message || err));
  }
  if (!transcriptText.trim()) throw new Error("Transcript leer");

  // Save transcript via REST → updates video page frontmatter
  const tRes = await fetch(`${httpBase}/tools/videos/${vaultId}/${slug}/transcript`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript: transcriptText, with_timestamps: !!withTimestamps }),
  });
  if (!tRes.ok) {
    const text = await tRes.text().catch(() => "");
    throw new Error(`Transcript-Save (${tRes.status}): ${text}`);
  }
  notify("Summary", "erstelle Zusammenfassung…");

  // Generate summary
  const sRes = await fetch(`${httpBase}/tools/videos/${vaultId}/${slug}/summary`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!sRes.ok) {
    const text = await sRes.text().catch(() => "");
    throw new Error(`Summary (${sRes.status}): ${text}`);
  }
  notify("Fertig", `Video aufbereitet: ${slug}`);
}

function isOpen(ws) {
  return ws && ws.readyState === WebSocket.OPEN;
}

async function getServerUrl() {
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  return serverUrl || DEFAULT_SERVER_URL;
}

async function connect() {
  if (connecting || isOpen(socket)) return;
  connecting = true;
  clearTimeout(reconnectTimer);

  const url = await getServerUrl();
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    connecting = false;
    scheduleReconnect();
    return;
  }
  socket = ws;

  // All handlers check `socket === ws` so a superseded socket's late events
  // (e.g. an old socket's onclose firing after forceReconnect created a new
  // one) don't clobber the active connection's state.

  ws.onopen = () => {
    if (socket !== ws) return;
    connecting = false;
    reconnectDelay = RECONNECT_MIN_MS;
    try {
      ws.send(JSON.stringify({
        type: "hello",
        client: "extension",
        version: chrome.runtime.getManifest().version,
      }));
    } catch {}
    broadcastStatus(true);
    startPing();
  };

  ws.onmessage = (event) => {
    if (socket !== ws) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "hello_ack") {
      if (msg.compatible === false) {
        broadcastStatus(false, { incompatible: true, serverVersion: msg.server_version });
      }
      return;
    }
    if (msg.type === "tool_call") {
      handleToolCall(msg).catch((err) => {
        sendResult(msg.request_id, false, undefined, err?.message || String(err));
      });
    }
  };

  ws.onerror = () => {};

  ws.onclose = () => {
    if (socket !== ws) return;
    connecting = false;
    socket = null;
    stopPing();
    broadcastStatus(false);
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(Math.round(reconnectDelay * RECONNECT_FACTOR), RECONNECT_MAX_MS);
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (isOpen(socket)) {
      try { socket.send(JSON.stringify({ type: "ping" })); } catch {}
    }
  }, PING_MS);
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function forceReconnect() {
  const old = socket;
  socket = null;
  connecting = false;
  reconnectDelay = RECONNECT_MIN_MS;
  if (old) {
    // Detach handlers so the close event doesn't trigger a side-effect on
    // the new connection we're about to open.
    old.onopen = null;
    old.onmessage = null;
    old.onerror = null;
    old.onclose = null;
    try { old.close(); } catch {}
  }
  stopPing();
  connect();
}

async function handleToolCall(msg) {
  const handler = TOOL_HANDLERS[msg.tool];
  if (!handler) {
    sendResult(msg.request_id, false, undefined, `Unknown tool: ${msg.tool}`);
    return;
  }
  try {
    const data = await handler(msg.params || {});
    sendResult(msg.request_id, true, data);
  } catch (err) {
    sendResult(msg.request_id, false, undefined, err?.message || String(err));
  }
}

function sendResult(requestId, ok, data, error) {
  if (!isOpen(socket)) return;
  const payload = { type: "tool_result", request_id: requestId, ok };
  if (data !== undefined) payload.data = data;
  if (error !== undefined) payload.error = error;
  socket.send(JSON.stringify(payload));
}

function broadcastStatus(connected, extra) {
  chrome.runtime.sendMessage({ type: "connection_status", connected, ...(extra || {}) }).catch(() => {});
}

// --- HTTP helper for direct REST calls (not via WS tool-loop) ---

async function getHttpBase() {
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  if (serverUrl && serverUrl.startsWith("ws")) {
    return serverUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
  }
  return DEFAULT_HTTP_BASE;
}

async function httpPost(path, body) {
  const base = await getHttpBase();
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${path} → ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

// --- Notification helper for context-menu feedback ---

function notify(title, message) {
  // chrome.notifications would need permission; we use a lightweight badge
  // + log instead to avoid extra permission prompts.
  chrome.action.setBadgeText({ text: "✓" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#10b981" }).catch(() => {});
  console.log(`[EwtosBrain] ${title}: ${message}`);
  setTimeout(() => chrome.action.setBadgeText({ text: "" }).catch(() => {}), 2000);
}

function notifyError(message) {
  chrome.action.setBadgeText({ text: "!" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#ef4444" }).catch(() => {});
  console.error(`[EwtosBrain] ${message}`);
  setTimeout(() => chrome.action.setBadgeText({ text: "" }).catch(() => {}), 4000);
}

// --- Context-menu click dispatch ---

// Tastenkürzel-Listener: triggert KEINEN Body-Click → Multi-Tab-Markierung
// bleibt erhalten. Tastenkürzel ist nicht voreingestellt — User muss selbst
// eines setzen via chrome://extensions/shortcuts.
chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === "capture-highlighted-tabs") {
      const tabs = await runTabCapture({ mode: "highlighted" });
      if (!tabs.length) throw new Error("Keine markierten Tabs");
      for (const t of tabs) {
        await httpPost("/tools/bookmarks", {
          url: t.url, title: t.title, source: "shortcut-multi-tab",
        });
      }
      const list = tabs.map((t) => t.url).join("\n");
      await writeToClipboard(list);
      console.log(`[EwtosBrain] Shortcut Multi-Tab: ${tabs.length} Tabs`);
      notify("Multi-Tab", `${tabs.length} URLs gespeichert + in Clipboard`);
    }
    // 'add-highlighted-youtube-to-playlist' ist im Manifest registriert,
    // aber noch nicht implementiert — der Sidepanel-Picker erwartet aktuell
    // das Single-URL-Schema. Multi-YouTube-Pfad kommt als eigene Iteration
    // (siehe backlog_multi_tab_capture.md).
  } catch (err) {
    notifyError(err?.message || String(err));
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === CONTEXT_MENU_IDS.url) {
      const tabs = await runTabCapture({ mode: "active" });
      if (!tabs.length) throw new Error("Keine erfassbare URL");
      const t = tabs[0];
      await httpPost("/tools/bookmarks", {
        url: t.url, title: t.title, source: "context-menu",
      });
      notify("Bookmark", t.title);
    } else if (info.menuItemId === CONTEXT_MENU_IDS.selection) {
      if (!tab?.id) throw new Error("Kein aktiver Tab");
      const sel = await runSelectionCapture({ tabId: tab.id });
      const block = `**Aus Web** ([${sel.title}](${sel.url}))\n\n${sel.selection}`;
      await httpPost("/tools/notes/scratchpad/append", { text: block });
      notify("Notiz", sel.selection.slice(0, 50));
    } else if (info.menuItemId === CONTEXT_MENU_IDS.multitab) {
      const tabs = await runTabCapture({ mode: "highlighted" });
      if (!tabs.length) throw new Error("Keine markierten Tabs");
      for (const t of tabs) {
        await httpPost("/tools/bookmarks", {
          url: t.url, title: t.title, source: "multi-tab",
        });
      }
      // Clipboard: alle URLs als Liste
      const list = tabs.map((t) => t.url).join("\n");
      await writeToClipboard(list);
      console.log(`[EwtosBrain] Multi-Tab erfasst: ${tabs.length} Tabs`);
      if (tabs.length === 1) {
        notify(
          "Multi-Tab — nur 1 Tab",
          "Tipp: Strg+Klick im Tab-Strip, DANN Rechtsklick auf den Page-Body (nicht den Tab-Reiter).",
        );
      } else {
        notify("Multi-Tab", `${tabs.length} URLs gespeichert + in Clipboard`);
      }
    } else if (info.menuItemId === CONTEXT_MENU_IDS.brain) {
      const url = tab?.url;
      if (!url) throw new Error("Keine URL erfassbar");
      await chrome.storage.local.set({ brainPick: { url, tabId: tab?.id, ts: Date.now() } });
      if (tab?.windowId) {
        chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => {
          console.warn("[EwtosBrain] sidePanel.open failed:", err?.message || err);
        });
      }
    } else if (info.menuItemId === CONTEXT_MENU_IDS.youtube) {
      // MV3: chrome.sidePanel.open MUSS synchron im User-Gesture-Frame
      // aufgerufen werden — sonst schlägt es ohne sichtbaren Fehler fehl.
      let openPromise = null;
      if (tab?.windowId) {
        openPromise = chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => {
          console.warn("[EwtosBrain] sidePanel.open failed:", err?.message || err);
        });
      }
      const url = tab?.url;
      if (!url || !/^https?:/i.test(url)) {
        throw new Error("Keine YouTube-URL erfassbar");
      }
      // Try to scrape Channel + Duration from the YouTube DOM
      let meta = { url, title: tab?.title || url, channel: "", duration: "" };
      if (tab?.id) {
        try {
          const scraped = await runYoutubeMeta({ tabId: tab.id });
          if (scraped) meta = { ...meta, ...scraped };
        } catch (err) {
          console.warn("[EwtosBrain] youtube_meta failed:", err?.message || err);
        }
      }
      await chrome.storage.local.set({
        playlistPick: {
          url: meta.url,
          title: meta.title,
          channel: meta.channel,
          duration: meta.duration,
          ts: Date.now(),
        },
      });
      if (openPromise) await openPromise;
      notify("Playlist", `${meta.title} — Sidepanel: Playlist wählen`);
    }
  } catch (err) {
    notifyError(err?.message || String(err));
  }
});

// --- Clipboard write via offscreen (clipboardWrite alone is not enough in MV3 SW) ---

async function writeToClipboard(text) {
  // MV3 SW kann navigator.clipboard nicht direkt nutzen; wir injecten in den
  // aktiven Tab als Fallback.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (t) => navigator.clipboard?.writeText(t).catch(() => {}),
    args: [text],
  });
}

connect();
