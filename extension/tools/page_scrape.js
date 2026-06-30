// ewtos.com

import { scrapePageContent } from "./scrape_dom.js";

// Browser-interne Seiten lassen kein executeScript zu — sauber abfangen statt 500.
const BLOCKED_SCHEMES = ["chrome:", "chrome-extension:", "edge:", "about:", "devtools:", "view-source:"];

export async function runPageScrape(params) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("ERR_NO_TAB");

  const url = tab.url || "";
  const scheme = (url.split("/", 1)[0] || "").toLowerCase();
  if (BLOCKED_SCHEMES.includes(scheme)) throw new Error("ERR_UNSUPPORTED_PAGE");

  // scrapePageContent is serialized by executeScript and runs in the page context.
  // It is self-contained, so the imported reference injects identically to an inline function.
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapePageContent,
      args: [params?.mode || "content"],
    });
  } catch (err) {
    // file:// scheitert ohne den manuell aktivierten Datei-URL-Zugriff.
    if (url.toLowerCase().startsWith("file:")) throw new Error("ERR_FILE_PERMISSION");
    throw new Error(err?.message || "ERR_UNSUPPORTED_PAGE");
  }

  if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);

  const result = results?.[0]?.result;
  if (!result) throw new Error("ERR_NO_RESULT");
  if (result.error) throw new Error(result.error);

  return result;
}
