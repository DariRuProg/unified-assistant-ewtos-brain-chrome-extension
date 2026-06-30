// ewtos.com

export async function runSeoCheck(_params = {}) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("Kein aktiver Tab gefunden");

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const qs = (sel) => document.querySelector(sel);
      const qsa = (sel) =>
        Array.from(document.querySelectorAll(sel))
          .map((el) => el.innerText.trim())
          .filter(Boolean);
      return {
        title: document.title,
        description: qs('meta[name="description"]')?.content || "",
        h1: qsa("h1"),
        h2: qsa("h2"),
        h3: qsa("h3"),
        headings: Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
          .map((el) => ({ level: Number(el.tagName[1]), text: el.innerText.trim() }))
          .filter((h) => h.text),
        canonical: qs('link[rel="canonical"]')?.href || "",
        og_title: qs('meta[property="og:title"]')?.content || "",
        og_description: qs('meta[property="og:description"]')?.content || "",
        og_image: qs('meta[property="og:image"]')?.content || "",
        twitter_card: qs('meta[name="twitter:card"]')?.content || "",
        viewport: qs('meta[name="viewport"]')?.content || "",
        favicon: qs('link[rel*="icon"]')?.href || "",
        robots: qs('meta[name="robots"]')?.content || "",
        url: window.location.href,
      };
    },
  });

  if (!result?.result) throw new Error("SEO-Daten konnten nicht gelesen werden");
  return result.result;
}
