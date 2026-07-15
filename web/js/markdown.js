import { escapeAttr } from "./utils.js";
import DOMPurify from "./vendor/purify.js";

const ALLOWED_URL_SCHEME = /^(https?:|mailto:|tel:)/i;
const SCHEME_PATTERN = /^[a-z][a-zA-Z0-9+.-]*:/i;

// Tags that renderMarkdown legitimately produces. DOMPurify is the
// authoritative gate — anything not in this set is stripped from the
// post-render HTML, which closes the entire class of mutation-XSS /
// entity-encoding-bypass / SVG-injection vectors that regex sanitization
// can't reliably prevent.
const ALLOWED_TAGS = [
  "h1", "h2", "h3", "p", "a", "strong", "em", "code", "pre",
  "ul", "ol", "li", "blockquote", "hr",
  "table", "thead", "tbody", "tr", "th", "td",
  "div", "span",
];
const ALLOWED_ATTR = ["href", "target", "rel", "class"];
// Primary URI filter. sanitizeUrl still runs first as a secondary check,
// but DOMPurify's regex is authoritative. Allows http(s)/mailto/tel
// schemes plus relative URLs (#anchor, /root, ./, ../). Blocks
// javascript:, data:, vbscript:, etc.
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto|tel):|#|\.?\.?\/)/i;

export function sanitizeRenderedHtml(html) {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
    ALLOW_DATA_ATTR: false,
  });
}

// Decodes one layer of HTML entities (named + numeric decimal + numeric
// hex). Used in a loop by sanitizeUrl so multiply-encoded scheme bypasses
// (e.g. "java&amp;#115;cript:" -> "java&#115;cript:" -> "javascript:")
// resolve to their real value before the scheme is checked.
function decodeEntitiesOnce(str) {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'");
}

// Validates a link target against an allowlist of schemes, defeating
// javascript:/data:/vbscript: XSS vectors regardless of how the scheme is
// obfuscated (control characters, whitespace, or HTML-entity encoding).
// Relative and anchor URLs (no scheme) pass through untouched. The result
// is HTML-attribute-escaped and safe to embed directly in href="...".
export function sanitizeUrl(url) {
  if (url === undefined || url === null) return "#";
  let decoded = String(url);
  for (let i = 0; i < 5; i++) {
    const next = decodeEntitiesOnce(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  // Strip ASCII control/whitespace chars anywhere in the string — browsers
  // ignore these when resolving a URL scheme, so "java\tscript:alert(1)"
  // would otherwise slip past a naive scheme check.
  const stripped = decoded.replace(/[\x00-\x20\x7f]+/g, "");

  const hasScheme = SCHEME_PATTERN.test(stripped);
  if (hasScheme && !ALLOWED_URL_SCHEME.test(stripped)) {
    return "#";
  }
  return escapeAttr(stripped);
}

export function renderMarkdown(text) {
  // Escape all raw input up front. Every transform below only ever adds
  // well-formed tags around already-escaped text — attacker-controlled
  // content can never introduce a real `<` or `>`, which structurally
  // defeats SVG injection, entity double-decode tricks, and mutation XSS
  // without needing a DOM-based sanitizer (unavailable in this project's
  // Node-only test environment).
  let html = escapeAttr(text);

  // Mermaid diagrams — render as a diagram container instead of a code block.
  // Only process complete blocks (closing ``` present) to avoid mangling mid-stream content.
  html = html.replace(/```mermaid\n([\s\S]*?)```/g, (_, diagram) => {
    return `<div class="mermaid-diagram"><div class="mermaid">${diagram.trim()}</div></div>`;
  });

  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) => {
    return `<pre><code>${code}</code></pre>`;
  });

  html = html.replace(/`([^`]+)`/g, (_, code) => {
    return `<code>${code}</code>`;
  });

  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");

  html = html.replace(/^---$/gm, "<hr>");

  // `>` was escaped to `&gt;` by the up-front escape pass, so blockquote
  // detection matches the escaped form.
  html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");
  html = html.replace(/<\/blockquote>\n<blockquote>/g, "\n");

  html = html.replace(
    /^\[(.+?)\]\((.+?)\)\s*$/gm,
    (_, label, url) => `<a href="${sanitizeUrl(url)}" target="_blank" rel="noopener">${label}</a>`,
  );
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, label, url) => `<a href="${sanitizeUrl(url)}" target="_blank" rel="noopener">${label}</a>`,
  );

  html = html.replace(
    /^(\|.+\|)\n(\|[\s\-:|]+\|)\n((?:\|.+\|\n?)+)/gm,
    (_, headerRow, _sep, bodyRows) => {
      const headers = headerRow
        .split("|")
        .filter((c) => c.trim() !== "")
        .map((c) => `<th>${c.trim()}</th>`)
        .join("");
      const rows = bodyRows
        .trim()
        .split("\n")
        .map((row) => {
          const cells = row
            .split("|")
            .filter((c) => c.trim() !== "")
            .map((c) => `<td>${c.trim()}</td>`)
            .join("");
          return `<tr>${cells}</tr>`;
        })
        .join("\n");
      return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
    },
  );

  const lines = html.split("\n");
  const result = [];
  let inList = false;
  let listType = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);

    if (ulMatch) {
      if (!inList || listType !== "ul") {
        if (inList) result.push(listType === "ul" ? "</ul>" : "</ol>");
        result.push("<ul>");
        inList = true;
        listType = "ul";
      }
      result.push(`<li>${ulMatch[2]}</li>`);
    } else if (olMatch) {
      if (!inList || listType !== "ol") {
        if (inList) result.push(listType === "ul" ? "</ul>" : "</ol>");
        result.push("<ol>");
        inList = true;
        listType = "ol";
      }
      result.push(`<li>${olMatch[3]}</li>`);
    } else {
      if (inList) {
        result.push(listType === "ul" ? "</ul>" : "</ol>");
        inList = false;
        listType = null;
      }

      if (
        line.startsWith("<h") ||
        line.startsWith("<pre") ||
        line.startsWith("<blockquote") ||
        line.startsWith("<hr") ||
        line.startsWith("<a ") ||
        line.trim() === ""
      ) {
        result.push(line);
      } else {
        result.push(`<p>${line}</p>`);
      }
    }
  }

  if (inList) {
    result.push(listType === "ul" ? "</ul>" : "</ol>");
  }

  html = result.join("\n");

  html = html.replace(/<p>\s*<\/p>/g, "");
  html = html.replace(/<p>(<h[1-4]>)/g, "$1");
  html = html.replace(/(<\/h[1-4]>)<\/p>/g, "$1");
  html = html.replace(/<p>(<hr>)<\/p>/g, "$1");
  html = html.replace(/<p>(<pre>)/g, "$1");
  html = html.replace(/(<\/pre>)<\/p>/g, "$1");
  html = html.replace(/<p>(<ul>)/g, "$1");
  html = html.replace(/(<\/ul>)<\/p>/g, "$1");
  html = html.replace(/<p>(<ol>)/g, "$1");
  html = html.replace(/(<\/ol>)<\/p>/g, "$1");
  html = html.replace(/<p>(<blockquote>)/g, "$1");
  html = html.replace(/(<\/blockquote>)<\/p>/g, "$1");

  // Defense in depth: parse the rendered HTML through DOMPurify before
  // returning. The up-front escapeAttr pass + sanitizeUrl already block
  // the known XSS vectors, but DOMPurify walks a real DOM tree and strips
  // anything outside the allowlist, so any future regex transform that
  // accidentally introduces an unexpected tag or attribute is neutralized
  // here rather than reaching innerHTML.
  return sanitizeRenderedHtml(html);
}
