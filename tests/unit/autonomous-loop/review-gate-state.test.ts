import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ── Mocks ──────────────────────────────────────────────────────────────────────

// We mock the fs module so tests do not touch the real filesystem.
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import {
  loadReviewGateState,
  saveReviewGateState,
  clearReviewGateState,
  recordGateFindings,
  markForceDone,
  getLastFindings,
} from "../../../src/autonomous-loop/review-gate-state";

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);
const mockUnlinkSync = vi.mocked(fs.unlinkSync);

describe("review-gate-state", () => {
  beforeEach(() => {
    // Reset call history but keep mock implementations
    vi.clearAllMocks();
    // Set default return values for fs mocks
    (fs.existsSync as any).mockReturnValue(false);
    (fs.readFileSync as any).mockReturnValue("{}");
    (fs.writeFileSync as any).mockReturnValue(undefined);
    (fs.mkdirSync as any).mockReturnValue(undefined);
    (fs.unlinkSync as any).mockReturnValue(undefined);
    // Reset the in-memory cache between tests
    clearReviewGateState();
  });

  // ── loadReviewGateState ───────────────────────────────────────────────────────

  describe("loadReviewGateState", () => {
    it("returns initReviewGateState when file does not exist", () => {
      mockExistsSync.mockReturnValue(false);

      const state = loadReviewGateState();

      expect(state.lastFindings).toEqual([]);
      expect(state.reviewOccurred).toBe(false);
      expect(state.forceDoneUsed).toBe(false);
    });

    it("reads and parses the state file when it exists", () => {
      const fileState = {
        lastFindings: [{ severity: "high", category: "security", file: "a.ts", message: "bug" }],
        reviewOccurred: true,
        forceDoneUsed: false,
      };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(fileState));

      const state = loadReviewGateState();

      expect(state.lastFindings).toHaveLength(1);
      expect(state.reviewOccurred).toBe(true);
    });

    it("returns init state when file content is not valid JSON", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("not-json{{{");

      const state = loadReviewGateState();

      expect(state.lastFindings).toEqual([]);
      expect(state.reviewOccurred).toBe(false);
    });

    it("returns init state when JSON lacks lastFindings array", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ foo: "bar" }));

      const state = loadReviewGateState();

      expect(state.lastFindings).toEqual([]);
    });

    it("caches the state in memory on subsequent calls", () => {
      const fileState = {
        lastFindings: [],
        reviewOccurred: true,
        forceDoneUsed: false,
      };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(fileState));

      loadReviewGateState();
      loadReviewGateState();

      // File should only be read once (second call uses cache)
      expect(mockReadFileSync).toHaveBeenCalledTimes(1);
    });
  });

  // ── saveReviewGateState ───────────────────────────────────────────────────────

  describe("saveReviewGateState", () => {
    it("writes state as pretty-printed JSON to the state file", () => {
      const state = {
        lastFindings: [],
        reviewOccurred: false,
        forceDoneUsed: false,
      };

      saveReviewGateState(state);

      expect(mockMkdirSync).toHaveBeenCalled();
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.any(String),
        JSON.stringify(state, null, 2),
        "utf-8",
      );
    });

    it("caches the saved state for subsequent loads", () => {
      const state = {
        lastFindings: [{ severity: "critical", category: "security", file: "x.ts", message: "bad" }],
        reviewOccurred: true,
        forceDoneUsed: false,
      };

      saveReviewGateState(state);

      // Now load should return the saved state without reading from disk
      mockExistsSync.mockReturnValue(false);
      const loaded = loadReviewGateState();

      expect(loaded.lastFindings).toHaveLength(1);
      expect(mockReadFileSync).not.toHaveBeenCalled();
    });

    it("does not throw when write fails", () => {
      mockMkdirSync.mockImplementation(() => {
        throw new Error("disk full");
      });

      expect(() => saveReviewGateState({
        lastFindings: [],
        reviewOccurred: false,
        forceDoneUsed: false,
      })).not.toThrow();
    });
  });

  // ── clearReviewGateState ──────────────────────────────────────────────────────

  describe("clearReviewGateState", () => {
    it("deletes the state file when it exists", () => {
      mockExistsSync.mockReturnValue(true);

      clearReviewGateState();

      expect(mockUnlinkSync).toHaveBeenCalled();
    });

    it("does not attempt to delete when the file does not exist", () => {
      mockExistsSync.mockReturnValue(false);

      clearReviewGateState();

      expect(mockUnlinkSync).not.toHaveBeenCalled();
    });

    it("does not throw when unlink fails", () => {
      mockExistsSync.mockReturnValue(true);
      mockUnlinkSync.mockImplementation(() => {
        throw new Error("permission denied");
      });

      expect(() => clearReviewGateState()).not.toThrow();
    });

    it("clears the in-memory cache so next load reads from disk", () => {
      // First, populate the cache
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        lastFindings: [],
        reviewOccurred: true,
        forceDoneUsed: false,
      }));
      loadReviewGateState();

      // Now clear
      clearReviewGateState();

      // Next load should return default state (file doesn't exist)
      mockExistsSync.mockReturnValue(false);
      const state = loadReviewGateState();
      expect(state.reviewOccurred).toBe(false);
    });
  });

  // ── recordGateFindings ────────────────────────────────────────────────────────

  describe("recordGateFindings", () => {
    it("updates lastFindings and sets reviewOccurred to true", () => {
      const findings = [
        { severity: "critical", category: "security", file: "a.ts", message: "bad" },
      ];

      recordGateFindings(findings);

      const state = loadReviewGateState();
      expect(state.lastFindings).toHaveLength(1);
      expect(state.reviewOccurred).toBe(true);
    });

    it("preserves forceDoneUsed from existing state", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        lastFindings: [],
        reviewOccurred: true,
        forceDoneUsed: true,
        forceDoneAt: "2025-01-01T00:00:00.000Z",
      }));

      loadReviewGateState();

      recordGateFindings([
        { severity: "high", category: "quality", file: "b.ts", message: "issue" },
      ]);

      const state = loadReviewGateState();
      expect(state.forceDoneUsed).toBe(true);
      expect(state.forceDoneAt).toBe("2025-01-01T00:00:00.000Z");
    });
  });

  describe("markForceDone", () => {
    it("sets forceDoneUsed to true and records timestamp", () => {
      markForceDone();

      const state = loadReviewGateState();
      expect(state.forceDoneUsed).toBe(true);
      expect(state.forceDoneAt).not.toBeUndefined();
    });
  });

  // ── getLastFindings ───────────────────────────────────────────────────────────

  describe("getLastFindings", () => {
    it("returns lastFindings from the current state", () => {
      const findings = [
        { severity: "medium", category: "quality", file: "c.ts", message: "warning" },
      ];
      recordGateFindings(findings);

      const last = getLastFindings();
      expect(last).toHaveLength(1);
      expect(last[0].file).toBe("c.ts");
    });

    it("returns empty array when no findings have been recorded", () => {
      clearReviewGateState();
      const last = getLastFindings();
      expect(last).toEqual([]);
    });
  });
});
