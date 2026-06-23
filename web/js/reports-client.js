/**
 * Reports client — slash command + authenticated download interceptor.
 *
 * Two responsibilities:
 *
 * 1. handleReportSlashCommand(): when the user types `/report` (optionally
 *    with comma-separated formats and a template), POST /api/reports for the
 *    current session and render an assistant bubble with clickable download
 *    buttons.
 *
 * 2. installReportDownloadInterceptor(): downloads under /api/reports require
 *    the Authorization: Bearer <token> header. Plain anchor clicks won't send
 *    that header, so 401. This installs a global click listener that catches
 *    those links, fetches the file with auth, and triggers a browser download
 *    via blob URL. Works for both the slash-command UI and any /api/reports/...
 *    link the model emits in chat.
 */

import { API_BASE, currentSessionId } from "./state.js";
import { authHeaders } from "./auth.js";
import { addMessage, scrollChatToBottom } from "./messages.js";

const ALLOWED_FORMATS = new Set(["markdown", "docx", "pdf", "html"]);
const ALLOWED_TEMPLATES = new Set(["incident-response", "generic"]);

const FORMAT_LABEL = {
  markdown: "Markdown",
  docx: "Word",
  pdf: "PDF",
  html: "HTML",
};

/**
 * Parse a `/report` invocation. Supported shapes:
 *   /report
 *   /report docx
 *   /report docx,markdown
 *   /report generic docx,html
 *   /report incident-response markdown,docx,pdf
 *
 * Returns { template, formats } or null if the message isn't a /report command.
 */
function parseReportCommand(message) {
  const trimmed = message.trim();
  if (!/^\/reports?\b/i.test(trimmed)) return null;
  const rest = trimmed.replace(/^\/reports?\b/i, "").trim();
  let template = "incident-response";
  let formats = ["markdown", "docx"];
  if (!rest) return { template, formats };
  const tokens = rest.split(/\s+/);
  for (const tok of tokens) {
    if (ALLOWED_TEMPLATES.has(tok)) {
      template = tok;
      continue;
    }
    const fmtList = tok
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const validFmts = fmtList.filter((f) => ALLOWED_FORMATS.has(f));
    if (validFmts.length > 0) formats = validFmts;
  }
  return { template, formats };
}

/**
 * Try to handle the user input as a /report slash command.
 * Returns true if handled (caller should skip sending to chat stream),
 * false otherwise.
 */
export async function handleReportSlashCommand(message) {
  const parsed = parseReportCommand(message);
  if (!parsed) return false;

  if (!currentSessionId) {
    addMessage(
      "⚠️ *No active chat session yet — send at least one message first, then run `/report`.*",
      "assistant",
    );
    return true;
  }

  addMessage(message, "user");
  const placeholderId = addMessage(
    `📄 Generating ${parsed.template} report (${parsed.formats.join(", ")})…`,
    "assistant",
  );

  try {
    const res = await fetch(`${API_BASE}/api/reports`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        sessionId: currentSessionId,
        template: parsed.template,
        formats: parsed.formats,
      }),
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        detail = body.message || body.error || detail;
      } catch {
        // non-JSON body
      }
      updateBubble(
        placeholderId,
        `⚠️ *Report generation failed:* ${detail}`,
      );
      return true;
    }

    const body = await res.json();
    const warnings = Array.isArray(body.warnings) && body.warnings.length
      ? `\n\n_Warnings:_\n` + body.warnings.map((w) => `- ${w}`).join("\n")
      : "";
    const buttonsHtml = (body.files || [])
      .map(
        (f) =>
          `<a class="report-download-btn" href="${escapeAttr(
            f.downloadUrl,
          )}" data-format="${escapeAttr(f.format)}">${escapeHtml(
            FORMAT_LABEL[f.format] || f.format,
          )} <span class="report-download-size">(${formatBytes(f.bytes)})</span></a>`,
      )
      .join("");

    const title = body.metadata?.title || "Report";
    updateBubble(
      placeholderId,
      `📄 **${escapeHtml(title)}** ready (${parsed.template})${warnings}`,
      buttonsHtml,
    );
    return true;
  } catch (err) {
    updateBubble(
      placeholderId,
      `⚠️ *Could not reach the reports API:* ${err instanceof Error ? err.message : String(err)}`,
    );
    return true;
  }
}

function updateBubble(messageId, markdownText, extraHtml = "") {
  const el = document.getElementById(messageId);
  if (!el) return;
  const contentEl = el.querySelector(".message-content");
  if (!contentEl) return;
  // Minimal inline render — we control the inputs here, so simple replacements suffice.
  contentEl.innerHTML =
    simpleMarkdown(markdownText) +
    (extraHtml ? `<div class="report-download-row">${extraHtml}</div>` : "");
  scrollChatToBottom();
}

/**
 * Install a document-level click interceptor so any anchor pointing to a
 * download endpoint that requires auth gets fetched with the bearer header
 * and saved as a blob — regardless of whether it came from the slash
 * command, the model's response text, or a manifest link.
 *
 * Two URL families are handled:
 *   - `/api/reports/<uuid>/download/<fmt>` — generated by the reports tool
 *   - `/chat/files/download?path=<abs>`   — generated when the model wants
 *     to deliver a workspace file (docx/pdf/etc.) via chat
 *
 * Without this, a plain anchor click sends no Authorization header, so the
 * server returns 401 and the user sees the "Authentication required" JSON
 * error in their browser tab (session 926107f7 msg 1324).
 */
export function installReportDownloadInterceptor() {
  document.addEventListener("click", async (evt) => {
    const anchor = evt.target.closest?.("a[href]");
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    const family = classifyDownloadUrl(href);
    if (!family) return;
    evt.preventDefault();
    evt.stopPropagation();
    const originalText = anchor.textContent;
    try {
      anchor.classList.add("report-download-loading");
      const res = await fetch(joinUrl(href), {
        method: "GET",
        headers: stripContentType(authHeaders()),
      });
      if (!res.ok) {
        anchor.textContent = `⚠️ download failed (${res.status})`;
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = inferFilename(href, res, family);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      console.error("Download failed:", err);
      anchor.textContent = `⚠️ ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      anchor.classList.remove("report-download-loading");
      setTimeout(() => {
        if (anchor.textContent.startsWith("⚠️")) anchor.textContent = originalText;
      }, 4000);
    }
  });
}

function classifyDownloadUrl(href) {
  if (!href) return null;
  if (isReportDownloadUrl(href)) return "report";
  if (isChatFileDownloadUrl(href)) return "chat-file";
  return null;
}

function isReportDownloadUrl(href) {
  // Match both relative and absolute forms.
  return /\/api\/reports\/[a-f0-9-]{36}\/download\/(markdown|docx|pdf|html)\b/i.test(
    href,
  );
}

function isChatFileDownloadUrl(href) {
  // Bare /chat/files/download or any subpath with ?path=… query.
  return /(?:^|\/)chat\/files\/download(?:\?|$)/i.test(href);
}

function joinUrl(href) {
  if (/^https?:\/\//i.test(href)) return href;
  // API_BASE already starts with `/api` in the deployed app; the href we get
  // also starts with `/api`. Don't double-prefix — use the href as-is from
  // the page origin.
  return href;
}

function stripContentType(headers) {
  const copy = { ...headers };
  delete copy["Content-Type"];
  delete copy["content-type"];
  return copy;
}

function inferFilename(href, res, family) {
  const cd = res.headers.get("content-disposition") || "";
  const m = cd.match(/filename\*?="?([^";]+)"?/i);
  if (m) return decodeURIComponent(m[1]);
  if (family === "chat-file") {
    // /chat/files/download?path=…  → use the basename from the path param.
    try {
      const q = href.split("?")[1] || "";
      const params = new URLSearchParams(q);
      const p = params.get("path");
      if (p) {
        const base = p.split(/[\\/]/).pop();
        if (base) return base;
      }
    } catch {
      // fall through
    }
    return "download";
  }
  const fmt = href.match(/\/download\/(\w+)/)?.[1] || "report";
  const ext = fmt === "markdown" ? "md" : fmt;
  return `report.${ext}`;
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s) {
  return escapeHtml(s);
}

function simpleMarkdown(text) {
  // Very small subset: **bold**, *italic*, `code`, line breaks.
  let html = escapeHtml(text);
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\n/g, "<br>");
  return html;
}

// Exported for tests
export const __test = {
  parseReportCommand,
  isReportDownloadUrl,
  isChatFileDownloadUrl,
  classifyDownloadUrl,
  inferFilename,
};
