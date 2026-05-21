import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let tmpDir: string;

// Mock arg-parser so WORKSPACE points to our temp dir
vi.mock("../arg-parser", () => ({
  get WORKSPACE() {
    return tmpDir;
  },
}));

// Import AFTER mock is set up so the module captures our mock WORKSPACE
import {
  loadReviewGateState,
  saveReviewGateState,
  clearReviewGateState,
  recordGateFindings,
  markForceDone,
  getLastFindings,
} from "../review-gate-state";
import type { ReviewGateFinding } from "../review-gate";

const SAMPLE_FINDING: ReviewGateFinding = {
  severity: "high",
  category: "review",
  file: "src/a.ts",
  message: "Something wrong",
};

const ANOTHER_FINDING: ReviewGateFinding = {
  severity: "low",
  category: "style",
  file: "src/b.ts",
  message: "Minor issue",
};

describe("review-gate-state", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aicoder-rgs-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ── loadReviewGateState ─────────────────────────────────────────────────────

  describe("loadReviewGateState", () => {
    it("returns initial state when no file exists", () => {
      const state = loadReviewGateState("ISSUE-1");
      expect(state.lastFindings).toEqual([]);
      expect(state.reviewOccurred).toBe(false);
      expect(state.forceDoneUsed).toBe(false);
    });

    it("reads saved state from disk", () => {
      saveReviewGateState(
        {
          lastFindings: [SAMPLE_FINDING],
          reviewOccurred: true,
          forceDoneUsed: false,
        },
        "ISSUE-1",
      );
      const state = loadReviewGateState("ISSUE-1");
      expect(state.lastFindings).toHaveLength(1);
      expect(state.lastFindings[0].file).toBe("src/a.ts");
      expect(state.reviewOccurred).toBe(true);
    });

    it("returns initial state for corrupt file", () => {
      const dir = path.join(tmpDir, ".aicoder");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "review-gate-state-ISSUE-1.json"),
        "not-json",
        "utf-8",
      );
      const state = loadReviewGateState("ISSUE-1");
      expect(state.lastFindings).toEqual([]);
    });

    it("returns initial state for file missing lastFindings", () => {
      const dir = path.join(tmpDir, ".aicoder");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "review-gate-state-ISSUE-1.json"),
        JSON.stringify({ reviewOccurred: true }),
        "utf-8",
      );
      const state = loadReviewGateState("ISSUE-1");
      expect(state.lastFindings).toEqual([]);
    });

    it("uses default key when no issueKey provided", () => {
      saveReviewGateState(
        {
          lastFindings: [SAMPLE_FINDING],
          reviewOccurred: true,
          forceDoneUsed: false,
        },
      );
      const state = loadReviewGateState();
      expect(state.lastFindings).toHaveLength(1);
    });
  });

  // ── saveReviewGateState ─────────────────────────────────────────────────────

  describe("saveReviewGateState", () => {
    it("persists state to disk", () => {
      saveReviewGateState(
        {
          lastFindings: [SAMPLE_FINDING],
          reviewOccurred: true,
          forceDoneUsed: false,
        },
        "ISSUE-1",
      );
      const filePath = path.join(
        tmpDir,
        ".aicoder",
        "review-gate-state-ISSUE-1.json",
      );
      expect(fs.existsSync(filePath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      expect(data.lastFindings).toHaveLength(1);
    });

    it("creates .aicoder directory if missing", () => {
      saveReviewGateState(
        {
          lastFindings: [],
          reviewOccurred: false,
          forceDoneUsed: false,
        },
        "ISSUE-1",
      );
      expect(
        fs.existsSync(path.join(tmpDir, ".aicoder")),
      ).toBe(true);
    });
  });

  // ── clearReviewGateState ────────────────────────────────────────────────────

  describe("clearReviewGateState", () => {
    it("removes the state file", () => {
      saveReviewGateState(
        {
          lastFindings: [SAMPLE_FINDING],
          reviewOccurred: true,
          forceDoneUsed: false,
        },
        "ISSUE-1",
      );
      clearReviewGateState("ISSUE-1");
      expect(loadReviewGateState("ISSUE-1").lastFindings).toEqual([]);
    });

    it("does not affect other issue keys", () => {
      saveReviewGateState(
        { lastFindings: [SAMPLE_FINDING], reviewOccurred: true, forceDoneUsed: false },
        "ISSUE-1",
      );
      saveReviewGateState(
        { lastFindings: [ANOTHER_FINDING], reviewOccurred: true, forceDoneUsed: false },
        "ISSUE-2",
      );

      clearReviewGateState("ISSUE-1");
      expect(loadReviewGateState("ISSUE-1").lastFindings).toEqual([]);
      expect(loadReviewGateState("ISSUE-2").lastFindings).toHaveLength(1);
    });

    it("does not throw when file does not exist", () => {
      expect(() => clearReviewGateState("ISSUE-999")).not.toThrow();
    });
  });

  // ── recordGateFindings ──────────────────────────────────────────────────────

  describe("recordGateFindings", () => {
    it("records findings and sets reviewOccurred", () => {
      recordGateFindings([SAMPLE_FINDING], "ISSUE-1");
      const state = loadReviewGateState("ISSUE-1");
      expect(state.lastFindings).toHaveLength(1);
      expect(state.reviewOccurred).toBe(true);
    });

    it("preserves forceDone flag from previous state", () => {
      saveReviewGateState(
        {
          lastFindings: [],
          reviewOccurred: true,
          forceDoneUsed: true,
          forceDoneAt: "2026-01-01T00:00:00Z",
        },
        "ISSUE-1",
      );
      recordGateFindings([SAMPLE_FINDING], "ISSUE-1");
      const state = loadReviewGateState("ISSUE-1");
      expect(state.forceDoneUsed).toBe(true);
      expect(state.lastFindings).toHaveLength(1);
    });

    it("overwrites previous findings", () => {
      recordGateFindings([SAMPLE_FINDING], "ISSUE-1");
      recordGateFindings([ANOTHER_FINDING], "ISSUE-1");
      const state = loadReviewGateState("ISSUE-1");
      expect(state.lastFindings).toHaveLength(1);
      expect(state.lastFindings[0].file).toBe("src/b.ts");
    });
  });

  // ── markForceDone ───────────────────────────────────────────────────────────

  describe("markForceDone", () => {
    it("sets forceDoneUsed and forceDoneAt", () => {
      recordGateFindings([SAMPLE_FINDING], "ISSUE-1");
      markForceDone("ISSUE-1");
      const state = loadReviewGateState("ISSUE-1");
      expect(state.forceDoneUsed).toBe(true);
      expect(state.forceDoneAt).toBeDefined();
      expect(new Date(state.forceDoneAt!).getTime()).not.toBeNaN();
    });
  });

  // ── getLastFindings ─────────────────────────────────────────────────────────

  describe("getLastFindings", () => {
    it("returns empty array when no findings recorded", () => {
      expect(getLastFindings("ISSUE-1")).toEqual([]);
    });

    it("returns the last recorded findings", () => {
      recordGateFindings([SAMPLE_FINDING, ANOTHER_FINDING], "ISSUE-1");
      const findings = getLastFindings("ISSUE-1");
      expect(findings).toHaveLength(2);
      expect(findings[0].file).toBe("src/a.ts");
      expect(findings[1].file).toBe("src/b.ts");
    });
  });

  // ── path traversal validation ───────────────────────────────────────────────

  describe("path traversal protection", () => {
    it("rejects issueKey with forward slash", () => {
      expect(() =>
        saveReviewGateState(
          { lastFindings: [], reviewOccurred: false, forceDoneUsed: false },
          "PROJ/123",
        ),
      ).toThrow(/Invalid issueKey/);
    });

    it("rejects issueKey with ..", () => {
      expect(() =>
        loadReviewGateState("../etc/passwd"),
      ).toThrow(/Invalid issueKey/);
    });

    it("rejects issueKey with backslash", () => {
      expect(() =>
        clearReviewGateState("PROJ\\123"),
      ).toThrow(/Invalid issueKey/);
    });
  });

  // ── concurrency isolation ───────────────────────────────────────────────────

  describe("per-issue isolation", () => {
    it("supports many concurrent issues independently", () => {
      for (let i = 1; i <= 10; i++) {
        recordGateFindings(
          [{ severity: "low", category: "test", file: `f${i}.ts`, message: `m${i}` }],
          `ISSUE-${i}`,
        );
      }
      for (let i = 1; i <= 10; i++) {
        const findings = getLastFindings(`ISSUE-${i}`);
        expect(findings).toHaveLength(1);
        expect(findings[0].file).toBe(`f${i}.ts`);
      }
    });
  });
});
