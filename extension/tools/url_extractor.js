// EwtosBrain — URL Extractor | ewtos.com

export async function runUrlExtractor(params = {}) {
  const filterDomain = params.filter_domain !== false;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Kein aktiver Tab");

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (filterDomain) => {
      const base = document.baseURI;
      const currentHost = new URL(base).hostname;
      const seen = new Set();
      const urls = [];

      for (const a of document.querySelectorAll("a[href]")) {
        const raw = a.getAttribute("href") || "";
        if (!raw || /^(mailto:|tel:|javascript:)/i.test(raw)) continue;
        let absolute;
        try {
          absolute = new URL(raw, base).href;
        } catch {
          continue;
        }
        if (/^(mailto:|tel:|javascript:)/i.test(absolute)) continue;
        const url = new URL(absolute);
        if (url.hash && url.pathname === new URL(base).pathname && !url.search) continue;
        if (filterDomain && url.hostname !== currentHost) continue;
        const clean = absolute.split("#")[0];
        if (!seen.has(clean)) {
          seen.add(clean);
          urls.push(clean);
        }
      }

      urls.sort();
      return { urls, base_url: base };
    },
    args: [filterDomain],
  });

  if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
  const { urls, base_url } = result.result;
  return { urls, base_url, count: urls.length };
}
