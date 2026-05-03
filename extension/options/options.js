const CLIENT_FIELDS = ["serverUrl", "vaultPath", "llmProvider"];

function httpBaseFromWs(url) {
  return (url || "ws://localhost:9988/ws")
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/ws$/, "");
}

async function loadServerSettings() {
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  try {
    const res = await fetch(`${httpBaseFromWs(serverUrl)}/settings`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function saveServerSettings(values) {
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  const res = await fetch(`${httpBaseFromWs(serverUrl)}/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(values),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

(async () => {
  const stored = await chrome.storage.local.get(CLIENT_FIELDS);
  for (const key of CLIENT_FIELDS) {
    const el = document.getElementById(key);
    if (el && stored[key] !== undefined) el.value = stored[key];
  }

  const server = await loadServerSettings();
  const notesEl = document.getElementById("notesPath");
  if (server?.notes_path) notesEl.value = server.notes_path;
})();

document.getElementById("save").addEventListener("click", async () => {
  const clientPayload = {};
  for (const key of CLIENT_FIELDS) {
    const el = document.getElementById(key);
    if (el) clientPayload[key] = el.value.trim();
  }
  await chrome.storage.local.set(clientPayload);

  const notesPath = document.getElementById("notesPath").value.trim();
  let serverError = null;
  if (notesPath) {
    try {
      await saveServerSettings({ notes_path: notesPath });
    } catch (err) {
      serverError = err.message || String(err);
    }
  }

  const saved = document.getElementById("saved");
  saved.hidden = false;
  saved.textContent = serverError ? `lokal gespeichert (Server: ${serverError})` : "gespeichert";
  saved.style.color = serverError ? "#ef4444" : "#22c55e";
  setTimeout(() => (saved.hidden = true), serverError ? 4000 : 1500);

  chrome.runtime.sendMessage({ type: "reconnect" }).catch(() => {});
});
