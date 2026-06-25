/**
 * Decide which branch to base a new feature branch on when the issue
 * declares dependencies on other issues. Extracted from src/aicoder.ts
 * (2026-06-25).
 *
 * Strategy:
 *   - Every dep merged → branch from base (clean)
 *   - Any dep has an open PR/MR → branch from that one (so we stack)
 *   - Any dep has neither → unresolved, return null (caller blocks)
 *
 * Platform detection is delegated; this module just calls the supplied
 * findPRForIssue / findMRForIssue. baseBranch is passed in (no global
 * lookup) so the function is unit-testable against fakes.
 */

export type DepBranchResult =
  | { branch: string; source: "merged" | "open_pr" }
  | null;

export interface DepBranchLogger {
  logGit(message: string, detail?: string): void;
}

export interface DepBranchResolverOptions {
  logger: DepBranchLogger;
  platform: "github" | "gitlab" | "unknown";
  baseBranch: string;
  /** Used only on gitlab — typically `runner.repo || GITLAB_DEFAULT_PROJECT`. */
  gitlabProjectId: string;
  /** github only — repo owner from CLI args / env. */
  ghOwner: string;
  /** github only — repo name from CLI args / env. */
  ghRepo: string;
  findPRForIssue: (
    issueNumber: number,
  ) => Promise<{ branch: string; merged: boolean } | null>;
  findMRForIssue: (
    projectId: string,
    issueNumber: number,
  ) => Promise<{ branch: string; merged: boolean } | null>;
}

export async function resolveDependencyBranch(
  opts: DepBranchResolverOptions,
  depIssueRefs: string[],
): Promise<DepBranchResult> {
  const {
    logger,
    platform,
    baseBranch,
    gitlabProjectId,
    findPRForIssue,
    findMRForIssue,
  } = opts;
  let openBranch: string | null = null;

  for (const depRef of depIssueRefs) {
    const depNum = parseInt(depRef, 10);
    if (!Number.isFinite(depNum)) continue;

    if (platform === "gitlab") {
      if (!gitlabProjectId) continue;
      const mr = await findMRForIssue(gitlabProjectId, depNum);
      if (!mr) {
        logger.logGit("Dependency has no MR yet", `!${depNum}`);
        return null; // unresolved
      }
      if (mr.merged) {
        logger.logGit("Dependency merged", `!${depNum}`);
        continue;
      }
      logger.logGit("Dependency has open MR", `!${depNum} → ${mr.branch}`);
      openBranch = mr.branch;
    } else {
      const pr = await findPRForIssue(depNum);
      if (!pr) {
        logger.logGit("Dependency has no PR yet", `#${depNum}`);
        return null;
      }
      if (pr.merged) {
        logger.logGit("Dependency merged", `#${depNum}`);
        continue;
      }
      logger.logGit("Dependency has open PR", `#${depNum} → ${pr.branch}`);
      openBranch = pr.branch;
    }
  }

  return openBranch
    ? { branch: openBranch, source: "open_pr" }
    : { branch: baseBranch, source: "merged" };
}
