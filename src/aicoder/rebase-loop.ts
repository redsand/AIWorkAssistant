/**
 * Local-rebase orchestration with conflict resolution, extracted from
 * src/aicoder.ts (2026-06-26).
 *
 *   rebaseAndResolveConflicts: start-from-scratch rebase. Recovers
 *     from any stuck mid-rebase state first, fetches latest base,
 *     attempts the rebase, falls through to LLM-assisted conflict
 *     resolution → dumb --ours/--theirs resolution as last resort.
 *
 *   resolveRebaseConflictsInPlace: assumes a rebase is already in
 *     progress with conflicts, and finishes it. Same two-step
 *     resolution: LLM first, dumb fallback. Returns true if the
 *     rebase ultimately completes.
 *
 * Both functions delegate the working-tree fixes to git-recovery
 * (forceCheckout, resolveConflictsInWorkingTree) and the conflict
 * prompt to fix-prompts (buildConflictResolutionPrompt). Everything
 * else they need — runAgent, stageAndCommit, base-branch lookup —
 * comes through the injected RebaseLoopDeps options bag.
 */
import { spawnSync } from "node:child_process";
import {
  gitRun,
  gitRunWithOutput,
  isRebaseInProgress,
  recoverFromRebase,
} from "../autonomous-loop/git-ops";
import { buildConflictResolutionPrompt } from "./fix-prompts";
import {
  forceCheckout,
  resolveConflictsInWorkingTree,
} from "./git-recovery";
import type { GitRecoveryDeps } from "./git-recovery";

export interface RebaseLoopLogger {
  logError(message: string): void;
  logGit(message: string, detail?: string): void;
}

export interface RebaseLoopAgentResult {
  finDetected: boolean;
  exitCode: number | null;
}

export interface RebaseLoopDeps {
  logger: RebaseLoopLogger;
  workspace: string;
  /** Resolved base branch name (e.g. "main" / "master"). */
  baseBranch: string;
  /** Returns a list of files this feature branch has modified vs base. */
  getBranchModifiedFiles: () => string[];
  /** Returns the list of files currently containing conflict markers. */
  getConflictFiles: () => string[];
  /** Stage all + commit with `message`. Returns true on success. */
  stageAndCommit: (message: string) => boolean;
  /** Invoke the coding agent with `prompt`. */
  runAgent: (prompt: string) => Promise<RebaseLoopAgentResult>;
  /** Forwarded into git-recovery (forceCheckout + resolveConflicts). */
  gitRecoveryDeps: GitRecoveryDeps;
}

const MAX_CONFLICT_ROUNDS = 10;

function rebaseContinue(cwd: string) {
  return spawnSync("git", ["rebase", "--continue"], {
    cwd,
    stdio: "pipe",
    encoding: "utf-8",
    env: { ...process.env, GIT_EDITOR: "true" },
  });
}

/**
 * Run a rebase from a clean starting state. Stages pending work, recovers
 * any stuck rebase, fetches latest base, then attempts the rebase. On
 * conflicts, tries LLM-assisted resolution before falling back to
 * --ours/--theirs heuristics. Loops up to MAX_CONFLICT_ROUNDS for
 * multi-commit conflict cascades.
 */
export async function rebaseAndResolveConflicts(
  deps: RebaseLoopDeps,
  branchName: string,
): Promise<boolean> {
  deps.logger.logGit(
    "Starting local rebase with conflict resolution",
    branchName,
  );

  deps.stageAndCommit("[AI] auto-save before rebase");

  if (isRebaseInProgress(deps.workspace)) {
    if (!recoverFromRebase(deps.workspace)) {
      deps.logger.logError(
        "Could not recover from mid-rebase state before conflict rebase",
      );
      return false;
    }
  }

  if (!gitRun(["fetch", "origin", deps.baseBranch], deps.workspace)) {
    deps.logger.logError("Failed to fetch latest base branch for rebase");
    return false;
  }

  if (!forceCheckout(deps.gitRecoveryDeps, branchName, deps.workspace)) {
    deps.logger.logError(`Could not checkout ${branchName} for rebase`);
    return false;
  }

  const branchFiles = deps.getBranchModifiedFiles();
  deps.logger.logGit("Branch modifies files", branchFiles.join(", "));

  const rebaseResult = gitRunWithOutput(
    ["rebase", `origin/${deps.baseBranch}`],
    deps.workspace,
  );
  if (rebaseResult.ok) {
    deps.logger.logGit("Rebase completed cleanly (no conflicts)");
    return true;
  }

  deps.logger.logGit("Rebase has conflicts — attempting resolution");

  // Step 1: LLM-assisted resolution.
  const conflictFileList = deps.getConflictFiles();
  if (conflictFileList.length > 0) {
    deps.logger.logGit(
      `Attempting LLM conflict resolution for ${conflictFileList.length} file(s)`,
    );
    const conflictPrompt = buildConflictResolutionPrompt(
      conflictFileList,
      branchName,
      deps.workspace,
      deps.baseBranch,
    );
    const llmResult = await deps.runAgent(conflictPrompt);
    if (llmResult.finDetected || llmResult.exitCode === 0) {
      // Stage what the LLM edited — it writes files directly but doesn't
      // git-add them, so we have to do it before checking what's left.
      gitRun(["add", "--all"], deps.workspace);
      const remainingConflicts = deps.getConflictFiles();
      if (remainingConflicts.length === 0) {
        const cont = rebaseContinue(deps.workspace);
        if (cont.status === 0) {
          deps.logger.logGit("Rebase completed with LLM conflict resolution");
          return true;
        }
        if (!isRebaseInProgress(deps.workspace)) {
          deps.logger.logGit("Rebase completed after LLM resolution and continue");
          return true;
        }
        deps.logger.logGit(
          "LLM resolved conflicts but rebase continue had issues — falling back to dumb resolution",
        );
      } else {
        deps.logger.logGit(
          `LLM left ${remainingConflicts.length} conflict(s) — falling back to dumb resolution`,
        );
      }
    }
  }

  // Step 2: --ours/--theirs fallback. Loop because multi-commit
  // rebases can hit a fresh conflict on each subsequent patch.
  let resolvedTotal = 0;
  let maxRounds = MAX_CONFLICT_ROUNDS;

  while (maxRounds-- > 0) {
    const resolvedCount = resolveConflictsInWorkingTree(
      deps.gitRecoveryDeps,
      branchFiles,
      true,
    );
    if (resolvedCount === 0) break;
    resolvedTotal += resolvedCount;

    const cont = rebaseContinue(deps.workspace);
    if (cont.status === 0) {
      deps.logger.logGit(
        `Rebase completed with ${resolvedTotal} conflict(s) auto-resolved`,
      );
      return true;
    }

    if (!isRebaseInProgress(deps.workspace)) {
      deps.logger.logError(`Rebase continue failed: ${cont.stderr}`);
      if (!gitRun(["rebase", "--abort"], deps.workspace)) {
        recoverFromRebase(deps.workspace);
      }
      return false;
    }
    // More conflicts — loop again.
  }

  if (resolvedTotal === 0) {
    deps.logger.logGit("Rebase failed but no conflict files found — aborting rebase");
    if (!gitRun(["rebase", "--abort"], deps.workspace)) {
      recoverFromRebase(deps.workspace);
    }
    return false;
  }

  deps.logger.logGit(
    `Rebase completed with ${resolvedTotal} conflict(s) auto-resolved`,
  );
  return true;
}

/**
 * Finish a rebase that's already in progress with conflicts. Same
 * two-step (LLM → dumb) resolution as above, but assumes git is
 * already in REBASE-MERGE state — exits early if not.
 */
export async function resolveRebaseConflictsInPlace(
  deps: RebaseLoopDeps,
  branchName: string,
): Promise<boolean> {
  if (!isRebaseInProgress(deps.workspace)) {
    return true; // Nothing to do — rebase completed cleanly before this was called.
  }

  deps.logger.logGit("Rebase has conflicts — resolving in place");
  const branchFiles = deps.getBranchModifiedFiles();

  // Step 1: LLM-assisted resolution.
  const conflictFileList = deps.getConflictFiles();
  if (conflictFileList.length > 0) {
    deps.logger.logGit(
      `Attempting LLM conflict resolution for ${conflictFileList.length} file(s)`,
    );
    const conflictPrompt = buildConflictResolutionPrompt(
      conflictFileList,
      branchName,
      deps.workspace,
      deps.baseBranch,
    );
    const llmResult = await deps.runAgent(conflictPrompt);
    if (llmResult.finDetected || llmResult.exitCode === 0) {
      gitRun(["add", "--all"], deps.workspace);
      const afterLlm = deps.getConflictFiles();
      if (afterLlm.length === 0) {
        deps.logger.logGit("LLM resolved all conflicts — continuing rebase");
        const cont = rebaseContinue(deps.workspace);
        if (cont.status === 0 || !isRebaseInProgress(deps.workspace)) {
          deps.logger.logGit("Rebase completed with LLM conflict resolution");
          return true;
        }
        if (isRebaseInProgress(deps.workspace)) {
          deps.logger.logGit("More conflicts after LLM resolution — continuing");
        } else {
          return true;
        }
      } else {
        deps.logger.logGit(
          `LLM left ${afterLlm.length} conflict(s) — falling back to dumb resolution for remaining`,
        );
      }
    } else {
      deps.logger.logGit("LLM failed to resolve conflicts — falling back to dumb resolution");
    }
  }

  // Step 2: dumb --ours/--theirs fallback for any remainder.
  const remainingConflicts = deps.getConflictFiles();
  if (remainingConflicts.length > 0) {
    resolveConflictsInWorkingTree(deps.gitRecoveryDeps, branchFiles, true);
  }

  gitRun(["add", "--all"], deps.workspace);
  const cont = rebaseContinue(deps.workspace);

  if (cont.status === 0 || !isRebaseInProgress(deps.workspace)) {
    deps.logger.logGit("Rebase completed after conflict resolution");
    return true;
  }

  deps.logger.logError("Could not resolve rebase conflicts — aborting rebase");
  if (!gitRun(["rebase", "--abort"], deps.workspace)) {
    recoverFromRebase(deps.workspace);
  }
  return false;
}
