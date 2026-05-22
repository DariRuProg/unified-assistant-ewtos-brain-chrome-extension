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

    // --- Root selection ---
    const root = isFull
      ? document.body
      : (document.querySelector("article, main, [role='main'], .entry-content, .post-content, .article-body, .article-content, #content, #main-content")
         || document.body);

    const clone = root.cloneNode(true);

    // Always strip
    clone.querySelectorAll("script, style, noscript, iframe, svg, canvas").forEach(el => el.remove());

    // Content-mode: strip chrome (navigation, header, footer, sidebars, overlays)
    if (!isFull) {
      clone.querySelectorAll("nav, footer, header, aside, dialog").forEach(el => el.remove());
      clone.querySelectorAll(
        '[class*="cookie"],[id*="cookie"],[class*="banner"],[id*="banner"],' +
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
