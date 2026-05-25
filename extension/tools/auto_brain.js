// EwtosBrain — YouTube Auto-Brain | ewtos.com

import { runYoutubeMeta } from "./youtube_meta.js";

async function getHttpBase() {
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  return (serverUrl || "ws://localhost:9988/ws")
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/ws$/, "");
}

export async function runAutoBrain(params = {}) {
  const url = params.url;
  const vaultId = params.vault_id;
  if (!url) throw new Error("url required");
  if (!vaultId) throw new Error("vault_id required");

  const httpBase = await getHttpBase();

  // Server-API zuerst (mit Browser-Fallback) — gleicher Hybrid-Pfad wie im Sidepanel
  const ttRes = await fetch(`${httpBase}/tools/youtube_transcript`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, with_timestamps: !!params.with_timestamps }),
  });
  const ttText = await ttRes.text();
  let ttJson = null;
  try { ttJson = JSON.parse(ttText); } catch {}
  if (!ttRes.ok) throw new Error(ttJson?.detail || ttText || `youtube_transcript HTTP ${ttRes.status}`);
  const transcript = (ttJson?.transcript || "").trim();
  if (!transcript) throw new Error("Transcript leer oder nicht verfügbar");

  let title = "";
  if (params.tabId) {
    try {
      const meta = await runYoutubeMeta({ tabId: params.tabId });
      title = meta?.title || "";
    } catch {}
  }

  const res = await fetch(`${httpBase}/tools/auto_tag`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript, title, vault_id: vaultId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`auto_tag (${res.status}): ${text}`);
  }
  const data = await res.json();
  const suggestion = data.data || data;

  return { transcript, title, url, suggestion };
}
