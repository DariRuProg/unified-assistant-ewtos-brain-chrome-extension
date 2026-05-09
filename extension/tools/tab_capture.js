// Tab-Capture: holt URL+Titel des aktiven Tabs oder aller markierten Tabs.
// mode: "active" = nur der aktive Tab, "highlighted" = alle Strg/Shift-markierten.

export async function runTabCapture({ mode = "active" } = {}) {
  const query = mode === "highlighted"
    ? { highlighted: true, currentWindow: true }
    : { active: true, currentWindow: true };
  const tabs = await chrome.tabs.query(query);
  return tabs
    .filter((t) => t.url && /^https?:/i.test(t.url))
    .map((t) => ({ url: t.url, title: t.title || t.url }));
}
