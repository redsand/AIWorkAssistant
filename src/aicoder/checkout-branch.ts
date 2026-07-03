/**
 * Branch checkout / create / sync / rebase orchestration. Extracted
 * from src/aicoder.ts (2026-06-26). Handles every case the autonomous
 * loop hits: mid-rebase recovery, stale-local-branch cleanup,
 * already-on-target-branch (sync + rebase), branch switch with dirty
 * working tree (auto-commit), checkout-from-base, create-new-branch,
 * checkout-existing-branch fallback (stash-and-retry), and the rebase
 * + conflict-resolve fallback at the end.
 *
 * `syncRemoteBranch` is private to this module — it's only called from
 * `checkoutBranch`.
 */
import { spawnSync } from "child_process";

export interface CheckoutBranchLogger {
  logGit(action: string, detail?: string): void;
  logError(message: string): void;
}

export interface CheckoutBranchDeps {
  logger: CheckoutBranchLogger;
  workspace: string;

  // Git primitives
  gitRun: (args: string[], cwd: string) => boolean;
  gitRunWithOutput: (
    args: string[],
    cwd: string,
  ) => { ok: boolean; stdout: string; stderr: string };
  isRebaseInProgress: (workspace: string) => boolean;
  recoverFromRebase: (workspace: string) => boolean;
  safeStashPop: (workspace: string) => void;

  // Higher-level branch ops from aicoder.ts
  getCurrentBranch: () => string | null;
  stageAndCommit: (message: string) => boolean;
  pullAndUpdateBase: () => boolean;
  getBaseBranch: () => string;
  forceCheckout: (branch: string, cwd: string) => boolean;
  resolveRebaseConflictsInPlace: (branchName: string) => Promise<boolean>;
}

/** Check if a remote branch exists and pull latest commits into the
 *  local branch. Only one aicoder runs per repo, so force-sync is safe
 *  — no concurrent push risk. */
function syncRemoteBranch(
  deps: CheckoutBranchDeps,
  branchName: string,
): boolean {
  const result = spawnSync(
    "git",
    ["ls-remote", "--heads", "origin", branchName],
    {
      cwd: deps.workspace,
      stdio: "pipe",
      encoding: "utf-8",
    },
  );
  if (result.status !== 0 || !result.stdout.trim()) return false;
  deps.logger.logGit("Fetching remote branch", branchName);
  if (!deps.gitRun(["fetch", "origin", branchName], deps.workspace))
    return false;
  deps.logger.logGit("Resetting to remote", `origin/${branchName}`);
  return deps.gitRun(
    ["reset", "--hard", `origin/${branchName}`],
    deps.workspace,
  );
}

export async function checkoutBranch(
  deps: CheckoutBranchDeps,
  branchName: string,
  fromBranch?: string,
): Promise<boolean> {
  const log = deps.logger;
  // Recover from any stuck rebase state before doing anything
  if (deps.isRebaseInProgress(deps.workspace)) {
    log.logGit("WARN", "Mid-rebase state detected — recovering");
    if (!deps.recoverFromRebase(deps.workspace)) {
      log.logError("Could not recover from mid-rebase state");
      return false;
    }
  }

  // Delete stale local branches that were never pushed (left over from
  // prior runs that died early). If the branch exists locally but has
  // no remote tracking ref, it is almost certainly stale.
  const localRef = deps.gitRunWithOutput(
    ["rev-parse", "--verify", `refs/heads/${branchName}`],
    deps.workspace,
  );
  if (localRef.ok) {
    const remoteRef = deps.gitRunWithOutput(
      ["rev-parse", "--verify", `refs/remotes/origin/${branchName}`],
      deps.workspace,
    );
    if (!remoteRef.ok) {
      log.logGit(
        "Deleting stale local branch (no remote tracking)",
        branchName,
      );
      deps.gitRun(["branch", "-D", branchName], deps.workspace);
    }
  }

  // Already on the target branch — stage any pending changes, sync with
  // remote, then rebase onto base.
  const current = deps.getCurrentBranch();
  if (current === branchName) {
    log.logGit("Already on branch", branchName);
    // Stage any leftover changes from a prior interrupted run
    deps.stageAndCommit(`[AI] resume: staged pending changes`);
    // Sync with remote branch from prior PR/MR push (only 1 aicoder per
    // repo, no conflicts)
    if (syncRemoteBranch(deps, branchName)) {
      log.logGit("Synced with remote branch", branchName);
    }
    // Pull latest base, then rebase this branch onto it
    if (!deps.pullAndUpdateBase()) {
      log.logGit(
        "WARN",
        `Could not pull latest ${deps.getBaseBranch()} before rebase`,
      );
    }
    log.logGit("Rebasing onto latest", deps.getBaseBranch());
    if (!deps.forceCheckout(branchName, deps.workspace)) {
      log.logGit("WARN", `Could not switch back to ${branchName} after pull`);
    }
    const rebaseOk = deps.gitRun(["rebase", deps.getBaseBranch()], deps.workspace);
    if (!rebaseOk && !deps.isRebaseInProgress(deps.workspace)) {
      // `git rebase` failed outright (bad ref, dirty tree, etc.) rather than
      // stopping mid-conflict — resolveRebaseConflictsInPlace would see no
      // rebase in progress and report success, silently leaving the branch
      // un-rebased. Treat this as a real failure.
      log.logError(
        `Rebase of ${branchName} onto ${deps.getBaseBranch()} failed outright — not a conflict state`,
      );
      return false;
    }
    if (!(await deps.resolveRebaseConflictsInPlace(branchName))) {
      return false;
    }
    return true;
  }

  // Stage/commit ALL uncommitted changes before switching branches.
  // This includes .gitignore edits, leftover agent output, etc.
  const dirtyResult = spawnSync("git", ["diff", "--quiet"], {
    cwd: deps.workspace,
    stdio: "pipe",
    encoding: "utf-8",
  });
  const hasUncommittedChanges = dirtyResult.status !== 0;

  if (hasUncommittedChanges) {
    log.logGit(
      "Committing uncommitted changes before branch switch",
      current || "(detached)",
    );
    const saved = deps.stageAndCommit(
      `[AI] auto-save before switching from ${current || "detached"}`,
    );
    if (!saved) {
      log.logGit(
        "WARN",
        "Could not save all changes — some files may be left uncommitted",
      );
    }
  }

  // Start from the specified branch or pull latest base
  if (fromBranch) {
    log.logGit("Fetching and checking out base branch", fromBranch);
    if (!deps.gitRun(["fetch", "origin", fromBranch], deps.workspace)) {
      log.logGit(
        "WARN",
        `Could not fetch ${fromBranch} — trying local checkout`,
      );
    }
    if (!deps.forceCheckout(fromBranch, deps.workspace)) {
      log.logError(`Failed to checkout base branch ${fromBranch}`);
      return false;
    }
  } else {
    if (!deps.pullAndUpdateBase()) {
      log.logError(`Could not pull and update base branch — aborting`);
      return false;
    }
  }

  log.logGit("Creating branch", branchName);
  const createResult = deps.gitRunWithOutput(
    ["checkout", "-b", branchName],
    deps.workspace,
  );
  if (!createResult.ok) {
    log.logError(
      `git checkout -b failed: ${createResult.stderr || "unknown error"}`,
    );
    // Branch already exists — checkout, sync with remote, then rebase
    log.logGit("Switching to existing branch", branchName);
    if (!deps.forceCheckout(branchName, deps.workspace)) {
      // Checkout failed even with force — try stash with untracked too
      log.logGit("Stashing all changes (including untracked) before checkout");
      deps.gitRun(["stash", "--include-untracked"], deps.workspace);
      if (!deps.forceCheckout(branchName, deps.workspace)) {
        log.logError(`Could not checkout branch ${branchName}`);
        deps.safeStashPop(deps.workspace);
        return false;
      }
      // Sync with remote branch from prior PR/MR push, then stage
      syncRemoteBranch(deps, branchName);
      deps.stageAndCommit(`[AI] resume: staged pending changes on ${branchName}`);
      log.logGit("Rebasing existing branch onto latest", deps.getBaseBranch());
      const rebaseOk1 = deps.gitRun(["rebase", deps.getBaseBranch()], deps.workspace);
      if (!rebaseOk1 && !deps.isRebaseInProgress(deps.workspace)) {
        log.logError(
          `Rebase of ${branchName} onto ${deps.getBaseBranch()} failed outright — not a conflict state`,
        );
        deps.safeStashPop(deps.workspace);
        return false;
      }
      if (!(await deps.resolveRebaseConflictsInPlace(branchName))) {
        deps.safeStashPop(deps.workspace);
        return false;
      }
      deps.safeStashPop(deps.workspace);
    } else {
      // Successfully checked out — sync with remote, stage dirty, rebase
      syncRemoteBranch(deps, branchName);
      deps.stageAndCommit(`[AI] resume: staged pending changes on ${branchName}`);
      log.logGit("Rebasing existing branch onto latest", deps.getBaseBranch());
      const rebaseOk2 = deps.gitRun(["rebase", deps.getBaseBranch()], deps.workspace);
      if (!rebaseOk2 && !deps.isRebaseInProgress(deps.workspace)) {
        log.logError(
          `Rebase of ${branchName} onto ${deps.getBaseBranch()} failed outright — not a conflict state`,
        );
        return false;
      }
      if (!(await deps.resolveRebaseConflictsInPlace(branchName))) {
        return false;
      }
    }
  }
  return true;
}
