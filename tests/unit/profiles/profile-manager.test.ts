import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { ProfileManager } from "../../../src/profiles/profile-manager";
import type { ProfileConfig } from "../../../src/profiles/types";

let testDir: string;

function makeConfig(overrides?: Partial<ProfileConfig>): ProfileConfig {
  return {
    id: "test-profile",
    name: "Test Profile",
    description: "A test profile",
    ...overrides,
  };
}

beforeEach(() => {
  testDir = path.join(
    os.tmpdir(),
    `profile-manager-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

describe("ProfileManager", () => {
  describe("initialization", () => {
    it("creates default profile on first run", () => {
      const pm = new ProfileManager(testDir);
      const profiles = pm.listProfiles();

      expect(profiles.length).toBeGreaterThanOrEqual(1);
      const defaultProfile = profiles.find((p) => p.id === "default");
      expect(defaultProfile).toBeDefined();
      expect(defaultProfile!.name).toBe("Default");
    });

    it("creates SOUL.md for the default profile", () => {
      const pm = new ProfileManager(testDir);
      const profile = pm.getActiveProfile();

      expect(fs.existsSync(profile.systemPromptPath)).toBe(true);
    });

    it("sets default profile as active", () => {
      const pm = new ProfileManager(testDir);
      expect(pm.getActiveProfileId()).toBe("default");
    });

    it("creates profiles directory if it does not exist", () => {
      const newDir = path.join(testDir, "nonexistent");
      const pm = new ProfileManager(newDir);

      expect(fs.existsSync(newDir)).toBe(true);
      expect(pm.listProfiles().length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("createProfile", () => {
    it("creates a new profile with given config", () => {
      const pm = new ProfileManager(testDir);
      const config = makeConfig({ id: "work", name: "Work" });
      const profile = pm.createProfile(config);

      expect(profile.id).toBe("work");
      expect(profile.name).toBe("Work");
      expect(profile.description).toBe("A test profile");
      expect(fs.existsSync(profile.systemPromptPath)).toBe(true);
    });

    it("throws if profile id already exists", () => {
      const pm = new ProfileManager(testDir);
      pm.createProfile(makeConfig({ id: "duplicate" }));

      expect(() => pm.createProfile(makeConfig({ id: "duplicate" }))).toThrow(
        "already exists",
      );
    });

    it("persists profile to disk as config.json", () => {
      const pm = new ProfileManager(testDir);
      pm.createProfile(makeConfig({ id: "persist-test" }));

      const configPath = path.join(testDir, "persist-test", "config.json");
      expect(fs.existsSync(configPath)).toBe(true);

      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(raw.id).toBe("persist-test");
    });
  });

  describe("deleteProfile", () => {
    it("deletes an existing profile", () => {
      const pm = new ProfileManager(testDir);
      pm.createProfile(makeConfig({ id: "to-delete" }));

      const result = pm.deleteProfile("to-delete");
      expect(result).toBe(true);
      expect(pm.loadProfile("to-delete")).toBeUndefined();
    });

    it("removes profile directory from disk", () => {
      const pm = new ProfileManager(testDir);
      pm.createProfile(makeConfig({ id: "disk-delete" }));

      const profileDir = path.join(testDir, "disk-delete");
      expect(fs.existsSync(profileDir)).toBe(true);

      pm.deleteProfile("disk-delete");
      expect(fs.existsSync(profileDir)).toBe(false);
    });

    it("throws when trying to delete the default profile", () => {
      const pm = new ProfileManager(testDir);
      expect(() => pm.deleteProfile("default")).toThrow("Cannot delete");
    });

    it("returns false for non-existent profile", () => {
      const pm = new ProfileManager(testDir);
      expect(pm.deleteProfile("nonexistent")).toBe(false);
    });

    it("resets active profile to default if deleted profile was active", () => {
      const pm = new ProfileManager(testDir);
      pm.createProfile(makeConfig({ id: "active-del" }));
      pm.switchProfile("active-del");

      pm.deleteProfile("active-del");
      expect(pm.getActiveProfileId()).toBe("default");
    });
  });

  describe("switchProfile", () => {
    it("switches to an existing profile", () => {
      const pm = new ProfileManager(testDir);
      pm.createProfile(makeConfig({ id: "work" }));

      const profile = pm.switchProfile("work");
      expect(profile.id).toBe("work");
      expect(pm.getActiveProfileId()).toBe("work");
    });

    it("throws if profile does not exist", () => {
      const pm = new ProfileManager(testDir);
      expect(() => pm.switchProfile("nonexistent")).toThrow("not found");
    });
  });

  describe("getActiveProfile", () => {
    it("returns the default profile initially", () => {
      const pm = new ProfileManager(testDir);
      const profile = pm.getActiveProfile();

      expect(profile.id).toBe("default");
      expect(profile.name).toBe("Default");
    });

    it("returns the switched-to profile", () => {
      const pm = new ProfileManager(testDir);
      pm.createProfile(makeConfig({ id: "security" }));
      pm.switchProfile("security");

      expect(pm.getActiveProfile().id).toBe("security");
    });
  });

  describe("getSystemPrompt", () => {
    it("returns default SOUL.md content for default profile", () => {
      const pm = new ProfileManager(testDir);
      const prompt = pm.getSystemPrompt();

      expect(prompt.length).toBeGreaterThan(0);
    });

    it("returns profile-specific SOUL.md when switched", () => {
      const pm = new ProfileManager(testDir);
      pm.createProfile(makeConfig({ id: "custom" }));

      const profile = pm.loadProfile("custom")!;
      const customSoul = "# Custom Personality\nBe very formal.\n";
      fs.writeFileSync(profile.systemPromptPath, customSoul, "utf-8");

      pm.switchProfile("custom");
      expect(pm.getSystemPrompt()).toBe(customSoul.trim());
    });

    it("returns default content if SOUL.md is empty", () => {
      const pm = new ProfileManager(testDir);
      pm.createProfile(makeConfig({ id: "empty-soul" }));

      const profile = pm.loadProfile("empty-soul")!;
      fs.writeFileSync(profile.systemPromptPath, "", "utf-8");

      pm.switchProfile("empty-soul");
      const prompt = pm.getSystemPrompt();
      expect(prompt.length).toBeGreaterThan(0);
    });
  });

  describe("getAllowedTools", () => {
    it("returns all tools when no allow/block list set", () => {
      const pm = new ProfileManager(testDir);
      const allTools = ["tool.a", "tool.b", "tool.c"];

      expect(pm.getAllowedTools(allTools)).toEqual(allTools);
    });

    it("filters to allowedTools when set", () => {
      const pm = new ProfileManager(testDir);
      pm.createProfile(
        makeConfig({
          id: "restricted",
          allowedTools: ["tool.a", "tool.b"],
        }),
      );
      pm.switchProfile("restricted");

      const allTools = ["tool.a", "tool.b", "tool.c"];
      expect(pm.getAllowedTools(allTools)).toEqual(["tool.a", "tool.b"]);
    });

    it("removes blockedTools from the list", () => {
      const pm = new ProfileManager(testDir);
      pm.createProfile(
        makeConfig({
          id: "blocked",
          blockedTools: ["tool.c"],
        }),
      );
      pm.switchProfile("blocked");

      const allTools = ["tool.a", "tool.b", "tool.c"];
      expect(pm.getAllowedTools(allTools)).toEqual(["tool.a", "tool.b"]);
    });

    it("intersects allowed and removes blocked", () => {
      const pm = new ProfileManager(testDir);
      pm.createProfile(
        makeConfig({
          id: "both",
          allowedTools: ["tool.a", "tool.b", "tool.c"],
          blockedTools: ["tool.b"],
        }),
      );
      pm.switchProfile("both");

      const allTools = ["tool.a", "tool.b", "tool.c", "tool.d"];
      expect(pm.getAllowedTools(allTools)).toEqual(["tool.a", "tool.c"]);
    });
  });

  describe("listProfiles", () => {
    it("lists all profiles including default", () => {
      const pm = new ProfileManager(testDir);
      pm.createProfile(makeConfig({ id: "work" }));
      pm.createProfile(makeConfig({ id: "personal" }));

      const profiles = pm.listProfiles();
      const ids = profiles.map((p) => p.id);

      expect(ids).toContain("default");
      expect(ids).toContain("work");
      expect(ids).toContain("personal");
    });
  });

  describe("persistence across instances", () => {
    it("loads profiles from disk on reconstruction", () => {
      const pm1 = new ProfileManager(testDir);
      pm1.createProfile(makeConfig({ id: "persist" }));
      pm1.switchProfile("persist");

      const pm2 = new ProfileManager(testDir);
      expect(pm2.loadProfile("persist")).toBeDefined();
      // Active profile resets to default on new instance
      expect(pm2.getActiveProfileId()).toBe("default");
    });
  });

  describe("maxToolCalls", () => {
    it("returns 0 (unlimited) for default profile", () => {
      const pm = new ProfileManager(testDir);
      expect(pm.getMaxToolCalls()).toBe(0);
    });

    it("returns configured maxToolCalls for custom profile", () => {
      const pm = new ProfileManager(testDir);
      pm.createProfile(
        makeConfig({ id: "limited", maxToolCalls: 25 }),
      );
      pm.switchProfile("limited");

      expect(pm.getMaxToolCalls()).toBe(25);
    });
  });
});
