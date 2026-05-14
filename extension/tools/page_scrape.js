// ewtos.com

export async function runPageScrape(params) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Kein aktiver Tab gefunden");

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: scrapePageContent,
  });

  if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);

  const result = results?.[0]?.result;
  if (!result) throw new Error("Kein Ergebnis vom injizierten Script");
  if (result.error) throw new Error(result.error);

  return result;
}

// Injected into the active tab. Self-contained — no closures from outer scope.
function scrapePageContent() {
  try {
    const JUNK = [
      "script", "style", "nav", "footer", "header", "noscript", "iframe",
      "#cookie-banner", ".cookie-consent", '[id*="cookie"]', '[class*="cookie"]',
      "dialog", "aside", ".sidebar", '[id*="banner"]', '[class*="banner"]',
    ].join(",");

    const root = document.querySelector("article") || document.body;
    const clone = root.cloneNode(true);

    clone.querySelectorAll(JUNK).forEach((el) => el.remove());

    clone.querySelectorAll("h1").forEach((el) => { el.textContent = `\n# ${el.textContent.trim()}\n`; });
    clone.querySelectorAll("h2").forEach((el) => { el.textContent = `\n## ${el.textContent.trim()}\n`; });
    clone.querySelectorAll("h3").forEach((el) => { el.textContent = `\n### ${el.textContent.trim()}\n`; });
    clone.querySelectorAll("h4, h5, h6").forEach((el) => { el.textContent = `\n#### ${el.textContent.trim()}\n`; });
    clone.querySelectorAll("li").forEach((el) => { el.textContent = `\n- ${el.textContent.trim()}`; });

    const markdown = (clone.innerText || "")
      .replace(/[\t\r]+/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/ {2,}/g, " ")
      .trim();

    const wordCount = markdown.split(/\s+/).filter(Boolean).length;

    return { markdown, url: document.URL, title: document.title, wordCount };
  } catch (err) {
    return { error: err.toString() };
  }
}
