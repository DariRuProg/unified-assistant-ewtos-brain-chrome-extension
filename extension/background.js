// EwtosBrain background service worker
// - Connects to local Python server via WebSocket
// - Receives tool_call messages, dispatches to handlers, returns tool_result
// - Keeps service worker alive via chrome.alarms

import { runYoutubeTranscript } from "./tools/youtube_transcript.js";
import { runTabCapture } from "./tools/tab_capture.js";
import { runSelectionCapture } from "./tools/selection_capture.js";
import { runYoutubeMeta } from "./tools/youtube_meta.js";

const DEFAULT_SERVER_URL = "ws://localhost:9988/ws";
const DEFAULT_HTTP_BASE = "http://localhost:9988";
const RECONNECT_MS = 3000;
const PING_MS = 25000;
const KEEPALIVE_NAME = "ewtos-keepalive";

let socket = null;
let reconnectTimer = null;
let pingTimer = null;
let connecting = false;

const TOOL_HANDLERS = {
  youtube_transcript: runYoutubeTranscript,
  tab_capture: runTabCapture,
  selection_capture: runSelectionCapture,
  youtube_meta: runYoutubeMeta,
};

const CONTEXT_MENU_IDS = {
  url: "ewtos_url",
  selection: "ewtos_selection",
  youtube: "ewtos_youtube",
  multitab: "ewtos_multitab",
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
      contexts: ["page"],
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(KEEPALIVE_NAME, { periodInMinutes: 0.5 });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  setupContextMenus();
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(KEEPALIVE_NAME, { periodInMinutes: 0.5 });
  setupContextMenus();
  connect();
});

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
  return false;
});

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
    try {
      ws.send(JSON.stringify({ type: "hello", client: "extension", version: "0.1.0" }));
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
  reconnectTimer = setTimeout(connect, RECONNECT_MS);
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

function broadcastStatus(connected) {
  chrome.runtime.sendMessage({ type: "connection_status", connected }).catch(() => {});
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
      notify("Multi-Tab", `${tabs.length} URLs gespeichert + Clipboard`);
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
