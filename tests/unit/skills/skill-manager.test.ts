import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSkillManageHandler } from "../../../src/agent/handlers/skill-manage";
import type { SkillStore } from "../../../src/agent/handlers/skill-manage";
import { SkillManager } from "../../../src/skills/skill-manager";
import fs from "fs";
import path from "path";
import os from "os";

// ── Handler tests (mock store) ──────────────────────────────────────

function createMockStore(overrides?: Partial<SkillStore>): SkillStore {
  return {
    create: vi.fn().mockReturnValue({ success: true, data: { filePath: "test/my-skill/SKILL.md" }, message: "Created skill 'my-skill'" }),
    patch: vi.fn().mockReturnValue({ success: true, message: "Patched section" }),
    edit: vi.fn().mockReturnValue({ success: true, message: "Edited skill" }),
    delete: vi.fn().mockReturnValue({ success: true, message: "Archived skill" }),
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

  // ── action validation ──────────────────────────────────────────────

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

  // ── create ─────────────────────────────────────────────────────────

  describe("create", () => {
    it("should create a skill with all required params", async () => {
      const result = await handleSkillManage({
        action: "create",
        name: "fix-auth",
        description: "Fix authentication issues",
        category: "debugging",
        tags: ["auth", "security"],
        body: "## When to Use\nWhen auth fails.\n## Procedure\n1. Check logs",
      });
      expect(result.success).toBe(true);
      expect(store.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "fix-auth",
          description: "Fix authentication issues",
          category: "debugging",
          tags: ["auth", "security"],
        }),
      );
    });

    it("should reject create without name", async () => {
      const result = await handleSkillManage({
        action: "create",
        description: "test",
        category: "test",
        body: "content",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("name, description, and category");
    });

    it("should reject create without body", async () => {
      const result = await handleSkillManage({
        action: "create",
        name: "test",
        description: "test",
        category: "test",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("body is required");
    });
  });

  // ── patch ──────────────────────────────────────────────────────────

  describe("patch", () => {
    it("should patch a skill section", async () => {
      const result = await handleSkillManage({
        action: "patch",
        skill_path: "debugging/fix-auth/SKILL.md",
        section: "Procedure",
        new_content: "1. New procedure step",
      });
      expect(result.success).toBe(true);
      expect(store.patch).toHaveBeenCalledWith(
        "debugging/fix-auth/SKILL.md",
        "Procedure",
        "1. New procedure step",
      );
    });

    it("should reject patch without required params", async () => {
      const result = await handleSkillManage({
        action: "patch",
        skill_path: "test",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("skill_path, section, and new_content");
    });
  });

  // ── edit ───────────────────────────────────────────────────────────

  describe("edit", () => {
    it("should edit a skill body", async () => {
      const result = await handleSkillManage({
        action: "edit",
        skill_path: "debugging/fix-auth/SKILL.md",
        body: "New body content",
      });
      expect(result.success).toBe(true);
      expect(store.edit).toHaveBeenCalledWith(
        "debugging/fix-auth/SKILL.md",
        "New body content",
      );
    });
  });

  // ── delete ─────────────────────────────────────────────────────────

  describe("delete", () => {
    it("should archive a skill", async () => {
      const result = await handleSkillManage({
        action: "delete",
        skill_path: "debugging/fix-auth/SKILL.md",
      });
      expect(result.success).toBe(true);
      expect(store.delete).toHaveBeenCalledWith("debugging/fix-auth/SKILL.md");
    });

    it("should reject delete without skill_path", async () => {
      const result = await handleSkillManage({ action: "delete" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("skill_path is required");
    });
  });

  // ── list ───────────────────────────────────────────────────────────

  describe("list", () => {
    it("should list all skills", async () => {
      store.list = vi.fn().mockReturnValue([
        { name: "skill1", description: "First", category: "test", tags: [], status: "active", filePath: "test/skill1/SKILL.md" },
      ]);
      const result = await handleSkillManage({ action: "list" });
      expect(result.success).toBe(true);
      expect((result.data as { skills: unknown[] }).skills).toHaveLength(1);
    });

    it("should list skills filtered by category", async () => {
      store.list = vi.fn().mockReturnValue([]);
      const result = await handleSkillManage({ action: "list", category: "debugging" });
      expect(result.success).toBe(true);
      expect(store.list).toHaveBeenCalledWith("debugging");
    });
  });

  // ── search ─────────────────────────────────────────────────────────

  describe("search", () => {
    it("should search skills", async () => {
      store.search = vi.fn().mockReturnValue([
        { name: "auth-fix", description: "Fix auth", category: "debugging", tags: ["auth"], status: "active", filePath: "debugging/auth-fix/SKILL.md" },
      ]);
      const result = await handleSkillManage({ action: "search", query: "auth" });
      expect(result.success).toBe(true);
      expect(store.search).toHaveBeenCalledWith("auth");
    });

    it("should reject search without query", async () => {
      const result = await handleSkillManage({ action: "search" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("query is required");
    });
  });

  // ── load ───────────────────────────────────────────────────────────

  describe("load", () => {
    it("should load a full skill", async () => {
      store.loadFull = vi.fn().mockReturnValue({
        frontmatter: { name: "fix-auth", description: "Fix auth", status: "active" },
        body: "## Procedure\n1. Check logs",
        filePath: "/path/to/SKILL.md",
      });
      const result = await handleSkillManage({
        action: "load",
        skill_path: "debugging/fix-auth/SKILL.md",
      });
      expect(result.success).toBe(true);
      expect(result.message).toContain("fix-auth");
    });

    it("should reject load without skill_path", async () => {
      const result = await handleSkillManage({ action: "load" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("skill_path is required");
    });

    it("should return error when skill not found", async () => {
      store.loadFull = vi.fn().mockReturnValue(null);
      const result = await handleSkillManage({
        action: "load",
        skill_path: "nonexistent/skill/SKILL.md",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  // ── error handling ─────────────────────────────────────────────────

  describe("error handling", () => {
    it("should handle store exceptions", async () => {
      store.create = vi.fn().mockImplementation(() => {
        throw new Error("Disk full");
      });
      const result = await handleSkillManage({
        action: "create",
        name: "test",
        description: "test",
        category: "test",
        tags: [],
        body: "body",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe("Disk full");
    });

    it("should handle non-Error throws", async () => {
      store.list = vi.fn().mockImplementation(() => {
        throw "string error";
      });
      const result = await handleSkillManage({ action: "list" });
      expect(result.success).toBe(false);
      expect(result.error).toBe("string error");
    });
  });
});

// ── SkillManager integration tests (real filesystem) ────────────────

describe("SkillManager", () => {
  let tmpDir: string;
  let manager: SkillManager;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `skill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    manager = new SkillManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("create", () => {
    it("should create a skill file on disk", () => {
      const result = manager.create({
        name: "fix-auth",
        description: "Fix authentication flow issues",
        category: "debugging",
        tags: ["auth", "security"],
        body: "## When to Use\nAuth is broken.\n## Procedure\n1. Check logs",
      });

      expect(result.success).toBe(true);
      const skillPath = path.join(tmpDir, "debugging", "fix-auth", "SKILL.md");
      expect(fs.existsSync(skillPath)).toBe(true);

      const content = fs.readFileSync(skillPath, "utf-8");
      expect(content).toContain("name: fix-auth");
      expect(content).toContain("category: debugging");
      expect(content).toContain("status: active");
      expect(content).toContain("## When to Use");
    });

    it("should reject duplicate skill", () => {
      manager.create({
        name: "fix-auth",
        description: "Fix auth",
        category: "debugging",
        tags: [],
        body: "content",
      });

      const result = manager.create({
        name: "fix-auth",
        description: "Fix auth",
        category: "debugging",
        tags: [],
        body: "content",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("already exists");
    });

    it("should reject description over 60 chars", () => {
      const result = manager.create({
        name: "test",
        description: "a".repeat(61),
        category: "test",
        tags: [],
        body: "body",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("60 chars");
    });

    it("should reject missing required fields", () => {
      const result = manager.create({
        name: "",
        description: "test",
        category: "test",
        tags: [],
        body: "body",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("list", () => {
    it("should list skills across categories", () => {
      manager.create({
        name: "skill-a",
        description: "Skill A",
        category: "cat1",
        tags: ["a"],
        body: "body",
      });
      manager.create({
        name: "skill-b",
        description: "Skill B",
        category: "cat2",
        tags: ["b"],
        body: "body",
      });

      const skills = manager.list();
      expect(skills).toHaveLength(2);
      expect(skills.map((s) => s.name).sort()).toEqual(["skill-a", "skill-b"]);
    });

    it("should filter by category", () => {
      manager.create({
        name: "skill-a",
        description: "Skill A",
        category: "cat1",
        tags: [],
        body: "body",
      });
      manager.create({
        name: "skill-b",
        description: "Skill B",
        category: "cat2",
        tags: [],
        body: "body",
      });

      const skills = manager.list("cat1");
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe("skill-a");
    });

    it("should return empty array when no skills exist", () => {
      const skills = manager.list();
      expect(skills).toHaveLength(0);
    });
  });

  describe("search", () => {
    it("should search by name", () => {
      manager.create({
        name: "fix-auth",
        description: "Fix auth issues",
        category: "debugging",
        tags: ["auth"],
        body: "body",
      });
      manager.create({
        name: "deploy-app",
        description: "Deploy to prod",
        category: "deployment",
        tags: ["deploy"],
        body: "body",
      });

      const results = manager.search("auth");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("fix-auth");
    });

    it("should search by tag", () => {
      manager.create({
        name: "fix-auth",
        description: "Fix auth",
        category: "debugging",
        tags: ["authentication", "security"],
        body: "body",
      });

      const results = manager.search("security");
      expect(results).toHaveLength(1);
    });

    it("should be case-insensitive", () => {
      manager.create({
        name: "Fix-Auth",
        description: "Fix AUTH",
        category: "Debugging",
        tags: [],
        body: "body",
      });

      const results = manager.search("fix-auth");
      expect(results).toHaveLength(1);
    });
  });

  describe("loadFull", () => {
    it("should load a complete skill", () => {
      manager.create({
        name: "fix-auth",
        description: "Fix auth issues",
        category: "debugging",
        tags: ["auth"],
        body: "## When to Use\nAuth broken.\n## Procedure\n1. Check logs",
      });

      const skill = manager.loadFull("debugging/fix-auth/SKILL.md");
      expect(skill).not.toBeNull();
      expect(skill!.frontmatter.name).toBe("fix-auth");
      expect(skill!.frontmatter.use_count).toBe(0);
      expect(skill!.body).toContain("## When to Use");
      expect(skill!.body).toContain("## Procedure");
    });

    it("should return null for nonexistent skill", () => {
      const skill = manager.loadFull("no/such/SKILL.md");
      expect(skill).toBeNull();
    });
  });

  describe("patch", () => {
    it("should update a specific section", () => {
      manager.create({
        name: "fix-auth",
        description: "Fix auth",
        category: "debugging",
        tags: [],
        body: "## When to Use\nOld content.\n## Procedure\n1. Old step",
      });

      const result = manager.patch(
        "debugging/fix-auth/SKILL.md",
        "When to Use",
        "When auth is broken or token expired.",
      );

      expect(result.success).toBe(true);

      const skill = manager.loadFull("debugging/fix-auth/SKILL.md");
      expect(skill!.body).toContain("When auth is broken");
      expect(skill!.body).toContain("## Procedure");
      expect(skill!.frontmatter.patch_count).toBe(1);
    });

    it("should reject unknown section", () => {
      manager.create({
        name: "fix-auth",
        description: "Fix auth",
        category: "debugging",
        tags: [],
        body: "## When to Use\nContent",
      });

      const result = manager.patch(
        "debugging/fix-auth/SKILL.md",
        "Nonexistent Section",
        "content",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  describe("edit", () => {
    it("should replace the entire body", () => {
      manager.create({
        name: "fix-auth",
        description: "Fix auth",
        category: "debugging",
        tags: [],
        body: "Old body",
      });

      const result = manager.edit("debugging/fix-auth/SKILL.md", "New body");
      expect(result.success).toBe(true);

      const skill = manager.loadFull("debugging/fix-auth/SKILL.md");
      expect(skill!.body).toBe("New body");
      expect(skill!.frontmatter.patch_count).toBe(1);
    });
  });

  describe("delete", () => {
    it("should archive (not delete) a skill", () => {
      manager.create({
        name: "fix-auth",
        description: "Fix auth",
        category: "debugging",
        tags: [],
        body: "body",
      });

      const result = manager.delete("debugging/fix-auth/SKILL.md");
      expect(result.success).toBe(true);

      const skill = manager.loadFull("debugging/fix-auth/SKILL.md");
      expect(skill!.frontmatter.status).toBe("archived");
      // File still exists
      expect(fs.existsSync(skill!.filePath)).toBe(true);
    });

    it("should reject archiving already archived skill", () => {
      manager.create({
        name: "fix-auth",
        description: "Fix auth",
        category: "debugging",
        tags: [],
        body: "body",
      });
      manager.delete("debugging/fix-auth/SKILL.md");

      const result = manager.delete("debugging/fix-auth/SKILL.md");
      expect(result.success).toBe(false);
      expect(result.error).toContain("already archived");
    });
  });

  describe("incrementUse", () => {
    it("should increment use count and set last_used_at", () => {
      manager.create({
        name: "fix-auth",
        description: "Fix auth",
        category: "debugging",
        tags: [],
        body: "body",
      });

      const result = manager.incrementUse("debugging/fix-auth/SKILL.md");
      expect(result.success).toBe(true);

      const skill = manager.loadFull("debugging/fix-auth/SKILL.md");
      expect(skill!.frontmatter.use_count).toBe(1);
      expect(skill!.frontmatter.last_used_at).toBeTruthy();
    });
  });

  describe("incrementPatch", () => {
    it("should increment patch count", () => {
      manager.create({
        name: "fix-auth",
        description: "Fix auth",
        category: "debugging",
        tags: [],
        body: "body",
      });

      const result = manager.incrementPatch("debugging/fix-auth/SKILL.md");
      expect(result.success).toBe(true);

      const skill = manager.loadFull("debugging/fix-auth/SKILL.md");
      expect(skill!.frontmatter.patch_count).toBe(1);
    });
  });

  describe("getSummariesText", () => {
    it("should return formatted text for active skills", () => {
      manager.create({
        name: "fix-auth",
        description: "Fix authentication issues",
        category: "debugging",
        tags: ["auth"],
        body: "body",
      });

      const text = manager.getSummariesText();
      expect(text).toContain("AVAILABLE SKILLS");
      expect(text).toContain("fix-auth");
      expect(text).toContain("auth");
    });

    it("should exclude non-active skills", () => {
      manager.create({
        name: "old-skill",
        description: "Old skill",
        category: "test",
        tags: [],
        body: "body",
      });
      manager.delete("test/old-skill/SKILL.md");

      const text = manager.getSummariesText();
      expect(text).toBe("");
    });

    it("should return empty string when no skills", () => {
      expect(manager.getSummariesText()).toBe("");
    });
  });
});
