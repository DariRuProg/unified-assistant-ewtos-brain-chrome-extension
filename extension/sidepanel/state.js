// Shared mutable state for sidepanel modules. ewtos.com
export const state = {
  activeTab: "chat",
  activeTool: null,
  toolViewMode: "list",
  panelTitle: null,
  panelBody: null,
  quickSlots: ["vault_explorer", "scratchpad", "todos", "_briefing", "_save_page"],
  hideQuickRowOnTool: false,
  lastFetchData: null,
  pendingToolOptions: null,
  _chatPageModeScrape: null,
  currentToolCleanup: null,
};
