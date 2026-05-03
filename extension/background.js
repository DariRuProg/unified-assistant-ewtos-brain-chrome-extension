// EwtosBrain background service worker
// - Connects to local Python server via WebSocket
// - Receives tool_call messages, dispatches to handlers, returns tool_result
// - Keeps service worker alive via chrome.alarms

import { runYoutubeTranscript } from "./tools/youtube_transcript.js";

const DEFAULT_SERVER_URL = "ws://localhost:9988/ws";
const RECONNECT_MS = 3000;
const PING_MS = 25000;
const KEEPALIVE_NAME = "ewtos-keepalive";

let socket = null;
let reconnectTimer = null;
let pingTimer = null;
let connecting = false;

const TOOL_HANDLERS = {
  youtube_transcript: runYoutubeTranscript,
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(KEEPALIVE_NAME, { periodInMinutes: 0.5 });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(KEEPALIVE_NAME, { periodInMinutes: 0.5 });
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
  return false;
});

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
  try {
    socket = new WebSocket(url);
  } catch (err) {
    connecting = false;
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    connecting = false;
    socket.send(JSON.stringify({ type: "hello", client: "extension", version: "0.1.0" }));
    broadcastStatus(true);
    startPing();
  };

  socket.onmessage = (event) => {
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

  socket.onerror = () => {};

  socket.onclose = () => {
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
  try {
    socket?.close();
  } catch {}
  socket = null;
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

connect();
