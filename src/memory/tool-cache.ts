import { createHash } from "crypto";
import { createClient } from "redis";

export interface CachedToolCall {
  ref: string;
  toolName: string;
  params: Record<string, unknown>;
  result: unknown;
  resultSummary: string;
  resultSize: number;
  calledAt: number;
  toolCallId: string;
}

// Patterns identifying read-style tools that produce idempotent results.
// Mutating tools (create/update/delete/move/run/execute) are NEVER cached,
// because re-running them is a real side effect.
const READ_PATTERNS = [
  /\.get_/i,
  /\.list_/i,
  /\.search_/i,
  /\.summarize_/i,
  /\.fetch_/i,
  /\.query_/i,
  /\.export_/i,
  /\.read_/i,
  /\.check_/i,
  /\.show_/i,
  /\.find_/i,
  /\.lookup_/i,
  /\.detail_/i,
  /\.recent_/i,
  /\.recent$/i,
  /\.stats_/i,
  /\.stats$/i,
  /^system\./i,
  /^discover_tools$/i,
  /\.workbench_/i,
  /\.list$/i,
  /\.get$/i,
  /\.search$/i,
  /\.summarize$/i,
];

// Tools that must NEVER be cached even if name matches a read pattern.
const NEVER_CACHE = new Set<string>([
  "tools.fetch_cached",
  "agent.spawn",
  "agent.cancel_run",
  "memory.manage",
  "skill.manage",
  "cron.manage",
]);

export function isCacheableTool(canonicalName: string): boolean {
  if (NEVER_CACHE.has(canonicalName)) return false;
  return READ_PATTERNS.some((p) => p.test(canonicalName));
}

// Recursive stable stringify — object keys are sorted so {a:1,b:2} and
// {b:2,a:1} produce identical hashes.
export function stableStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(stableStringify).join(",") + "]";
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return "{" + keys
    .map((k) => JSON.stringify(k) + ":" + stableStringify((obj as Record<string, unknown>)[k]))
    .join(",") + "}";
}

// Hash a tool call to a 12-char ref key. Internal params (prefixed with `_`)
// like `_mode` and `_loadedTools` are stripped — they don't affect the result.
export function hashCall(toolName: string, params: Record<string, unknown>): string {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (!k.startsWith("_")) cleaned[k] = v;
  }
  return createHash("sha1")
    .update(toolName + ":" + stableStringify(cleaned))
    .digest("hex")
    .substring(0, 12);
}

function shortenParams(params: Record<string, unknown>): string {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k.startsWith("_")) continue;
    if (typeof v === "string" && v.length > 80) cleaned[k] = v.substring(0, 80) + "…";
    else cleaned[k] = v;
  }
  return JSON.stringify(cleaned);
}

// Generate a short human-readable summary of a tool result for the manifest.
export function summarizeResult(result: unknown): string {
  if (result === null || result === undefined) return "null";
  if (typeof result !== "object") return String(result).substring(0, 120);
  const obj = result as Record<string, unknown>;

  if (obj.error) return `ERROR: ${String(obj.error).substring(0, 100)}`;
  if (obj.success === false) {
    return `failed${obj.error ? ": " + String(obj.error).substring(0, 80) : ""}`;
  }

  const data = obj.data;
  if (Array.isArray(data)) return `array of ${data.length} items`;

  if (data && typeof data === "object") {
    const dataObj = data as Record<string, unknown>;
    if (Array.isArray(dataObj.items)) return `${dataObj.items.length} items`;
    if (Array.isArray(dataObj.data)) return `${dataObj.data.length} items`;
    if (Array.isArray(dataObj.results)) return `${dataObj.results.length} results`;
    if (typeof dataObj.summary === "string") return dataObj.summary.substring(0, 120);
    if (typeof dataObj.total_vulnerabilities === "number") {
      return `${dataObj.total_vulnerabilities} vulnerabilities, ${dataObj.total_assets ?? "?"} assets`;
    }
    if (typeof dataObj.count === "number") return `${dataObj.count} records`;
    if (typeof dataObj.total === "number") return `${dataObj.total} records`;
    const keys = Object.keys(dataObj).slice(0, 4).join(",");
    return `object {${keys}${Object.keys(dataObj).length > 4 ? ",…" : ""}}`;
  }

  return "ok";
}

// Threshold above which we replace the full result in chat context with a
// summary + ref pointer. Tunable via env, default 8 KB.
const LARGE_RESULT_THRESHOLD = parseInt(
  process.env.TOOL_CACHE_LARGE_THRESHOLD || "8192",
  10,
);

// Redis TTL for tool cache entries: 7 days by default.
const TOOL_CACHE_TTL_SECONDS = parseInt(
  process.env.TOOL_CACHE_TTL_SECONDS || String(7 * 24 * 3600),
  10,
);

const REDIS_PREFIX = (process.env.CLAIMKIT_REDIS_PREFIX || "aiworkassistant") + ":tool-cache";

type RedisClient = ReturnType<typeof createClient>;

class ToolCallCache {
  private bySession = new Map<string, Map<string, CachedToolCall>>();
  private byRef = new Map<string, { sessionId: string; key: string }>();
  private warmedSessions = new Set<string>();
  private redis: RedisClient | null = null;

  // Called once at server startup if a Redis URL is configured.
  async connectRedis(url: string): Promise<void> {
    try {
      const client = createClient({ url });
      client.on("error", (err) => {
        console.warn("[ToolCache] Redis error:", err.message);
      });
      await client.connect();
      this.redis = client;
      console.log("[ToolCache] Redis backing connected —", url);
    } catch (err) {
      console.warn("[ToolCache] Redis connect failed, falling back to memory-only:", (err as Error).message);
    }
  }

  // Load all entries for a session from Redis into the in-memory map.
  // Safe to call multiple times — skips sessions already warmed this process lifetime.
  async warmSession(sessionId: string): Promise<void> {
    if (this.warmedSessions.has(sessionId) || !this.redis) return;
    this.warmedSessions.add(sessionId);

    try {
      const indexKey = `${REDIS_PREFIX}:index:${sessionId}`;
      const keys = await this.redis.sMembers(indexKey);
      if (keys.length === 0) return;

      const redisKeys = keys.map((k) => `${REDIS_PREFIX}:entry:${sessionId}:${k}`);
      const raws = await this.redis.mGet(redisKeys);

      let loaded = 0;
      for (let i = 0; i < keys.length; i++) {
        const raw = raws[i];
        if (!raw) continue;
        try {
          const entry: CachedToolCall = JSON.parse(raw);
          let sessionCache = this.bySession.get(sessionId);
          if (!sessionCache) {
            sessionCache = new Map();
            this.bySession.set(sessionId, sessionCache);
          }
          sessionCache.set(keys[i]!, entry);
          this.byRef.set(entry.ref, { sessionId, key: keys[i]! });
          loaded++;
        } catch {
          // corrupt entry — skip
        }
      }
      if (loaded > 0) {
        console.log(`[ToolCache] Warmed session ${sessionId}: ${loaded} entries from Redis`);
      }
    } catch (err) {
      console.warn("[ToolCache] warmSession failed:", (err as Error).message);
    }
  }

  isCacheable(toolName: string): boolean {
    return isCacheableTool(toolName);
  }

  get(
    sessionId: string,
    toolName: string,
    params: Record<string, unknown>,
  ): CachedToolCall | null {
    if (!isCacheableTool(toolName)) return null;
    const key = hashCall(toolName, params);
    return this.bySession.get(sessionId)?.get(key) ?? null;
  }

  set(
    sessionId: string,
    toolName: string,
    params: Record<string, unknown>,
    result: unknown,
    toolCallId: string,
  ): CachedToolCall {
    const key = hashCall(toolName, params);
    const ref = `tc-${key}`;
    const resultStr =
      typeof result === "string" ? result : JSON.stringify(result ?? null);
    const entry: CachedToolCall = {
      ref,
      toolName,
      params,
      result,
      resultSummary: summarizeResult(result),
      resultSize: resultStr.length,
      calledAt: Date.now(),
      toolCallId,
    };

    let sessionCache = this.bySession.get(sessionId);
    if (!sessionCache) {
      sessionCache = new Map();
      this.bySession.set(sessionId, sessionCache);
    }
    sessionCache.set(key, entry);
    this.byRef.set(ref, { sessionId, key });

    // Persist to Redis asynchronously — don't block the caller.
    if (this.redis) {
      void this.persistEntry(sessionId, key, entry);
    }

    return entry;
  }

  private async persistEntry(sessionId: string, key: string, entry: CachedToolCall): Promise<void> {
    if (!this.redis) return;
    try {
      const entryKey = `${REDIS_PREFIX}:entry:${sessionId}:${key}`;
      const indexKey = `${REDIS_PREFIX}:index:${sessionId}`;
      await Promise.all([
        this.redis.set(entryKey, JSON.stringify(entry), { EX: TOOL_CACHE_TTL_SECONDS }),
        this.redis.sAdd(indexKey, key),
        this.redis.expire(indexKey, TOOL_CACHE_TTL_SECONDS),
      ]);
    } catch (err) {
      console.warn("[ToolCache] Redis persist failed:", (err as Error).message);
    }
  }

  getByRef(ref: string): CachedToolCall | null {
    const lookup = this.byRef.get(ref);
    if (!lookup) return null;
    return this.bySession.get(lookup.sessionId)?.get(lookup.key) ?? null;
  }

  list(sessionId: string): CachedToolCall[] {
    const sessionCache = this.bySession.get(sessionId);
    if (!sessionCache) return [];
    return Array.from(sessionCache.values()).sort((a, b) => a.calledAt - b.calledAt);
  }

  clear(sessionId: string): void {
    const sessionCache = this.bySession.get(sessionId);
    if (sessionCache) {
      for (const entry of sessionCache.values()) this.byRef.delete(entry.ref);
      this.bySession.delete(sessionId);
    }
    this.warmedSessions.delete(sessionId);

    // Remove from Redis asynchronously.
    if (this.redis) {
      void this.clearRedisSession(sessionId);
    }
  }

  private async clearRedisSession(sessionId: string): Promise<void> {
    if (!this.redis) return;
    try {
      const indexKey = `${REDIS_PREFIX}:index:${sessionId}`;
      const keys = await this.redis.sMembers(indexKey);
      if (keys.length > 0) {
        const entryKeys = keys.map((k) => `${REDIS_PREFIX}:entry:${sessionId}:${k}`);
        await this.redis.del([indexKey, ...entryKeys]);
      } else {
        await this.redis.del(indexKey);
      }
    } catch (err) {
      console.warn("[ToolCache] Redis clear failed:", (err as Error).message);
    }
  }

  buildManifest(sessionId: string): string {
    const entries = this.list(sessionId);
    if (entries.length === 0) return "";
    const lines = [
      "=== TOOL CALLS ALREADY EXECUTED THIS SESSION ===",
      "Do NOT repeat these exact calls. To retrieve a full prior result, call: tools.fetch_cached({ref:\"tc-xxx\"})",
      "",
    ];
    for (const e of entries) {
      const shortParams = shortenParams(e.params);
      const size = e.resultSize > 1024
        ? `${Math.round(e.resultSize / 1024)}KB`
        : `${e.resultSize}B`;
      lines.push(
        `- ${e.toolName}(${shortParams}) → ${e.resultSummary} [ref:${e.ref}, ${size}]`,
      );
    }
    return lines.join("\n");
  }

  compactForContext(entry: CachedToolCall): unknown {
    if (entry.resultSize <= LARGE_RESULT_THRESHOLD) return entry.result;
    return {
      success:
        typeof entry.result === "object" && entry.result !== null
          ? (entry.result as Record<string, unknown>).success ?? true
          : true,
      _cached_ref: entry.ref,
      _cached_size: entry.resultSize,
      _cached_summary: entry.resultSummary,
      _instructions: `Result too large (${entry.resultSize} bytes) to inline. Call tools.fetch_cached({ref:"${entry.ref}"}) to retrieve full data.`,
    };
  }

  wrapCachedAsResult(entry: CachedToolCall): unknown {
    const compact = this.compactForContext(entry);
    const note =
      "This result was cached from an earlier identical call in this session. " +
      "Use it directly — do NOT re-run the original tool.";

    if (compact && typeof compact === "object" && !Array.isArray(compact)) {
      const obj = compact as Record<string, unknown>;
      if ("data" in obj || "success" in obj) {
        return {
          success: obj.success ?? true,
          _cached: true,
          _cached_ref: entry.ref,
          _called_at: new Date(entry.calledAt).toISOString(),
          _note: note,
          data: obj.data ?? obj,
          ...(obj.error ? { error: obj.error } : {}),
        };
      }
    }
    return {
      success: true,
      _cached: true,
      _cached_ref: entry.ref,
      _called_at: new Date(entry.calledAt).toISOString(),
      _note: note,
      data: compact,
    };
  }

  sessionStats(sessionId: string): { entries: number; bytes: number } {
    const entries = this.list(sessionId);
    return {
      entries: entries.length,
      bytes: entries.reduce((sum, e) => sum + e.resultSize, 0),
    };
  }
}

export const toolCallCache = new ToolCallCache();
export { LARGE_RESULT_THRESHOLD };
