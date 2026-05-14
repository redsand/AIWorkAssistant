/**
 * Tests for the reviewer's skip-counter, convergence detection, and exponential
 * backoff added to fix the infinite SHA-unchanged polling loop (IR-115 / #76).
 *
 * The skip-counter and backoff state live inside reviewer.ts (a CLI entry-point)
 * so they can't be imported directly.  These tests instead verify:
 *   1. The convergence logic as the reviewer now uses it (recordRoundFindings with
 *      no new commits → emptyPRCount grows → checkConvergence fires).
 *   2. The backoff math (base × 1.5, capped at MAX).
 *   3. The convergence report includes the reviewer's skip message.
 *   4. Skip counter simulation — modelling the same Map logic used in reviewer.ts.
 */

import { describe, it, expect } from "vitest";
import {
  initConvergenceState,
  recordRoundFindings,
  checkConvergence,
  formatConvergenceReport,
  DEFAULT_CONVERGENCE_CONFIG,
  type ConvergenceConfig,
} from "../../../src/autonomous-loop/convergence";

// ── Constants mirrored from reviewer.ts ──────────────────────────────────────

const MAX_CONSECUTIVE_SKIPS = 5; // default value from reviewer.ts
const BASE_POLL_INTERVAL_MS = 30_000;
const MAX_POLL_INTERVAL_MS = 300_000;

function applyBackoff(current: number | null): number {
  const base = current ?? BASE_POLL_INTERVAL_MS;
  return Math.min(base * 1.5, MAX_POLL_INTERVAL_MS);
}

// Config that only triggers via empty_prs (maxNoProgressRounds set very high so
// no_progress doesn't fire first — isolates the empty_prs path cleanly).
const EMPTY_PR_ONLY_CONFIG: ConvergenceConfig = {
  ...DEFAULT_CONVERGENCE_CONFIG,
  maxNoProgressRounds: 999,
};

// ── Skip counter simulation ───────────────────────────────────────────────────

describe("reviewer skip counter — convergence detection", () => {
  it("stops after maxEmptyPRs+1 consecutive empty rounds", () => {
    // With maxEmptyPRs=2, convergence fires when emptyPRCount > 2 (i.e., round 3)
    let state = initConvergenceState();
    let stoppedAt = -1;
    for (let i = 0; i < 10; i++) {
      state = recordRoundFindings(state, [], false);
      const result = checkConvergence(state, EMPTY_PR_ONLY_CONFIG);
      if (result.shouldStop) {
        stoppedAt = i + 1; // 1-indexed
        expect(result.reason).toBe("empty_prs");
        break;
      }
    }
    expect(stoppedAt).toBe(3); // fires at round 3 (emptyPRCount=3 > maxEmptyPRs=2)
  });

  it("does not stop before maxEmptyPRs threshold", () => {
    let state = initConvergenceState();
    // 2 empty rounds should not trigger empty_prs (need > 2, not >= 2)
    state = recordRoundFindings(state, [], false);
    expect(checkConvergence(state, EMPTY_PR_ONLY_CONFIG).shouldStop).toBe(false);
    state = recordRoundFindings(state, [], false);
    expect(checkConvergence(state, EMPTY_PR_ONLY_CONFIG).shouldStop).toBe(false);
    // Round 3 tips it over
    state = recordRoundFindings(state, [], false);
    expect(checkConvergence(state, EMPTY_PR_ONLY_CONFIG).shouldStop).toBe(true);
  });

  it("tracks emptyPRCount correctly across rounds", () => {
    let state = initConvergenceState();
    expect(state.emptyPRCount).toBe(0);

    state = recordRoundFindings(state, [], false);
    expect(state.emptyPRCount).toBe(1);

    state = recordRoundFindings(state, [], false);
    expect(state.emptyPRCount).toBe(2);

    // prHadChanges=true resets emptyPRCount regardless of findings
    state = recordRoundFindings(state, [], true);
    expect(state.emptyPRCount).toBe(0);
  });

  it("convergence fires within MAX_CONSECUTIVE_SKIPS empty rounds", () => {
    // Config where empty_prs fires before no_progress
    const config: ConvergenceConfig = { ...EMPTY_PR_ONLY_CONFIG, maxEmptyPRs: MAX_CONSECUTIVE_SKIPS - 1 };
    let state = initConvergenceState();

    let stopped = false;
    for (let i = 0; i < MAX_CONSECUTIVE_SKIPS; i++) {
      state = recordRoundFindings(state, [], false);
      const result = checkConvergence(state, config);
      if (result.shouldStop) {
        expect(result.reason).toBe("empty_prs");
        stopped = true;
        break;
      }
    }
    expect(stopped).toBe(true);
  });

  it("emptyPRCount resets when SHA changes (prHadChanges=true)", () => {
    let state = initConvergenceState();

    // Two consecutive skips (SHA unchanged)
    state = recordRoundFindings(state, [], false);
    state = recordRoundFindings(state, [], false);
    expect(state.emptyPRCount).toBe(2);

    // SHA changes — aicoder pushed rework — prHadChanges=true resets emptyPRCount
    state = recordRoundFindings(state, [], true);
    expect(state.emptyPRCount).toBe(0); // fresh start for empty PR counting
  });
});

// ── Exponential backoff ───────────────────────────────────────────────────────

describe("reviewer poll — exponential backoff", () => {
  it("starts at BASE_POLL_INTERVAL_MS on first skip", () => {
    const after1 = applyBackoff(null);
    expect(after1).toBe(BASE_POLL_INTERVAL_MS * 1.5);
  });

  it("doubles (×1.5) on each consecutive skip", () => {
    let interval: number | null = null;
    const values: number[] = [];
    for (let i = 0; i < 6; i++) {
      interval = applyBackoff(interval);
      values.push(interval);
    }
    // Each value should be 1.5× the previous
    for (let i = 1; i < values.length; i++) {
      if (values[i]! < MAX_POLL_INTERVAL_MS) {
        expect(values[i]).toBeCloseTo(values[i - 1]! * 1.5, 0);
      }
    }
  });

  it("caps at MAX_POLL_INTERVAL_MS", () => {
    let interval: number | null = null;
    // Apply backoff many times
    for (let i = 0; i < 30; i++) {
      interval = applyBackoff(interval);
    }
    expect(interval).toBe(MAX_POLL_INTERVAL_MS);
  });

  it("reset to null means next backoff starts from BASE", () => {
    let interval: number | null = applyBackoff(null); // first skip
    interval = applyBackoff(interval); // second skip
    expect(interval).toBeGreaterThan(BASE_POLL_INTERVAL_MS);

    // SHA changes — reset
    interval = null;

    // Next skip starts fresh from BASE
    const afterReset = applyBackoff(interval);
    expect(afterReset).toBe(BASE_POLL_INTERVAL_MS * 1.5);
  });
});

// ── Convergence report content ────────────────────────────────────────────────

describe("formatConvergenceReport — reviewer skip scenario", () => {
  it("includes skip count and MR number in the report message", () => {
    const state = initConvergenceState();
    const result = {
      shouldStop: true,
      reason: "empty_prs" as const,
      recommendation: "requeue_different_prompt" as const,
      message: "Reviewer skipped MR !9 5 times (SHA unchanged). Stopping poll — will resume when the aicoder pushes a rework.",
    };

    const report = formatConvergenceReport(result, state, DEFAULT_CONVERGENCE_CONFIG);

    expect(report).toContain("empty_prs");
    expect(report).toContain("MR !9");
    expect(report).toContain("5 times");
    expect(report).toContain("SHA unchanged");
  });

  it("includes convergence table headers", () => {
    const state = initConvergenceState();
    const result = {
      shouldStop: true,
      reason: "empty_prs" as const,
      recommendation: "escalate_human" as const,
      message: "Reviewer stuck.",
    };

    const report = formatConvergenceReport(result, state, DEFAULT_CONVERGENCE_CONFIG);

    expect(report).toContain("Autonomous Loop Convergence Report");
    expect(report).toContain("Rounds completed");
    expect(report).toContain("Consecutive empty PRs");
  });
});

// ── Skip counter Map logic ────────────────────────────────────────────────────

describe("skip counter Map logic (mirrors reviewer.ts behaviour)", () => {
  it("increments on each skip and resets on SHA change", () => {
    const skipCounts = new Map<string, number>();
    const mrKey = "gitlab:siem/9";

    // Three consecutive skips
    for (let i = 1; i <= 3; i++) {
      const count = (skipCounts.get(mrKey) ?? 0) + 1;
      skipCounts.set(mrKey, count);
      expect(skipCounts.get(mrKey)).toBe(i);
    }

    // SHA changes — reset
    skipCounts.delete(mrKey);
    expect(skipCounts.has(mrKey)).toBe(false);

    // Next skip starts from 1
    skipCounts.set(mrKey, 1);
    expect(skipCounts.get(mrKey)).toBe(1);
  });

  it("reaching MAX_CONSECUTIVE_SKIPS triggers cleanup", () => {
    const skipCounts = new Map<string, number>();
    const reviewedMRs = new Set<string>();
    const reviewedMRShas = new Map<string, string>();
    const mrKey = "gitlab:siem/9";

    reviewedMRs.add(mrKey);
    reviewedMRShas.set(mrKey, "abc123sha");

    // Simulate MAX_CONSECUTIVE_SKIPS skips
    for (let i = 0; i < MAX_CONSECUTIVE_SKIPS; i++) {
      const count = (skipCounts.get(mrKey) ?? 0) + 1;
      skipCounts.set(mrKey, count);

      if (count >= MAX_CONSECUTIVE_SKIPS) {
        // Cleanup (mirrors reviewer.ts behaviour)
        reviewedMRs.delete(mrKey);
        reviewedMRShas.delete(mrKey);
        skipCounts.delete(mrKey);
        break;
      }
    }

    // After cleanup: MR is no longer tracked → next poll cycle treats it as fresh
    expect(reviewedMRs.has(mrKey)).toBe(false);
    expect(reviewedMRShas.has(mrKey)).toBe(false);
    expect(skipCounts.has(mrKey)).toBe(false);
  });
});
