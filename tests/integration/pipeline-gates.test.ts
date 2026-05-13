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

import { reviewGate, type ReviewGateFinding } from "../../src/autonomous-loop/review-gate";

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

// ── Pipeline integration — end-to-end gate flow ───────────────────────────────
//
// These tests chain the modules together the same way aicoder.ts does:
//   agent output → validateOutputFromDiff
//   pre-push     → validateDiffBeforePush
//   each round   → recordRoundFindings + checkConvergence
//   Done attempt → reviewGate
//
// They confirm the modules agree on the same inputs and that their
// exit-code / shouldStop / canMarkDone signals compose correctly.

describe("Pipeline integration — end-to-end gate flow", () => {
  // ── Scenario 1: agent produces no changes ──────────────────────────────────
  it("empty diff: validateOutputFromDiff and validateDiffBeforePush both reject with EXIT_NO_CHANGES", () => {
    const emptyStat = "";
    const emptyDiff = "";

    // Both validators must reject an empty diff with the same exit code
    const outputResult = validateOutputFromDiff(emptyStat, emptyDiff, false);
    expect(outputResult.valid).toBe(false);
    expect(outputResult.exitCode).toBe(EXIT_NO_CHANGES);

    const diffResult = validateDiffBeforePush(emptyStat, emptyDiff);
    expect(diffResult.valid).toBe(false);
    expect(diffResult.exitCode).toBe(EXIT_NO_CHANGES);

    // Exit codes agree — the pipeline exits consistently
    expect(outputResult.exitCode).toBe(diffResult.exitCode);
  });

  // ── Scenario 2: agent output is all stubs ──────────────────────────────────
  it("placeholder output: validateOutputFromDiff rejects with EXIT_PLACEHOLDER_ONLY; validateDiffBeforePush sees real lines and passes", () => {
    // The stub diff has a populated stat (files were touched) but all added
    // lines are TODO comments — validateOutputFromDiff catches this while
    // validateDiffBeforePush (which only looks at whitespace/meta) passes.
    const stat = makeDiffStat(1, 6);
    const stubDiff = makeGitDiff([{
      path: "src/api.ts",
      lines: [
        "// TODO: implement handler",
        "// TODO: validate request",
        "// TODO: query database",
        "// TODO: handle errors",
        "// PLACEHOLDER: not done",
        "// TODO: return response",
      ],
    }]);

    const outputResult = validateOutputFromDiff(stat, stubDiff, false);
    expect(outputResult.valid).toBe(false);
    expect(outputResult.exitCode).toBe(EXIT_PLACEHOLDER_ONLY);

    // validateDiffBeforePush only checks for empty/whitespace/meta — stubs
    // are real characters, so it passes
    const diffResult = validateDiffBeforePush(stat, stubDiff);
    expect(diffResult.valid).toBe(true);
    expect(diffResult.exitCode).toBe(EXIT_SUCCESS);

    // Pipeline should use the stricter (output) result to block the push
    expect(outputResult.exitCode).not.toBe(EXIT_SUCCESS);
  });

  // ── Scenario 3: critical security finding drives both gate and convergence ──
  it("critical finding: reviewGate blocks Done and convergence stops after 3 identical rounds", () => {
    const criticalFinding: ReviewGateFinding = {
      severity: "critical",
      category: "security",
      file: "src/auth.ts",
      message: "SQL injection via unsanitised query",
    };

    // Gate fires immediately on the first review
    const gate = reviewGate([criticalFinding], false, true);
    expect(gate.canMarkDone).toBe(false);
    expect(gate.criticalCount).toBe(1);
    expect(gate.blockedBy[0]).toContain("[CRITICAL]");
    expect(gate.blockedBy[0]).toContain("src/auth.ts");

    // Convergence accumulates round-by-round — confirm it doesn't stop too early
    let state = initConvergenceState();
    for (let round = 1; round <= 3; round++) {
      state = recordRoundFindings(state, [criticalFinding], true);
      const check = checkConvergence(state, DEFAULT_CONVERGENCE_CONFIG);
      if (round < 3) {
        expect(check.shouldStop).toBe(false);
      } else {
        // Round 3: identical count (3) exceeds maxIdenticalFindings (2) → stop
        expect(check.shouldStop).toBe(true);
        expect(check.reason).toBe("identical_findings");
        expect(check.recommendation).toBe("escalate_human");
      }
    }
  });

  // ── Scenario 4: force-done bypasses gate but not convergence ──────────────
  it("force-done allows the Done transition but convergence still halts the loop", () => {
    const finding: ReviewGateFinding = {
      severity: "critical",
      category: "security",
      file: "src/auth.ts",
      message: "Hardcoded admin password",
    };

    // force-done=true: gate allows the transition (audited override)
    const gateForced = reviewGate([finding], true, true);
    expect(gateForced.canMarkDone).toBe(true);
    expect(gateForced.blockedBy).toHaveLength(0);

    // Without force-done: same finding still blocks
    const gateNormal = reviewGate([finding], false, true);
    expect(gateNormal.canMarkDone).toBe(false);

    // Convergence is independent of force-done — loop still stops at 3 rounds
    let state = initConvergenceState();
    for (let i = 0; i < 3; i++) {
      state = recordRoundFindings(state, [finding], true);
    }
    const convergence = checkConvergence(state, DEFAULT_CONVERGENCE_CONFIG);
    expect(convergence.shouldStop).toBe(true);
    expect(convergence.reason).toBe("identical_findings");
  });

  // ── Scenario 5: low-severity security finding blocked via alwaysBlockCategories
  it("low-severity security finding: alwaysBlockCategories prevents Done even without high/critical severity", () => {
    const lowSecurity: ReviewGateFinding = {
      severity: "low",
      category: "security",
      file: "src/config.ts",
      message: "Insecure default cookie settings",
    };

    const gate = reviewGate([lowSecurity], false, true);
    expect(gate.canMarkDone).toBe(false);
    // criticalCount and highCount are 0 — the block came from alwaysBlockCategories
    expect(gate.criticalCount).toBe(0);
    expect(gate.highCount).toBe(0);
    expect(gate.blockedBy).toHaveLength(1);
    expect(gate.blockedBy[0]).toContain("[LOW]");
    expect(gate.blockedBy[0]).toContain("src/config.ts");
  });

  // ── Scenario 6: happy path — all gates pass ────────────────────────────────
  it("happy path: valid diff + clean review → validateDiffBeforePush passes, reviewGate allows Done, convergence recommends mark_done", () => {
    const stat = makeDiffStat(2, 15, 3);
    const diff = makeGitDiff([
      { path: "src/auth.ts", lines: ["export function validateToken(token: string): boolean {", "  return jwt.verify(token, SECRET) !== null;", "}"] },
      { path: "tests/auth.test.ts", lines: ["it('validates a real token', () => { expect(validateToken(VALID)).toBe(true); });"] },
    ]);

    // Pre-push gate passes
    const diffResult = validateDiffBeforePush(stat, diff);
    expect(diffResult.valid).toBe(true);
    expect(diffResult.exitCode).toBe(EXIT_SUCCESS);

    // Review gate allows Done (no findings, review occurred)
    const gate = reviewGate([], false, true);
    expect(gate.canMarkDone).toBe(true);

    // Convergence: one round with a finding, then it's resolved → mark_done
    let state = initConvergenceState();
    const initialFinding = { file: "src/auth.ts", severity: "high" as const, category: "security" };
    state = recordRoundFindings(state, [initialFinding], true);
    state = recordRoundFindings(state, [], true); // resolved
    const convergence = checkConvergence(state, DEFAULT_CONVERGENCE_CONFIG);
    expect(convergence.shouldStop).toBe(false);
    expect(convergence.recommendation).toBe("mark_done");
  });

  // ── Scenario 7: rework simulation — full review-loop cycle ────────────────
  it("rework simulation: 3 rounds with same high finding → gate blocks each time + convergence stops on round 3", () => {
    const bugFinding: ReviewGateFinding = {
      severity: "high",
      category: "bug",
      file: "src/payment.ts",
      message: "Off-by-one in fee calculation",
    };

    let state = initConvergenceState();
    for (let round = 1; round <= 3; round++) {
      // Reviewer posts the same finding again
      state = recordRoundFindings(state, [bugFinding], /*prHadChanges=*/true);

      // Gate blocks Done on every round until the finding is resolved
      const gate = reviewGate([bugFinding], false, true);
      expect(gate.canMarkDone).toBe(false);
      expect(gate.highCount).toBe(1);

      const convergence = checkConvergence(state, DEFAULT_CONVERGENCE_CONFIG);
      if (round < 3) {
        // Rounds 1–2: keep going
        expect(convergence.shouldStop).toBe(false);
      } else {
        // Round 3: identical count (3) exceeds threshold (2) → stop the loop
        expect(convergence.shouldStop).toBe(true);
        expect(convergence.reason).toBe("identical_findings");
        // At this point the pipeline should post a convergence report and exit
        // with EXIT_MAX_REWORK rather than looping indefinitely
      }
    }
  });

  // ── Scenario 8: persistence across simulated restarts ─────────────────────
  describe("convergence accumulates correctly across simulated aicoder restarts", () => {
    let tempDir: string;
    const originalCwd = process.cwd;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-convergence-"));
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

    it("three separate runs each recording the same finding → convergence fires on run 3", () => {
      const finding: ReviewGateFinding = {
        severity: "high",
        category: "bug",
        file: "src/app.ts",
        message: "Null pointer dereference",
      };

      // Run 1: agent finishes, reviewer posts the finding, aicoder saves state and exits
      let state = initConvergenceState();
      state = recordRoundFindings(state, [finding], true);
      saveConvergenceState(state);
      expect(checkConvergence(state, DEFAULT_CONVERGENCE_CONFIG).shouldStop).toBe(false);

      // Run 2: aicoder restarts, loads state, agent reworks, reviewer posts same finding
      _resetCache();
      state = loadConvergenceState();
      expect(state.roundNumber).toBe(1);
      state = recordRoundFindings(state, [finding], true);
      saveConvergenceState(state);
      expect(checkConvergence(state, DEFAULT_CONVERGENCE_CONFIG).shouldStop).toBe(false);

      // Run 3: aicoder restarts again, loads state, reviewer posts same finding again
      _resetCache();
      state = loadConvergenceState();
      expect(state.roundNumber).toBe(2);
      state = recordRoundFindings(state, [finding], true);
      const result = checkConvergence(state, DEFAULT_CONVERGENCE_CONFIG);

      // After 3 identical rounds the convergence check must stop the loop
      expect(result.shouldStop).toBe(true);
      expect(result.reason).toBe("identical_findings");

      // Gate still blocks Done (finding is still present)
      const gate = reviewGate([finding], false, true);
      expect(gate.canMarkDone).toBe(false);
    });
  });
});
