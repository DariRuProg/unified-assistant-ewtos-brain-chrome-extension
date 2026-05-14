// ewtos.com

export async function runColorPicker(_params = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Kein aktiver Tab gefunden");

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      // --- Quelle 1: CSS Custom Properties aus :root ---
      const cssVars = {};
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.selectorText === ":root") {
              const style = rule.style;
              for (let i = 0; i < style.length; i++) {
                const prop = style[i];
                if (
                  prop.startsWith("--") &&
                  (prop.includes("color") ||
                    prop.includes("bg") ||
                    prop.includes("background") ||
                    prop.includes("primary") ||
                    prop.includes("secondary") ||
                    prop.includes("accent"))
                ) {
                  cssVars[prop] = style.getPropertyValue(prop).trim();
                }
              }
            }
          }
        } catch (e) {} // Cross-origin stylesheets ignorieren
      }

      // --- Quelle 2: Computed Styles von Key-Elementen ---
      const selectors = [
        "body", "main", "header", "nav", "footer",
        "h1", "h2", "a", "button",
        "[class*='btn']", "[class*='primary']",
      ];
      const seenColors = new Set();
      const computed = [];

      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (!el) continue;
        const style = getComputedStyle(el);
        const color = style.color;
        const background = style.backgroundColor;

        const isTransparent = (v) => v === "rgba(0, 0, 0, 0)" || v === "transparent";
        const key = `${selector}|${color}|${background}`;

        if (seenColors.has(key)) continue;
        if (isTransparent(color) && isTransparent(background)) continue;
        if (seenColors.size >= 20) break;

        seenColors.add(key);
        computed.push({
          selector,
          color: isTransparent(color) ? null : color,
          background: isTransparent(background) ? null : background,
        });
      }

      return {
        css_vars: cssVars,
        computed,
        has_design_system: Object.keys(cssVars).length > 0,
      };
    },
  });

  if (!result?.result) throw new Error("Konnte Farben nicht extrahieren");
  return result.result;
}
