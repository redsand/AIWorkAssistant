import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { toolCallCache, type CachedToolCall } from "../tool-cache";

describe("toolCallCache TTL", () => {
  const sessionId = "test-session";

  beforeEach(() => {
    vi.useFakeTimers();
    toolCallCache.clear(sessionId);
  });

  afterEach(() => {
    vi.useRealTimers();
    toolCallCache.clear(sessionId);
  });

  function setMutableEntry(toolName: string, ttlMs: number): CachedToolCall {
    const entry = toolCallCache.set(sessionId, toolName, { id: 1 }, { state: "open" }, "tc-1");
    expect(entry.ttlMs).toBe(ttlMs);
    return entry;
  }

  it("stores a 120s TTL for github.get_issue", () => {
    const entry = setMutableEntry("github.get_issue", 120_000);
    expect(entry.toolName).toBe("github.get_issue");
  });

  it("stores a 60s TTL for github.list_workflow_runs", () => {
    const entry = setMutableEntry("github.list_workflow_runs", 60_000);
    expect(entry.toolName).toBe("github.list_workflow_runs");
  });

  it("stores Infinity TTL for unknown cacheable tools", () => {
    const entry = toolCallCache.set(
      sessionId,
      "filesystem.read_file",
      { path: "/tmp/foo.txt" },
      "content",
      "tc-2",
    );
    expect(entry.ttlMs).toBe(Infinity);
  });

  it("returns mutable data before TTL expires", () => {
    toolCallCache.set(sessionId, "github.get_issue", { id: 1 }, { state: "open" }, "tc-1");
    vi.advanceTimersByTime(119_000);
    const cached = toolCallCache.get(sessionId, "github.get_issue", { id: 1 });
    expect(cached).not.toBeNull();
    expect((cached!.result as { state: string }).state).toBe("open");
  });

  it("returns null and evicts a mutable entry after TTL expires", () => {
    const entry = toolCallCache.set(
      sessionId,
      "github.get_issue",
      { id: 1 },
      { state: "open" },
      "tc-1",
    );
    vi.advanceTimersByTime(120_001);
    const cached = toolCallCache.get(sessionId, "github.get_issue", { id: 1 });
    expect(cached).toBeNull();
    expect(toolCallCache.getByRef(entry.ref)).toBeNull();
    expect(toolCallCache.list(sessionId)).toHaveLength(0);
  });

  it("returns immutable data regardless of age", () => {
    toolCallCache.set(
      sessionId,
      "filesystem.read_file",
      { path: "/tmp/foo.txt" },
      "content",
      "tc-2",
    );
    vi.advanceTimersByTime(7 * 24 * 3600 * 1000); // 7 days
    const cached = toolCallCache.get(sessionId, "filesystem.read_file", { path: "/tmp/foo.txt" });
    expect(cached).not.toBeNull();
    expect(cached!.result).toBe("content");
  });

  it("evicts expired entries from both bySession and byRef maps on get", () => {
    const entry = toolCallCache.set(
      sessionId,
      "jira.get_issue",
      { key: "PROJ-1" },
      { status: "In Progress" },
      "tc-3",
    );
    vi.advanceTimersByTime(120_001);
    expect(toolCallCache.get(sessionId, "jira.get_issue", { key: "PROJ-1" })).toBeNull();
    expect(toolCallCache.list(sessionId)).toHaveLength(0);
    expect(toolCallCache.getByRef(entry.ref)).toBeNull();
  });

  it("does not cache non-read tools regardless of TTL map", () => {
    expect(toolCallCache.get(sessionId, "github.create_issue", { title: "x" })).toBeNull();
    const entry = toolCallCache.set(
      sessionId,
      "github.create_issue",
      { title: "x" },
      { id: 123 },
      "tc-4",
    );
    expect(entry.ttlMs).toBe(Infinity);
    expect(toolCallCache.get(sessionId, "github.create_issue", { title: "x" })).toBeNull();
  });

  it("covers all required mutable-state tools", () => {
    const mutableTools = [
      "github.get_issue",
      "github.get_pull_request",
      "github.list_issues",
      "github.list_pull_requests",
      "github.list_workflow_runs",
      "github.get_workflow_run",
      "gitlab.get_issue",
      "gitlab.get_merge_request",
      "gitlab.list_merge_requests",
      "jira.get_issue",
      "jira.search_issues",
      "hawk_ir.get_case",
      "hawk_ir.list_cases",
      "system.list_approvals",
    ];
    for (const toolName of mutableTools) {
      const entry = toolCallCache.set(sessionId, toolName, {}, { ok: true }, `tc-${toolName}`);
      expect(entry.ttlMs).toBeLessThan(Infinity);
      expect(entry.ttlMs).toBeGreaterThan(0);
    }
  });

  it("evicts expired entries from both bySession and byRef maps on get", () => {
    const entry = toolCallCache.set(
      sessionId,
      "jira.get_issue",
      { key: "PROJ-1" },
      { status: "In Progress" },
      "tc-3",
    );
    vi.advanceTimersByTime(120_001);
    expect(toolCallCache.get(sessionId, "jira.get_issue", { key: "PROJ-1" })).toBeNull();
    expect(toolCallCache.list(sessionId)).toHaveLength(0);
    expect(toolCallCache.getByRef(entry.ref)).toBeNull();
  });

  it("getByRef returns null for an expired mutable entry", () => {
    const entry = toolCallCache.set(
      sessionId,
      "gitlab.get_merge_request",
      { iid: 42 },
      { state: "opened" },
      "tc-5",
    );
    vi.advanceTimersByTime(120_001);
    expect(toolCallCache.getByRef(entry.ref)).toBeNull();
    expect(toolCallCache.list(sessionId)).toHaveLength(0);
  });

  it("buildManifest omits expired mutable entries", () => {
    toolCallCache.set(sessionId, "github.get_issue", { id: 1 }, { state: "open" }, "tc-1");
    vi.advanceTimersByTime(120_001);
    const manifest = toolCallCache.buildManifest(sessionId);
    expect(manifest).toBe("");
  });
});
