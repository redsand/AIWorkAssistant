import { describe, expect, it, vi } from "vitest";
import { shouldSkipIssue, type IssuePrecheckDeps } from "../issue-precheck";
import type { ConvergenceState } from "../../autonomous-loop/convergence";

/**
 * Regression: once an aicoder opened a PR for an issue, `processedIssues`
 * permanently skipped it on every future cycle — even when the reviewer
 * re-added "ready-for-agent" to legitimately request rework. The
 * convergence pre-check that should gate re-entry was dead code, since the
 * blanket "already processed" skip returned first. Convergence must be
 * consulted before the processed-flag skip fires, not after.
 */
function freshConvergenceState(overrides: Partial<ConvergenceState> = {}): ConvergenceState {
  return {
    roundNumber: 0,
    noProgressCount: 0,
    ...overrides,
  } as ConvergenceState;
}

function fakeDeps(overrides: Partial<IssuePrecheckDeps> = {}): IssuePrecheckDeps {
  return {
    logger: { logSkip: vi.fn(), logError: vi.fn(), logConfig: vi.fn() },
    workspace: "/repo",
    force: false,
    maxFailedAttempts: 5,
    infrastructureBlockedIssues: new Set(),
    processedIssues: { has: vi.fn(() => false), delete: vi.fn() },
    checkProcessRetryCircuit: vi.fn(() => null),
    agentRunDatabase: {
      isIssueBlacklisted: vi.fn(() => false),
      incrementFailedAttempt: vi.fn(() => 1),
      blacklistIssue: vi.fn(),
      clearFailedAttempt: vi.fn(),
      unmarkIssueProcessed: vi.fn(),
    },
    saveProcessedIssue: vi.fn(),
    convergence: {
      loadConvergenceState: vi.fn(() => freshConvergenceState()),
      checkConvergence: vi.fn(() => ({ shouldStop: false })),
      config: {} as never,
    },
    ...overrides,
  };
}

describe("shouldSkipIssue — reviewer-requested rework re-entry", () => {
  it("skips permanently when already processed and no convergence state exists (no known rework request)", () => {
    const deps = fakeDeps({
      processedIssues: { has: vi.fn(() => true), delete: vi.fn() },
    });
    const result = shouldSkipIssue(deps, "42");
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("already processed");
    expect(deps.agentRunDatabase.unmarkIssueProcessed).not.toHaveBeenCalled();
  });

  it("re-processes when already processed but convergence is still within budget", () => {
    const deps = fakeDeps({
      processedIssues: { has: vi.fn(() => true), delete: vi.fn() },
      convergence: {
        loadConvergenceState: vi.fn(() => freshConvergenceState({ roundNumber: 1 })),
        checkConvergence: vi.fn(() => ({ shouldStop: false })),
        config: {} as never,
      },
    });
    const result = shouldSkipIssue(deps, "42");
    expect(result.skip).toBe(false);
    expect(deps.processedIssues.delete).toHaveBeenCalledWith("42");
    expect(deps.agentRunDatabase.unmarkIssueProcessed).toHaveBeenCalledWith("42");
  });

  it("still skips permanently when already processed and convergence has fired", () => {
    const deps = fakeDeps({
      processedIssues: { has: vi.fn(() => true), delete: vi.fn() },
      convergence: {
        loadConvergenceState: vi.fn(() => freshConvergenceState({ roundNumber: 4 })),
        checkConvergence: vi.fn(() => ({ shouldStop: true, reason: "no progress" })),
        config: {} as never,
      },
    });
    const result = shouldSkipIssue(deps, "42");
    expect(result.skip).toBe(true);
    expect(result.reason).toContain("convergence already fired");
    expect(deps.agentRunDatabase.unmarkIssueProcessed).not.toHaveBeenCalled();
  });

  it("does not skip when the issue was never processed before", () => {
    const deps = fakeDeps();
    const result = shouldSkipIssue(deps, "42");
    expect(result.skip).toBe(false);
  });

  it("--force bypasses the processed-issue check regardless of convergence", () => {
    const deps = fakeDeps({
      force: true,
      processedIssues: { has: vi.fn(() => true), delete: vi.fn() },
      convergence: {
        loadConvergenceState: vi.fn(() => freshConvergenceState({ roundNumber: 4 })),
        checkConvergence: vi.fn(() => ({ shouldStop: true, reason: "no progress" })),
        config: {} as never,
      },
    });
    const result = shouldSkipIssue(deps, "42");
    expect(result.skip).toBe(false);
    expect(deps.processedIssues.delete).toHaveBeenCalledWith("42");
    expect(deps.agentRunDatabase.unmarkIssueProcessed).toHaveBeenCalledWith("42");
  });
});
