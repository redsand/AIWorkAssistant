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
    vi.clearAllMocks();
    (fs.existsSync as any).mockReturnValue(false);
    (fs.readFileSync as any).mockReturnValue("{}");
    (fs.writeFileSync as any).mockReturnValue(undefined);
    (fs.mkdirSync as any).mockReturnValue(undefined);
    (fs.unlinkSync as any).mockReturnValue(undefined);
  });

  // ── loadReviewGateState ───────────────────────────────────────────────────────

  describe("loadReviewGateState", () => {
    it("returns initReviewGateState when file does not exist", () => {
      mockExistsSync.mockReturnValue(false);

      const state = loadReviewGateState("TEST-1");

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

      const state = loadReviewGateState("TEST-1");

      expect(state.lastFindings).toHaveLength(1);
      expect(state.reviewOccurred).toBe(true);
    });

    it("returns init state when file content is not valid JSON", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("not-json{{{");

      const state = loadReviewGateState("TEST-1");

      expect(state.lastFindings).toEqual([]);
      expect(state.reviewOccurred).toBe(false);
    });

    it("returns init state when JSON lacks lastFindings array", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ foo: "bar" }));

      const state = loadReviewGateState("TEST-1");

      expect(state.lastFindings).toEqual([]);
    });

    it("uses per-issue file path with issueKey", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        lastFindings: [],
        reviewOccurred: true,
        forceDoneUsed: false,
      }));

      loadReviewGateState("MY-PROJECT-42");

      expect(mockExistsSync).toHaveBeenCalledWith(
        expect.stringContaining("review-gate-state-MY-PROJECT-42.json"),
      );
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

      saveReviewGateState(state, "TEST-1");

      expect(mockMkdirSync).toHaveBeenCalled();
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining("review-gate-state-TEST-1.json"),
        JSON.stringify(state, null, 2),
        "utf-8",
      );
    });

    it("saves to per-issue file when issueKey is provided", () => {
      const state = {
        lastFindings: [],
        reviewOccurred: false,
        forceDoneUsed: false,
      };

      saveReviewGateState(state, "ISSUE-42");

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining("review-gate-state-ISSUE-42.json"),
        expect.any(String),
        "utf-8",
      );
    });

    it("does not throw when write fails", () => {
      mockMkdirSync.mockImplementation(() => {
        throw new Error("disk full");
      });

      expect(() => saveReviewGateState({
        lastFindings: [],
        reviewOccurred: false,
        forceDoneUsed: false,
      }, "TEST-1")).not.toThrow();
    });
  });

  // ── clearReviewGateState ──────────────────────────────────────────────────────

  describe("clearReviewGateState", () => {
    it("deletes the state file when it exists", () => {
      mockExistsSync.mockReturnValue(true);

      clearReviewGateState("TEST-1");

      expect(mockUnlinkSync).toHaveBeenCalledWith(
        expect.stringContaining("review-gate-state-TEST-1.json"),
      );
    });

    it("does not attempt to delete when the file does not exist", () => {
      mockExistsSync.mockReturnValue(false);

      clearReviewGateState("TEST-1");

      expect(mockUnlinkSync).not.toHaveBeenCalled();
    });

    it("does not throw when unlink fails", () => {
      mockExistsSync.mockReturnValue(true);
      mockUnlinkSync.mockImplementation(() => {
        throw new Error("permission denied");
      });

      expect(() => clearReviewGateState("TEST-1")).not.toThrow();
    });
  });

  // ── recordGateFindings ────────────────────────────────────────────────────────

  describe("recordGateFindings", () => {
    it("updates lastFindings and sets reviewOccurred to true", () => {
      const findings = [
        { severity: "critical", category: "security", file: "a.ts", message: "bad" },
      ];

      recordGateFindings(findings, "TEST-1");

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining("review-gate-state-TEST-1.json"),
        expect.any(String),
        "utf-8",
      );
      const saved = JSON.parse((mockWriteFileSync as any).mock.calls[0][1]);
      expect(saved.lastFindings).toHaveLength(1);
      expect(saved.reviewOccurred).toBe(true);
    });

    it("writes to distinct files for distinct issue keys", () => {
      const findingsA = [
        { severity: "critical", category: "security", file: "a.ts", message: "bad" },
      ];
      const findingsB = [
        { severity: "high", category: "quality", file: "b.ts", message: "warn" },
      ];

      recordGateFindings(findingsA, "ISSUE-1");
      recordGateFindings(findingsB, "ISSUE-2");

      const calls = (mockWriteFileSync as any).mock.calls;
      expect(calls[0][0]).toContain("review-gate-state-ISSUE-1.json");
      expect(calls[1][0]).toContain("review-gate-state-ISSUE-2.json");
    });
  });

  describe("markForceDone", () => {
    it("sets forceDoneUsed to true and records timestamp", () => {
      markForceDone("TEST-1");

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining("review-gate-state-TEST-1.json"),
        expect.any(String),
        "utf-8",
      );
      const saved = JSON.parse((mockWriteFileSync as any).mock.calls[0][1]);
      expect(saved.forceDoneUsed).toBe(true);
      expect(saved.forceDoneAt).not.toBeUndefined();
    });
  });

  // ── getLastFindings ───────────────────────────────────────────────────────────

  describe("getLastFindings", () => {
    it("returns lastFindings from the loaded state", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        lastFindings: [{ severity: "medium", category: "quality", file: "c.ts", message: "warning" }],
        reviewOccurred: true,
        forceDoneUsed: false,
      }));

      const last = getLastFindings("TEST-1");
      expect(last).toHaveLength(1);
      expect(last[0].file).toBe("c.ts");
    });

    it("returns empty array when no findings have been recorded", () => {
      mockExistsSync.mockReturnValue(false);
      const last = getLastFindings("TEST-1");
      expect(last).toEqual([]);
    });
  });
});
