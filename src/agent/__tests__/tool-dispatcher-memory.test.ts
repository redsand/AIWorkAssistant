import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMemoryManageHandler } from "../handlers/memory-manage";
import type { MemoryStore } from "../handlers/memory-manage";

function createMockStore(overrides?: Partial<MemoryStore>): MemoryStore {
  return {
    add: vi.fn().mockReturnValue({ success: true }),
    replace: vi.fn().mockReturnValue({ success: true }),
    remove: vi.fn().mockReturnValue({ success: true }),
    consolidate: vi.fn().mockReturnValue({ success: true }),
    getUsage: vi.fn().mockReturnValue({ used: 100, total: 2200, percent: 5 }),
    getEntries: vi.fn().mockReturnValue([]),
    shouldConsolidate: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

describe("handleMemoryManage", () => {
  let store: ReturnType<typeof createMockStore>;
  let handleMemoryManage: ReturnType<typeof createMemoryManageHandler>;

  beforeEach(() => {
    store = createMockStore();
    handleMemoryManage = createMemoryManageHandler(store);
  });

  // ── action validation ──────────────────────────────────────────────────

  describe("action validation", () => {
    it("should reject missing action", async () => {
      const result = await handleMemoryManage({});
      expect(result.success).toBe(false);
      expect(result.error).toContain("action is required");
    });

    it("should reject non-string action", async () => {
      const result = await handleMemoryManage({ action: 42 });
      expect(result.success).toBe(false);
      expect(result.error).toContain("action is required");
    });

    it("should reject unknown action", async () => {
      const result = await handleMemoryManage({ action: "explode" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown action 'explode'");
    });

    it("should accept all valid actions", async () => {
      for (const action of ["add", "replace", "remove", "consolidate", "status"]) {
        const result = await handleMemoryManage({
          action,
          key: "k",
          value: "v",
          source_keys: "a,b",
          merged_key: "m",
          merged_value: "mv",
        });
        expect(result.success).toBe(true);
      }
    });
  });

  // ── target validation ──────────────────────────────────────────────────

  describe("target validation", () => {
    it("should default target to 'memory'", async () => {
      await handleMemoryManage({ action: "status" });
      expect(store.getUsage).toHaveBeenCalledWith("memory");
    });

    it("should accept target 'user'", async () => {
      await handleMemoryManage({ action: "status", target: "user" });
      expect(store.getUsage).toHaveBeenCalledWith("user");
    });

    it("should treat invalid target as 'memory'", async () => {
      await handleMemoryManage({ action: "status", target: "invalid" });
      expect(store.getUsage).toHaveBeenCalledWith("memory");
    });

    it("should treat non-string target as 'memory'", async () => {
      await handleMemoryManage({ action: "status", target: 123 });
      expect(store.getUsage).toHaveBeenCalledWith("memory");
    });
  });

  // ── add action ─────────────────────────────────────────────────────────

  describe("add", () => {
    it("should add entry and return success", async () => {
      const result = await handleMemoryManage({
        action: "add", key: "pref_stack", value: "TypeScript + React",
      });
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ message: expect.stringContaining("Added 'pref_stack'") });
      expect(store.add).toHaveBeenCalledWith("memory", "pref_stack", "TypeScript + React");
    });

    it("should add entry to user target", async () => {
      const result = await handleMemoryManage({
        action: "add", target: "user", key: "theme", value: "dark",
      });
      expect(result.success).toBe(true);
      expect(store.add).toHaveBeenCalledWith("user", "theme", "dark");
    });

    it("should reject missing key", async () => {
      const result = await handleMemoryManage({ action: "add", value: "v" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("key and value are required");
    });

    it("should reject missing value", async () => {
      const result = await handleMemoryManage({ action: "add", key: "k" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("key and value are required");
    });

    it("should reject non-string key", async () => {
      const result = await handleMemoryManage({ action: "add", key: 42, value: "v" });
      expect(result.success).toBe(false);
    });

    it("should return error when store rejects (capacity)", async () => {
      store = createMockStore({
        add: vi.fn().mockReturnValue({
          success: false,
          error: "exceeds limit",
          entries: [{ key: "existing", value: "v", timestamp: "", accessCount: 1 }],
        }),
      });
      handleMemoryManage = createMemoryManageHandler(store);

      const result = await handleMemoryManage({ action: "add", key: "big", value: "x".repeat(3000) });
      expect(result.success).toBe(false);
      expect(result.error).toContain("exceeds limit");
      expect(result.data).toMatchObject({ entries: expect.any(Array) });
    });
  });

  // ── replace action ─────────────────────────────────────────────────────

  describe("replace", () => {
    it("should replace entry and return success", async () => {
      const result = await handleMemoryManage({
        action: "replace", key: "pref_stack", value: "Rust + Svelte",
      });
      expect(result.success).toBe(true);
      expect(store.replace).toHaveBeenCalledWith("memory", "pref_stack", "Rust + Svelte");
    });

    it("should reject missing key", async () => {
      const result = await handleMemoryManage({ action: "replace", value: "v" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("key and value are required");
    });

    it("should return error when key not found", async () => {
      store = createMockStore({
        replace: vi.fn().mockReturnValue({ success: false, error: "Entry 'missing' not found" }),
      });
      handleMemoryManage = createMemoryManageHandler(store);

      const result = await handleMemoryManage({ action: "replace", key: "missing", value: "v" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  // ── remove action ──────────────────────────────────────────────────────

  describe("remove", () => {
    it("should remove entry and return success", async () => {
      const result = await handleMemoryManage({
        action: "remove", key: "stale_pref",
      });
      expect(result.success).toBe(true);
      expect(store.remove).toHaveBeenCalledWith("memory", "stale_pref");
    });

    it("should reject missing key", async () => {
      const result = await handleMemoryManage({ action: "remove" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("key is required");
    });

    it("should return error when key not found", async () => {
      store = createMockStore({
        remove: vi.fn().mockReturnValue({ success: false, error: "Entry 'ghost' not found" }),
      });
      handleMemoryManage = createMemoryManageHandler(store);

      const result = await handleMemoryManage({ action: "remove", key: "ghost" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  // ── consolidate action ─────────────────────────────────────────────────

  describe("consolidate", () => {
    it("should consolidate entries and return success", async () => {
      const result = await handleMemoryManage({
        action: "consolidate",
        source_keys: "pref1, pref2",
        merged_key: "merged_prefs",
        merged_value: "Prefers TypeScript and React",
      });
      expect(result.success).toBe(true);
      expect(store.consolidate).toHaveBeenCalledWith(
        "memory",
        ["pref1", "pref2"],
        "merged_prefs",
        "Prefers TypeScript and React",
      );
    });

    it("should reject missing source_keys", async () => {
      const result = await handleMemoryManage({
        action: "consolidate", merged_key: "m", merged_value: "v",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("source_keys");
    });

    it("should reject missing merged_key", async () => {
      const result = await handleMemoryManage({
        action: "consolidate", source_keys: "a,b", merged_value: "v",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("merged_key");
    });

    it("should reject missing merged_value", async () => {
      const result = await handleMemoryManage({
        action: "consolidate", source_keys: "a,b", merged_key: "m",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("merged_value");
    });

    it("should reject empty source_keys after trimming", async () => {
      const result = await handleMemoryManage({
        action: "consolidate", source_keys: " , , ", merged_key: "m", merged_value: "v",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("at least one key");
    });

    it("should reject source_keys exceeding max length", async () => {
      const keys = Array.from({ length: 21 }, (_, i) => `key${i}`).join(",");
      const result = await handleMemoryManage({
        action: "consolidate", source_keys: keys, merged_key: "m", merged_value: "v",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("at most 20 keys");
    });

    it("should accept source_keys at exactly max length", async () => {
      const keys = Array.from({ length: 20 }, (_, i) => `key${i}`).join(",");
      const result = await handleMemoryManage({
        action: "consolidate", source_keys: keys, merged_key: "m", merged_value: "v",
      });
      expect(result.success).toBe(true);
    });

    it("should trim whitespace from source_keys", async () => {
      await handleMemoryManage({
        action: "consolidate",
        source_keys: "  key1  ,  key2  ",
        merged_key: "merged",
        merged_value: "value",
      });
      expect(store.consolidate).toHaveBeenCalledWith(
        "memory",
        ["key1", "key2"],
        "merged",
        "value",
      );
    });

    it("should return error when store rejects consolidation", async () => {
      store = createMockStore({
        consolidate: vi.fn().mockReturnValue({ success: false, error: "Source 'missing' not found" }),
      });
      handleMemoryManage = createMemoryManageHandler(store);

      const result = await handleMemoryManage({
        action: "consolidate", source_keys: "missing", merged_key: "m", merged_value: "v",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  // ── status action ──────────────────────────────────────────────────────

  describe("status", () => {
    it("should return usage, entries, and consolidation flag", async () => {
      store = createMockStore({
        getUsage: vi.fn().mockReturnValue({ used: 1800, total: 2200, percent: 82 }),
        getEntries: vi.fn().mockReturnValue([
          { key: "k1", value: "v1", timestamp: "2026-01-01", accessCount: 3 },
        ]),
        shouldConsolidate: vi.fn().mockReturnValue(true),
      });
      handleMemoryManage = createMemoryManageHandler(store);

      const result = await handleMemoryManage({ action: "status" });
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        target: "memory",
        usage: { used: 1800, total: 2200, percent: 82 },
        entries: [{ key: "k1" }],
        shouldConsolidate: true,
      });
    });

    it("should return status for user target", async () => {
      await handleMemoryManage({ action: "status", target: "user" });
      expect(store.getUsage).toHaveBeenCalledWith("user");
      expect(store.getEntries).toHaveBeenCalledWith("user");
      expect(store.shouldConsolidate).toHaveBeenCalledWith("user");
    });
  });

  // ── error handling ─────────────────────────────────────────────────────

  describe("error handling", () => {
    it("should catch store exceptions and return error", async () => {
      store = createMockStore({
        add: vi.fn().mockImplementation(() => { throw new Error("disk full"); }),
      });
      handleMemoryManage = createMemoryManageHandler(store);

      const result = await handleMemoryManage({
        action: "add", key: "k", value: "v",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe("disk full");
    });

    it("should handle non-Error throws", async () => {
      store = createMockStore({
        add: vi.fn().mockImplementation(() => { throw "string error"; }),
      });
      handleMemoryManage = createMemoryManageHandler(store);

      const result = await handleMemoryManage({
        action: "add", key: "k", value: "v",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe("string error");
    });
  });
});
