/**
 * Git working-tree recovery helpers extracted from src/aicoder.ts
 * (2026-06-26). Three interlocking functions that handle the common
 * "can't checkout — something's in the way" / "stash pop conflicts" /
 * "merge or rebase left files unmerged" cases.
 *
 *   forceCheckout         — best-effort `git checkout <branch>` that
 *                            recovers from detached HEAD, branch-in-use,
 *                            untracked-overwrite, and other common
 *                            blockers. Falls back to stash+checkout+pop
 *                            as the last resort.
 *   safeStashPop          — `git stash pop` that auto-resolves any
 *                            conflicts triggered by the pop.
 *   resolveConflictsInWorkingTree — for each unmerged file, prefer the
 *                            AI's version when the file was modified by
 *                            the feature branch, otherwise prefer base.
 *                            Inverts ours/theirs semantics correctly
 *                            during rebase.
 *
 * All three take their dependencies through a shared GitRecoveryDeps
 * options bag so this module can be unit-tested against fake gitRun
 * implementations.
 */
import { spawnSync } from "node:child_process";
import { gitRun, gitRunWithOutput } from "../autonomous-loop/git-ops";

export interface GitRecoveryLogger {
  logError(message: string): void;
  logGit(message: string, detail?: string): void;
}

export interface GitRecoveryDeps {
  logger: GitRecoveryLogger;
  workspace: string;
  /** Returns the current branch name, "(detached)", or null on error. */
  getCurrentBranch: () => string | null;
  /** Stages all changes + commits with `message`. Returns true on success. */
  stageAndCommit: (message: string) => boolean;
  /**
   * Returns the list of files modified by the current feature branch
   * relative to the base branch. Used by safeStashPop's auto-resolver
   * to decide which side to prefer.
   */
  getBranchModifiedFiles: () => string[];
}

const OVERWRITE_RE =
  /The following untracked working tree files would be overwritten by checkout:\s*\n((?:\s+.+\n?)+)/;

/**
 * Try to land on `branch`. Recovers from common failure modes:
 *
 *   - "already used by worktree" — falls back to `reset --hard
 *     origin/<branch>` because git refuses to check out the same branch
 *     in two worktrees.
 *   - detached HEAD — force-switches via `checkout -f` then `-b` from
 *     origin if the local branch doesn't exist.
 *   - untracked-file overwrite — stages + commits the conflicting files
 *     so they're preserved, then retries the checkout.
 *   - last resort — stash everything, checkout, then safeStashPop.
 *
 * Returns true on success, false when nothing recovers.
 */
export function forceCheckout(
  deps: GitRecoveryDeps,
  branch: string,
  cwd: string,
): boolean {
  const firstAttempt = gitRunWithOutput(["checkout", branch], cwd);
  if (firstAttempt.ok) return true;

  const stderr = firstAttempt.stderr;

  if (stderr.includes("already used by worktree")) {
    deps.logger.logGit(
      "WARN",
      `Branch ${branch} already used by another worktree -- resetting to origin/${branch} instead`,
    );
    gitRun(["fetch", "origin", branch], cwd);
    if (gitRun(["reset", "--hard", `origin/${branch}`], cwd)) {
      deps.logger.logGit("Reset detached HEAD to", `origin/${branch}`);
      return true;
    }
    deps.logger.logError(
      `Could not reset to origin/${branch} after worktree conflict`,
    );
    return false;
  }

  const currentBranch = deps.getCurrentBranch();
  const isDetached =
    (currentBranch && currentBranch.startsWith("(")) ||
    stderr.includes("detached HEAD") ||
    stderr.includes("HEAD detached");
  if (isDetached) {
    deps.logger.logGit("WARN", `Detached HEAD detected — force-switching to ${branch}`);
    gitRun(["checkout", "-f", branch], cwd);
    const current = deps.getCurrentBranch();
    if (current === branch) {
      deps.logger.logGit("Recovered from detached HEAD — now on", branch);
      return true;
    }
    deps.logger.logGit(
      "WARN",
      `Local branch ${branch} not found — fetching from origin`,
    );
    gitRun(["fetch", "origin", branch], cwd);
    if (gitRun(["checkout", "-b", branch, `origin/${branch}`], cwd)) {
      deps.logger.logGit("Created local branch from origin", branch);
      return true;
    }
    deps.logger.logError(`Could not recover from detached HEAD to ${branch}`);
    return false;
  }

  const overwriteMatch = stderr.match(OVERWRITE_RE);
  if (!overwriteMatch) {
    deps.logger.logError(
      `Could not checkout ${branch} — no recognizable conflict pattern`,
    );
    return false;
  }

  const conflictingFiles = overwriteMatch[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((f) => f);

  if (conflictingFiles.length === 0) {
    deps.logger.logError(
      `Could not checkout ${branch} — untracked conflict but no files found`,
    );
    return false;
  }

  deps.logger.logGit(
    "Staging conflicting untracked files before checkout",
    conflictingFiles.join(", "),
  );
  for (const f of conflictingFiles) {
    if (!gitRun(["add", f], cwd)) {
      deps.logger.logGit("WARN", `Could not stage ${f} — may need manual resolution`);
    }
  }
  deps.stageAndCommit(
    `[AI] auto-save: preserve untracked files before checkout of ${branch}`,
  );

  if (gitRun(["checkout", branch], cwd)) return true;

  // Last resort: stash everything including untracked, checkout, then pop.
  deps.logger.logGit(
    "WARN",
    "Checkout still failed — stashing all changes including untracked",
  );
  gitRun(["stash", "--include-untracked"], cwd);
  if (!gitRun(["checkout", branch], cwd)) {
    deps.logger.logError(`Could not checkout ${branch} even after stashing`);
    safeStashPop(deps, cwd);
    return false;
  }
  safeStashPop(deps, cwd);
  return true;
}

/**
 * Pop the stash and auto-resolve any conflicts the pop triggers. The
 * stash entry is consumed either way (pop, unlike apply, removes it).
 * Returns true when pop was clean, false when it had conflicts that
 * were auto-resolved.
 */
export function safeStashPop(deps: GitRecoveryDeps, cwd: string): boolean {
  if (!gitRun(["stash", "pop"], cwd)) {
    deps.logger.logGit("WARN", "Stash pop had conflicts — auto-resolving");
    const branchFiles = deps.getBranchModifiedFiles();
    resolveConflictsInWorkingTree(deps, branchFiles, false);
    deps.stageAndCommit("[AI] auto-resolved stash pop conflicts");
    return false;
  }
  return true;
}

/**
 * Resolve every unmerged file in the working tree. Files that the
 * feature branch modified → prefer the feature side; others → prefer
 * base. During rebase git's --ours/--theirs are inverted (ours = base
 * being rebased ONTO, theirs = feature being replayed), so we swap.
 *
 * Returns the number of files resolved.
 */
export function resolveConflictsInWorkingTree(
  deps: GitRecoveryDeps,
  branchFiles: string[],
  isRebase: boolean = false,
): number {
  const statusResult = spawnSync("git", ["status", "--porcelain"], {
    cwd: deps.workspace,
    stdio: "pipe",
    encoding: "utf-8",
  });
  if (statusResult.status !== 0) return 0;

  const conflictFiles = statusResult.stdout
    .trim()
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("UU") ||
        line.startsWith("AA") ||
        line.startsWith("DU") ||
        line.startsWith("UD"),
    )
    .map((line) => line.slice(3).trim());

  if (conflictFiles.length === 0) return 0;

  // Empty branchFiles → caller couldn't determine ownership. Default to
  // keeping the AI's changes (ours in merge, theirs in rebase) so we
  // don't discard all the agent's work when in doubt.
  const branchFileSet = new Set(branchFiles);
  const aiFileDefault = branchFileSet.size === 0;

  let resolvedCount = 0;

  for (const file of conflictFiles) {
    const isAiFile = aiFileDefault || branchFileSet.has(file);

    if (isRebase) {
      if (isAiFile) {
        deps.logger.logGit("Resolving conflict (rebase: accept AI/theirs)", file);
        gitRun(["checkout", "--theirs", "--", file], deps.workspace);
      } else {
        deps.logger.logGit("Resolving conflict (rebase: accept base/ours)", file);
        gitRun(["checkout", "--ours", "--", file], deps.workspace);
      }
    } else {
      if (isAiFile) {
        deps.logger.logGit("Resolving conflict (merge: accept AI/ours)", file);
        gitRun(["checkout", "--ours", "--", file], deps.workspace);
      } else {
        deps.logger.logGit("Resolving conflict (merge: accept base/theirs)", file);
        gitRun(["checkout", "--theirs", "--", file], deps.workspace);
      }
    }
    gitRun(["add", "--", file], deps.workspace);
    resolvedCount++;
  }

  return resolvedCount;
}
