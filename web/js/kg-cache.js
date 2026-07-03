/**
 * Frontend cache of knowledge-graph node titles.
 *
 * Fetches the entire node list once on chat init and keeps a Map of
 * { id → { title, type, status, tags } }. Type-ahead, /kg, and the chat
 * input's @-mention helper all query the cache first so search is
 * instant — no server round-trip for the common case of matching by
 * title. Cache miss / filtered query / refresh hits /chat/graph/nodes.
 *
 * Trivial to invalidate: call refresh(). Default TTL is 5 minutes.
 */

import { API_BASE } from "./state.js";
import { authHeaders } from "./auth.js";

const TTL_MS = 5 * 60 * 1000;
const MAX_NODES = 5000;

const cache = {
  loadedAt: 0,
  loading: null, // Promise<void> while a load is in flight
  byId: new Map(),
  /** Lowercased substrings of title for cheap searches. */
  searchIndex: [],
};

/**
 * Load (or reload) the node cache. Idempotent — concurrent calls share a
 * single in-flight fetch. Resolves with the number of nodes loaded.
 */
export async function loadKgCache(force = false) {
  const now = Date.now();
  if (!force && cache.loadedAt && now - cache.loadedAt < TTL_MS) {
    return cache.byId.size;
  }
  if (cache.loading) return cache.loading.then(() => cache.byId.size);

  cache.loading = (async () => {
    try {
      const res = await fetch(
        `${API_BASE}/chat/graph/nodes?limit=${MAX_NODES}`,
        { headers: authHeaders() },
      );
      if (!res.ok) return;
      const body = await res.json();
      const nodes = Array.isArray(body.nodes) ? body.nodes : [];
      cache.byId.clear();
      cache.searchIndex.length = 0;
      for (const n of nodes) {
        cache.byId.set(n.id, {
          id: n.id,
          title: n.title || "(untitled)",
          type: n.type || "",
          status: n.status || "",
          tags: Array.isArray(n.tags) ? n.tags : [],
        });
        cache.searchIndex.push({
          id: n.id,
          titleLower: (n.title || "").toLowerCase(),
          typeLower: (n.type || "").toLowerCase(),
          tagsLower: (n.tags || []).map((t) => String(t).toLowerCase()),
        });
      }
      cache.loadedAt = Date.now();
    } catch {
      // Best-effort warm: a failed fetch must not surface as an unhandled
      // rejection in fire-and-forget callers (e.g. `void loadKgCache()`).
    } finally {
      cache.loading = null;
    }
  })();

  await cache.loading;
  return cache.byId.size;
}

/**
 * Synchronous in-memory search. Returns up to `limit` matching node
 * snapshots ranked by where the match occurred (title-prefix > title-
 * contains > tag > type). Works without a network round-trip.
 *
 * filters: optional { type, status, tags } narrows the result set the
 * same way the server-side query does, so a caller mirroring REST
 * semantics gets a consistent shape.
 */
export function searchKgCache(query, filters = {}, limit = 8) {
  const q = (query || "").trim().toLowerCase();
  if (!q && !filters.type && !filters.status && !filters.tags?.length) {
    return [];
  }
  const out = [];
  for (const idx of cache.searchIndex) {
    const node = cache.byId.get(idx.id);
    if (!node) continue;
    if (filters.type && node.type !== filters.type) continue;
    if (filters.status && node.status !== filters.status) continue;
    if (filters.tags && filters.tags.length) {
      const have = new Set(idx.tagsLower);
      if (!filters.tags.every((t) => have.has(String(t).toLowerCase()))) continue;
    }
    let score = 0;
    if (q) {
      if (idx.titleLower === q) score = 100;
      else if (idx.titleLower.startsWith(q)) score = 80;
      else if (idx.titleLower.includes(q)) score = 60;
      else if (idx.tagsLower.some((t) => t.includes(q))) score = 40;
      else if (idx.typeLower.includes(q)) score = 20;
      else continue;
    } else {
      score = 10;
    }
    out.push({ node, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit).map((r) => r.node);
}

/**
 * Get a single node by id from the cache. Returns null on miss; caller
 * can fetch via REST if needed.
 */
export function getKgNode(id) {
  return cache.byId.get(id) || null;
}

/**
 * Hard refresh (next call after this resolves will refetch).
 */
export function invalidateKgCache() {
  cache.loadedAt = 0;
}

/** Diagnostics — exported for tests. */
export const __test = {
  cache,
  reset() {
    cache.loadedAt = 0;
    cache.loading = null;
    cache.byId.clear();
    cache.searchIndex.length = 0;
  },
};
