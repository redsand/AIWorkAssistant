import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { SoulManager } from "../../memory/soul-manager";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "soul-fs-test-"));
}

describe("SoulManager filesystem error handling", () => {
  let tempDir: string;
  let manager: SoulManager;

  beforeEach(() => {
    tempDir = createTempDir();
    process.env.VITEST = "true";
    process.env.VITEST_WORKER_ID = "fs-test";
    manager = new SoulManager(tempDir);
  });

  afterEach(() => {
    // Restore permissions before cleanup
    try {
      const soulPath = path.join(tempDir, "SOUL.md");
      fs.chmodSync(soulPath, 0o644);
    } catch {}
    try {
      fs.chmodSync(tempDir, 0o755);
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ── read errors ────────────────────────────────────────────────────────

  describe("read errors", () => {
    it("should fall back to default when SOUL.md does not exist", () => {
      const soulPath = path.join(tempDir, "SOUL.md");
      fs.unlinkSync(soulPath);

      const content = manager.load();
      expect(content).toContain("pragmatic senior engineer");
    });

    it("should fall back to default when SOUL.md is empty", () => {
      const soulPath = path.join(tempDir, "SOUL.md");
      fs.writeFileSync(soulPath, "", "utf-8");

      const content = manager.load();
      expect(content).toContain("pragmatic senior engineer");
    });

    it("should fall back to default when SOUL.md is only whitespace", () => {
      const soulPath = path.join(tempDir, "SOUL.md");
      fs.writeFileSync(soulPath, "   \n  \n  ", "utf-8");

      const content = manager.load();
      expect(content).toContain("pragmatic senior engineer");
    });
  });

  // ── write errors ───────────────────────────────────────────────────────

  describe("write errors", () => {
    it("save() should throw on permission error", () => {
      const soulPath = path.join(tempDir, "SOUL.md");
      fs.writeFileSync(soulPath, "", "utf-8");
      fs.chmodSync(soulPath, 0o444);

      expect(() => manager.save("# Identity\nNew content")).toThrow();
    });

    it("edit() should throw on permission error", () => {
      const soulPath = path.join(tempDir, "SOUL.md");
      fs.chmodSync(soulPath, 0o444);

      expect(() => manager.edit("Style", "New style")).toThrow();
    });

    it("reset() should throw on permission error", () => {
      const soulPath = path.join(tempDir, "SOUL.md");
      fs.chmodSync(soulPath, 0o444);

      expect(() => manager.reset()).toThrow();
    });
  });

  // ── concurrent file access ─────────────────────────────────────────────

  describe("concurrent file access", () => {
    it("should handle atomic write via tmp+rename pattern", () => {
      const soulPath = path.join(tempDir, "SOUL.md");
      const tmpPath = soulPath + ".tmp";

      manager.edit("Style", "Updated concurrently");

      // No leftover tmp file after write
      expect(fs.existsSync(tmpPath)).toBe(false);
      // Content should be the updated version
      const content = fs.readFileSync(soulPath, "utf-8");
      expect(content).toContain("Updated concurrently");
    });

    it("should survive stale tmp file from crashed previous write", () => {
      const soulPath = path.join(tempDir, "SOUL.md");
      const tmpPath = soulPath + ".tmp";

      // Simulate a crashed write that left a stale tmp file
      fs.writeFileSync(tmpPath, "stale content from crash", "utf-8");

      // New write should succeed (overwrites the stale tmp)
      const result = manager.edit("Style", "Fresh content");
      expect(result.success).toBe(true);

      const content = fs.readFileSync(soulPath, "utf-8");
      expect(content).toContain("Fresh content");
      expect(fs.existsSync(tmpPath)).toBe(false);
    });

    it("should handle rapid sequential edits", () => {
      const results = [];
      for (let i = 0; i < 10; i++) {
        results.push(manager.edit("Style", `Iteration ${i}`));
      }

      // All edits should succeed
      for (const result of results) {
        expect(result.success).toBe(true);
      }

      // Last edit should be the final content
      const content = manager.load();
      expect(content).toContain("Iteration 9");
    });

    it("should handle rapid set/clear personality cycles", () => {
      for (let i = 0; i < 5; i++) {
        manager.setPersonality("concise", "# Identity\nTerse engineer");
        expect(manager.getActivePersonality()).toBe("concise");
        expect(manager.load()).toContain("Terse engineer");

        manager.clearPersonality();
        expect(manager.getActivePersonality()).toBeNull();
        expect(manager.load()).toContain("pragmatic senior engineer");
      }
    });
  });

  // ── directory creation ─────────────────────────────────────────────────

  describe("directory handling", () => {
    it("should create base directory if it does not exist", () => {
      const nestedDir = path.join(tempDir, "nested", "deep", "dir");
      const newManager = new SoulManager(nestedDir);
      expect(fs.existsSync(nestedDir)).toBe(true);
      const content = newManager.load();
      expect(content).toContain("pragmatic senior engineer");

      fs.rmSync(nestedDir, { recursive: true, force: true });
    });
  });

  // ── personality null safety ────────────────────────────────────────────

  describe("personality null safety", () => {
    it("should fall back to file content if personalityContent is null after setPersonality", () => {
      // Simulate the invariant break: activePersonality set but content null
      (manager as any).activePersonality = "broken";
      (manager as any).personalityContent = null;

      const content = manager.load();
      // Should fall back to reading file rather than crashing on null
      expect(content).toBeTruthy();
    });

    it("should handle setPersonality with empty content", () => {
      manager.setPersonality("empty", "");
      const content = manager.load();
      // personalityContent is empty string (falsy for the ternary, but actually truthy since it's set)
      // load() uses this.personalityContent ?? this.readSoulFile() — empty string doesn't trigger ??
      expect(content).toBe("");
    });
  });
});
