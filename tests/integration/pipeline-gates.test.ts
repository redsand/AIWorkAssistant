/**
 * Integration tests for the P0 pipeline safety gates.
 *
 * Verifies that validateDiffBeforePush, validateOutputFromDiff,
 * convergence detection, and the review gate all behave correctly
 * when composed together — without spawning aicoder or requiring git.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  validateDiffBeforePush,
  validateOutputFromDiff,
  EXIT_SUCCESS,
  EXIT_NO_CHANGES,
  EXIT_PLACEHOLDER_ONLY,
  EXIT_WHITESPACE_ONLY,
  EXIT_META_ONLY,
} from "../../src/aicoder-pipeline";

import {
  initConvergenceState,
  recordRoundFindings,
  checkConvergence,
  DEFAULT_CONVERGENCE_CONFIG,
} from "../../src/autonomous-loop/convergence";

import { reviewGate } from "../../src/autonomous-loop/review-gate";

import {
  loadConvergenceState,
  saveConvergenceState,
  clearConvergenceState,
  _resetCache,
} from "../../src/autonomous-loop/convergence-state";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDiffStat(filesChanged: number, insertions: number, deletions = 0): string {
  const parts: string[] = [];
  if (insertions > 0) parts.push(`${insertions} insertion${insertions !== 1 ? "s" : ""}(+)`);
  if (deletions > 0) parts.push(`${deletions} deletion${deletions !== 1 ? "s" : ""}(-)`);
  return `${filesChanged} file${filesChanged !== 1 ? "s" : ""} changed${parts.length ? ", " + parts.join(", ") : ""}`;
}

function makeGitDiff(files: Array<{ path: string; lines: string[] }>): string {
  return files
    .map(({ path: p, lines }) => {
      const added = lines.map((l) => `+${l}`).join("\n");
      return `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n${added}`;
    })
    .join("\n");
}

// ── validateDiffBeforePush ─────────────────────────────────────────────────────

describe("validateDiffBeforePush — empty diff", () => {
  it("returns EXIT_NO_CHANGES for empty diffStat", () => {
    const result = validateDiffBeforePush("", "");
    expect(result.valid).toBe(false);
    expect(result.exitCode).toBe(EXIT_NO_CHANGES);
    expect(result.reason).toBe("NO_CHANGES");
  });

  it("returns EXIT_NO_CHANGES for whitespace-only diffStat", () => {
    const result = validateDiffBeforePush("   \n  ", "");
    expect(result.valid).toBe(false);
    expect(result.exitCode).toBe(EXIT_NO_CHANGES);
  });

  it("returns EXIT_NO_CHANGES when filesChanged parses to 0", () => {
    // A stat line that mentions 0 files — malformed but safe to handle
    const result = validateDiffBeforePush("0 files changed", "");
    expect(result.valid).toBe(false);
    expect(result.exitCode).toBe(EXIT_NO_CHANGES);
  });
});

describe("validateDiffBeforePush — whitespace-only diff", () => {
  it("returns EXIT_WHITESPACE_ONLY when all added lines are blank", () => {
    const stat = makeDiffStat(1, 3);
    const diff = makeGitDiff([{ path: "src/foo.ts", lines: ["", "  ", "\t"] }]);
    const result = validateDiffBeforePush(stat, diff);
    expect(result.valid).toBe(false);
    expect(result.exitCode).toBe(EXIT_WHITESPACE_ONLY);
    expect(result.reason).toBe("WHITESPACE_ONLY");
  });

  it("passes when whitespace lines are mixed with real content", () => {
    const stat = makeDiffStat(1, 2);
    const diff = makeGitDiff([{ path: "src/foo.ts", lines: ["", "const x = 1;"] }]);
    const result = validateDiffBeforePush(stat, diff);
    expect(result.valid).toBe(true);
    expect(result.exitCode).toBe(EXIT_SUCCESS);
  });
});

describe("validateDiffBeforePush — meta-only diff", () => {
  it("returns EXIT_META_ONLY when only .gitignore changed", () => {
    const stat = makeDiffStat(1, 1);
    const diff = makeGitDiff([{ path: ".gitignore", lines: ["dist/"] }]);
    const result = validateDiffBeforePush(stat, diff);
    expect(result.valid).toBe(false);
    expect(result.exitCode).toBe(EXIT_META_ONLY);
    expect(result.reason).toBe("META_ONLY");
  });

  it("returns EXIT_META_ONLY when only tsconfig.json changed", () => {
    const stat = makeDiffStat(1, 2);
    const diff = makeGitDiff([{ path: "tsconfig.json", lines: ['"strict": true'] }]);
    const result = validateDiffBeforePush(stat, diff);
    expect(result.valid).toBe(false);
    expect(result.exitCode).toBe(EXIT_META_ONLY);
  });

  it("returns EXIT_META_ONLY when only lock files changed", () => {
    const stat = makeDiffStat(1, 5);
    const diff = makeGitDiff([{ path: "pnpm-lock.yaml", lines: ["lockfileVersion: '9.0'"] }]);
    const result = validateDiffBeforePush(stat, diff);
    expect(result.valid).toBe(false);
    expect(result.exitCode).toBe(EXIT_META_ONLY);
  });

  it("passes when meta file is mixed with real source changes", () => {
    const stat = makeDiffStat(2, 4);
    const diff = makeGitDiff([
      { path: ".gitignore", lines: ["dist/"] },
      { path: "src/index.ts", lines: ["export const version = '2';"] },
    ]);
    const result = validateDiffBeforePush(stat, diff);
    expect(result.valid).toBe(true);
    expect(result.exitCode).toBe(EXIT_SUCCESS);
  });

  it("passes for deletions-only diffs (no added lines)", () => {
    const stat = makeDiffStat(1, 0, 3);
    // Diff with only removed lines (no + lines besides the header)
    const diff = `diff --git a/src/old.ts b/src/old.ts\n--- a/src/old.ts\n+++ b/src/old.ts\n-deleted line 1\n-deleted line 2`;
    const result = validateDiffBeforePush(stat, diff);
    expect(result.valid).toBe(true);
    expect(result.exitCode).toBe(EXIT_SUCCESS);
  });
});

// ── validateOutputFromDiff ─────────────────────────────────────────────────────

describe("validateOutputFromDiff — placeholder detection", () => {
  it("returns EXIT_PLACEHOLDER_ONLY when >80% of added lines are stubs", () => {
    const stat = makeDiffStat(1, 6);
    const stubLines = [
      "// TODO: implement auth",
      "// TODO: validate input",
      "// TODO: handle errors",
      "// TODO: write tests",
      "// PLACEHOLDER: not done",
      "// TODO: add logging",
    ];
    const diff = makeGitDiff([{ path: "src/auth.ts", lines: stubLines }]);
    const result = validateOutputFromDiff(stat, diff, false);
    expect(result.valid).toBe(false);
    expect(result.exitCode).toBe(EXIT_PLACEHOLDER_ONLY);
  });

  it("passes when stub lines are below the 80% threshold", () => {
    const stat = makeDiffStat(1, 4);
    const lines = [
      "// TODO: improve later",
      "const handler = async (req, res) => {",
      "  const data = await db.query('SELECT 1');",
      "  res.json(data);",
    ];
    const diff = makeGitDiff([{ path: "src/handler.ts", lines }]);
    const result = validateOutputFromDiff(stat, diff, false);
    expect(result.valid).toBe(true);
    expect(result.exitCode).toBe(EXIT_SUCCESS);
  });

  it("bypasses all checks when skipAgent is true", () => {
    const result = validateOutputFromDiff("", "", true);
    expect(result.valid).toBe(true);
    expect(result.exitCode).toBe(EXIT_SUCCESS);
  });

  it("returns EXIT_NO_CHANGES when diffStat is empty and skipAgent is false", () => {
    const result = validateOutputFromDiff("", "", false);
    expect(result.valid).toBe(false);
    expect(result.exitCode).toBe(EXIT_NO_CHANGES);
  });
});

// ── Convergence detection ─────────────────────────────────────────────────────

describe("convergence detection — identical findings stop the loop", () => {
  const finding = { file: "src/auth.ts", severity: "high", category: "security" };

  it("does not stop after round 1 with identical finding", () => {
    let state = initConvergenceState();
    state = recordRoundFindings(state, [finding], true);
    const result = checkConvergence(state, DEFAULT_CONVERGENCE_CONFIG);
    expect(result.shouldStop).toBe(false);
  });

  it("does not stop after round 2 with identical finding (at threshold)", () => {
    let state = initConvergenceState();
    state = recordRoundFindings(state, [finding], true);
    state = recordRoundFindings(state, [finding], true);
    const result = checkConvergence(state, DEFAULT_CONVERGENCE_CONFIG);
    expect(result.shouldStop).toBe(false);
  });

  it("stops after round 3 with identical finding (exceeds threshold)", () => {
    let state = initConvergenceState();
    state = recordRoundFindings(state, [finding], true);
    state = recordRoundFindings(state, [finding], true);
    state = recordRoundFindings(state, [finding], true);
    const result = checkConvergence(state, DEFAULT_CONVERGENCE_CONFIG);
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe("identical_findings");
    expect(result.recommendation).toBe("escalate_human");
  });

  it("stops when max rounds exceeded", () => {
    let state = initConvergenceState();
    const differentFinding = (i: number) => ({ file: `src/file${i}.ts`, severity: "high", category: "bug" });
    for (let i = 0; i <= DEFAULT_CONVERGENCE_CONFIG.maxRounds + 1; i++) {
      state = recordRoundFindings(state, [differentFinding(i)], true);
    }
    const result = checkConvergence(state, DEFAULT_CONVERGENCE_CONFIG);
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe("max_rounds");
  });

  it("stops after consecutive empty PRs exceeds threshold", () => {
    let state = initConvergenceState();
    // Record 3 rounds with no changes (prHadChanges=false)
    for (let i = 0; i < DEFAULT_CONVERGENCE_CONFIG.maxEmptyPRs + 1; i++) {
      state = recordRoundFindings(state, [], false);
    }
    const result = checkConvergence(state, DEFAULT_CONVERGENCE_CONFIG);
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe("empty_prs");
  });

  it("stops after no-progress rounds reach threshold", () => {
    const staleFinding = { file: "src/stale.ts", severity: "medium", category: "style" };
    let state = initConvergenceState();
    // Raise identical-findings threshold so that check doesn't fire before no_progress.
    // The same finding repeating each round never resolves → noProgressCount accumulates.
    const noProgressConfig = { ...DEFAULT_CONVERGENCE_CONFIG, maxIdenticalFindings: 100 };
    for (let i = 0; i < DEFAULT_CONVERGENCE_CONFIG.maxNoProgressRounds; i++) {
      state = recordRoundFindings(state, [staleFinding], true);
    }
    const result = checkConvergence(state, noProgressConfig);
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe("no_progress");
  });

  it("marks done (shouldStop=false) when all findings resolved", () => {
    const f = { file: "src/foo.ts", severity: "high", category: "bug" };
    let state = initConvergenceState();
    // Round 1: finding appears
    state = recordRoundFindings(state, [f], true);
    // Round 2: no findings (all resolved)
    state = recordRoundFindings(state, [], true);
    const result = checkConvergence(state, DEFAULT_CONVERGENCE_CONFIG);
    expect(result.shouldStop).toBe(false);
    expect(result.reason).toBe("converged");
    expect(result.recommendation).toBe("mark_done");
  });
});

// ── Review gate ────────────────────────────────────────────────────────────────

describe("review gate — blocks Done transition with critical/high findings", () => {
  it("blocks Done when critical finding is present", () => {
    const findings = [
      { severity: "critical" as const, category: "security", file: "src/auth.ts", message: "SQL injection" },
    ];
    const result = reviewGate(findings, false, true);
    expect(result.canMarkDone).toBe(false);
    expect(result.criticalCount).toBe(1);
    expect(result.highCount).toBe(0);
    expect(result.blockedBy).toHaveLength(1);
  });

  it("blocks Done when high-severity finding is present", () => {
    const findings = [
      { severity: "high" as const, category: "bug", file: "src/payment.ts", message: "off-by-one error" },
    ];
    const result = reviewGate(findings, false, true);
    expect(result.canMarkDone).toBe(false);
    expect(result.highCount).toBe(1);
  });

  it("allows Done when only medium/low findings remain", () => {
    const findings = [
      { severity: "medium" as const, category: "style", file: "src/ui.ts", message: "naming convention" },
      { severity: "low" as const, category: "docs", file: "src/ui.ts", message: "missing jsdoc" },
    ];
    const result = reviewGate(findings, false, true);
    expect(result.canMarkDone).toBe(true);
    expect(result.criticalCount).toBe(0);
    expect(result.highCount).toBe(0);
  });

  it("allows Done when no findings remain", () => {
    const result = reviewGate([], false, true);
    expect(result.canMarkDone).toBe(true);
  });

  it("blocks Done when no review has occurred", () => {
    const result = reviewGate([], false, false);
    expect(result.canMarkDone).toBe(false);
    expect(result.blockedBy).toContain("No review found");
  });

  it("forceDone overrides gate even with critical findings", () => {
    const findings = [
      { severity: "critical" as const, category: "security", file: "src/auth.ts", message: "RCE" },
    ];
    const result = reviewGate(findings, true, true);
    expect(result.canMarkDone).toBe(true);
    expect(result.criticalCount).toBe(0);
  });
});

// ── Convergence state persistence ─────────────────────────────────────────────

describe("convergence state — persistence across restarts", () => {
  let tempDir: string;
  const originalCwd = process.cwd;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "convergence-test-"));
    // Point the state file to our temp dir by overriding cwd
    process.cwd = () => tempDir;
    _resetCache();
  });

  afterEach(() => {
    process.cwd = originalCwd;
    _resetCache();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns a fresh state when no file exists", () => {
    const state = loadConvergenceState();
    expect(state.roundNumber).toBe(0);
    expect(state.emptyPRCount).toBe(0);
    expect(state.identicalCount.size).toBe(0);
  });

  it("persists and reloads convergence state", () => {
    const finding = { file: "src/a.ts", severity: "high", category: "bug" };
    let state = initConvergenceState();
    state = recordRoundFindings(state, [finding], true);
    saveConvergenceState(state);

    // Reset cache to force a file read on next load
    _resetCache();
    const loaded = loadConvergenceState();

    expect(loaded.roundNumber).toBe(1);
    expect(loaded.identicalCount.size).toBe(1);
    // Map key is the finding hash — verify it deserialized correctly
    const keys = [...loaded.identicalCount.keys()];
    expect(keys[0]).toContain("src/a.ts");
  });

  it("clearConvergenceState removes the file and resets in-memory cache", () => {
    let state = initConvergenceState();
    state = recordRoundFindings(state, [{ file: "x.ts", severity: "low", category: "docs" }], true);
    saveConvergenceState(state);

    clearConvergenceState();
    _resetCache();

    const fresh = loadConvergenceState();
    expect(fresh.roundNumber).toBe(0);
  });
});
