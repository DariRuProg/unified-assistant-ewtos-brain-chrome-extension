// ewtos.com

export async function runScreenshot(_params = {}) {
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
  return {
    dataUrl,
    format: "png",
    timestamp: new Date().toISOString(),
  };
}
