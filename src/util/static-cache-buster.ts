/**
 * Cache-buster for static web assets.
 *
 * The browser's no-cache headers we set are not enough when ES module
 * imports chain across files. Chat → chat.js → file-attachments.js: only
 * the entry-point JS has a `?v=N` in the HTML; the inner imports resolve
 * by relative URL with no version, so a stubborn proxy/disk cache can
 * still serve the old file even after a deploy.
 *
 * Fix is two-sided:
 *   - HTML: stamp every  src="/js/x.js?v=N" / href="/css/x.css?v=N"
 *     attribute with the current BUILD_ID, replacing or appending.
 *   - JS:   rewrite relative ES-import URLs the same way, so chained
 *     imports also carry the version.
 *
 * BUILD_ID is the git short SHA when available, falling back to the
 * server-start epoch. Either way it changes on every deploy, so any
 * client whose previous cache is stale will refetch the whole module
 * graph on the next page load.
 */

import { execFileSync } from "child_process";

function computeBuildId(): string {
  // Allow explicit override (CI, container builds without git, manual deploy).
  if (process.env.AIWORK_BUILD_ID && process.env.AIWORK_BUILD_ID.trim().length > 0) {
    return process.env.AIWORK_BUILD_ID.trim();
  }
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
    if (sha) {
      // Add the seconds-since-epoch of server start so the cache buster
      // refreshes on every restart even when the SHA hasn't moved. Without
      // this, in-development edits to web/js/* would silently serve stale
      // bytes after a tsx restart.
      return `${sha}.${Math.floor(Date.now() / 1000)}`;
    }
  } catch {
    // git not installed / not a repo — fall through.
  }
  return `t${Date.now()}`;
}

export const BUILD_ID = computeBuildId();

const HTML_VERSION_RE = /(src|href)\s*=\s*"(\/[^"?]+?\.(?:js|css|mjs|cjs))(\?[^"]*)?"/gi;

/**
 * Stamp every <script src=...> / <link href=...> / inline url(...) we
 * recognize with the current BUILD_ID. Idempotent — re-applying replaces
 * any prior version.
 */
export function rewriteHtml(html: string): string {
  return html.replace(HTML_VERSION_RE, (_match, attr, path) => {
    return `${attr}="${path}?v=${BUILD_ID}"`;
  });
}

// ── JS import rewriting ──────────────────────────────────────────────────
//
// Cover both `import x from "./y.js"` and dynamic `import("./y.js")` plus
// `export ... from "./y.js"`. Only relative URLs starting with ./ or ../
// get the version — node_modules / package specifiers are left alone.

const JS_IMPORT_RE =
  /\b(import\s+(?:(?:[\w$*{}\s,]+?)\s+from\s*)?|export\s+(?:[\w$*{}\s,]+?)\s+from\s*|import\s*\(\s*)(['"`])(\.{1,2}\/[^'"`?]+?\.m?js)(\?[^'"`]*)?\2/g;

export function rewriteJs(code: string): string {
  return code.replace(JS_IMPORT_RE, (_m, lead, quote, path) => {
    return `${lead}${quote}${path}?v=${BUILD_ID}${quote}`;
  });
}
