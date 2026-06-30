// ewtos.com
//
// Shared DOM→Markdown converter. Runs in a page context — used both by the
// extension (chrome.scripting.executeScript) and the server-side Playwright
// scraper (page.evaluate). Must stay self-contained: no closures, no imports,
// no module-scope references inside the function body.
//
// skipInteractions=true: skip in-page FAQ collection (the Playwright scraper
// expands and captures accordions natively and owns the FAQ block itself).

export async function scrapePageContent(mode, skipInteractions = false) {
  // Scroll-Position des Nutzers merken, um sie nach dem Lazy-Load-Scroll wiederherzustellen.
  const _scrollX = window.scrollX || 0;
  const _scrollY = window.scrollY || 0;
  try {
    const isFull = mode === "full";

    // Scroll to trigger lazy loading. behavior:"instant" überschreibt ein evtl.
    // gesetztes CSS scroll-behavior:smooth, das sonst das Zurückscrollen sichtbar animiert.
    window.scrollTo({ top: document.body.scrollHeight, left: 0, behavior: "instant" });
    await new Promise(r => setTimeout(r, 600));

    // --- Root selection (content mode only) ---
    // Text-density heuristic: find the deepest DOM node that still contains
    // ≥30% of total body text and isn't a known chrome element.
    // Guard: don't drill into a single child if doing so would leave ≥30% of
    // the current element's text behind — that means sibling sections with real
    // content exist and we must stay at the parent level.
    function findContentRoot() {
      const body = document.body;
      const totalLen = body.textContent.trim().length;
      if (totalLen < 150) return body;

      const SKIP_TAGS = new Set(["script","style","noscript","nav","header","footer","aside","dialog","form"]);
      const SKIP_RE = /\b(nav(igation)?|header|masthead|footer|sidebar|side[_-]?bar|menu(bar)?|ad(vert(isement)?)?|cookie|popup|modal|overlay|social|share|comment|widget|promo|sponsor|related|recommend|breadcrumb|pagination|pager|search-?form|tag-?cloud)\b/i;

      function isSkipped(el) {
        if (SKIP_TAGS.has(el.tagName.toLowerCase())) return true;
        const token = (el.className || "") + " " + (el.id || "");
        return SKIP_RE.test(token);
      }

      const threshold = Math.max(150, totalLen * 0.30);

      function deepest(el) {
        if (isSkipped(el)) return null;
        const elLen = el.textContent.trim().length;
        if (elLen < threshold) return null;

        let best = null;
        let bestLen = 0;
        for (const child of el.children) {
          const found = deepest(child);
          if (found) {
            const fLen = found.textContent.trim().length;
            if (fLen > bestLen) { bestLen = fLen; best = found; }
          }
        }

        // If drilling into the best child would leave ≥30% of this element's
        // text in other siblings, stay here to capture all sections (e.g. FAQ + article).
        if (best && bestLen / elLen < 0.70) return el;
        return best || el;
      }

      const result = deepest(body);
      return (result && result !== body) ? result : body;
    }

    const root = isFull ? document.body : findContentRoot();

    // Collect FAQ Q&A without clicking (no popup/exclusive-accordion side-effects).
    // Works for CSS-only accordions (Radix, Headless UI, custom) where panel content is
    // always in the DOM — just hidden via CSS. textContent reads it regardless of visibility.
    // Skipped when the caller (Playwright scraper) handles accordions natively.
    const hasFaq = !skipInteractions &&
      /faq|frequently.asked|häufig/i.test(document.body.textContent.slice(0, 20000));
    const faqItems = [];
    if (hasFaq) {
      // Find the panel element associated with a trigger button.
      function findPanel(btn) {
        const id = btn.getAttribute('aria-controls');
        if (id) return document.getElementById(id);
        // next sibling of button itself
        const ns = btn.nextElementSibling;
        if (ns?.textContent.trim()) return ns;
        // next sibling of button's parent (e.g. button inside <h3>/<dt>)
        const ps = btn.parentElement?.nextElementSibling;
        if (ps?.textContent.trim()) return ps;
        return null;
      }

      const NON_FAQ = /\b(menu|nav|dropdown|search|cart|login|close|share|social|hamburger|submit|cookie)\b/i;
      const CONSENT_CONT = '[id*=cookie],[class*=cookie],[id*=consent],[class*=consent],' +
        '[id*=onetrust],[id*=usercentrics],[id*=cookiebot],[id*=cmp],' +
        '[aria-modal],[role=dialog],dialog,footer,nav,header';
      const triggers = [...document.querySelectorAll('button[aria-expanded], button[class*="faq"], button[class*="accordion"]')]
        .filter(btn =>
          !NON_FAQ.test((btn.className || "") + " " + (btn.id || "")) &&
          !btn.getAttribute('aria-haspopup') &&
          !btn.closest?.(CONSENT_CONT)
        );

      // CSS-only accordions: panel always in DOM, no click needed
      for (const btn of triggers) {
        const question = btn.textContent.trim();
        if (!question) continue;
        const panel = findPanel(btn);
        const answer = panel?.textContent.trim();
        if (answer) faqItems.push({ question, answer });
      }

      // Lazy-only: click panels where content is not yet in DOM (exclusive/React accordions).
      // Re-query findPanel AFTER click — Radix unmounts the panel element when closed, so
      // getElementById returns null before click and the real element only after React mounts it.
      for (const btn of triggers) {
        const question = btn.textContent.trim();
        if (!question || faqItems.some(i => i.question === question)) continue;
        // If panel already has content it was handled by the CSS-only loop above
        const panelBefore = findPanel(btn);
        if (panelBefore?.textContent.trim()) continue;
        try {
          btn.click();
          await new Promise(r => setTimeout(r, 400));
          const panelAfter = findPanel(btn); // re-query: element may now be mounted
          const answer = panelAfter?.textContent.trim() || "";
          if (answer && answer.length <= 4000) faqItems.push({ question, answer });
        } catch { continue; }
      }
    }

    const clone = root.cloneNode(true);

    // Expand native <details> accordions
    clone.querySelectorAll("details").forEach(d => d.setAttribute("open", ""));

    // Always strip
    clone.querySelectorAll("script, style, noscript, iframe, svg, canvas, template").forEach(el => el.remove());

    // Content-mode: strip remaining chrome that wasn't caught by root selection.
    // Note: [aria-hidden="true"] is intentionally NOT stripped — accordion panels use it
    // on collapsed content; stripping would remove FAQ answers.
    if (!isFull) {
      clone.querySelectorAll("nav, footer, header, aside, dialog, [role=dialog], [aria-modal]").forEach(el => el.remove());
      clone.querySelectorAll(
        '[class*="cookie"],[id*="cookie"],' +
        '[id*="onetrust"],[id*="usercentrics"],[id*="cookiebot"],[id*="cmp"],' +
        '[id*="consent"],[class*="consent"],' +
        '[class*="popup"],[id*="popup"],[class*="modal"],[id*="modal"],' +
        '[class*="sidebar"],[id*="sidebar"],[class*="newsletter"],[class*="subscribe"],' +
        '[class*="overlay"],[id*="overlay"],' +
        '[role=navigation],[role=banner],[role=complementary]'
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
      if (["script","style","noscript","iframe","svg","canvas","input","select","textarea","form"].includes(tag)) return "";

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
        if (!href || href.startsWith("#") || href.startsWith("javascript:")) return text;
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

      // Tables — :scope prevents nested tables from leaking their rows into the outer table
      if (tag === "table") {
        const rows = Array.from(node.querySelectorAll(":scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr, :scope > tr"));
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

      // Native accordion question
      if (tag === "summary") {
        const text = node.textContent.trim();
        return text ? `\n\n#### ${text}\n\n` : "";
      }

      // Button: accordion/FAQ triggers render as headings; pure UI buttons render as text
      // Reliable signals: aria-expanded (ARIA accordion pattern) or aria-controls (panel link).
      // Class-name check as fallback for custom components.
      if (tag === "button") {
        const text = node.textContent.trim();
        if (!text) return "";
        const CONSENT_SEL = '[id*=cookie],[class*=cookie],[id*=consent],[class*=consent],' +
          '[id*=onetrust],[id*=usercentrics],[id*=cookiebot],[id*=cmp],' +
          '[aria-modal],[role=dialog],dialog,footer,nav,header';
        if (node.closest?.(CONSENT_SEL)) return text;
        if (node.getAttribute('aria-haspopup')) return text;
        const hasAriaExpanded = node.hasAttribute("aria-expanded");
        const hasAriaControls = node.hasAttribute("aria-controls");
        const cls = (node.className || "") + " " + (node.id || "");
        const NON_FAQ_BTN = /\b(menu|nav|dropdown|search|cart|login|close|share|social|hamburger|submit|cookie)\b/i;
        if (NON_FAQ_BTN.test(cls)) return text;
        const isTrigger = hasAriaExpanded || hasAriaControls ||
          /\b(faq|accordion|toggle|expand|collaps|question|q)\b/i.test(cls);
        return isTrigger ? `\n\n#### ${text}\n\n` : text;
      }

      // Block containers: wrap with newlines
      if (BLOCK_TAGS.has(tag)) {
        const inner = children({ inBlock: true });
        return inner.trim() ? `\n${inner}\n` : "";
      }

      return children();
    }

    const raw = nodeToMd(clone, { inBlock: false });
    let markdown = raw
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/ {2,}/g, " ")
      .trim();

    // Append FAQ items collected from closed accordion panels.
    // Only include answers not already present in the normal scrape (dedup by first 60 chars).
    if (faqItems.length) {
      const seen = new Set([...markdown.matchAll(/\S.{0,59}/g)].map(m => m[0]));
      const fresh = faqItems.filter(({ answer }) => !seen.has(answer.slice(0, 60)));
      if (fresh.length) {
        const faqMd = fresh.map(({ question, answer }) => `#### ${question}\n\n${answer}`).join("\n\n");
        markdown += `\n\n## FAQ\n\n${faqMd}`;
      }
    }

    window.scrollTo({ top: _scrollY, left: _scrollX, behavior: "instant" }); // Nutzer-Scrollposition wiederherstellen
    return {
      markdown,
      url: document.URL,
      title: document.title,
      wordCount: markdown.split(/\s+/).filter(Boolean).length,
      mode,
    };
  } catch (err) {
    try { window.scrollTo({ top: _scrollY, left: _scrollX, behavior: "instant" }); } catch (_) {}
    return { error: err.toString() };
  }
}
