import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ─── validateIssueKey ────────────────────────────────────────────────────────
// Duplicated from aicoder.ts to avoid importing the heavy module.
// The exported _runStateInternals.validateIssueKey is the source of truth;
// this copy must stay in sync.

const INVALID_KEY_RE = /[/\\]|\.\./;

function validateIssueKey(issueKey: string): void {
  if (INVALID_KEY_RE.test(issueKey)) {
    throw new Error(
      `Invalid issueKey "${issueKey}": must not contain /, \\, or ..`,
    );
  }
}

// ─── File system helpers matching aicoder.ts run-state pattern ────────────────

interface RunState {
  checkpoint: string;
  issueKey: string;
  [k: string]: unknown;
}

function getRunStateFile(baseDir: string, issueKey?: string): string {
  if (issueKey) validateIssueKey(issueKey);
  const aicoderDir = path.join(baseDir, ".aicoder");
  const name = issueKey
    ? `run-state-${issueKey}.json`
    : "run-state.json";
  return path.join(aicoderDir, name);
}

function saveRunState(
  baseDir: string,
  state: RunState,
  issueKey?: string,
): void {
  const filePath = getRunStateFile(baseDir, issueKey || state.issueKey);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

function loadRunState(baseDir: string, issueKey?: string): RunState | null {
  const filePath = getRunStateFile(baseDir, issueKey);
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (data && data.checkpoint && data.issueKey) return data;
    }
  } catch {
    // corrupt or missing
  }
  // Legacy fallback
  if (issueKey) return loadRunState(baseDir);
  return null;
}

function clearRunState(baseDir: string, issueKey?: string): void {
  const filePath = getRunStateFile(baseDir, issueKey);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* non-fatal */
  }
  if (issueKey) {
    const legacyPath = getRunStateFile(baseDir);
    try {
      if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
    } catch {
      /* non-fatal */
    }
  }
}

/** Mirrors aicoder.ts findExistingRunState scanning logic. */
function findExistingRunState(
  baseDir: string,
  targetIssueKey?: string,
): RunState | null {
  if (targetIssueKey) {
    const state = loadRunState(baseDir, targetIssueKey);
    if (state) return state;
  }
  const dir = path.join(baseDir, ".aicoder");
  try {
    if (!fs.existsSync(dir)) return null;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith("run-state-") && entry.endsWith(".json")) {
        const key = entry.slice("run-state-".length, -".json".length);
        const state = loadRunState(baseDir, key);
        if (state) return state;
      }
    }
  } catch {
    /* non-fatal */
  }
  return loadRunState(baseDir);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("validateIssueKey", () => {
  it("should accept valid issue keys", () => {
    expect(() => validateIssueKey("PROJ-123")).not.toThrow();
    expect(() => validateIssueKey("abc")).not.toThrow();
    expect(() => validateIssueKey("PROJ_123")).not.toThrow();
  });

  it("should reject keys with forward slash", () => {
    expect(() => validateIssueKey("PROJ/123")).toThrow(/Invalid issueKey/);
  });

  it("should reject keys with backslash", () => {
    expect(() => validateIssueKey("PROJ\\123")).toThrow(/Invalid issueKey/);
  });

  it("should reject keys with .. (path traversal)", () => {
    expect(() => validateIssueKey("..")).toThrow(/Invalid issueKey/);
    expect(() => validateIssueKey("../etc/passwd")).toThrow(/Invalid issueKey/);
    expect(() => validateIssueKey("foo..bar")).toThrow(/Invalid issueKey/);
  });
});

describe("findExistingRunState scanning logic", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aicoder-rs-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeState(issueKey: string, checkpoint: string): RunState {
    return { checkpoint, issueKey };
  }

  it("returns null when no state files exist", () => {
    expect(findExistingRunState(tmpDir)).toBeNull();
  });

  it("finds state by target issue key first", () => {
    saveRunState(tmpDir, makeState("PROJ-1", "branch_checked_out"), "PROJ-1");
    saveRunState(tmpDir, makeState("PROJ-2", "tests_passed"), "PROJ-2");

    const state = findExistingRunState(tmpDir, "PROJ-1");
    expect(state).not.toBeNull();
    expect(state!.issueKey).toBe("PROJ-1");
    expect(state!.checkpoint).toBe("branch_checked_out");
  });

  it("scans directory when target key has no state", () => {
    saveRunState(tmpDir, makeState("PROJ-5", "tests_passed"), "PROJ-5");

    // No target key provided — should scan and find PROJ-5
    const state = findExistingRunState(tmpDir);
    expect(state).not.toBeNull();
    expect(state!.issueKey).toBe("PROJ-5");
  });

  it("falls back to legacy run-state.json", () => {
    // Only the legacy file exists
    const aicoderDir = path.join(tmpDir, ".aicoder");
    fs.mkdirSync(aicoderDir, { recursive: true });
    fs.writeFileSync(
      path.join(aicoderDir, "run-state.json"),
      JSON.stringify(makeState("LEGACY-1", "issue_transitioned")),
      "utf-8",
    );

    const state = findExistingRunState(tmpDir);
    expect(state).not.toBeNull();
    expect(state!.issueKey).toBe("LEGACY-1");
  });

  it("prefers keyed file over legacy fallback", () => {
    saveRunState(tmpDir, makeState("PROJ-1", "branch_checked_out"), "PROJ-1");
    // Legacy file
    const aicoderDir = path.join(tmpDir, ".aicoder");
    fs.writeFileSync(
      path.join(aicoderDir, "run-state.json"),
      JSON.stringify(makeState("LEGACY-1", "issue_transitioned")),
      "utf-8",
    );

    const state = findExistingRunState(tmpDir, "PROJ-1");
    expect(state!.issueKey).toBe("PROJ-1");
  });

  it("skips corrupt state files during scan", () => {
    const aicoderDir = path.join(tmpDir, ".aicoder");
    fs.mkdirSync(aicoderDir, { recursive: true });
    fs.writeFileSync(
      path.join(aicoderDir, "run-state-BAD.json"),
      "not-json",
      "utf-8",
    );
    saveRunState(tmpDir, makeState("PROJ-9", "tests_passed"), "PROJ-9");

    const state = findExistingRunState(tmpDir);
    expect(state).not.toBeNull();
    expect(state!.issueKey).toBe("PROJ-9");
  });

  it("skips state files missing required fields", () => {
    const aicoderDir = path.join(tmpDir, ".aicoder");
    fs.mkdirSync(aicoderDir, { recursive: true });
    fs.writeFileSync(
      path.join(aicoderDir, "run-state-INCOMPLETE.json"),
      JSON.stringify({ checkpoint: "tests_passed" }), // missing issueKey
      "utf-8",
    );
    saveRunState(tmpDir, makeState("PROJ-10", "tests_passed"), "PROJ-10");

    const state = findExistingRunState(tmpDir);
    expect(state).not.toBeNull();
    expect(state!.issueKey).toBe("PROJ-10");
  });
});

describe("clearRunState legacy cleanup", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aicoder-clear-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeState(issueKey: string): RunState {
    return { checkpoint: "tests_passed", issueKey };
  }

  it("deletes both keyed and legacy files", () => {
    saveRunState(tmpDir, makeState("PROJ-1"), "PROJ-1");
    // Also create legacy file
    const aicoderDir = path.join(tmpDir, ".aicoder");
    fs.writeFileSync(
      path.join(aicoderDir, "run-state.json"),
      JSON.stringify(makeState("PROJ-1")),
      "utf-8",
    );

    clearRunState(tmpDir, "PROJ-1");

    expect(loadRunState(tmpDir, "PROJ-1")).toBeNull();
    expect(loadRunState(tmpDir)).toBeNull();
  });

  it("only deletes the keyed file when no legacy file exists", () => {
    saveRunState(tmpDir, makeState("PROJ-1"), "PROJ-1");
    clearRunState(tmpDir, "PROJ-1");
    expect(loadRunState(tmpDir, "PROJ-1")).toBeNull();
  });

  it("does not throw when no files exist", () => {
    expect(() => clearRunState(tmpDir, "PROJ-1")).not.toThrow();
  });
});
