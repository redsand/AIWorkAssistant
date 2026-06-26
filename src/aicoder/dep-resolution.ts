/**
 * Pre-flight dependency resolution. Extracted from src/aicoder.ts
 * (2026-06-26) so processWorkItem doesn't have to inline the Jira-vs-
 * numeric-dep branching logic alongside everything else.
 *
 * Reads the issue body (Jira description + comments OR GitHub issue
 * body), pulls dep references out of it, then:
 *   - blocks on any unresolved Jira dependency
 *   - tries to resolve numeric GitHub deps to a source branch; if the
 *     resolution returns null and --wait-for-deps is on, we punt;
 *     otherwise we hard-block this issue
 *   - on success, returns the branch to base the work on (open PR branch
 *     when applicable, else undefined for default base)
 *
 * On a "blocked" return, the module has already done the run-tracking
 * cleanup (endRun, completeRunTrack, clearFailedAttempt, mark the issue
 * dep-blocked-this-cycle). The caller just needs to return null.
 */

export interface DepResolutionLogger {
  logGit(action: string, detail?: string): void;
  logSkip(message: string): void;
  endRun(exitCode: number | null): void;
}

export interface DepResolutionJiraClient {
  isConfigured(): boolean;
  getIssue(issueKey: string): Promise<{
    fields?: { description?: unknown };
  }>;
  getComments(issueKey: string): Promise<Array<{ body: string }>>;
}

export interface DepResolutionDeps {
  logger: DepResolutionLogger;
  workspace: string;
  waitForDeps: boolean;
  jiraClient: DepResolutionJiraClient;

  // Pure helpers (no side effects on the host)
  jiraDescriptionToText: (description: unknown) => string;
  parseDependencies: (body: string) => string[];
  fetchIssueBody: (
    ghToken: string,
    owner: string,
    repo: string,
    issueNumber: number,
  ) => Promise<string>;
  getUnresolvedJiraDependencies: (jiraDeps: string[]) => Promise<string[]>;
  resolveDependencyBranch: (
    ghToken: string,
    owner: string,
    repo: string,
    numericDeps: string[],
  ) => Promise<{ source: string; branch: string } | null>;
  getBaseBranch: () => string;

  // Run/agent tracking side-effects
  trackStep: (
    runId: string,
    kind: "note",
    message: string,
  ) => void;
  completeRunTrack: (
    runId: string,
    summary: { model: string; toolLoopCount: number; totalTokens: number },
  ) => void;
  clearFailedAttempt: (issueKey: string, workspace: string) => void;
  markDepBlockedThisCycle: (issueKey: string) => void;

  // Runtime model id (passed through to completeRunTrack)
  model: string;
}

export type DepResolutionResult =
  | { kind: "blocked" }
  | { kind: "ok"; fromBranch?: string };

export async function resolveIssueDependencies(
  deps: DepResolutionDeps,
  args: {
    issueKey: string;
    item: {
      id: string;
      number: number;
    };
    runId: string;
    ghToken: string | undefined;
    owner: string;
    repo: string;
  },
): Promise<DepResolutionResult> {
  const { issueKey, item, runId, ghToken, owner, repo } = args;
  const isJiraIssue = /^[A-Z]+-\d+$/.test(item.id);

  let depBody = "";
  if (isJiraIssue && deps.jiraClient.isConfigured()) {
    try {
      const jiraIssue = await deps.jiraClient.getIssue(item.id);
      depBody = deps.jiraDescriptionToText(jiraIssue?.fields?.description);
      const comments = await deps.jiraClient
        .getComments(item.id)
        .catch(() => []);
      depBody = [depBody, ...comments.map((c) => c.body)]
        .filter(Boolean)
        .join("\n");
    } catch {
      // Jira fetch failed — proceed with empty body (no deps detected).
    }
  } else if (ghToken && repo) {
    depBody = await deps.fetchIssueBody(ghToken, owner, repo, item.number);
  }

  const selfRefs = new Set(
    [item.id?.toUpperCase(), issueKey.toUpperCase(), String(item.number)].filter(
      Boolean,
    ),
  );
  const allDeps = [...new Set(deps.parseDependencies(depBody))].filter(
    (dep) => !selfRefs.has(dep.toUpperCase()),
  );

  if (allDeps.length === 0) {
    return { kind: "ok" };
  }

  deps.logger.logGit("Found dependencies", allDeps.join(", "));

  // Jira-style dep keys (PROJ-123)
  const jiraDeps = allDeps.filter((dep) => /^[A-Z]+-\d+$/.test(dep));
  if (jiraDeps.length > 0 && deps.jiraClient.isConfigured()) {
    const unresolved = await deps.getUnresolvedJiraDependencies(jiraDeps);
    if (unresolved.length > 0) {
      const message = `Blocked by unresolved Jira dependencies: ${unresolved.join(", ")}`;
      deps.logger.logSkip(`${issueKey}: ${message}`);
      deps.trackStep(runId, "note", message);
      deps.logger.endRun(null);
      deps.completeRunTrack(runId, {
        model: deps.model,
        toolLoopCount: 0,
        totalTokens: 0,
      });
      // dep-blocked is not a failure — don't burn retry budget
      deps.clearFailedAttempt(issueKey, deps.workspace);
      deps.markDepBlockedThisCycle(issueKey);
      return { kind: "blocked" };
    }
  }

  // Numeric (GitHub) dep ids
  const numericDeps = allDeps.filter((dep) => /^\d+$/.test(dep));
  if (numericDeps.length > 0) {
    const resolved = await deps.resolveDependencyBranch(
      ghToken || "",
      owner,
      repo,
      numericDeps,
    );
    if (!resolved) {
      // dep-blocked is not a failure — don't burn retry budget
      deps.clearFailedAttempt(issueKey, deps.workspace);
      deps.markDepBlockedThisCycle(issueKey);
      if (deps.waitForDeps) {
        deps.logger.logGit("Waiting for dependencies", "will retry later");
        deps.logger.endRun(null);
        deps.completeRunTrack(runId, {
          model: deps.model,
          toolLoopCount: 0,
          totalTokens: 0,
        });
        return { kind: "blocked" };
      }
      deps.logger.logSkip(
        `${issueKey}: blocked by unresolved dependencies ${numericDeps.join(", ")}`,
      );
      deps.logger.endRun(null);
      deps.completeRunTrack(runId, {
        model: deps.model,
        toolLoopCount: 0,
        totalTokens: 0,
      });
      return { kind: "blocked" };
    }
    const fromBranch =
      resolved.source === "open_pr" ? resolved.branch : undefined;
    deps.logger.logGit("Base branch resolved", fromBranch || deps.getBaseBranch());
    return { kind: "ok", fromBranch };
  }

  return { kind: "ok" };
}
