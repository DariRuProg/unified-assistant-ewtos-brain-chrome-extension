// Shared mutable state for sidepanel modules. ewtos.com
export const state = {
  activeTab: "all",
  activeTool: null,
  panelTitle: null,
  panelBody: null,
  quickSlots: ["vault_explorer", "scratchpad", "todos", "_save_page"],
  showQuickRow: false,
  searchQuery: "",
  lastFetchData: null,
  pendingToolOptions: null,
  _chatPageModeScrape: null,
  currentToolCleanup: null,
  toolViewMode: "list",
};
