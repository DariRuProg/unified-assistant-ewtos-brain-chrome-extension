// CRM-Kachel: öffnet die Kundenstamm-Base im Tab + Explorer auf crm/kunden im
// Sidepanel. CSV-Import/-Export läuft im Tab (crm-io.js). ewtos.com
import { getHttpBase } from '../modules/api.js';
import { openWorkspaceTab } from '../modules/workspace-tab.js';
import { renderVaultExplorer } from './vault.js';
import { CRM_BASE_PATH } from './crm-io.js';

const CRM_FOLDER = "crm/kunden";

async function resolveVaultId(httpBase) {
  const { selectedVaultId } = await chrome.storage.local.get("selectedVaultId");
  try {
    const res = await fetch(`${httpBase}/vaults`);
    if (!res.ok) return selectedVaultId || null;
    const vaults = (await res.json()).vaults || [];
    if (vaults.some((v) => v.id === selectedVaultId)) return selectedVaultId;
    return vaults[0]?.id || null;
  } catch (_) {
    return selectedVaultId || null;
  }
}

export async function renderCrm() {
  const httpBase = await getHttpBase();
  const vaultId = await resolveVaultId(httpBase);
  if (vaultId) openWorkspaceTab(vaultId, CRM_BASE_PATH);
  await renderVaultExplorer({ initialFolder: CRM_FOLDER, vaultId });
}
