/**
 * Best-effort workspace tidy-up before doing real work. Extracted from
 * src/aicoder.ts (2026-06-26).
 *
 * In order:
 *   1. Abort any mid-rebase state (caller can retry).
 *   2. Auto-resolve unmerged paths by accepting whatever's in the
 *      working tree, then committing.
 *   3. Stash any dirty / staged changes into a labeled stash so the
 *      next operation starts from a clean tree.
 *   4. Switch off detached HEAD onto the base branch.
 *
 * Returns false only when a step fails in a way the caller cannot
 * safely proceed from (rebase recovery failure, stash failure).
 */
import { spawnSync } from "child_process";

export interface EnsureCleanWorkspaceLogger {
  logGit(action: string, detail?: string): void;
  logError(message: string): void;
}

export interface EnsureCleanWorkspaceDeps {
  logger: EnsureCleanWorkspaceLogger;
  workspace: string;

  isRebaseInProgress: (workspace: string) => boolean;
  recoverFromRebase: (workspace: string) => boolean;
  validateGitWorkspace: (workspace: string) => boolean;
  gitRun: (args: string[], cwd: string) => boolean;
  gitRunWithOutput: (
    args: string[],
    cwd: string,
  ) => { ok: boolean; stdout: string; stderr: string };
  stageAndCommit: (message: string) => boolean;
  getCurrentBranch: () => string | null;
  getBaseBranch: () => string;
  forceCheckout: (branch: string, cwd: string) => boolean;
  summarizeDiffStat: (statOutput: string) => string;
}

export function ensureCleanWorkspace(
  deps: EnsureCleanWorkspaceDeps,
): boolean {
  const log = deps.logger;

  if (!deps.validateGitWorkspace(deps.workspace)) {
    log.logGit(
      "WARN",
      "Workspace is not a valid git repository — skipping git cleanup; commit/push recovery will preserve changed files",
    );
    return true;
  }

  // 1. Recover from mid-rebase
  if (deps.isRebaseInProgress(deps.workspace)) {
    log.logGit("WARN", "Mid-rebase state detected during workspace cleanup");
    if (!deps.recoverFromRebase(deps.workspace)) {
      log.logError("Could not recover from mid-rebase state");
      return false;
    }
  }

  // 2. Check for unmerged paths
  const statusResult = spawnSync("git", ["status", "--porcelain"], {
    cwd: deps.workspace,
    stdio: "pipe",
    encoding: "utf-8",
  });
  if (statusResult.status === 0) {
    const unmerged = statusResult.stdout
      .trim()
      .split("\n")
      .filter((line) => /^(DD|AU|UD|UA|DU|UU|AA)/.test(line))
      .map((line) => line.slice(3).trim())
      .filter(Boolean);

    if (unmerged.length > 0) {
      log.logGit(
        "WARN",
        `Found ${unmerged.length} unmerged path(s) — resolving`,
      );
      for (const file of unmerged) {
        // Accept whatever is in the working tree (likely partial)
        if (!deps.gitRun(["add", "--", file], deps.workspace)) {
          // If add fails, the file may have been deleted — drop from index
          deps.gitRun(["rm", "--", file], deps.workspace);
        }
      }
      // Commit the resolution
      deps.stageAndCommit("[AI] auto-resolved unmerged paths");
    }
  }

  // 3. Commit any dirty working tree changes
  const dirtyResult = spawnSync("git", ["diff", "--quiet"], {
    cwd: deps.workspace,
    stdio: "pipe",
    encoding: "utf-8",
  });
  const hasUncommittedChanges = dirtyResult.status !== 0;

  const cachedResult = spawnSync("git", ["diff", "--cached", "--quiet"], {
    cwd: deps.workspace,
    stdio: "pipe",
    encoding: "utf-8",
  });
  const hasStagedChanges = cachedResult.status !== 0;

  if (hasUncommittedChanges || hasStagedChanges) {
    const stat = deps.gitRunWithOutput(["diff", "--stat"], deps.workspace);
    log.logGit(
      "WARN",
      `Preserving dirty workspace in git stash during cleanup${
        stat.ok && stat.stdout.trim()
          ? `: ${deps.summarizeDiffStat(stat.stdout)}`
          : ""
      }`,
    );
    if (
      !deps.gitRun(
        [
          "stash",
          "push",
          "--include-untracked",
          "-m",
          "[AI] auto-cleanup: pending changes preserved",
        ],
        deps.workspace,
      )
    ) {
      log.logError(
        "Could not preserve dirty workspace in stash during cleanup",
      );
      return false;
    }
  }

  // 4. Check for detached HEAD
  const branch = deps.getCurrentBranch();
  if (branch === "HEAD" || branch === null || branch.startsWith("(")) {
    log.logGit("WARN", "Detached HEAD detected — switching to base branch");
    deps.forceCheckout(deps.getBaseBranch(), deps.workspace);
  }

  return true;
}
