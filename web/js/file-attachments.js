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

import { API_BASE, currentSessionId } from "./state.js";
import { authHeaders } from "./auth.js";

const DOWNLOADABLE_EXTS = [
  "docx", "doc", "xlsx", "xls", "pptx", "ppt",
  "pdf", "md", "txt", "csv", "json", "html", "htm",
  "png", "jpg", "jpeg", "gif", "svg",
];
const PATH_RE = new RegExp(
  // matches: Windows-absolute, POSIX-absolute, or relative paths whose
  // segments can include letters/digits/-_./\, ending in a known ext
  String.raw`([A-Za-z]:\\[^\s"'<>]+\.(?:` + DOWNLOADABLE_EXTS.join("|") + `)|(?:[\\/][^\s"'<>]+|[\w.-]+(?:[\\/][^\s"'<>]+)+)\.(?:` + DOWNLOADABLE_EXTS.join("|") + `))`,
  "gi",
);

const pendingAttachments = [];

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
        <span class="attachment-chip" title="${escapeAttr(att.path)}">
          <span class="attachment-name">${escapeHtml(att.name)}</span>
          <span class="attachment-size">${formatBytes(att.size)}</span>
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
  if (!currentSessionId) {
    alert("Send at least one message first so a session exists, then attach.");
    return;
  }
  if (!files || files.length === 0) return;
  const payload = { files: [] };
  for (const f of Array.from(files)) {
    if (f.size > 10 * 1024 * 1024) {
      alert(`${f.name} is over the 10 MB per-file cap and will be skipped.`);
      continue;
    }
    payload.files.push({
      name: f.name,
      mime: f.type || "application/octet-stream",
      contentBase64: await readFileAsBase64(f),
    });
  }
  if (payload.files.length === 0) return;
  try {
    const res = await fetch(`${API_BASE}/chat/sessions/${encodeURIComponent(currentSessionId)}/files`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await safeJson(res);
      alert(`Upload failed (${res.status}): ${detail?.error || detail?.message || "see console"}`);
      console.warn("[attach] upload failed", res.status, detail);
      return;
    }
    const body = await res.json();
    for (const f of body.files || []) {
      pendingAttachments.push({
        name: f.name,
        path: f.path,
        size: f.size,
        mime: f.mime,
      });
    }
    renderAttachmentBar();
  } catch (err) {
    alert(`Upload error: ${err instanceof Error ? err.message : String(err)}`);
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

export function installFileAttachmentUI() {
  const btn = document.getElementById("attachBtn");
  const input = document.getElementById("attachInput");
  if (!btn || !input) return;
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
 * Walk the chat DOM, find any text node containing a recognized file
 * path, and replace the path with a small download button. Idempotent —
 * runs after every render via a MutationObserver.
 */
function enrichDownloadablePaths(root) {
  if (!root) return;
  const treeWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  let n;
  while ((n = treeWalker.nextNode())) {
    if (!n.nodeValue) continue;
    // Skip if already inside a code block / pre / inside a download button.
    const closestDl = n.parentElement?.closest?.(".file-download-btn");
    if (closestDl) continue;
    if (PATH_RE.test(n.nodeValue)) {
      PATH_RE.lastIndex = 0;
      nodes.push(n);
    }
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
  document.addEventListener("click", (evt) => {
    const btn = evt.target.closest?.(".file-download-btn");
    if (!btn) return;
    evt.preventDefault();
    const p = btn.dataset.path;
    if (p) void downloadFile(p);
  });
  const chatMessages = document.getElementById("chatMessages");
  if (chatMessages) {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) enrichDownloadablePaths(node);
        }
      }
    });
    observer.observe(chatMessages, { childList: true, subtree: true });
    // Catch existing content on first install.
    enrichDownloadablePaths(chatMessages);
  }
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
