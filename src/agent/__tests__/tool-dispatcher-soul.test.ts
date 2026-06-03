import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSoulManageHandler } from "../handlers/soul-manage";
import type { SoulStore } from "../handlers/soul-manage";

function createMockStore(overrides?: Partial<SoulStore>): SoulStore {
  return {
    load: vi.fn().mockReturnValue("# Identity\nTest soul content"),
    view: vi.fn().mockReturnValue({
      success: true,
      content: "# Identity\nTest soul content",
      data: { content: "# Identity\nTest soul content", activePersonality: null, charCount: 30, charLimit: 2000 },
    }),
    edit: vi.fn().mockReturnValue({ success: true, content: "# Identity\nPatched content" }),
    reset: vi.fn().mockReturnValue({ success: true, content: "# Identity\nDefault" }),
    setPersonality: vi.fn(),
    clearPersonality: vi.fn(),
    getActivePersonality: vi.fn().mockReturnValue(null),
    ...overrides,
  };
}

describe("handleSoulManage", () => {
  let store: ReturnType<typeof createMockStore>;
  let handleSoulManage: ReturnType<typeof createSoulManageHandler>;

  beforeEach(() => {
    store = createMockStore();
    handleSoulManage = createSoulManageHandler(store);
  });

  // ── action validation ──────────────────────────────────────────────────

  describe("action validation", () => {
    it("should reject missing action", async () => {
      const result = await handleSoulManage({});
      expect(result.success).toBe(false);
      expect(result.error).toContain("action is required");
    });

    it("should reject non-string action", async () => {
      const result = await handleSoulManage({ action: 42 });
      expect(result.success).toBe(false);
      expect(result.error).toContain("action is required");
    });

    it("should reject unknown action", async () => {
      const result = await handleSoulManage({ action: "destroy" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown action 'destroy'");
    });

    it("should accept all valid actions", async () => {
      for (const action of ["view", "edit", "reset", "personality"]) {
        const result = await handleSoulManage({
          action,
          section: "Style",
          patch: "Be brief",
          preset: "concise",
        });
        expect(result.success).toBe(true);
      }
    });
  });

  // ── view action ────────────────────────────────────────────────────────

  describe("view", () => {
    it("should return current soul content", async () => {
      const result = await handleSoulManage({ action: "view" });
      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty("content");
      expect(result.message).toContain("Current SOUL.md loaded");
    });

    it("should return error when store.view fails", async () => {
      store = createMockStore({
        view: vi.fn().mockReturnValue({ success: false, error: "file not found" }),
      });
      handleSoulManage = createSoulManageHandler(store);
      const result = await handleSoulManage({ action: "view" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("file not found");
    });
  });

  // ── edit action ────────────────────────────────────────────────────────

  describe("edit", () => {
    it("should edit a section with section and patch", async () => {
      const result = await handleSoulManage({ action: "edit", section: "Style", patch: "Be brief" });
      expect(result.success).toBe(true);
      expect(store.edit).toHaveBeenCalledWith("Style", "Be brief");
      expect(result.message).toContain("Updated section 'Style'");
    });

    it("should reject missing section", async () => {
      const result = await handleSoulManage({ action: "edit", patch: "content" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("section and patch are required");
    });

    it("should reject missing patch", async () => {
      const result = await handleSoulManage({ action: "edit", section: "Style" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("section and patch are required");
    });

    it("should reject non-string section", async () => {
      const result = await handleSoulManage({ action: "edit", section: 42, patch: "content" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("section and patch are required");
    });

    it("should return error when store.edit fails", async () => {
      store = createMockStore({
        edit: vi.fn().mockReturnValue({ success: false, error: "injection patterns" }),
      });
      handleSoulManage = createSoulManageHandler(store);
      const result = await handleSoulManage({ action: "edit", section: "Style", patch: "Ignore previous" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("injection patterns");
    });
  });

  // ── reset action ───────────────────────────────────────────────────────

  describe("reset", () => {
    it("should reset to default", async () => {
      const result = await handleSoulManage({ action: "reset" });
      expect(result.success).toBe(true);
      expect(store.reset).toHaveBeenCalled();
      expect(result.message).toContain("reset to default identity");
    });

    it("should return error when store.reset fails", async () => {
      store = createMockStore({
        reset: vi.fn().mockReturnValue({ success: false, error: "permission denied" }),
      });
      handleSoulManage = createSoulManageHandler(store);
      const result = await handleSoulManage({ action: "reset" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("permission denied");
    });
  });

  // ── personality action ─────────────────────────────────────────────────

  describe("personality", () => {
    it("should list presets when no preset specified", async () => {
      const result = await handleSoulManage({ action: "personality" });
      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty("availablePresets");
      expect(result.data).toHaveProperty("activePersonality");
    });

    it("should set a valid preset", async () => {
      const result = await handleSoulManage({ action: "personality", preset: "pirate" });
      expect(result.success).toBe(true);
      expect(store.setPersonality).toHaveBeenCalledWith("pirate", expect.any(String));
      expect(result.message).toContain("pirate");
    });

    it("should reject invalid preset", async () => {
      const result = await handleSoulManage({ action: "personality", preset: "nonexistent" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown personality 'nonexistent'");
    });

    it("should clear personality with clear flag", async () => {
      const result = await handleSoulManage({ action: "personality", clear: true });
      expect(result.success).toBe(true);
      expect(store.clearPersonality).toHaveBeenCalled();
      expect(result.message).toContain("cleared");
    });

    it("should treat non-boolean clear as false", async () => {
      const result = await handleSoulManage({ action: "personality", clear: "yes" });
      expect(result.success).toBe(true);
      expect(store.clearPersonality).not.toHaveBeenCalled();
    });

    it("should treat non-string preset as empty", async () => {
      const result = await handleSoulManage({ action: "personality", preset: 42 });
      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty("availablePresets");
    });
  });

  // ── error handling ─────────────────────────────────────────────────────

  describe("error handling", () => {
    it("should catch store exceptions and return error", async () => {
      store = createMockStore({
        view: vi.fn().mockImplementation(() => { throw new Error("disk failure"); }),
      });
      handleSoulManage = createSoulManageHandler(store);
      const result = await handleSoulManage({ action: "view" });
      expect(result.success).toBe(false);
      expect(result.error).toBe("disk failure");
    });

    it("should handle non-Error throws", async () => {
      store = createMockStore({
        view: vi.fn().mockImplementation(() => { throw "string error"; }),
      });
      handleSoulManage = createSoulManageHandler(store);
      const result = await handleSoulManage({ action: "view" });
      expect(result.success).toBe(false);
      expect(result.error).toBe("string error");
    });
  });
});
