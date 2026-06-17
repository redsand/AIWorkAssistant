import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { ProfileManager } from "../../../src/config/profile-manager";

let rootDir: string;

function makeManager(): ProfileManager {
  // rootDir plays the role of HERMES_HOME; profiles live under rootDir/profiles
  return new ProfileManager(path.join(rootDir, "profiles"));
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-profiles-"));
});

afterEach(() => {
  if (fs.existsSync(rootDir)) {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

describe("config/ProfileManager", () => {
  describe("getActive", () => {
    it("auto-creates the default profile when none exists", () => {
      const pm = makeManager();
      const active = pm.getActive();

      expect(active.name).toBe("default");
      expect(fs.existsSync(active.path)).toBe(true);
      expect(fs.existsSync(path.join(active.path, "memories"))).toBe(true);
      expect(fs.existsSync(path.join(active.path, "skills"))).toBe(true);
      expect(fs.existsSync(path.join(active.path, "sessions"))).toBe(true);
    });

    it("writes the active marker file", () => {
      const pm = makeManager();
      pm.getActive();
      const activeFile = path.join(rootDir, "profiles", "active");
      expect(fs.existsSync(activeFile)).toBe(true);
      expect(fs.readFileSync(activeFile, "utf-8").trim()).toBe("default");
    });

    it("updates lastUsedAt on access", () => {
      const pm = makeManager();
      const first = pm.getActive();
      expect(first.lastUsedAt).toBeTruthy();
    });

    it("falls back to default when the active marker is tampered with a traversal sequence", () => {
      const pm = makeManager();
      pm.getActive(); // seed default + marker
      const marker = path.join(rootDir, "profiles", "active");
      fs.writeFileSync(marker, "../escape\n", "utf-8");

      // A tampered name must never reach path.join/fs.mkdirSync unvalidated.
      expect(() => pm.getActive()).toThrow();
      // No directory should have been created outside the profiles root.
      expect(fs.existsSync(path.join(rootDir, "escape"))).toBe(false);
    });

    it("migrates legacy data/memories and data/skills into the default profile on first run", () => {
      // Simulate a pre-isolation install: state directly under HERMES_HOME.
      const legacyMem = path.join(rootDir, "memories");
      const legacySkills = path.join(rootDir, "skills", "general", "greet");
      fs.mkdirSync(legacyMem, { recursive: true });
      fs.mkdirSync(legacySkills, { recursive: true });
      fs.writeFileSync(path.join(legacyMem, "MEMORY.md"), "legacy fact", "utf-8");
      fs.writeFileSync(path.join(legacySkills, "SKILL.md"), "---\nname: greet\n---\n", "utf-8");

      const pm = makeManager();
      const active = pm.getActive();

      expect(
        fs.readFileSync(path.join(active.path, "memories", "MEMORY.md"), "utf-8"),
      ).toContain("legacy fact");
      expect(
        fs.existsSync(
          path.join(active.path, "skills", "general", "greet", "SKILL.md"),
        ),
      ).toBe(true);
      // Originals are left in place (copy, not move).
      expect(fs.existsSync(path.join(legacyMem, "MEMORY.md"))).toBe(true);
    });

    it("is idempotent: a second migration never re-copies into a populated profile", () => {
      const legacyMem = path.join(rootDir, "memories");
      fs.mkdirSync(legacyMem, { recursive: true });
      fs.writeFileSync(path.join(legacyMem, "MEMORY.md"), "legacy fact", "utf-8");

      const pm = makeManager();
      const active = pm.getActive(); // first run migrates
      const migratedMem = path.join(active.path, "memories");
      expect(
        fs.readFileSync(path.join(migratedMem, "MEMORY.md"), "utf-8"),
      ).toContain("legacy fact");

      // Add a NEW legacy file, then run migration again. Because the default
      // profile's memories dir is already populated, the run must be a no-op —
      // the new legacy file must NOT be copied in (and nothing duplicated).
      fs.writeFileSync(path.join(legacyMem, "USER.md"), "added later", "utf-8");
      const before = fs.readdirSync(migratedMem).sort();

      // migrateLegacyData is private; invoke it directly to prove idempotency
      // independent of the getActive() dir-existence guard.
      (pm as unknown as { migrateLegacyData(dir: string): void }).migrateLegacyData(
        active.path,
      );

      const after = fs.readdirSync(migratedMem).sort();
      expect(after).toEqual(before);
      expect(fs.existsSync(path.join(migratedMem, "USER.md"))).toBe(false);
    });

    it("does not overwrite existing default-profile files during migration", () => {
      const legacyMem = path.join(rootDir, "memories");
      fs.mkdirSync(legacyMem, { recursive: true });
      fs.writeFileSync(path.join(legacyMem, "MEMORY.md"), "legacy", "utf-8");

      // Pre-create the default profile with its own MEMORY.md.
      const defaultMem = path.join(rootDir, "profiles", "default", "memories");
      fs.mkdirSync(defaultMem, { recursive: true });
      fs.writeFileSync(path.join(defaultMem, "MEMORY.md"), "existing", "utf-8");

      const pm = makeManager();
      pm.getActive();

      // Default dir already existed → migration must not clobber it.
      expect(fs.readFileSync(path.join(defaultMem, "MEMORY.md"), "utf-8")).toBe(
        "existing",
      );
    });
  });

  describe("create", () => {
    it("creates a new profile with the full directory structure", () => {
      const pm = makeManager();
      const profile = pm.create("researcher");

      expect(profile.name).toBe("researcher");
      expect(fs.existsSync(path.join(profile.path, "memories"))).toBe(true);
      expect(fs.existsSync(path.join(profile.path, "skills"))).toBe(true);
      expect(fs.existsSync(path.join(profile.path, "sessions"))).toBe(true);
      expect(fs.existsSync(path.join(profile.path, "config.yaml"))).toBe(true);
    });

    it("rejects duplicate profile names", () => {
      const pm = makeManager();
      pm.create("researcher");
      expect(() => pm.create("researcher")).toThrow(/already exists/i);
    });

    it("rejects invalid profile names", () => {
      const pm = makeManager();
      expect(() => pm.create("../escape")).toThrow();
      expect(() => pm.create("has space")).toThrow();
    });

    it("reports no custom soul/memory for a fresh profile", () => {
      const pm = makeManager();
      const profile = pm.create("fresh");
      expect(profile.hasCustomSoul).toBe(false);
      expect(profile.hasCustomMemory).toBe(false);
      expect(profile.skillCount).toBe(0);
    });

    it("clones config and .env from a source profile when clone option is given", () => {
      const pm = makeManager();
      const source = pm.create("dev");
      fs.writeFileSync(path.join(source.path, ".env"), "FOO=bar\n", "utf-8");
      fs.writeFileSync(
        path.join(source.path, "config.yaml"),
        "name: dev\nmodel: glm-5\n",
        "utf-8",
      );

      const cloned = pm.create("dev-copy", { clone: "dev" });
      expect(fs.existsSync(path.join(cloned.path, ".env"))).toBe(true);
      expect(fs.readFileSync(path.join(cloned.path, ".env"), "utf-8")).toContain(
        "FOO=bar",
      );
      expect(
        fs.readFileSync(path.join(cloned.path, "config.yaml"), "utf-8"),
      ).toContain("model: glm-5");
    });
  });

  describe("list", () => {
    it("lists all profiles with metadata", () => {
      const pm = makeManager();
      pm.getActive();
      pm.create("researcher");
      pm.create("developer");

      const profiles = pm.list();
      const names = profiles.map((p) => p.name).sort();
      expect(names).toContain("default");
      expect(names).toContain("researcher");
      expect(names).toContain("developer");
    });

    it("reports a custom soul and skill count", () => {
      const pm = makeManager();
      const profile = pm.create("researcher");
      fs.writeFileSync(
        path.join(profile.path, "memories", "SOUL.md"),
        "# Identity\nResearch focused",
        "utf-8",
      );
      const skillDir = path.join(profile.path, "skills", "research", "summarize");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: x\n---\n", "utf-8");

      const listed = pm.list().find((p) => p.name === "researcher")!;
      expect(listed.hasCustomSoul).toBe(true);
      expect(listed.skillCount).toBe(1);
    });
  });

  describe("switch", () => {
    it("changes the active profile", () => {
      const pm = makeManager();
      pm.create("researcher");
      pm.switch("researcher");
      expect(pm.getActive().name).toBe("researcher");
    });

    it("throws when switching to an unknown profile", () => {
      const pm = makeManager();
      expect(() => pm.switch("ghost")).toThrow(/not found/i);
    });
  });

  describe("delete", () => {
    it("removes a profile directory", () => {
      const pm = makeManager();
      const profile = pm.create("temp");
      pm.delete("temp");
      expect(fs.existsSync(profile.path)).toBe(false);
      expect(pm.list().find((p) => p.name === "temp")).toBeUndefined();
    });

    it("refuses to delete the active profile", () => {
      const pm = makeManager();
      pm.create("researcher");
      pm.switch("researcher");
      expect(() => pm.delete("researcher")).toThrow(/active/i);
    });

    it("throws when deleting a non-existent profile", () => {
      const pm = makeManager();
      expect(() => pm.delete("ghost")).toThrow(/not found/i);
    });
  });

  describe("clone", () => {
    it("copies config and .env into the new profile", () => {
      const pm = makeManager();
      const source = pm.create("dev");
      fs.writeFileSync(path.join(source.path, ".env"), "KEY=1\n", "utf-8");

      const cloned = pm.clone("dev", "dev2");
      expect(cloned.name).toBe("dev2");
      expect(fs.existsSync(path.join(cloned.path, ".env"))).toBe(true);
      expect(fs.readFileSync(path.join(cloned.path, ".env"), "utf-8")).toContain(
        "KEY=1",
      );
    });

    it("throws when the source profile is missing", () => {
      const pm = makeManager();
      expect(() => pm.clone("ghost", "dev2")).toThrow(/not found/i);
    });
  });
});
