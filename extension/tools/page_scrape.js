// ewtos.com

import { scrapePageContent } from "./scrape_dom.js";

export async function runPageScrape(params) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Kein aktiver Tab gefunden");

  // scrapePageContent is serialized by executeScript and runs in the page context.
  // It is self-contained, so the imported reference injects identically to an inline function.
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: scrapePageContent,
    args: [params?.mode || "content"],
  });

  if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);

  const result = results?.[0]?.result;
  if (!result) throw new Error("Kein Ergebnis vom injizierten Script");
  if (result.error) throw new Error(result.error);

  return result;
}
