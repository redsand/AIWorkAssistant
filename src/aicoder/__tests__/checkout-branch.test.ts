import { describe, expect, it, vi } from "vitest";
import { checkoutBranch, type CheckoutBranchDeps } from "../checkout-branch";

/**
 * Regression: `git rebase <base>` can fail outright (bad ref, detached HEAD,
 * etc.) without ever entering a mid-rebase conflict state. The old code
 * discarded gitRun's boolean result and unconditionally trusted
 * resolveRebaseConflictsInPlace, which reports success whenever
 * isRebaseInProgress() is false — including "never started" as well as
 * "finished cleanly". That silently turned a failed rebase into a reported
 * success, leaving the branch based on stale history.
 */
function fakeDeps(overrides: Partial<CheckoutBranchDeps> = {}): CheckoutBranchDeps {
  return {
    logger: { logGit: vi.fn(), logError: vi.fn() },
    workspace: "/repo",
    gitRun: vi.fn(() => true),
    gitRunWithOutput: vi.fn(() => ({ ok: true, stdout: "", stderr: "" })),
    isRebaseInProgress: vi.fn(() => false),
    recoverFromRebase: vi.fn(() => true),
    safeStashPop: vi.fn(),
    getCurrentBranch: vi.fn(() => "feature/x"),
    stageAndCommit: vi.fn(() => true),
    pullAndUpdateBase: vi.fn(() => true),
    getBaseBranch: vi.fn(() => "main"),
    forceCheckout: vi.fn(() => true),
    resolveRebaseConflictsInPlace: vi.fn(async () => true),
    ...overrides,
  };
}

describe("checkoutBranch — already on target branch, rebase onto base", () => {
  it("returns true when the rebase succeeds cleanly", async () => {
    const deps = fakeDeps({ gitRun: vi.fn(() => true) });
    const result = await checkoutBranch(deps, "feature/x");
    expect(result).toBe(true);
    expect(deps.resolveRebaseConflictsInPlace).toHaveBeenCalledWith("feature/x");
  });

  it("returns false when the rebase fails outright with no conflict state", async () => {
    const deps = fakeDeps({
      gitRun: vi.fn((args: string[]) => !(args[0] === "rebase")),
      isRebaseInProgress: vi.fn(() => false),
    });
    const result = await checkoutBranch(deps, "feature/x");
    expect(result).toBe(false);
    expect(deps.logger.logError).toHaveBeenCalledWith(
      expect.stringContaining("failed outright"),
    );
    // Must not proceed to trust resolveRebaseConflictsInPlace's "nothing to
    // do" success when the rebase never actually happened.
    expect(deps.resolveRebaseConflictsInPlace).not.toHaveBeenCalled();
  });

  it("still resolves conflicts when the rebase fails but leaves git mid-rebase", async () => {
    const deps = fakeDeps({
      gitRun: vi.fn((args: string[]) => !(args[0] === "rebase")),
      isRebaseInProgress: vi.fn(() => true),
      resolveRebaseConflictsInPlace: vi.fn(async () => true),
    });
    const result = await checkoutBranch(deps, "feature/x");
    expect(result).toBe(true);
    expect(deps.resolveRebaseConflictsInPlace).toHaveBeenCalledWith("feature/x");
  });
});
