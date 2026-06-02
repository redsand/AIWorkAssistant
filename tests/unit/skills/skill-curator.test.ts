import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SkillCurator } from "../../../src/skills/skill-curator";
import { SkillManager } from "../../../src/skills/skill-manager";
import fs from "fs";
import path from "path";
import os from "os";

describe("SkillCurator", () => {
  let tmpDir: string;
  let manager: SkillManager;
  let curator: SkillCurator;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `skill-curator-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    manager = new SkillManager(tmpDir);
    curator = new SkillCurator(manager, {
      staleThresholdDays: 30,
      archiveThresholdDays: 14,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createSkillWithDate(name: string, lastUsedAt: string | undefined, status: "active" | "stale" | "archived" = "active") {
    manager.create({
      name,
      description: `Skill ${name}`,
      category: "test",
      tags: ["test"],
      body: "## When to Use\nTest.\n## Procedure\n1. Step",
    });

    if (status !== "active" || lastUsedAt) {
      // Load the raw file and rewrite with custom dates
      const skill = manager.loadFull(`test/${name}/SKILL.md`)!;
      const fm = { ...skill.frontmatter };
      fm.status = status;
      fm.last_used_at = lastUsedAt;
      fm.updated_at = lastUsedAt ?? fm.updated_at;

      // Write directly
      const filePath = skill.filePath;
      const content = serialize(fm, skill.body);
      fs.writeFileSync(filePath, content, "utf-8");
    }
  }

  it("should mark skills as stale when not used in 30 days", () => {
    const staleDate = new Date();
    staleDate.setDate(staleDate.getDate() - 35);
    createSkillWithDate("old-skill", staleDate.toISOString());

    const result = curator.curate();

    expect(result.decisions.some((d) => d.action === "stale")).toBe(true);
    expect(result.totalEvaluated).toBe(1);

    const skill = manager.loadFull("test/old-skill/SKILL.md");
    expect(skill!.frontmatter.status).toBe("stale");
  });

  it("should not mark recently used skills as stale", () => {
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 5);
    createSkillWithDate("recent-skill", recentDate.toISOString());

    const result = curator.curate();

    expect(result.decisions.some((d) => d.action === "stale")).toBe(false);

    const skill = manager.loadFull("test/recent-skill/SKILL.md");
    expect(skill!.frontmatter.status).toBe("active");
  });

  it("should archive stale skills after 14 more days", () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 50); // 50 days = 30 stale + 20 more
    createSkillWithDate("very-old-skill", oldDate.toISOString(), "stale");

    const result = curator.curate();

    expect(result.decisions.some((d) => d.action === "archive")).toBe(true);

    const skill = manager.loadFull("test/very-old-skill/SKILL.md");
    expect(skill!.frontmatter.status).toBe("archived");
  });

  it("should never auto-delete skills", () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 365);
    createSkillWithDate("ancient-skill", oldDate.toISOString(), "stale");

    curator.curate();

    const skill = manager.loadFull("test/ancient-skill/SKILL.md");
    expect(skill).not.toBeNull();
    expect(skill!.frontmatter.status).toBe("archived");
    // File still exists on disk
    expect(fs.existsSync(skill!.filePath)).toBe(true);
  });

  it("should skip already archived skills", () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100);
    createSkillWithDate("archived-skill", oldDate.toISOString(), "archived");

    const result = curator.curate();

    // No decisions for already-archived skills
    expect(result.decisions.every((d) => d.skillPath !== "test/archived-skill/SKILL.md")).toBe(true);
  });

  it("should suggest merging overlapping skills", () => {
    manager.create({
      name: "skill-a",
      description: "Fix auth",
      category: "debugging",
      tags: ["auth", "jwt", "token", "oauth", "security", "login"],
      body: "body",
    });
    manager.create({
      name: "skill-b",
      description: "Fix auth tokens",
      category: "debugging",
      tags: ["auth", "jwt", "token", "oauth", "security", "signin"],
      body: "body",
    });

    const result = curator.curate();

    const mergeDecision = result.decisions.find((d) => d.action === "merge_suggestion");
    expect(mergeDecision).toBeTruthy();
    expect(mergeDecision!.reason).toContain("overlap");
  });

  it("should not suggest merging dissimilar skills", () => {
    manager.create({
      name: "skill-a",
      description: "Fix auth",
      category: "debugging",
      tags: ["auth", "jwt"],
      body: "body",
    });
    manager.create({
      name: "skill-b",
      description: "Deploy app",
      category: "deployment",
      tags: ["docker", "k8s"],
      body: "body",
    });

    const result = curator.curate();

    expect(result.decisions.some((d) => d.action === "merge_suggestion")).toBe(false);
  });

  it("should return totalEvaluated count", () => {
    manager.create({
      name: "skill-1",
      description: "One",
      category: "cat1",
      tags: [],
      body: "body",
    });
    manager.create({
      name: "skill-2",
      description: "Two",
      category: "cat2",
      tags: [],
      body: "body",
    });

    const result = curator.curate();
    expect(result.totalEvaluated).toBe(2);
  });
});

// ── Serialization helper for tests ─────────────────────────────────

function serialize(frontmatter: Record<string, unknown>, body: string): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${frontmatter.name}`);
  lines.push(`description: "${frontmatter.description}"`);
  lines.push(`version: ${frontmatter.version ?? "1.0.0"}`);
  lines.push(`category: ${frontmatter.category}`);
  lines.push(`tags:`);
  for (const tag of (frontmatter.tags as string[])) {
    lines.push(`  - ${tag}`);
  }
  lines.push(`created_at: ${frontmatter.created_at}`);
  lines.push(`updated_at: ${frontmatter.updated_at}`);
  lines.push(`use_count: ${frontmatter.use_count}`);
  lines.push(`patch_count: ${frontmatter.patch_count}`);
  if (frontmatter.last_used_at) {
    lines.push(`last_used_at: ${frontmatter.last_used_at}`);
  }
  lines.push(`status: ${frontmatter.status}`);
  lines.push("---");
  lines.push("");
  lines.push(body.trim());
  return lines.join("\n") + "\n";
}
