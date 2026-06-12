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
      pm.switchProfile("active-del", "sess1");

      pm.deleteProfile("active-del");
      expect(pm.getActiveProfileId("sess1")).toBe("default");
    });
  });

  describe("switchProfile", () => {
    it("switches to an existing profile for a session", () => {
      const pm = new ProfileManager(testDir);
      pm.createProfile(makeConfig({ id: "work" }));

      const profile = pm.switchProfile("work", "sess1");
      expect(profile.id).toBe("work");
      expect(pm.getActiveProfileId("sess1")).toBe("work");
    });

    it("does not affect other sessions", () => {
      const pm = new ProfileManager(testDir);
      pm.createProfile(makeConfig({ id: "work" }));

      pm.switchProfile("work", "sess1");
      expect(pm.getActiveProfileId("sess1")).toBe("work");
      expect(pm.getActiveProfileId("sess2")).toBe("default");
    });

    it("throws if profile does not exist", () => {
      const pm = new ProfileManager(testDir);
      expect(() => pm.switchProfile("nonexistent", "sess1")).toThrow("not found");
    });
  });

  describe("getActiveProfile", () => {
    it("returns the default profile initially", () => {
      const pm = new ProfileManager(testDir);
      const profile = pm.getActiveProfile();

      expect(profile.id).toBe("default");
      expect(profile.name).toBe("Default");
    });

    it("returns the switched-to profile for a session", () => {
      const pm = new ProfileManager(testDir);
      pm.createProfile(makeConfig({ id: "security" }));
      pm.switchProfile("security", "sess1");

      expect(pm.getActiveProfile("sess1").id).toBe("security");
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

      pm.switchProfile("custom", "sess1");
      expect(pm.getSystemPrompt("sess1")).toBe(customSoul.trim());
    });

    it("returns default content if SOUL.md is empty", () => {
      const pm = new ProfileManager(testDir);
      pm.createProfile(makeConfig({ id: "empty-soul" }));

      const profile = pm.loadProfile("empty-soul")!;
      fs.writeFileSync(profile.systemPromptPath, "", "utf-8");

      pm.switchProfile("empty-soul", "sess1");
      const prompt = pm.getSystemPrompt("sess1");
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
      pm.switchProfile("restricted", "sess1");

      const allTools = ["tool.a", "tool.b", "tool.c"];
      expect(pm.getAllowedTools(allTools, "sess1")).toEqual(["tool.a", "tool.b"]);
    });

    it("removes blockedTools from the list", () => {
      const pm = new ProfileManager(testDir);
      pm.createProfile(
        makeConfig({
          id: "blocked",
          blockedTools: ["tool.c"],
        }),
      );
      pm.switchProfile("blocked", "sess1");

      const allTools = ["tool.a", "tool.b", "tool.c"];
      expect(pm.getAllowedTools(allTools, "sess1")).toEqual(["tool.a", "tool.b"]);
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
      pm.switchProfile("both", "sess1");

      const allTools = ["tool.a", "tool.b", "tool.c", "tool.d"];
      expect(pm.getAllowedTools(allTools, "sess1")).toEqual(["tool.a", "tool.c"]);
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

      const pm2 = new ProfileManager(testDir);
      expect(pm2.loadProfile("persist")).toBeDefined();
      // Active profile resets to default on new instance (per-session, no persisted state)
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
      pm.switchProfile("limited", "sess1");

      expect(pm.getMaxToolCalls("sess1")).toBe(25);
    });
  });

  describe("path traversal protection", () => {
    it("rejects createProfile with path traversal in ID", () => {
      const pm = new ProfileManager(testDir);
      expect(() => pm.createProfile(makeConfig({ id: "../etc" }))).toThrow("Invalid profile ID");
    });

    it("rejects createProfile with path separator in ID", () => {
      const pm = new ProfileManager(testDir);
      expect(() => pm.createProfile(makeConfig({ id: "foo/bar" }))).toThrow("Invalid profile ID");
    });

    it("rejects createProfile with backslash in ID", () => {
      const pm = new ProfileManager(testDir);
      expect(() => pm.createProfile(makeConfig({ id: "foo\\bar" }))).toThrow("Invalid profile ID");
    });

    it("rejects createProfile with special characters in ID", () => {
      const pm = new ProfileManager(testDir);
      expect(() => pm.createProfile(makeConfig({ id: "test;rm -rf" }))).toThrow("Invalid profile ID");
    });

    it("rejects deleteProfile with path traversal in ID", () => {
      const pm = new ProfileManager(testDir);
      expect(() => pm.deleteProfile("../../../etc")).toThrow("Invalid profile ID");
    });

    it("rejects switchProfile with path traversal in ID", () => {
      const pm = new ProfileManager(testDir);
      expect(() => pm.switchProfile("../../etc", "sess1")).toThrow("Invalid profile ID");
    });

    it("rejects empty ID in createProfile", () => {
      const pm = new ProfileManager(testDir);
      expect(() => pm.createProfile(makeConfig({ id: "" }))).toThrow("Invalid profile ID");
    });

    it("accepts valid IDs with letters, numbers, underscores, hyphens", () => {
      const pm = new ProfileManager(testDir);
      expect(() => pm.createProfile(makeConfig({ id: "my-profile_123" }))).not.toThrow();
    });
  });

  describe("per-session isolation", () => {
    it("different sessions can have different active profiles", () => {
      const pm = new ProfileManager(testDir);
      pm.createProfile(makeConfig({ id: "work" }));
      pm.createProfile(makeConfig({ id: "personal" }));

      pm.switchProfile("work", "sess1");
      pm.switchProfile("personal", "sess2");

      expect(pm.getActiveProfileId("sess1")).toBe("work");
      expect(pm.getActiveProfileId("sess2")).toBe("personal");
      expect(pm.getActiveProfileId("sess3")).toBe("default");
    });

    it("getSystemPrompt returns different content per session", () => {
      const pm = new ProfileManager(testDir);
      pm.createProfile(makeConfig({ id: "alpha" }));
      pm.createProfile(makeConfig({ id: "beta" }));

      const alphaProfile = pm.loadProfile("alpha")!;
      fs.writeFileSync(alphaProfile.systemPromptPath, "Alpha personality", "utf-8");

      const betaProfile = pm.loadProfile("beta")!;
      fs.writeFileSync(betaProfile.systemPromptPath, "Beta personality", "utf-8");

      pm.switchProfile("alpha", "sess-a");
      pm.switchProfile("beta", "sess-b");

      expect(pm.getSystemPrompt("sess-a")).toBe("Alpha personality");
      expect(pm.getSystemPrompt("sess-b")).toBe("Beta personality");
    });

    it("switching profile in one session does not affect another", () => {
      const pm = new ProfileManager(testDir);
      pm.createProfile(makeConfig({ id: "work" }));

      pm.switchProfile("work", "sess1");
      // sess2 was never switched, should still be default
      expect(pm.getActiveProfileId("sess2")).toBe("default");

      pm.switchProfile("default", "sess1");
      expect(pm.getActiveProfileId("sess1")).toBe("default");
    });
  });

  describe("loadAllProfiles ID validation", () => {
    it("skips directories with non-matching profile IDs in config", () => {
      // Create a profile directory with a mismatched config ID
      const profileDir = path.join(testDir, "legit-id");
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(
        path.join(profileDir, "config.json"),
        JSON.stringify({ id: "different-id", name: "Bad", description: "Mismatched" }),
        "utf-8",
      );

      const pm = new ProfileManager(testDir);
      expect(pm.loadProfile("legit-id")).toBeUndefined();
      expect(pm.loadProfile("different-id")).toBeUndefined();
    });
  });
});
