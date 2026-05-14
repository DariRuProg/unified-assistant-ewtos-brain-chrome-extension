// ewtos.com

export async function runImageAnalyse() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Kein aktiver Tab");

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      return Array.from(document.querySelectorAll("img"))
        .filter(img => img.width > 30 && img.height > 30 && img.src && !img.src.startsWith("data:"))
        .map(img => ({
          src: img.currentSrc || img.src,
          alt: img.getAttribute("alt") ?? null,
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
          loading: img.loading,
        }))
        .slice(0, 50);
    },
  });

  if (!result?.result) throw new Error("Konnte Bilder nicht lesen");

  const images = result.result;
  const missing_alt = images.filter(img => img.alt === null).length;
  return { images, total: images.length, missing_alt };
}
