// Selection-Capture: liest die aktuelle Text-Auswahl auf einem Tab + Page-Meta.
// Wird typischerweise vom Context-Menü aufgerufen (info.selectionText hat schon
// den Text, aber wir holen URL+Title sauber via scripting).

export async function runSelectionCapture({ tabId } = {}) {
  if (!tabId) throw new Error("tabId fehlt");
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      selection: window.getSelection ? window.getSelection().toString() : "",
      url: location.href,
      title: document.title || "",
    }),
  });
  if (!result?.result) throw new Error("Konnte keine Auswahl lesen");
  const { selection, url, title } = result.result;
  if (!selection || !selection.trim()) throw new Error("Keine Text-Auswahl auf der Seite");
  return { selection: selection.trim(), url, title };
}
