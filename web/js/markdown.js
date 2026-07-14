import { escapeAttr } from "./utils.js";

const ALLOWED_URL_SCHEME = /^(https?:|mailto:|tel:)/i;
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

// Decodes one layer of HTML entities (named + numeric decimal + numeric
// hex).  Used in a loop by sanitizeUrl so multiple-encoded scheme bypasses
// (e.g. "java&#115;cript:" -> "javascript:") resolve to their real value
// before the scheme is checked.
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
// Relative and anchor URLs (no scheme) pass through untouched.  The result
// is HTML-attribute-escaped and safe to embed directly in href="...".
export function sanitizeUrl(url) {
  if (url === undefined || url === null) return "#";
  let decoded = String(url);
  for (let i = 0; i < 5; i++) {
    const next = decodeEntitiesOnce(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  // Strip ASCII control/whitespace characters anywhere in the string --
  // browsers ignore these when resolving a URL scheme, so
  // "java\tscript:alert(1)" would otherwise slip past a naive scheme check.
  const stripped = decoded.replace(/[\x00-\x20\x7f]+/g, "");

  const hasScheme = SCHEME_PATTERN.test(stripped);
  if (hasScheme && !ALLOWED_URL_SCHEME.test(stripped)) {
    return "#";
  }
  return escapeAttr(stripped);
}

// Allowed HTML tags after markdown rendering.  Anything not in this set is
// unwrapped (children kept, tag stripped) or, for script-like elements,
// removed entirely.
const ALLOWED_TAGS = new Set([
  "P", "H1", "H2", "H3", "STRONG", "EM", "A", "UL", "OL", "LI",
  "HR", "BLOCKQUOTE", "PRE", "CODE", "TABLE", "THEAD", "TBODY",
  "TR", "TH", "TD", "DIV",
]);

// Allowed HTML attributes.  Anything not in this set is stripped.
const ALLOWED_ATTRS = new Set(["href", "target", "rel", "class"]);

// Elements that must be removed entirely (including children) because they
// can execute code or load external resources.
const DANGEROUS_TAGS = new Set([
  "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH",
  "FORM", "INPUT", "BUTTON", "TEXTAREA", "SELECT", "OPTION",
  "LINK", "META", "BASE", "NOSCRIPT", "TEMPLATE",
]);

// DOM-based HTML sanitizer.  Parses the rendered HTML using the browser's
// built-in HTML parser (which correctly handles entity decoding, tag nesting,
// and malformed markup), then walks the DOM tree to strip dangerous elements
// and attributes.  This is a defense-in-depth second layer on top of the
// upfront escapeAttr() pass.
//
// In environments where DOMParser is unavailable (e.g. Node test runner),
// this is a no-op -- the upfront escaping remains as the sole defense,
// which is acceptable since there is no real XSS risk in tests.
function sanitizeHtml(html) {
  if (typeof DOMParser === "undefined") return html;

  const doc = new DOMParser().parseFromString(html, "text/html");

  function walk(node) {
    // Snapshot children since we mutate during iteration.
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === Node.COMMENT_NODE) {
        child.remove();
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      const tag = child.tagName;

      // Dangerous elements: remove entirely, do not recurse.
      if (DANGEROUS_TAGS.has(tag)) {
        child.remove();
        continue;
      }

      // Allowed elements: clean attributes, then recurse into children.
      if (ALLOWED_TAGS.has(tag)) {
        for (const attr of Array.from(child.attributes)) {
          const name = attr.name.toLowerCase();
          if (!ALLOWED_ATTRS.has(name)) {
            child.removeAttribute(attr.name);
          } else if (name === "href") {
            const safe = sanitizeUrl(child.getAttribute("href"));
            if (safe === "#") {
              child.removeAttribute("href");
            } else {
              child.setAttribute("href", safe);
            }
          }
        }
        walk(child);
        continue;
      }

      // Unknown (but not dangerous) elements: recurse into children first
      // so they get cleaned, then unwrap (replace with children).
      walk(child);
      const parent = child.parentNode;
      while (child.firstChild) {
        parent.insertBefore(child.firstChild, child);
      }
      parent.removeChild(child);
    }
  }

  walk(doc.body);
  return doc.body.innerHTML;
}

export function renderMarkdown(text) {
  // Escape all raw input up front.  Every transform below only ever adds
  // well-formed tags around already-escaped text -- attacker-controlled
  // content can never introduce a real `<` or `>` that could form a tag.
  let html = escapeAttr(text);

  // Mermaid diagrams -- render as a diagram container instead of a code block.
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

  html = html.replace(/\*\*(.+?)\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*(.+?)\*/g, "<strong>$1</strong>");
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
    /^(\|.+\|\n\|[\s\-:|]+\|\n((?:\|.+?\|\n?)+))/gm,
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
        line.startsWith("<table") ||
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
  html = html.replace(/<p>(<hr>)/g, "$1");
  html = html.replace(/<p>(<pre>)/g, "$1");
  html = html.replace(/(<\/pre>)<\/p>/g, "$1");
  html = html.replace(/<p>(<ul>)/g, "$1");
  html = html.replace(/(<\/ul>)<\/p>/g, "$1");
  html = html.replace(/<p>(<ol>)/g, "$1");
  html = html.replace(/(<\/ol>)<\/p>/g, "$1");
  html = html.replace(/<p>(<blockquote>)/g, "$1");
  html = html.replace(/(<\/blockquote>)<\/p>/g, "$1");

  // DOM-based sanitization pass.  The up-front escaping + regex conversion
  // above is the first layer of defense; this is the second.  The browser's
  // HTML parser correctly handles entity decoding, tag nesting, and malformed
  // markup, and the allowlist walk strips anything that slipped through.
  html = sanitizeHtml(html);

  return html;
}