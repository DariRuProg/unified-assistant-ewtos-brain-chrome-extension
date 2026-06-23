// Markdown rendering and diff utilities. ewtos.com
import { el } from './dom.js';

export function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildNestedList(lines, ordered) {
  const items = lines.map((l) => {
    const m = ordered
      ? l.match(/^(\s*)\d+\.\s+(.+)$/)
      : l.match(/^(\s*)[-*]\s+(\[[ xX]\]\s+)?(.+)$/);
    if (!m) return null;
    const indent = m[1].length;
    const text = ordered ? m[2] : (m[3] || m[2]);
    return { indent, text };
  }).filter(Boolean);
  if (!items.length) return "";
  function buildGroup(group) {
    let html = "";
    let i = 0;
    while (i < group.length) {
      const item = group[i];
      const children = [];
      let j = i + 1;
      while (j < group.length && group[j].indent > item.indent) {
        children.push(group[j]);
        j++;
      }
      const childHtml = children.length ? buildGroup(children) : "";
      const tag = ordered ? "ol" : "ul";
      html += `<li>${inlineMd(item.text)}${childHtml ? `<${tag}>${childHtml}</${tag}>` : ""}</li>`;
      i = j;
    }
    return html;
  }
  const tag = ordered ? "ol" : "ul";
  return `<${tag}>${buildGroup(items)}</${tag}>`;
}

export function renderMarkdown(text) {
  // Strip YAML frontmatter and render as a collapsible key-value table.
  let fmHtml = "";
  text = text.replace(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/, (_, yaml) => {
    const rows = yaml.trim().split("\n").map((line) => {
      const m = line.match(/^([\w][\w-]*):\s*(.*)/);
      if (!m) return "";
      return `<tr><th>${escapeHtml(m[1])}</th><td>${escapeHtml(m[2].trim())}</td></tr>`;
    }).filter(Boolean);
    if (rows.length) {
      fmHtml = `<details class="fm-block" open><summary class="fm-toggle">Metadaten</summary><table class="fm-table"><tbody>${rows.join("")}</tbody></table></details>`;
    }
    return "";
  });

  // Preserve fenced code blocks before any other processing.
  const codeBlocks = [];
  let src = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = codeBlocks.length;
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    codeBlocks.push(`<pre><code${langAttr}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return `\x00CODEBLOCK${i}\x00`;
  });

  const blocks = src.split(/\n{2,}/);
  const html = blocks.map((block) => {
    const trimmed = block.trim();
    if (/^\x00CODEBLOCK\d+\x00$/.test(trimmed)) return trimmed;

    const lines = block.split("\n").filter((l) => l !== "");
    if (!lines.length) return "";

    // Heading
    const h = lines[0].match(/^(#{1,6})\s*(.+)$/);
    if (h) {
      const level = h[1].length;
      const headingHtml = `<h${level}>${inlineMd(h[2])}</h${level}>`;
      if (lines.length === 1) return headingHtml;
      return headingHtml + "<p>" + inlineMd(lines.slice(1).join(" ")) + "</p>";
    }

    // Horizontal rule
    if (lines.length === 1 && /^[-*_]{3,}$/.test(lines[0].trim())) {
      return "<hr>";
    }

    // Table: first line has |, second line is the separator (|---|)
    if (lines.length >= 2 && lines[0].includes("|") && /^\|[\s\-:|]+\|/.test(lines[1])) {
      const parseRow = (l) => l.split("|").slice(1, -1).map((c) => c.trim());
      const headers = parseRow(lines[0]).map((c) => `<th>${inlineMd(c)}</th>`).join("");
      const rows = lines.slice(2)
        .filter((l) => l.includes("|"))
        .map((l) => parseRow(l).map((c) => `<td>${inlineMd(c)}</td>`).join(""))
        .map((cells) => `<tr>${cells}</tr>`)
        .join("");
      return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
    }

    // Blockquote
    if (lines.every((l) => /^>\s?/.test(l))) {
      const inner = lines.map((l) => l.replace(/^>\s?/, "")).join("\n");
      return `<blockquote>${renderMarkdown(inner)}</blockquote>`;
    }

    // Ordered list (supports nesting via indentation)
    if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
      return buildNestedList(lines, true);
    }

    // Unordered list (supports nesting via indentation)
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      return buildNestedList(lines, false);
    }

    // Paragraph (single newlines → <br>)
    return `<p>${lines.map(inlineMd).join("<br>")}</p>`;
  }).join("");

  return fmHtml + html.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);
}

export function inlineMd(s) {
  s = escapeHtml(s);
  // Inline code first — protect content from other replacements
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    const i = codes.length;
    codes.push(`<code>${c}</code>`);
    return `\x01CODE${i}\x01`;
  });
  // Bold+italic, bold, italic, strikethrough
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  // Bilder ZUERST (vor Wikilinks/Links): externe URL, lokaler Pfad, Obsidian-Embed
  s = s.replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, '<img class="md-image" src="$2" alt="$1" loading="lazy">');
  s = s.replace(/!\[\[([^\]]+?)\]\]/g, (_m, p) => {
    const rel = p.trim().replace(/"/g, "&quot;");
    return `<img class="md-image" data-vault-src="${rel}" alt="${rel}" loading="lazy">`;
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, rel) => {
    const r = rel.trim().replace(/"/g, "&quot;");
    return `<img class="md-image" data-vault-src="${r}" alt="${alt}" loading="lazy">`;
  });
  // Obsidian wikilinks [[path|alias]] / [[path#heading]] / [[path]] → öffnen Datei im Vault-Explorer
  s = s.replace(/\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_match, path, alias) => {
    const display = (alias || path).trim();
    const rel = path.trim().replace(/"/g, "&quot;");
    return `<a href="#" class="wiki-link" data-rel="${rel}">${display}</a>`;
  });
  // Relative .md links → Vault-Explorer (gleicher Handler wie wikilinks)
  s = s.replace(/\[([^\]]+)\]\((?!https?:\/\/)([^)#\s]+\.md)(?:#[^)]*)?\)/g, (_m, text, path) => {
    const rel = path.replace(/"/g, "&quot;");
    return `<a href="#" class="wiki-link" data-rel="${rel}">${text}</a>`;
  });
  // Links [text](url) — https
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" class="ext-link" rel="noopener noreferrer">$1</a>');
  // Auto-link bare URLs
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)(?=[\s.,)!?]|$)/g, '$1<a href="$2" class="ext-link" rel="noopener noreferrer">$2</a>');
  // Restore code spans
  s = s.replace(/\x01CODE(\d+)\x01/g, (_, i) => codes[Number(i)]);
  return s;
}

export function obsidianUri(vaultName, relPath) {
  // obsidian://open?vault=...&file=...   (URL-encode + drop .md if present)
  const file = relPath.replace(/\.md$/i, "");
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file)}`;
}

export function openInObsidian(vaultName, relPath) {
  // Custom-Protocol-Handler brauchen User-Gesture + Chrome-API. Ein normaler
  // <a href="obsidian://..."> wird vom Sidepanel-Context blockiert, deshalb
  // gehen wir den Weg über chrome.tabs.create — die Extension hat dafür die
  // Permission und Chrome lässt den Protocol-Handler greifen.
  const uri = obsidianUri(vaultName, relPath);
  if (chrome.tabs && chrome.tabs.create) {
    chrome.tabs.create({ url: uri, active: true });
  } else {
    window.open(uri, "_blank");
  }
}

export function renderLineDiff(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const frag = document.createDocumentFragment();
  const addLine = (cls, prefix, text) =>
    frag.append(el("div", { className: "vh-diff-line " + cls, textContent: prefix + text }));
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { addLine("ctx", "  ", A[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { addLine("del", "- ", A[i]); i++; }
    else { addLine("add", "+ ", B[j]); j++; }
  }
  while (i < n) { addLine("del", "- ", A[i]); i++; }
  while (j < m) { addLine("add", "+ ", B[j]); j++; }
  return frag;
}
