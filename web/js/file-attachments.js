/**
 * Multi-file attachment + bidirectional download wiring for the chat.
 *
 * Two halves:
 *   - upload: paperclip button → file picker (multi-select) → base64-JSON
 *     POST to /chat/sessions/<id>/files. The server writes them to
 *     data/profiles/<active>/uploads/<sessionId>/, and we prepend the
 *     resulting absolute paths to the next user message so the model can
 *     read them via local.read_file.
 *   - download: any time the chat renders an assistant message or tool
 *     result that contains an absolute or workspace-relative path
 *     ending in a known doc extension, install a small "Download
 *     <basename>" button next to it that hits /chat/files/download with
 *     an authenticated blob fetch (anchor clicks drop the bearer token).
 */

import {
  API_BASE,
  currentMode,
  currentSessionId,
  setCurrentSessionId,
  updateSessionHash,
} from "./state.js";
import { authHeaders } from "./auth.js";

const DOWNLOADABLE_EXTS = [
  "docx", "doc", "xlsx", "xls", "pptx", "ppt",
  "pdf", "md", "txt", "csv", "json", "html", "htm",
  "png", "jpg", "jpeg", "gif", "svg",
];
// String.raw only tags the literal immediately following it — chaining more
// backtick strings on with `+` makes those *un*tagged (cooked) templates,
// where `\s`/`\w`/`\.` silently lose their backslash (e.g. "\s" === "s").
// That downgraded class exclusions and dropped the escaped dot, which
// swallowed leading path segments like "reports/" off real download links.
// Interpolating via `${...}` inside a single tagged template avoids it.
const EXTS_ALT = DOWNLOADABLE_EXTS.join("|");
const PATH_RE = new RegExp(
  // matches: Windows-absolute, POSIX-absolute, or relative paths whose
  // segments can include letters/digits/-_./\, ending in a known ext
  String.raw`([A-Za-z]:\\[^\s"'<>]+\.(?:${EXTS_ALT})|(?:[\\/][^\s"'<>]+|[\w.-]+(?:[\\/][^\s"'<>]+)+)\.(?:${EXTS_ALT}))`,
  "gi",
);

const pendingAttachments = [];
let nextAttachmentId = 1;
let attachmentUiInstalled = false;

// ── Upload ────────────────────────────────────────────────────────────────

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = reader.result;
      // result is "data:<mime>;base64,<data>" — strip the prefix.
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

function renderAttachmentBar() {
  const bar = document.getElementById("attachmentBar");
  if (!bar) return;
  if (pendingAttachments.length === 0) {
    bar.style.display = "none";
    bar.innerHTML = "";
    return;
  }
  bar.style.display = "flex";
  bar.innerHTML = pendingAttachments
    .map(
      (att, i) => `
        <span class="attachment-chip" title="${escapeAttr(att.path || "")}">
          <span class="attachment-name">${escapeHtml(att.name)}</span>
          <span class="attachment-size">${att.error ? "failed" : att.uploading ? "uploading..." : formatBytes(att.size)}</span>
          <button class="attachment-remove" data-idx="${i}" aria-label="Remove">×</button>
        </span>`,
    )
    .join("");
  for (const btn of bar.querySelectorAll(".attachment-remove")) {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx, 10);
      if (!Number.isNaN(idx)) {
        pendingAttachments.splice(idx, 1);
        renderAttachmentBar();
      }
    });
  }
}

async function handleFilesPicked(files) {
  if (!files || files.length === 0) return;
  const selected = [];
  for (const f of Array.from(files)) {
    if (f.size > 25 * 1024 * 1024) {
      alert(`${f.name} is over the 25 MB per-file cap and will be skipped.`);
      continue;
    }
    const attachment = {
      id: `pending-${nextAttachmentId++}`,
      name: f.name,
      path: "",
      size: f.size,
      mime: f.type || "application/octet-stream",
      uploading: true,
    };
    pendingAttachments.push(attachment);
    selected.push({ file: f, attachment });
  }
  if (selected.length === 0) return;
  renderAttachmentBar();

  const removeSelectedPlaceholders = () => {
    for (const item of selected) {
      const idx = pendingAttachments.indexOf(item.attachment);
      if (idx >= 0) pendingAttachments.splice(idx, 1);
    }
  };
  const markSelectedFailed = (message) => {
    for (const item of selected) {
      item.attachment.uploading = false;
      item.attachment.error = true;
      item.attachment.path = message;
    }
  };

  const sessionId = await ensureAttachmentSession();
  if (!sessionId) {
    markSelectedFailed("Upload failed before a chat session could be created.");
    renderAttachmentBar();
    return;
  }
  try {
    const payload = { files: [] };
    for (const item of selected) {
      payload.files.push({
        name: item.file.name,
        mime: item.file.type || "application/octet-stream",
        contentBase64: await readFileAsBase64(item.file),
      });
    }
    if (payload.files.length === 0) {
      removeSelectedPlaceholders();
      renderAttachmentBar();
      return;
    }
    const res = await fetch(`${API_BASE}/chat/sessions/${encodeURIComponent(sessionId)}/files`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await safeJson(res);
      markSelectedFailed(detail?.error || detail?.message || "Upload failed.");
      renderAttachmentBar();
      alert(`Upload failed (${res.status}): ${detail?.error || detail?.message || "see console"}`);
      console.warn("[attach] upload failed", res.status, detail);
      return;
    }
    const body = await res.json();
    removeSelectedPlaceholders();
    for (const f of body.files || []) {
      pendingAttachments.push({
        id: `file-${nextAttachmentId++}`,
        name: f.name,
        path: f.path,
        size: f.size,
        mime: f.mime,
      });
    }
    renderAttachmentBar();
  } catch (err) {
    markSelectedFailed(err instanceof Error ? err.message : String(err));
    renderAttachmentBar();
    alert(`Upload error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function ensureAttachmentSession() {
  if (currentSessionId) return currentSessionId;
  try {
    const res = await fetch(`${API_BASE}/chat/sessions`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        userId: "web-user",
        mode: currentMode,
        title: `Chat on ${new Date().toLocaleDateString()}`,
      }),
    });
    if (!res.ok) {
      const detail = await safeJson(res);
      alert(`Could not start chat for upload (${res.status}): ${detail?.error || detail?.message || "see console"}`);
      console.warn("[attach] session create failed", res.status, detail);
      return null;
    }
    const body = await res.json();
    if (!body.sessionId) {
      alert("Could not start chat for upload: server did not return a session id.");
      console.warn("[attach] session create missing sessionId", body);
      return null;
    }
    setCurrentSessionId(body.sessionId);
    localStorage.setItem("currentSessionId", body.sessionId);
    updateSessionHash(body.sessionId);
    import("./conversations.js")
      .then((mod) => mod.loadConversations?.())
      .catch((err) => console.warn("[attach] conversation refresh failed", err));
    return body.sessionId;
  } catch (err) {
    alert(`Could not start chat for upload: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Drain pending attachments into a stringified "attached files" preamble
 * the next outgoing message should carry. Called by sendMessage() before
 * the fetch fires. Returns the augmented text.
 */
export function applyAttachmentsToMessage(text) {
  if (pendingAttachments.length === 0) return text;
  const lines = pendingAttachments.map(
    (a) => `- ${a.name} (${formatBytes(a.size)}) at: ${a.path}`,
  );
  const preamble = [
    "📎 Attached files (use local.read_file to inspect; download via /chat/files/download?path=…):",
    ...lines,
  ].join("\n");
  pendingAttachments.length = 0;
  renderAttachmentBar();
  return `${preamble}\n\n${text}`;
}

export function hasPendingAttachmentUploads() {
  return pendingAttachments.some((a) => a.uploading);
}

export function hasFailedAttachments() {
  return pendingAttachments.some((a) => a.error);
}

export function installFileAttachmentUI() {
  if (attachmentUiInstalled) return;
  const btn = document.getElementById("attachBtn");
  const input = document.getElementById("attachInput");
  if (!btn || !input) return;
  attachmentUiInstalled = true;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    input.click();
  });
  input.addEventListener("change", () => {
    if (input.files && input.files.length > 0) {
      void handleFilesPicked(input.files);
    }
    input.value = "";
  });
}

// ── Download ──────────────────────────────────────────────────────────────

/**
 * Walk the given root (a single completed message bubble, NOT the whole
 * chat) and replace recognized file paths in text nodes with a small
 * Download button. Idempotent — bails out for any node already inside an
 * existing `.file-download-btn` or `.file-path-with-download`.
 *
 * Callers must pass a stable, non-streaming root. We deliberately do NOT
 * use a MutationObserver: the prior version observed #chatMessages with
 * subtree:true, which fired on every streaming token, re-ran the regex,
 * and then mutated the DOM (which re-fired itself). On long sessions
 * that produced a hard browser freeze. Now the enrichment runs only at
 * known-finalized points (load-history, message-finalized event).
 */
function enrichDownloadablePaths(root) {
  if (!root || root.nodeType !== 1) return;
  if (root.dataset && root.dataset.dlEnriched === "1") return;
  const treeWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  let n;
  let scanned = 0;
  // Hard cap — don't scan absurdly long text nodes (would still be cheap
  // in practice but keeps the function bounded under pathological input).
  while ((n = treeWalker.nextNode())) {
    if (++scanned > 4000) break;
    if (!n.nodeValue || n.nodeValue.length > 8000) continue;
    // Skip if already inside an existing download wrapper.
    const par = n.parentElement;
    if (par?.closest?.(".file-download-btn, .file-path-with-download")) continue;
    PATH_RE.lastIndex = 0;
    if (PATH_RE.test(n.nodeValue)) nodes.push(n);
    PATH_RE.lastIndex = 0;
  }
  for (const node of nodes) {
    const parent = node.parentNode;
    if (!parent) continue;
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    PATH_RE.lastIndex = 0;
    let match;
    while ((match = PATH_RE.exec(text)) !== null) {
      if (match.index > cursor) {
        frag.appendChild(document.createTextNode(text.slice(cursor, match.index)));
      }
      const path = match[0];
      const wrapper = document.createElement("span");
      wrapper.className = "file-path-with-download";
      const codeEl = document.createElement("code");
      codeEl.textContent = path;
      wrapper.appendChild(codeEl);
      const btn = document.createElement("button");
      btn.className = "file-download-btn";
      btn.type = "button";
      btn.dataset.path = path;
      btn.title = `Download ${pathBasename(path)}`;
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:3px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download`;
      wrapper.appendChild(btn);
      frag.appendChild(wrapper);
      cursor = match.index + path.length;
    }
    if (cursor < text.length) {
      frag.appendChild(document.createTextNode(text.slice(cursor)));
    }
    parent.replaceChild(frag, node);
  }
  if (root.dataset) root.dataset.dlEnriched = "1";
}

/**
 * Public hook: enrich a single message bubble after it finalizes.
 * Safe to call multiple times — re-enriches only if text changed.
 */
export function enrichMessageBubble(messageEl) {
  if (!messageEl) return;
  // Clear the idempotency flag so a follow-up re-render (markdown re-parse,
  // user edit) gets a fresh pass.
  if (messageEl.dataset) delete messageEl.dataset.dlEnriched;
  try {
    enrichDownloadablePaths(messageEl);
  } catch (err) {
    console.warn("[file-attachments] enrichMessageBubble failed:", err);
  }
}

async function downloadFile(absolutePath) {
  try {
    const url = `${API_BASE}/chat/files/download?path=${encodeURIComponent(absolutePath)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: stripContentType(authHeaders()),
    });
    if (!res.ok) {
      const detail = await safeJson(res);
      alert(`Download failed (${res.status}): ${detail?.error || res.statusText}`);
      return;
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = inferFilenameFromCD(res.headers.get("content-disposition")) || pathBasename(absolutePath);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (err) {
    alert(`Download error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function installDownloadInterceptor() {
  // Click delegation for the rendered Download buttons. Cheap: only
  // runs on actual click events, no continuous scanning.
  document.addEventListener("click", (evt) => {
    const btn = evt.target.closest?.(".file-download-btn");
    if (!btn) return;
    evt.preventDefault();
    const p = btn.dataset.path;
    if (p) void downloadFile(p);
  });
  // No MutationObserver. The prior version observed #chatMessages with
  // subtree:true, which fired on every streaming token, ran the path
  // regex over the entire chat log, then mutated the DOM (which re-
  // fired the observer recursively) — observed hard browser freezes on
  // long sessions. enrichMessageBubble() is now called explicitly from
  // messages.js after a streaming message finalizes and from the
  // initial chat-history render.
}

// ── Helpers ───────────────────────────────────────────────────────────────

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
function formatBytes(n) {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function pathBasename(p) {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
function inferFilenameFromCD(cd) {
  if (!cd) return null;
  const m = cd.match(/filename\*?="?([^";]+)"?/i);
  return m ? decodeURIComponent(m[1]) : null;
}
function stripContentType(headers) {
  const copy = { ...headers };
  delete copy["Content-Type"];
  delete copy["content-type"];
  return copy;
}

export const __test = { applyAttachmentsToMessage };
