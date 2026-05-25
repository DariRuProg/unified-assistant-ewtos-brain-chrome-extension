// ewtos.com

export async function runPageScrape(params) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Kein aktiver Tab gefunden");

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

// Injected into the active tab. Self-contained — no closures, no imports.
function scrapePageContent(mode) {
  try {
    const isFull = mode === "full";

    // --- Root selection (content mode only) ---
    // Text-density heuristic: find the deepest DOM node that still contains
    // ≥30% of total body text and isn't a known chrome element.
    // Inspired by Readability.js — no fixed selector list needed.
    function findContentRoot() {
      const body = document.body;
      const totalLen = body.textContent.trim().length;
      if (totalLen < 150) return body;

      const SKIP_TAGS = new Set(["script","style","noscript","nav","header","footer","aside","dialog","form"]);
      // matches class/id tokens that indicate non-content chrome
      const SKIP_RE = /\b(nav(igation)?|header|masthead|footer|sidebar|side[_-]?bar|menu(bar)?|ad(vert(isement)?)?|cookie|popup|modal|overlay|social|share|comment|widget|promo|sponsor|related|recommend|breadcrumb|pagination|pager|search-?form|tag-?cloud)\b/i;

      function isSkipped(el) {
        if (SKIP_TAGS.has(el.tagName.toLowerCase())) return true;
        const token = (el.className || "") + " " + (el.id || "");
        return SKIP_RE.test(token);
      }

      // DFS: return the deepest qualifying element (≥30% of body text, not skipped).
      // When multiple children qualify, pick the one with the most text.
      const threshold = Math.max(150, totalLen * 0.30);

      function deepest(el) {
        if (isSkipped(el)) return null;
        if (el.textContent.trim().length < threshold) return null;

        let best = null;
        let bestLen = 0;
        for (const child of el.children) {
          const found = deepest(child);
          if (found) {
            const fLen = found.textContent.trim().length;
            if (fLen > bestLen) { bestLen = fLen; best = found; }
          }
        }
        return best || el;
      }

      const result = deepest(body);
      // Only use result if it's more specific than body itself
      return (result && result !== body) ? result : body;
    }

    const root = isFull ? document.body : findContentRoot();
    const clone = root.cloneNode(true);

    // Always strip
    clone.querySelectorAll("script, style, noscript, iframe, svg, canvas").forEach(el => el.remove());

    // Content-mode: strip remaining chrome that wasn't caught by root selection
    if (!isFull) {
      clone.querySelectorAll("nav, footer, header, aside, dialog").forEach(el => el.remove());
      clone.querySelectorAll(
        '[class*="cookie"],[id*="cookie"],' +
        '[class*="popup"],[id*="popup"],[class*="modal"],[id*="modal"],' +
        '[class*="sidebar"],[id*="sidebar"],[class*="newsletter"],[class*="subscribe"],' +
        '[class*="overlay"],[id*="overlay"],[aria-hidden="true"]'
      ).forEach(el => el.remove());
    }

    // --- DOM → Markdown ---
    const BLOCK_TAGS = new Set([
      "div","section","article","main","aside","header","footer",
      "nav","figure","figcaption","details","summary",
    ]);

    function nodeToMd(node, ctx) {
      if (node.nodeType === 3) { // TEXT_NODE
        const t = node.textContent.replace(/[\r\n\t]+/g, " ").replace(/  +/g, " ");
        return t === " " && !ctx.inBlock ? "" : t;
      }
      if (node.nodeType !== 1) return ""; // ELEMENT_NODE only

      const tag = node.tagName.toLowerCase();
      if (["script","style","noscript","iframe","svg","canvas","button","input","select","textarea","form"].includes(tag)) return "";

      const children = (c = ctx) => Array.from(node.childNodes).map(n => nodeToMd(n, c)).join("");

      // Headings
      const hm = tag.match(/^h([1-6])$/);
      if (hm) {
        const prefix = "#".repeat(parseInt(hm[1]));
        const text = node.textContent.trim();
        return text ? `\n\n${prefix} ${text}\n\n` : "";
      }

      // Paragraph
      if (tag === "p") {
        const inner = children({ inBlock: true }).trim();
        return inner ? `\n\n${inner}\n\n` : "";
      }

      // Line breaks
      if (tag === "br") return "\n";
      if (tag === "hr") return "\n\n---\n\n";

      // Links
      if (tag === "a") {
        const href = node.getAttribute("href") || "";
        const text = node.textContent.trim();
        if (!text) return children();
        if (!href || href.startsWith("#") || href.startsWith("javascript")) return text;
        try {
          const abs = href.startsWith("http") ? href : new URL(href, document.baseURI).href;
          return `[${text}](${abs})`;
        } catch {
          return text;
        }
      }

      // Inline formatting
      if (tag === "strong" || tag === "b") {
        const inner = children().trim();
        return inner ? `**${inner}**` : "";
      }
      if (tag === "em" || tag === "i") {
        const inner = children().trim();
        return inner ? `*${inner}*` : "";
      }

      // Inline code
      if (tag === "code" && node.parentElement?.tagName.toLowerCase() !== "pre") {
        return `\`${node.textContent}\``;
      }

      // Code blocks
      if (tag === "pre") {
        const codeEl = node.querySelector("code");
        const lang = codeEl?.className?.match(/language-(\w+)/)?.[1] || "";
        const content = (codeEl || node).textContent.trimEnd();
        return `\n\n\`\`\`${lang}\n${content}\n\`\`\`\n\n`;
      }

      // Blockquote
      if (tag === "blockquote") {
        const inner = children({ inBlock: true }).trim();
        return inner ? "\n\n" + inner.split("\n").map(l => `> ${l}`).join("\n") + "\n\n" : "";
      }

      // Lists
      if (tag === "ul" || tag === "ol") {
        return "\n" + children({ inList: true, ordered: tag === "ol", index: 1 }) + "\n";
      }
      if (tag === "li") {
        const marker = ctx.ordered ? `${ctx.index++}. ` : "- ";
        const inner = children({ inBlock: true }).trim();
        return inner ? `${marker}${inner}\n` : "";
      }

      // Tables
      if (tag === "table") {
        const rows = Array.from(node.querySelectorAll("tr"));
        if (!rows.length) return "";
        const lines = rows.map((row, i) => {
          const cells = Array.from(row.querySelectorAll("td,th"))
            .map(c => c.textContent.trim().replace(/\|/g, "\\|"));
          const line = `| ${cells.join(" | ")} |`;
          return i === 0 ? line + "\n|" + cells.map(() => "---|").join("") : line;
        });
        return `\n\n${lines.join("\n")}\n\n`;
      }

      // Images (show alt text)
      if (tag === "img") {
        const alt = node.getAttribute("alt")?.trim();
        return alt ? `![${alt}]` : "";
      }

      // Block containers: wrap with newlines
      if (BLOCK_TAGS.has(tag)) {
        const inner = children({ inBlock: true });
        return inner.trim() ? `\n${inner}\n` : "";
      }

      return children();
    }

    const raw = nodeToMd(clone, { inBlock: false });
    const markdown = raw
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/ {2,}/g, " ")
      .trim();

    return {
      markdown,
      url: document.URL,
      title: document.title,
      wordCount: markdown.split(/\s+/).filter(Boolean).length,
      mode,
    };
  } catch (err) {
    return { error: err.toString() };
  }
}
