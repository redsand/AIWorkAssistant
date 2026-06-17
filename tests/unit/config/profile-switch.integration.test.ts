// tests/unit/config/profile-switch.integration.test.ts
//
// Integration coverage for profile isolation: after `ProfileManager.switch()`
// writes the `active` marker, the memory / skill / soul managers must resolve
// their storage into the newly active profile's directory.
//
// These managers normally short-circuit to a per-worker temp dir when
// `process.env.VITEST` is set, so the suite deletes VITEST (and the per-manager
// path overrides) for the duration of the test, forcing them through the real
// `resolvePath()` → active-marker path.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("dotenv", () => ({
  config: vi.fn(),
}));

const ENV_OVERRIDES = [
  "VITEST",
  "ACTIVE_PROFILE",
  "AGENT_MEMORY_PATH",
  "SOUL_PATH",
  "SKILLS_PATH",
  "CONVERSATION_MEMORY_PATH",
];

describe("profile switch routes managers to the active profile", () => {
  let tmpHome: string;
  const saved: Record<string, string | undefined> = {};

  const profileDir = (name: string) =>
    path.join(tmpHome, "profiles", name);

  beforeEach(() => {
    for (const key of ["HERMES_HOME", ...ENV_OVERRIDES]) {
      saved[key] = process.env[key];
    }
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "profile-switch-"));
    process.env.HERMES_HOME = tmpHome;
    for (const key of ENV_OVERRIDES) {
      delete process.env[key];
    }
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of ["HERMES_HOME", ...ENV_OVERRIDES]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("creates managers under the active profile after a switch", async () => {
    const { ProfileManager } = await import(
      "../../../src/config/profile-manager"
    );
    const pm = new ProfileManager(path.join(tmpHome, "profiles"));
    pm.create("work");
    pm.switch("work");

    const { AgentMemory } = await import("../../../src/memory/agent-memory");
    const { SoulManager } = await import("../../../src/memory/soul-manager");
    const { SkillManager } = await import("../../../src/skills/skill-manager");

    const memory = new AgentMemory();
    const soul = new SoulManager();
    const skills = new SkillManager();

    memory.add("memory", "fact", "the sky is blue");
    skills.create({
      name: "greet",
      description: "say hello",
      category: "general",
      body: "Say hello to the user.",
    });

    void soul; // constructed → writes SOUL.md under the active profile

    const workMemories = path.join(profileDir("work"), "memories");
    const workSkills = path.join(profileDir("work"), "skills");

    expect(fs.existsSync(path.join(workMemories, "MEMORY.md"))).toBe(true);
    expect(fs.existsSync(path.join(workMemories, "SOUL.md"))).toBe(true);
    expect(
      fs.existsSync(path.join(workSkills, "general", "greet", "SKILL.md")),
    ).toBe(true);

    // Nothing should have leaked into the default profile.
    const defaultMemories = path.join(profileDir("default"), "memories");
    expect(fs.existsSync(path.join(defaultMemories, "MEMORY.md"))).toBe(false);
    expect(fs.existsSync(path.join(defaultMemories, "SOUL.md"))).toBe(false);
  });

  it("routes to a different directory after switching profiles again", async () => {
    const { ProfileManager } = await import(
      "../../../src/config/profile-manager"
    );
    const pm = new ProfileManager(path.join(tmpHome, "profiles"));
    pm.create("alpha");
    pm.create("beta");

    const { AgentMemory } = await import("../../../src/memory/agent-memory");

    pm.switch("alpha");
    new AgentMemory().add("memory", "k", "alpha-value");

    pm.switch("beta");
    new AgentMemory().add("memory", "k", "beta-value");

    const alphaMem = path.join(profileDir("alpha"), "memories", "MEMORY.md");
    const betaMem = path.join(profileDir("beta"), "memories", "MEMORY.md");

    expect(fs.readFileSync(alphaMem, "utf-8")).toContain("alpha-value");
    expect(fs.readFileSync(betaMem, "utf-8")).toContain("beta-value");
    expect(fs.readFileSync(alphaMem, "utf-8")).not.toContain("beta-value");
  });
});
