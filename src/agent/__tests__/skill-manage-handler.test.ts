import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSkillManageHandler } from "../handlers/skill-manage";
import type { SkillStore } from "../handlers/skill-manage";

function createMockStore(overrides?: Partial<SkillStore>): SkillStore {
  return {
    create: vi.fn().mockReturnValue({ success: true, data: { filePath: "cat/name/SKILL.md" }, message: "Created" }),
    patch: vi.fn().mockReturnValue({ success: true, message: "Patched" }),
    edit: vi.fn().mockReturnValue({ success: true, message: "Edited" }),
    delete: vi.fn().mockReturnValue({ success: true, message: "Archived" }),
    list: vi.fn().mockReturnValue([]),
    search: vi.fn().mockReturnValue([]),
    loadFull: vi.fn().mockReturnValue(null),
    ...overrides,
  };
}

describe("handleSkillManage", () => {
  let store: ReturnType<typeof createMockStore>;
  let handleSkillManage: ReturnType<typeof createSkillManageHandler>;

  beforeEach(() => {
    store = createMockStore();
    handleSkillManage = createSkillManageHandler(store);
  });

  // ── action validation ──────────────────────────────────────────────────

  describe("action validation", () => {
    it("should reject missing action", async () => {
      const result = await handleSkillManage({});
      expect(result.success).toBe(false);
      expect(result.error).toContain("action is required");
    });

    it("should reject non-string action", async () => {
      const result = await handleSkillManage({ action: 42 });
      expect(result.success).toBe(false);
      expect(result.error).toContain("action is required");
    });

    it("should reject unknown action", async () => {
      const result = await handleSkillManage({ action: "foobar" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown action");
    });
  });

  // ── create ─────────────────────────────────────────────────────────────

  describe("create", () => {
    it("should require name, description, category, and body", async () => {
      const result = await handleSkillManage({ action: "create" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("name, description, and category are required");
    });

    it("should require body", async () => {
      const result = await handleSkillManage({ action: "create", name: "x", description: "d", category: "c" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("body is required");
    });

    it("should succeed with all required fields", async () => {
      const result = await handleSkillManage({
        action: "create",
        name: "fix-auth",
        description: "Fix auth flow",
        category: "debugging",
        body: "## When to Use\nWhen auth breaks",
      });
      expect(result.success).toBe(true);
      expect(store.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: "fix-auth", description: "Fix auth flow", category: "debugging" }),
      );
    });
  });

  // ── list (no create-required fields needed) ────────────────────────────

  describe("list", () => {
    it("should succeed without name, description, category, or body", async () => {
      const result = await handleSkillManage({ action: "list" });
      expect(result.success).toBe(true);
      expect(store.list).toHaveBeenCalled();
    });

    it("should pass optional category filter", async () => {
      const result = await handleSkillManage({ action: "list", category: "debugging" });
      expect(result.success).toBe(true);
      expect(store.list).toHaveBeenCalledWith("debugging");
    });
  });

  // ── search (no create-required fields needed) ──────────────────────────

  describe("search", () => {
    it("should require query", async () => {
      const result = await handleSkillManage({ action: "search" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("query is required");
    });

    it("should succeed with only query (no name/description/category/body)", async () => {
      const result = await handleSkillManage({ action: "search", query: "auth" });
      expect(result.success).toBe(true);
      expect(store.search).toHaveBeenCalledWith("auth");
    });
  });

  // ── delete (no create-required fields needed) ──────────────────────────

  describe("delete", () => {
    it("should require skill_path", async () => {
      const result = await handleSkillManage({ action: "delete" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("skill_path is required");
    });

    it("should succeed with only skill_path (no name/description/category/body)", async () => {
      const result = await handleSkillManage({ action: "delete", skill_path: "debugging/fix-auth/SKILL.md" });
      expect(result.success).toBe(true);
      expect(store.delete).toHaveBeenCalledWith("debugging/fix-auth/SKILL.md");
    });

    it("should reject path traversal in skill_path", async () => {
      const result = await handleSkillManage({ action: "delete", skill_path: "../etc/passwd" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("invalid characters or path traversal");
    });
  });

  // ── load (no create-required fields needed) ────────────────────────────

  describe("load", () => {
    it("should require skill_path", async () => {
      const result = await handleSkillManage({ action: "load" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("skill_path is required");
    });

    it("should succeed with only skill_path (no name/description/category/body)", async () => {
      store.loadFull = vi.fn().mockReturnValue({
        frontmatter: { name: "fix-auth", description: "d", category: "debugging" },
        body: "## When to Use",
        filePath: "/tmp/skills/debugging/fix-auth/SKILL.md",
      });
      const result = await handleSkillManage({ action: "load", skill_path: "debugging/fix-auth/SKILL.md" });
      expect(result.success).toBe(true);
    });
  });

  // ── patch (no create-required fields needed) ───────────────────────────

  describe("patch", () => {
    it("should require skill_path, section, and new_content", async () => {
      const result = await handleSkillManage({ action: "patch" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("skill_path, section, and new_content");
    });

    it("should succeed with skill_path, section, and new_content (no name/description/category)", async () => {
      const result = await handleSkillManage({
        action: "patch",
        skill_path: "debugging/fix-auth/SKILL.md",
        section: "Procedure",
        new_content: "New steps",
      });
      expect(result.success).toBe(true);
      expect(store.patch).toHaveBeenCalledWith("debugging/fix-auth/SKILL.md", "Procedure", "New steps");
    });

    it("should accept body as fallback for new_content", async () => {
      const result = await handleSkillManage({
        action: "patch",
        skill_path: "debugging/fix-auth/SKILL.md",
        section: "Procedure",
        body: "Body as new content",
      });
      expect(result.success).toBe(true);
      expect(store.patch).toHaveBeenCalledWith("debugging/fix-auth/SKILL.md", "Procedure", "Body as new content");
    });
  });

  // ── edit (no name/description/category needed) ─────────────────────────

  describe("edit", () => {
    it("should require skill_path and body", async () => {
      const result = await handleSkillManage({ action: "edit" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("skill_path and body are required");
    });

    it("should succeed with skill_path and body (no name/description/category)", async () => {
      const result = await handleSkillManage({
        action: "edit",
        skill_path: "debugging/fix-auth/SKILL.md",
        body: "## Updated body",
      });
      expect(result.success).toBe(true);
      expect(store.edit).toHaveBeenCalledWith("debugging/fix-auth/SKILL.md", "## Updated body");
    });
  });
});
