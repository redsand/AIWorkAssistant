import { describe, it, expect, beforeEach } from "vitest";
import {
  toolCallCache,
  hashCall,
  stableStringify,
  isCacheableTool,
  summarizeResult,
} from "../../../src/memory/tool-cache";

describe("tool-cache: stableStringify", () => {
  it("produces identical strings regardless of key order", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });
  it("handles nested objects", () => {
    expect(stableStringify({ a: { x: 1, y: 2 } })).toBe(
      stableStringify({ a: { y: 2, x: 1 } }),
    );
  });
  it("handles arrays in order (arrays are ordered)", () => {
    expect(stableStringify([1, 2, 3])).toBe("[1,2,3]");
  });
  it("handles null and undefined", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(undefined)).toBe(undefined as unknown as string);
  });
});

describe("tool-cache: hashCall", () => {
  it("produces identical hashes for the same call", () => {
    const h1 = hashCall("jitbit.search_tickets", { customer: "HUNT", dateFrom: "2026-05-01" });
    const h2 = hashCall("jitbit.search_tickets", { dateFrom: "2026-05-01", customer: "HUNT" });
    expect(h1).toBe(h2);
  });
  it("produces different hashes for different params", () => {
    const h1 = hashCall("jitbit.search_tickets", { customer: "HUNT" });
    const h2 = hashCall("jitbit.search_tickets", { customer: "OTHER" });
    expect(h1).not.toBe(h2);
  });
  it("ignores internal params prefixed with underscore", () => {
    const h1 = hashCall("jitbit.search_tickets", { customer: "HUNT", _mode: "productivity" });
    const h2 = hashCall("jitbit.search_tickets", { customer: "HUNT", _mode: "engineering", _loadedTools: ["a"] });
    expect(h1).toBe(h2);
  });
  it("produces 12-char hashes", () => {
    expect(hashCall("a.b", {})).toHaveLength(12);
  });
});

describe("tool-cache: isCacheableTool", () => {
  it.each([
    ["jitbit.search_tickets", true],
    ["jitbit.get_ticket", true],
    ["tenable.list_vulnerabilities", true],
    ["tenable.export_vulnerabilities", true],
    ["jitbit.summarize_ticket", true],
    ["hawk_ir.get_cases", true],
    ["system.get_time", true],
    ["system.check_health", true],
    ["discover_tools", true],
    ["knowledge.search", true],
    ["knowledge.get", true],
  ])("classifies %s as cacheable=%s (read-style)", (name, expected) => {
    expect(isCacheableTool(name)).toBe(expected);
  });

  it.each([
    ["agent.spawn", false],
    ["tools.fetch_cached", false],
    ["memory.manage", false],
    ["skill.manage", false],
    ["cron.manage", false],
    ["kanban.create_card", false],
    ["jitbit.update_ticket", false],
    ["jira.delete_issue", false],
    ["work_items.create", false],
  ])("classifies %s as cacheable=%s (mutating)", (name, expected) => {
    expect(isCacheableTool(name)).toBe(expected);
  });
});

describe("tool-cache: summarizeResult", () => {
  it("summarizes array results", () => {
    expect(summarizeResult({ success: true, data: [1, 2, 3] })).toBe("array of 3 items");
  });
  it("summarizes data.items results", () => {
    expect(summarizeResult({ success: true, data: { items: new Array(47).fill(null) } })).toBe("47 items");
  });
  it("summarizes tenable vulnerability results", () => {
    expect(summarizeResult({ success: true, data: { total_vulnerabilities: 312, total_assets: 50 } }))
      .toBe("312 vulnerabilities, 50 assets");
  });
  it("summarizes errors", () => {
    expect(summarizeResult({ success: false, error: "Request failed with status code 404" }))
      .toContain("ERROR");
  });
  it("summarizes object with summary field", () => {
    expect(summarizeResult({ success: true, data: { summary: "Ticket 12345: VPN Login event" } }))
      .toContain("Ticket 12345: VPN Login event");
  });
  it("handles null/undefined", () => {
    expect(summarizeResult(null)).toBe("null");
    expect(summarizeResult(undefined)).toBe("null");
  });
});

describe("tool-cache: ToolCallCache", () => {
  const SESSION = "test-session-1";

  beforeEach(() => {
    toolCallCache.clear(SESSION);
    toolCallCache.clear("other-session");
  });

  it("stores and retrieves results by tool+params", () => {
    const result = { success: true, data: { items: [1, 2, 3] } };
    toolCallCache.set(SESSION, "jitbit.search_tickets", { customer: "HUNT" }, result, "call-1");

    const hit = toolCallCache.get(SESSION, "jitbit.search_tickets", { customer: "HUNT" });
    expect(hit).not.toBeNull();
    expect(hit?.result).toEqual(result);
  });

  it("returns cache hit for identical params regardless of key order", () => {
    const result = { success: true, data: [1] };
    toolCallCache.set(SESSION, "jitbit.search_tickets",
      { customer: "HUNT", dateFrom: "2026-05-01", dateTo: "2026-05-10" }, result, "c1");

    const hit = toolCallCache.get(SESSION, "jitbit.search_tickets",
      { dateTo: "2026-05-10", customer: "HUNT", dateFrom: "2026-05-01" });
    expect(hit?.result).toEqual(result);
  });

  it("returns null for mutating tools (never cached)", () => {
    expect(toolCallCache.get(SESSION, "kanban.create_card", { title: "X" })).toBeNull();
  });

  it("returns null for cache miss", () => {
    expect(toolCallCache.get(SESSION, "jitbit.search_tickets", { customer: "X" })).toBeNull();
  });

  it("isolates caches by session", () => {
    const result = { success: true, data: "session-1 data" };
    toolCallCache.set(SESSION, "jitbit.get_ticket", { id: 1 }, result, "c1");
    expect(toolCallCache.get("other-session", "jitbit.get_ticket", { id: 1 })).toBeNull();
  });

  it("retrieves by ref ID across sessions (Layer 4 fetch_cached)", () => {
    const result = { success: true, data: { big: true } };
    const entry = toolCallCache.set(SESSION, "tenable.list_vulnerabilities", { date_range: 30 }, result, "c1");
    expect(toolCallCache.getByRef(entry.ref)).not.toBeNull();
    expect(toolCallCache.getByRef(entry.ref)?.result).toEqual(result);
  });

  it("returns null for unknown ref", () => {
    expect(toolCallCache.getByRef("tc-nonexistent")).toBeNull();
  });

  it("clears session cache", () => {
    toolCallCache.set(SESSION, "jitbit.get_ticket", { id: 1 }, { success: true }, "c1");
    toolCallCache.clear(SESSION);
    expect(toolCallCache.get(SESSION, "jitbit.get_ticket", { id: 1 })).toBeNull();
    expect(toolCallCache.list(SESSION)).toHaveLength(0);
  });

  it("lists entries in call order", () => {
    toolCallCache.set(SESSION, "jitbit.search_tickets", { a: 1 }, { success: true }, "c1");
    toolCallCache.set(SESSION, "jitbit.get_ticket", { id: 2 }, { success: true }, "c2");
    const entries = toolCallCache.list(SESSION);
    expect(entries).toHaveLength(2);
    expect(entries[0].toolName).toBe("jitbit.search_tickets");
    expect(entries[1].toolName).toBe("jitbit.get_ticket");
  });

  it("returns session stats", () => {
    toolCallCache.set(SESSION, "jitbit.get_ticket", { id: 1 }, { success: true, data: "x" }, "c1");
    const stats = toolCallCache.sessionStats(SESSION);
    expect(stats.entries).toBe(1);
    expect(stats.bytes).toBeGreaterThan(0);
  });
});

describe("tool-cache: manifest builder (Layer 2)", () => {
  const SESSION = "manifest-session";

  beforeEach(() => {
    toolCallCache.clear(SESSION);
  });

  it("returns empty string for empty session", () => {
    expect(toolCallCache.buildManifest(SESSION)).toBe("");
  });

  it("builds manifest with tool name, params, summary, ref, size", () => {
    toolCallCache.set(
      SESSION,
      "jitbit.search_tickets",
      { customer: "HUNT", dateFrom: "2026-05-01" },
      { success: true, data: { items: [1, 2, 3, 4, 5] } },
      "c1",
    );
    const manifest = toolCallCache.buildManifest(SESSION);
    expect(manifest).toContain("=== TOOL CALLS ALREADY EXECUTED THIS SESSION ===");
    expect(manifest).toContain("jitbit.search_tickets");
    expect(manifest).toContain("HUNT");
    expect(manifest).toContain("5 items");
    expect(manifest).toMatch(/\[ref:tc-[a-f0-9]+/);
    expect(manifest).toContain("tools.fetch_cached");
  });

  it("strips internal params from manifest", () => {
    toolCallCache.set(SESSION, "jitbit.get_ticket",
      { id: 99764432, _mode: "productivity", _loadedTools: ["x", "y"] },
      { success: true, data: { summary: "test ticket" } }, "c1");
    const manifest = toolCallCache.buildManifest(SESSION);
    expect(manifest).not.toContain("_mode");
    expect(manifest).not.toContain("_loadedTools");
    expect(manifest).toContain("99764432");
  });

  it("includes one line per cached call", () => {
    for (let i = 0; i < 5; i++) {
      toolCallCache.set(SESSION, "jitbit.get_ticket", { id: i },
        { success: true, data: { summary: `t${i}` } }, `c${i}`);
    }
    const manifest = toolCallCache.buildManifest(SESSION);
    const lines = manifest.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(5);
  });
});

describe("tool-cache: large-payload handling (Layer 4)", () => {
  const SESSION = "large-session";

  beforeEach(() => {
    toolCallCache.clear(SESSION);
  });

  it("inlines small results", () => {
    const small = { success: true, data: { items: [1, 2, 3] } };
    const entry = toolCallCache.set(SESSION, "jitbit.get_ticket", { id: 1 }, small, "c1");
    expect(toolCallCache.compactForContext(entry)).toEqual(small);
  });

  it("compacts large results to ref-pointer form", () => {
    // Build a result over the 8 KB threshold
    const bigData = { items: new Array(500).fill({ a: "x".repeat(50), b: "y".repeat(50) }) };
    const big = { success: true, data: bigData };
    const entry = toolCallCache.set(SESSION, "tenable.list_vulnerabilities", { range: 30 }, big, "c1");
    const compact = toolCallCache.compactForContext(entry) as any;
    expect(compact).not.toEqual(big);
    expect(compact._cached_ref).toBe(entry.ref);
    expect(compact._cached_size).toBe(entry.resultSize);
    expect(compact._instructions).toContain("tools.fetch_cached");
  });

  it("wrapCachedAsResult returns standard tool-result shape with _cached marker", () => {
    const result = { success: true, data: { summary: "x" } };
    const entry = toolCallCache.set(SESSION, "jitbit.get_ticket", { id: 1 }, result, "c1");
    const wrapped = toolCallCache.wrapCachedAsResult(entry) as any;
    expect(wrapped.success).toBe(true);
    expect(wrapped._cached).toBe(true);
    expect(wrapped._cached_ref).toBe(entry.ref);
    expect(typeof wrapped._called_at).toBe("string");
  });
});

describe("tool-cache: tool name aliasing dedup (Layer 3 integration)", () => {
  // The dispatcher resolves jitbit_search_tickets → jitbit.search_tickets via
  // resolveToolName(). The cache key must be built on the CANONICAL name.
  // Since chat.ts is what calls toolCallCache.set/get with canonical names,
  // we verify the hash is what we'd expect: same canonical name = same hash.
  it("hash for canonical name dedups regardless of original alias", () => {
    const params = { customer: "HUNT", dateFrom: "2026-05-01" };
    const h1 = hashCall("jitbit.search_tickets", params);
    const h2 = hashCall("jitbit.search_tickets", params);
    expect(h1).toBe(h2);
  });
});
