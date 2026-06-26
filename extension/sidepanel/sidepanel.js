// Sidepanel: connection status, tab navigation, tool runner. ewtos.com
import { renderMarkdown } from './markdown.js';
import { applyTheme, updateDarkToggleIcon } from './modules/theme.js';
import { state } from './state.js';
import { checkPendingBrainPick, checkActiveTabForYoutube } from './renderers/briefing.js';
import { checkPendingPlaylistPick } from './renderers/playlists.js';
import { statusDot, openOptions, reconnectBtn, offlineBannerText, DEFAULT_OFFLINE_HTML, burgerBtn, navSidebar, toggleFavbarBtn, toolSearch } from './modules/dom-refs.js';
import { renderSidebar, renderToolList, renderQuickActions, openQuickEditor, applyQuickRowVisibility, updateCrumb } from './modules/nav.js';
import { openTool, TOOL_RENDERERS } from './modules/tool-runner.js';
import { initI18n, localizeDom, t } from '../i18n/i18n.js';

// Keep the background Service Worker alive via a persistent port.
// MV3 SWs are terminated after ~30s idle — an open port prevents that,
// keeping the WebSocket connection stable while the sidepanel is open.
const _keepalivePort = chrome.runtime.connect({ name: "sidepanel-keepalive" });
_keepalivePort.onDisconnect.addListener(() => { void chrome.runtime.lastError; });

// ── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  try {
    await initI18n();
    localizeDom();
    const { theme = "neutral", darkMode = false } =
      await chrome.storage.local.get(["theme", "darkMode"]);
    applyTheme(theme, darkMode);
    updateDarkToggleIcon(darkMode);
    const stored = (await chrome.storage.local.get("quickSlots")).quickSlots;
    if (Array.isArray(stored)) state.quickSlots = stored.filter(Boolean);
    state.showQuickRow = !!(await chrome.storage.local.get("showQuickRow")).showQuickRow;
    const { uiIconScale, uiFontScale } = await chrome.storage.local.get(["uiIconScale", "uiFontScale"]);
    if (uiIconScale != null) document.documentElement.style.setProperty("--ui-icon-scale", uiIconScale);
    if (uiFontScale != null) document.documentElement.style.setProperty("--ui-font-scale", uiFontScale);
    syncFavbarToggle();
    renderSidebar();
    renderQuickActions();
    applyQuickRowVisibility();
    updateCrumb();
    if (!state.activeTool) renderToolList();
  } catch (err) {
    const c = document.getElementById("content");
    if (c) c.innerHTML = `<pre style="color:red;padding:8px;font-size:11px">INIT ERROR:\n${err?.stack || err}</pre>`;
    console.error("sidepanel init error:", err);
  }
})();

chrome.storage.onChanged.addListener((changes) => {
  if (changes.theme !== undefined || changes.darkMode !== undefined) {
    chrome.storage.local.get(["theme", "darkMode"], ({ theme = "neutral", darkMode = false }) => {
      applyTheme(theme, darkMode);
      updateDarkToggleIcon(darkMode);
    });
  }
  if (changes.showQuickRow !== undefined) {
    state.showQuickRow = !!changes.showQuickRow.newValue;
    syncFavbarToggle();
    renderQuickActions();
    applyQuickRowVisibility();
  }
  if (changes.uiIconScale !== undefined) {
    document.documentElement.style.setProperty("--ui-icon-scale", changes.uiIconScale.newValue ?? 1.15);
  }
  if (changes.uiFontScale !== undefined) {
    document.documentElement.style.setProperty("--ui-font-scale", changes.uiFontScale.newValue ?? 1);
  }
  if (changes.playlistPick && changes.playlistPick.newValue) {
    checkPendingPlaylistPick();
  }
});

// ── DOM refs ─────────────────────────────────────────────────────────────────











setStatus(false, "verbinde...");
renderSidebar();
renderToolList();
renderQuickActions();
checkPendingPlaylistPick();
checkPendingBrainPick();
checkStartTool();
checkActiveTabForYoutube();

// Globaler Click-Handler für Obsidian-Wikilinks aus renderMarkdown.
// Öffnet die Ziel-Datei im Vault-Explorer (gleicher Vault wie aktuell ausgewählt).
document.addEventListener("click", async (e) => {
  const link = e.target.closest("a.wiki-link");
  if (!link) return;
  e.preventDefault();
  let rel = link.dataset.rel || "";
  if (!rel) return;
  if (!/\.(md|txt)$/i.test(rel)) rel = rel + ".md";
  const { selectedVaultId } = await chrome.storage.local.get("selectedVaultId");
  if (!selectedVaultId) return;
  openTool("vault_explorer", { initialFile: rel, vaultId: selectedVaultId });
});

// Externe Links (https) im Sidepanel via chrome.tabs.create öffnen —
// target="_blank" funktioniert in MV3-Sidepanels nicht zuverlässig.
document.addEventListener("click", (e) => {
  const a = e.target.closest("a.ext-link");
  if (!a) return;
  e.preventDefault();
  chrome.tabs.create({ url: a.href });
});

chrome.runtime.sendMessage({ type: "get_connection_status" }, (resp) => {
  if (chrome.runtime.lastError) return;
  if (resp) setStatus(!!resp.connected);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "connection_status") {
    if (msg.incompatible) {
      if (offlineBannerText) {
        offlineBannerText.textContent =
          `Version-Konflikt: Server v${msg.serverVersion ?? "?"}, Extension v${chrome.runtime.getManifest().version}. Bitte beide aktualisieren.`;
      }
      setStatus(false, "Version-Konflikt");
    } else {
      if (offlineBannerText) offlineBannerText.innerHTML = DEFAULT_OFFLINE_HTML;
      setStatus(!!msg.connected);
    }
  }
});

// Wenn das Sidepanel schon offen ist und ein neuer Context-Menu-Pick reinkommt,
// triggert checkPendingPlaylistPick — sonst würde der Picker nie auftauchen.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.playlistPick && changes.playlistPick.newValue) {
    checkPendingPlaylistPick();
  }
  if (area === "local" && changes.brainPick && changes.brainPick.newValue) {
    checkPendingBrainPick();
  }
  if (area === "local" && changes.startTool && changes.startTool.newValue) {
    checkStartTool();
  }
  // Vault-Switch: Notes-Tools sind vault-scoped, also komplett neu rendern,
  // damit scratchpad/todos/bookmarks aus dem neu gewählten Vault geladen werden.
  if (area === "local" && changes.selectedVaultId && state.activeTool && NOTES_TOOLS.has(state.activeTool)) {
    openTool(state.activeTool);
  }
});

openOptions.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  closeNavSidebar();
});

reconnectBtn.addEventListener("click", () => {
  setStatus(false, "verbinde...");
  chrome.runtime.sendMessage({ type: "reconnect" }).catch(() => {});
  closeNavSidebar();
});

function syncFavbarToggle() {
  if (toggleFavbarBtn) toggleFavbarBtn.classList.toggle("active", state.showQuickRow);
}
toggleFavbarBtn.addEventListener("click", () => {
  state.showQuickRow = !state.showQuickRow;
  chrome.storage.local.set({ showQuickRow: state.showQuickRow });
  syncFavbarToggle();
  renderQuickActions();
  applyQuickRowVisibility();
});
document.getElementById("edit-quick-slots").addEventListener("click", () => {
  openQuickEditor(null);
});

toolSearch.addEventListener("input", () => {
  state.searchQuery = toolSearch.value;
  if (state.searchQuery.trim()) state.activeTool = null;
  renderToolList();
  applyQuickRowVisibility();
});
toolSearch.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    document.querySelector("#content .tool-row")?.click();
  } else if (e.key === "Escape") {
    toolSearch.value = "";
    state.searchQuery = "";
    renderToolList();
    applyQuickRowVisibility();
    toolSearch.blur();
  }
});

// Navigation als Push-Sidebar (rechts): ☰ togglet, bleibt offen bis erneut
// geschlossen wird (per ☰ oder Escape).
function openNavSidebar() {
  navSidebar.classList.add("open");
  navSidebar.setAttribute("aria-hidden", "false");
  burgerBtn.setAttribute("aria-expanded", "true");
}
function closeNavSidebar() {
  navSidebar.classList.remove("open");
  navSidebar.setAttribute("aria-hidden", "true");
  burgerBtn.setAttribute("aria-expanded", "false");
}
burgerBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (navSidebar.classList.contains("open")) closeNavSidebar();
  else openNavSidebar();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && navSidebar.classList.contains("open")) closeNavSidebar();
});

document.getElementById("retry-connect")?.addEventListener("click", () => {
  setStatus(false, "verbinde...");
  chrome.runtime.sendMessage({ type: "reconnect" }).catch(() => {});
});

document.getElementById("dark-toggle").addEventListener("click", async () => {
  const isDark = document.documentElement.dataset.mode === "dark";
  const { theme = "neutral" } = await chrome.storage.local.get("theme");
  applyTheme(theme, !isDark);
  updateDarkToggleIcon(!isDark);
  chrome.storage.local.set({ darkMode: !isDark });
});

function setStatus(connected, customText) {
  statusDot.classList.toggle("online", connected);
  statusDot.classList.toggle("offline", !connected);
  statusDot.title = customText ?? (connected ? t("sidepanel.status_connected") : t("sidepanel.status_offline"));
  const banner = document.getElementById("offline-banner");
  if (banner) banner.classList.toggle("hidden", connected);
}

async function checkStartTool() {
  const { startTool } = await chrome.storage.local.get("startTool");
  if (!startTool) return;
  await chrome.storage.local.remove("startTool");
  if (TOOL_RENDERERS[startTool]) openTool(startTool);
}






document.addEventListener("click", () => {
  document.querySelectorAll(".tool-popover.open").forEach(p => p.classList.remove("open"));
});




































const NOTES_TOOLS = new Set(["scratchpad", "todos", "bookmarks"]);



// --- Playlists Tool -----------------------------------------------------











// --- Bookmarks Tool -----------------------------------------------------

// Bookmarks-State (über Re-Render hinweg, weil filter+search lokal sind)






// Scraped YouTube-Metadaten aus einem konkreten Tab. Inline-Variante von
// extension/tools/youtube_meta.js — Sidepanel-Module-Imports sind Setup-
// Aufwand, deshalb hier dupliziert.










// ── Sprint 3: Web-Tools ──────────────────────────────────────────────────────






// ── URL-Extraktor ────────────────────────────────────────────────────────────


// ── Image-Generator (Gemini Nano Banana) ─────────────────────────────────────






// ── Guten-Morgen-Briefing ────────────────────────────────────────────────────














// ── YouTube Auto-Brain Modal ─────────────────────────────────────────────────



// ── YouTube-Hint im Header ───────────────────────────────────────────────────




chrome.tabs.onActivated.addListener(() => {
  checkActiveTabForYoutube();
  if (state._chatPageModeScrape) state._chatPageModeScrape();
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete" || !state._chatPageModeScrape) return;
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.id === tabId) state._chatPageModeScrape();
  });
});

// --- Dokument-Ingest ---

