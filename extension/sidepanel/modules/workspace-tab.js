// Workspace-Tab öffnen (Datei/Base/Chat in eigenem Browser-Tab statt Sidepanel).
// Zentrale Stelle für Vault-Explorer, CRM, Note-Taker und Nav-Rail.
// Default: bestehenden Workspace-Tab wiederverwenden (der Tab fragt selbst nach,
// falls dort ungespeicherte Änderungen offen sind). forceNew=true → neuer Tab.
export function openWorkspaceTab(vaultId, relPath, { forceNew = false, chatMode = "" } = {}) {
  if (!vaultId || !relPath) return;
  const extra = chatMode ? `&chat_mode=${encodeURIComponent(chatMode)}` : "";
  const url = chrome.runtime.getURL(
    `workspace/workspace.html?vault_id=${encodeURIComponent(vaultId)}&rel_path=${encodeURIComponent(relPath)}${extra}`
  );
  if (forceNew) { chrome.tabs.create({ url }); return; }
  const prefix = chrome.runtime.getURL("workspace/workspace.html");
  chrome.tabs.query({}, (tabs) => {
    const existing = (tabs || []).find((t) => t.url && t.url.startsWith(prefix));
    if (!existing) { chrome.tabs.create({ url }); return; }
    // Broadcast an Extension-Seiten (tabs.sendMessage erreicht nur Content-Scripts).
    // targetTabId filtert auf den richtigen Workspace-Tab; der Tab navigiert selbst
    // und fragt vorher bei ungespeicherten Änderungen nach.
    chrome.runtime.sendMessage(
      { type: "ws_open_file", targetTabId: existing.id, vault_id: vaultId, rel_path: relPath, chat_mode: chatMode },
      (resp) => {
        if (chrome.runtime.lastError || resp === undefined) {
          chrome.tabs.update(existing.id, { url, active: true }, () => { void chrome.runtime.lastError; });
        } else {
          chrome.tabs.update(existing.id, { active: true });
        }
      }
    );
  });
}
