// Tool-Dispatcher: openTool/closeTool + TOOL_RENDERERS-Map. ewtos.com
import { state } from '../state.js';
import { el } from '../dom.js';
import { content } from './dom-refs.js';
import { getGroups, renderSidebar, renderToolList, renderQuickActions, applyQuickRowVisibility, updateCrumb } from './nav.js';
import { renderYoutubeTranscript } from '../renderers/youtube.js';
import { renderNotesFile, renderTodos } from '../renderers/notes.js';
import { renderChat } from '../renderers/chat.js';
import { renderVaultExplorer, renderVaultHealth } from '../renderers/vault.js';
import { renderCrmTable } from '../renderers/crm.js';
import { renderPlaylistsTool } from '../renderers/playlists.js';
import { renderBookmarksTool } from '../renderers/bookmarks.js';
import { renderPageScrape, renderSeoCheck, renderImageAnalyse, renderColorPicker, renderScreenshot, renderUrlExtractor, renderImageGenerator } from '../renderers/web-tools.js';
import { renderDocumentIngest } from '../renderers/briefing.js';

export const TOOL_RENDERERS = {
  youtube_transcript: renderYoutubeTranscript,
  scratchpad: () => renderNotesFile("scratchpad", {
    title: "Note-Taker",
    placeholder: "Notizen, Gedanken, Skizzen... wird automatisch gespeichert.",
  }),
  todos: renderTodos,
  chat: renderChat,
  chat_web: renderChat,
  vault_explorer: renderVaultExplorer,
  vault_health: renderVaultHealth,
  crm: renderCrmTable,
  playlists: renderPlaylistsTool,
  bookmarks: renderBookmarksTool,
  page_scrape: renderPageScrape,
  seo_check: renderSeoCheck,
  image_analyse: renderImageAnalyse,
  color_picker: renderColorPicker,
  screenshot: renderScreenshot,
  url_extractor: renderUrlExtractor,
  image_generator: renderImageGenerator,
  ingest_document: renderDocumentIngest,
};

function runToolCleanup() {
  if (state.currentToolCleanup) {
    try { state.currentToolCleanup(); } catch {}
    state.currentToolCleanup = null;
  }
}

export function openTool(toolId, options = null) {
  const renderer = TOOL_RENDERERS[toolId];
  if (!renderer) return;
  runToolCleanup();
  state.searchQuery = "";
  const searchEl = document.getElementById("tool-search");
  if (searchEl) searchEl.value = "";
  for (const g of getGroups()) {
    if (g.tools.some((t) => t.id === toolId)) { state.activeTab = g.id; break; }
  }
  state.activeTool = toolId;
  state.pendingToolOptions = options;
  renderSidebar();
  renderQuickActions();
  applyQuickRowVisibility();
  updateCrumb();

  content.replaceChildren();
  const view = el("section", { className: "tool-view" });
  const header = el("div", { className: "tool-header" });
  const back = el("button", { type: "button", className: "back", textContent: "←" });
  back.addEventListener("click", closeTool);
  state.panelTitle = el("h3");
  header.append(back, state.panelTitle);
  state.panelBody = el("div", { className: "tool-body" });
  view.append(header, state.panelBody);
  content.append(view);

  renderer();
  state.pendingToolOptions = null;
}

function closeTool() {
  runToolCleanup();
  state.activeTool = null;
  state.activeTab = "all";
  state.panelTitle = null;
  state.panelBody = null;
  renderSidebar();
  renderQuickActions();
  applyQuickRowVisibility();
  renderToolList();
  updateCrumb();
}
