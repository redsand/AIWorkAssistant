/**
 * /kg slash command — instant knowledge-graph search from the chat input.
 *
 * Syntax:
 *   /kg <query>
 *   /kg type=adr decisions
 *   /kg status=accepted auth
 *   /kg tag=ir-72
 *
 * The cache fast path returns matches in <1ms; the REST path is only
 * used when the user supplied a multi-token query that the cache might
 * have stale data for, OR when filters narrow the result set to zero
 * cached matches.
 */

import { API_BASE } from "./state.js";
import { authHeaders } from "./auth.js";
import { addMessage, scrollChatToBottom } from "./messages.js";
import { loadKgCache, searchKgCache, getKgNode } from "./kg-cache.js";

/**
 * Parse a /kg invocation into { query, filters }. Supports inline
 * key=value filters (type, status, tag, limit) mixed with free-text
 * query terms.
 */
function parseKgCommand(message) {
  const trimmed = message.trim();
  if (!/^\/(kg|graph)\b/i.test(trimmed)) return null;
  const rest = trimmed.replace(/^\/(kg|graph)\b/i, "").trim();
  const filters = {};
  const queryParts = [];
  let limit = 8;
  for (const tok of rest.split(/\s+/).filter(Boolean)) {
    const m = tok.match(/^([a-z]+)=(.+)$/i);
    if (!m) {
      queryParts.push(tok);
      continue;
    }
    const k = m[1].toLowerCase();
    const v = m[2];
    if (k === "type") filters.type = v;
    else if (k === "status") filters.status = v;
    else if (k === "tag" || k === "tags") {
      filters.tags = (filters.tags || []).concat(v);
    } else if (k === "limit") {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n > 0 && n <= 100) limit = n;
    } else {
      // Unknown filter — treat as part of the free-text query.
      queryParts.push(tok);
    }
  }
  return { query: queryParts.join(" "), filters, limit };
}

/**
 * Handle a /kg slash command. Returns true if consumed.
 */
export async function handleKgSlashCommand(message) {
  const parsed = parseKgCommand(message);
  if (!parsed) return false;

  addMessage(message, "user");
  const placeholderId = addMessage("🔍 Searching the knowledge graph…", "assistant");

  // Cache fast path. Single-token queries against cached titles return in <1ms.
  try {
    await loadKgCache(false);
  } catch {
    /* fall through to REST */
  }

  let nodes = searchKgCache(parsed.query, parsed.filters, parsed.limit);

  // If the cache returned nothing AND the user supplied a non-trivial
  // query, fall back to the REST endpoint — FTS5 can find content matches
  // the title-only cache misses.
  if (nodes.length === 0 && parsed.query) {
    try {
      const qs = new URLSearchParams();
      qs.set("search", parsed.query);
      qs.set("limit", String(parsed.limit));
      if (parsed.filters.type) qs.set("type", parsed.filters.type);
      if (parsed.filters.status) qs.set("status", parsed.filters.status);
      const res = await fetch(
        `${API_BASE}/chat/graph/nodes?${qs.toString()}`,
        { headers: authHeaders() },
      );
      if (res.ok) {
        const body = await res.json();
        nodes = Array.isArray(body.nodes) ? body.nodes : [];
      }
    } catch (err) {
      console.warn("[KG] REST search failed:", err);
    }
  }

  updateBubble(placeholderId, parsed, nodes);
  return true;
}

function updateBubble(messageId, parsed, nodes) {
  const el = document.getElementById(messageId);
  if (!el) return;
  const contentEl = el.querySelector(".message-content");
  if (!contentEl) return;

  if (nodes.length === 0) {
    const filterStr = describeFilters(parsed);
    contentEl.innerHTML = `<em>No knowledge-graph nodes matched <code>${escapeHtml(parsed.query || "(no query)")}</code>${filterStr ? ` with ${filterStr}` : ""}.</em>`;
    scrollChatToBottom();
    return;
  }

  const header = `📊 <strong>${nodes.length}</strong> match${nodes.length === 1 ? "" : "es"}${parsed.query ? ` for <code>${escapeHtml(parsed.query)}</code>` : ""}${describeFilters(parsed) ? ` <span class="kg-filter">${describeFilters(parsed)}</span>` : ""}:`;
  const rows = nodes
    .map((n) => {
      const status = n.status
        ? `<span class="kg-status kg-status-${escapeAttr(n.status)}">${escapeHtml(n.status)}</span>`
        : "";
      const tags = Array.isArray(n.tags) && n.tags.length
        ? `<span class="kg-tags">${n.tags.slice(0, 3).map((t) => `#${escapeHtml(String(t))}`).join(" ")}</span>`
        : "";
      return `
        <li class="kg-result-row" data-node-id="${escapeAttr(n.id)}">
          <span class="kg-type">${escapeHtml(n.type)}</span>
          <span class="kg-title">${escapeHtml(n.title)}</span>
          ${status}
          ${tags}
        </li>`;
    })
    .join("");

  contentEl.innerHTML = `${header}<ul class="kg-result-list">${rows}</ul>`;
  // Click a row → fetch full node + edges, show as a follow-up bubble.
  for (const row of contentEl.querySelectorAll(".kg-result-row")) {
    row.addEventListener("click", () => showKgNodeDetail(row.dataset.nodeId));
  }
  scrollChatToBottom();
}

async function showKgNodeDetail(nodeId) {
  let node = getKgNode(nodeId);
  let edges = [];
  try {
    const res = await fetch(`${API_BASE}/chat/graph/nodes/${encodeURIComponent(nodeId)}`, {
      headers: authHeaders(),
    });
    if (res.ok) {
      const body = await res.json();
      if (body.node) node = body.node;
      if (Array.isArray(body.edges)) edges = body.edges;
    }
  } catch (err) {
    console.warn("[KG] node detail fetch failed:", err);
  }
  if (!node) return;

  const detailHtml = `
    <div class="kg-detail">
      <div class="kg-detail-header">
        <span class="kg-type">${escapeHtml(node.type || "")}</span>
        <strong>${escapeHtml(node.title || "(untitled)")}</strong>
        ${node.status ? `<span class="kg-status kg-status-${escapeAttr(node.status)}">${escapeHtml(node.status)}</span>` : ""}
      </div>
      ${node.content ? `<pre class="kg-content">${escapeHtml(String(node.content))}</pre>` : ""}
      ${edges.length ? `<div class="kg-edges-header">${edges.length} edge${edges.length === 1 ? "" : "s"}:</div>` : ""}
      ${edges.length ? `<ul class="kg-edges">${edges.map((e) => `<li><code>${escapeHtml(e.type)}</code> → <span data-node-id="${escapeAttr(e.targetId === node.id ? e.sourceId : e.targetId)}" class="kg-edge-link">${escapeHtml(e.targetId === node.id ? e.sourceId : e.targetId)}</span>${e.description ? ` — ${escapeHtml(e.description)}` : ""}</li>`).join("")}</ul>` : ""}
    </div>`;
  const bubbleId = addMessage(detailHtml, "assistant");
  const bubble = document.getElementById(bubbleId);
  if (bubble) {
    const contentEl = bubble.querySelector(".message-content");
    if (contentEl) {
      contentEl.innerHTML = detailHtml;
      for (const link of contentEl.querySelectorAll(".kg-edge-link")) {
        link.addEventListener("click", () => showKgNodeDetail(link.dataset.nodeId));
      }
    }
  }
  scrollChatToBottom();
}

function describeFilters(parsed) {
  const bits = [];
  if (parsed.filters?.type) bits.push(`type=${parsed.filters.type}`);
  if (parsed.filters?.status) bits.push(`status=${parsed.filters.status}`);
  if (parsed.filters?.tags?.length) {
    bits.push(`tags=${parsed.filters.tags.join(",")}`);
  }
  return bits.join(" ");
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

// Exported for tests
export const __test = { parseKgCommand };
