/**
 * Recovery for a rejected (non-fast-forward) branch push. Extracted from
 * src/aicoder.ts (2026-07-03, issue #256).
 *
 * The aicoder owns ai/issue-* branches exclusively, so when a fresh
 * worktree's push is rejected it means a previous run left commits on the
 * remote branch. The old recovery did a plain `git pull --rebase`, which
 * cannot resolve conflicts in files both runs touched (test files, import
 * statements, etc.) and just aborted straight to a force push on any
 * conflict — discarding whatever the rebase could have salvaged. This
 * swaps in the LLM-assisted rebaseAndResolveConflicts (multi-round, with a
 * dumb --ours/--theirs fallback of its own) so conflicts get a real
 * resolution attempt before anything is discarded.
 */

export interface PushRecoveryLogger {
  logGit(action: string, detail?: string): void;
  logError(message: string): void;
}

export interface PushRecoveryDeps {
  logger: PushRecoveryLogger;
  workspace: string;
  pushBranch: (
    branchName: string,
    options?: { forceWithLease?: boolean },
  ) => boolean;
  isRebaseInProgress: (workspace: string) => boolean;
  recoverFromRebase: (workspace: string) => boolean;
  rebaseAndResolveConflicts: (branchName: string) => Promise<boolean>;
  trackStep: (
    message: string,
    toolName: string,
    options?: { success?: boolean; errorMessage?: string },
  ) => void;
}

export type PushRecoveryResult =
  | { ok: true }
  | { ok: false; errorMessage: string };

/** Call when pushBranch(branchName) has already returned false. */
export async function recoverFromRejectedPush(
  deps: PushRecoveryDeps,
  branchName: string,
): Promise<PushRecoveryResult> {
  deps.logger.logGit("Push rejected — rebasing on remote and retrying");
  deps.trackStep(
    "Push rejected, attempting LLM-assisted rebase",
    "git_rebase",
  );

  // Guard against stuck rebase state left over from a prior failed attempt
  if (deps.isRebaseInProgress(deps.workspace)) {
    deps.recoverFromRebase(deps.workspace);
  }

  const rebaseOk = await deps.rebaseAndResolveConflicts(branchName);

  if (rebaseOk) {
    if (deps.pushBranch(branchName)) {
      deps.trackStep(`Pushed branch after rebase: ${branchName}`, "git_push");
      return { ok: true };
    }

    // Push still failed after a successful rebase — force push
    deps.logger.logGit("Push failed after rebase — force pushing");
    if (deps.pushBranch(branchName, { forceWithLease: true })) {
      deps.trackStep(`Force pushed branch: ${branchName}`, "git_push");
      return { ok: true };
    }

    const errorMessage = "Force push failed after rebase";
    deps.logger.logError(`${errorMessage} — PR not created`);
    deps.trackStep(errorMessage, "git_push", { success: false, errorMessage });
    return { ok: false, errorMessage };
  }

  // Rebase failed — stale commits from a previous run are on the remote
  // branch. The aicoder owns ai/issue-* branches exclusively, so force
  // push is safe.
  deps.logger.logGit(
    "Rebase failed — force pushing to replace stale remote branch",
  );
  if (deps.pushBranch(branchName, { forceWithLease: true })) {
    deps.trackStep(
      `Force pushed branch after rebase failure: ${branchName}`,
      "git_push",
    );
    return { ok: true };
  }

  const errorMessage = "Force push failed after rebase failure";
  deps.logger.logError(`${errorMessage} — PR not created`);
  deps.trackStep(errorMessage, "git_push", { success: false, errorMessage });
  return { ok: false, errorMessage };
}
