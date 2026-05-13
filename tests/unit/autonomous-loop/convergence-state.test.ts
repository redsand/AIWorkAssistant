import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  loadConvergenceState,
  saveConvergenceState,
  clearConvergenceState,
  _resetCache,
  serializeConvergence,
} from "../../../src/autonomous-loop/convergence-state";
import { initConvergenceState, recordRoundFindings, hashFinding, type ConvergenceState } from "../../../src/autonomous-loop/convergence";

// ── Helpers ──────────────────────────────────────────────────────────────────

const STATE_DIR = path.join(process.cwd(), ".aicoder");
const STATE_FILE = path.join(STATE_DIR, "convergence-state.json");

function fileExists(fp: string): boolean {
  try { return fs.existsSync(fp); } catch { return false; }
}

function readFile(fp: string): string | null {
  try { return fs.readFileSync(fp, "utf-8"); } catch { return null; }
}

function removeFile(fp: string): void {
  try { fs.unlinkSync(fp); } catch { /* ignore */ }
}

const finding1 = { file: "src/auth.ts", severity: "high", category: "security", message: "Auth bypass" };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("convergence-state persistence", () => {
  beforeEach(() => {
    _resetCache();
    removeFile(STATE_FILE);
  });

  afterEach(() => {
    _resetCache();
    removeFile(STATE_FILE);
  });

  describe("loadConvergenceState", () => {
    it("returns fresh state when no file exists", () => {
      const state = loadConvergenceState();
      expect(state.roundNumber).toBe(0);
      expect(state.previousFindings).toEqual([]);
      expect(state.emptyPRCount).toBe(0);
      expect(state.identicalCount.size).toBe(0);
      expect(state.lastRoundFindings.size).toBe(0);
    });

    it("loads state from disk when file exists", () => {
      const original = initConvergenceState();
      const evolved = recordRoundFindings(original, [finding1], true);
      saveConvergenceState(evolved);

      // Clear the in-memory cache to force a disk load (keep file)
      _resetCache();

      const loaded = loadConvergenceState();
      expect(loaded.roundNumber).toBe(1);
      expect(loaded.findingsResolved).toBe(evolved.findingsResolved);
      expect(loaded.findingsNew).toBe(evolved.findingsNew);
    });

    it("returns fresh state when file is corrupt", () => {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, "{ not valid json }}}", "utf-8");

      _resetCache();
      const state = loadConvergenceState();
      expect(state.roundNumber).toBe(0);
      expect(state.identicalCount.size).toBe(0);
    });

    it("returns fresh state when file has invalid shape", () => {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify({ foo: "bar" }), "utf-8");

      _resetCache();
      const state = loadConvergenceState();
      expect(state.roundNumber).toBe(0);
    });

    it("returns cached state on subsequent calls without disk read", () => {
      const first = loadConvergenceState();
      const second = loadConvergenceState();
      expect(first).toBe(second); // same reference — cached
    });
  });

  describe("saveConvergenceState", () => {
    it("persists state to disk as JSON", () => {
      const state = recordRoundFindings(initConvergenceState(), [finding1], true);
      saveConvergenceState(state);

      const raw = readFile(STATE_FILE);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.roundNumber).toBe(1);
    });

    it("serializes Map and Set to plain JSON types", () => {
      let state = initConvergenceState();
      state = recordRoundFindings(state, [finding1], true);

      saveConvergenceState(state);

      const raw = readFile(STATE_FILE);
      const parsed = JSON.parse(raw!);
      // identicalCount should be a plain object (not a Map)
      expect(typeof parsed.identicalCount).toBe("object");
      expect(parsed.identicalCount).not.toBeInstanceOf(Array);
      // lastRoundFindings should be an array (not a Set)
      expect(Array.isArray(parsed.lastRoundFindings)).toBe(true);
    });

    it("creates .aicoder directory if it doesn't exist", () => {
      // Remove dir if it exists
      try { fs.rmSync(STATE_DIR, { recursive: true }); } catch { /* ignore */ }

      const state = initConvergenceState();
      saveConvergenceState(state);
      expect(fileExists(STATE_FILE)).toBe(true);
    });

    it("round-trips state through save → clear cache → load", () => {
      let state = initConvergenceState();
      state = recordRoundFindings(state, [finding1], true);
      state = recordRoundFindings(state, [finding1], true);
      // state has: roundNumber=2, identicalCount with finding1→2, lastRoundFindings with finding1

      saveConvergenceState(state);
      _resetCache();
      const loaded = loadConvergenceState();

      expect(loaded.roundNumber).toBe(2);
      expect(loaded.emptyPRCount).toBe(0);
      expect(loaded.identicalCount.get(hashFinding(finding1))).toBe(2);
      expect(loaded.lastRoundFindings.has(hashFinding(finding1))).toBe(true);
      expect(loaded.previousFindings).toContain(hashFinding(finding1));
    });
  });

  describe("clearConvergenceState", () => {
    it("removes the state file from disk", () => {
      saveConvergenceState(initConvergenceState());
      expect(fileExists(STATE_FILE)).toBe(true);

      clearConvergenceState();
      expect(fileExists(STATE_FILE)).toBe(false);
    });

    it("clears the in-memory cache and deletes the file", () => {
      saveConvergenceState(recordRoundFindings(initConvergenceState(), [finding1], true));
      expect(fileExists(STATE_FILE)).toBe(true);

      clearConvergenceState();
      expect(fileExists(STATE_FILE)).toBe(false);

      // Next load should return a fresh object
      const fresh = loadConvergenceState();
      expect(fresh.roundNumber).toBe(0);
    });

    it("does not throw when file doesn't exist", () => {
      removeFile(STATE_FILE);
      expect(() => clearConvergenceState()).not.toThrow();
    });
  });

  describe("serializeConvergence", () => {
    it("converts Map to plain object and Set to array", () => {
      let state = initConvergenceState();
      state = recordRoundFindings(state, [finding1], true);

      const serialized = serializeConvergence(state);
      expect(typeof serialized.identicalCount).toBe("object");
      expect(serialized.identicalCount).not.toBeInstanceOf(Map);
      expect(Array.isArray(serialized.lastRoundFindings)).toBe(true);
      expect(serialized.lastRoundFindings).toContain(hashFinding(finding1));
    });

    it("preserves all scalar fields", () => {
      let state = initConvergenceState();
      state = recordRoundFindings(state, [finding1], true);
      state = { ...state, emptyPRCount: 2, noProgressCount: 3 };

      const serialized = serializeConvergence(state);
      expect(serialized.roundNumber).toBe(1);
      expect(serialized.emptyPRCount).toBe(2);
      expect(serialized.noProgressCount).toBe(3);
      expect(serialized.findingsResolved).toBe(state.findingsResolved);
      expect(serialized.findingsNew).toBe(state.findingsNew);
    });
  });
});