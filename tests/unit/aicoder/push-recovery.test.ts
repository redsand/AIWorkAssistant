import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  recoverFromRejectedPush,
  type PushRecoveryDeps,
} from "../../../src/aicoder/push-recovery";

function makeDeps(overrides: Partial<PushRecoveryDeps> = {}): PushRecoveryDeps {
  return {
    logger: { logGit: vi.fn(), logError: vi.fn() },
    workspace: "/workspace",
    pushBranch: vi.fn().mockReturnValue(true),
    isRebaseInProgress: vi.fn().mockReturnValue(false),
    recoverFromRebase: vi.fn().mockReturnValue(true),
    rebaseAndResolveConflicts: vi.fn().mockResolvedValue(true),
    trackStep: vi.fn(),
    ...overrides,
  };
}

describe("recoverFromRejectedPush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("triggers rebaseAndResolveConflicts, in the correct order, after a rejected push", async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      isRebaseInProgress: vi.fn(() => {
        calls.push("isRebaseInProgress");
        return true;
      }),
      recoverFromRebase: vi.fn(() => {
        calls.push("recoverFromRebase");
        return true;
      }),
      rebaseAndResolveConflicts: vi.fn(async () => {
        calls.push("rebaseAndResolveConflicts");
        return true;
      }),
      pushBranch: vi.fn(() => {
        calls.push("pushBranch");
        return true;
      }),
    });

    const result = await recoverFromRejectedPush(deps, "ai/issue-256");

    expect(calls).toEqual([
      "isRebaseInProgress",
      "recoverFromRebase",
      "rebaseAndResolveConflicts",
      "pushBranch",
    ]);
    expect(deps.rebaseAndResolveConflicts).toHaveBeenCalledWith("ai/issue-256");
    expect(result).toEqual({ ok: true });
  });

  it("does not call recoverFromRebase when no rebase is in progress", async () => {
    const deps = makeDeps({ isRebaseInProgress: vi.fn().mockReturnValue(false) });

    await recoverFromRejectedPush(deps, "ai/issue-256");

    expect(deps.recoverFromRebase).not.toHaveBeenCalled();
    expect(deps.rebaseAndResolveConflicts).toHaveBeenCalledWith("ai/issue-256");
  });

  it("on rebase success, pushes again (non-force) and succeeds", async () => {
    const deps = makeDeps({
      rebaseAndResolveConflicts: vi.fn().mockResolvedValue(true),
      pushBranch: vi.fn().mockReturnValue(true),
    });

    const result = await recoverFromRejectedPush(deps, "ai/issue-256");

    expect(deps.pushBranch).toHaveBeenCalledTimes(1);
    expect(deps.pushBranch).toHaveBeenCalledWith("ai/issue-256");
    expect(result).toEqual({ ok: true });
  });

  it("on rebase success but retried push rejected again, falls back to a force-with-lease push", async () => {
    const pushBranch = vi
      .fn()
      .mockReturnValueOnce(false) // retried non-force push after rebase
      .mockReturnValueOnce(true); // force push
    const deps = makeDeps({
      rebaseAndResolveConflicts: vi.fn().mockResolvedValue(true),
      pushBranch,
    });

    const result = await recoverFromRejectedPush(deps, "ai/issue-256");

    expect(pushBranch).toHaveBeenNthCalledWith(1, "ai/issue-256");
    expect(pushBranch).toHaveBeenNthCalledWith(2, "ai/issue-256", { forceWithLease: true });
    expect(result).toEqual({ ok: true });
  });

  it("on rebase failure, falls back to a force-with-lease push and succeeds", async () => {
    const deps = makeDeps({
      rebaseAndResolveConflicts: vi.fn().mockResolvedValue(false),
      pushBranch: vi.fn().mockReturnValue(true),
    });

    const result = await recoverFromRejectedPush(deps, "ai/issue-256");

    expect(deps.pushBranch).toHaveBeenCalledTimes(1);
    expect(deps.pushBranch).toHaveBeenCalledWith("ai/issue-256", { forceWithLease: true });
    expect(result).toEqual({ ok: true });
  });

  it("fails with a clear error when the force push also fails after a rebase failure", async () => {
    const deps = makeDeps({
      rebaseAndResolveConflicts: vi.fn().mockResolvedValue(false),
      pushBranch: vi.fn().mockReturnValue(false),
    });

    const result = await recoverFromRejectedPush(deps, "ai/issue-256");

    expect(result).toEqual({
      ok: false,
      errorMessage: "Force push failed after rebase failure",
    });
    expect(deps.logger.logError).toHaveBeenCalledWith(
      expect.stringContaining("Force push failed after rebase failure"),
    );
    expect(deps.trackStep).toHaveBeenCalledWith(
      "Force push failed after rebase failure",
      "git_push",
      { success: false, errorMessage: "Force push failed after rebase failure" },
    );
  });

  it("fails with a clear error when the force push also fails after a successful rebase but rejected retry push", async () => {
    const deps = makeDeps({
      rebaseAndResolveConflicts: vi.fn().mockResolvedValue(true),
      pushBranch: vi.fn().mockReturnValue(false),
    });

    const result = await recoverFromRejectedPush(deps, "ai/issue-256");

    expect(result).toEqual({
      ok: false,
      errorMessage: "Force push failed after rebase",
    });
  });
});
