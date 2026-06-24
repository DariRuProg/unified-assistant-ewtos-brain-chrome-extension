// Server- und Vault-Zugriff (geteilte Leaf-Helfer). ewtos.com

export async function getHttpBase() {
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  return (serverUrl || "ws://localhost:9988/ws")
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/ws$/, "");
}

// Vault helper (used by Playlists/Bookmarks/Vault tools)

export async function getActiveVault(httpBase) {
  const { selectedVaultId } = await chrome.storage.local.get("selectedVaultId");
  try {
    const res = await fetch(`${httpBase}/vaults`);
    const data = await res.json();
    const list = data.vaults || [];
    if (selectedVaultId) {
      const found = list.find((v) => v.id === selectedVaultId);
      if (found) return found;
    }
    return list[0] || null;
  } catch {
    return null;
  }
}

export async function getActiveVaultId(httpBase) {
  const v = await getActiveVault(httpBase);
  return v?.id || null;
}

// Hängt vault_id als Query-Param an eine URL an. Unterstützt URLs, die bereits
// einen Query-String haben (z.B. /tools/playlists/<id>?saeule=...).
export function withVaultId(url, vaultId) {
  if (!vaultId) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}vault_id=${encodeURIComponent(vaultId)}`;
}
