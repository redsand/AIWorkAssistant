/**
 * --publish entrypoint: take an already-pushed-ready branch, validate
 * the diff, force-push it, and open a PR (GitHub) or MR (GitLab) with
 * an enriched description (Closes link + issue body). Extracted from
 * src/aicoder.ts (2026-06-26).
 *
 * Exits the process on every failure path because this is a one-shot
 * CLI mode — there is no caller to recover. The injected exit codes
 * stay numeric (not callbacks) so the module reads top-to-bottom.
 */
import axios from "axios";
import type { ServerConfig, WorkItem } from "../autonomous-loop/types";

export interface PublishBranchLogger {
  logWork(message: string): void;
  logConfig(message: string): void;
  logGit(action: string, detail?: string): void;
  logError(message: string): void;
  logPR(message: string): void;
  endRun(exitCode: number | null): void;
}

export interface PublishBranchJiraClient {
  isConfigured(): boolean;
  getIssue(
    issueKey: string,
  ): Promise<{ fields: { description?: unknown } }>;
}

export interface PublishBranchDeps {
  logger: PublishBranchLogger;
  workspace: string;

  // Tunables passed from the CLI args
  dryRunPush: boolean;
  targetIssueKey: string | null;
  source: string;
  exitSuccess: number;

  // Pure git helpers
  gitRun: (args: string[], cwd: string) => boolean;
  gitRunWithOutput: (
    args: string[],
    cwd: string,
  ) => { ok: boolean; stdout: string; stderr: string };
  getBaseBranch: () => string;
  pushBranch: (
    branch: string,
    options?: { forceWithLease?: boolean },
  ) => boolean;

  // Validation + URL helpers
  validateDiffBeforePush: (
    statOutput: string,
    contentOutput: string,
  ) => {
    valid: boolean;
    reason?: string;
    exitCode: number;
    stats: {
      filesChanged: number;
      insertions: number;
      deletions: number;
    };
  };
  extractIssueKeyFromBranchName: (branchName: string) => string | null;
  detectRemotePlatform: (workspace: string) => string;
  getGitLabProjectFromRemote: (workspace: string) => string | null | undefined;
  truncate: (text: string, max: number) => string;
  authHeaders: (cfg: ServerConfig) => Record<string, string>;

  // Issue fetchers (each platform has its own)
  jiraClient: PublishBranchJiraClient;
  fetchWorkItemDirectly: (
    cfg: ServerConfig,
    workItemId: string,
  ) => Promise<WorkItem | null>;
  fetchJiraIssueDirectly: (key: string) => Promise<WorkItem | null>;
  fetchIssueDirectly: (
    cfg: ServerConfig,
    issueNumber: number,
  ) => Promise<WorkItem | null>;
}

export async function publishBranch(
  deps: PublishBranchDeps,
  cfg: ServerConfig,
  branchName: string,
): Promise<void> {
  const log = deps.logger;
  log.logWork(`Publishing branch: ${branchName}`);

  // 1. Ensure we're on the right branch
  const currentBranchResult = deps.gitRunWithOutput(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    deps.workspace,
  );
  const currentBranch = currentBranchResult.ok
    ? currentBranchResult.stdout.trim()
    : "";
  if (currentBranch !== branchName) {
    log.logGit(`Switching to branch: ${branchName}`);
    if (!deps.gitRun(["checkout", branchName], deps.workspace)) {
      log.logError(`Cannot checkout branch ${branchName} — does it exist?`);
      process.exit(1);
    }
  }

  // 2. Validate diff before push — reject empty / whitespace / meta only
  const baseBranch = deps.getBaseBranch();
  const diffStatResult = deps.gitRunWithOutput(
    ["diff", `${baseBranch}...HEAD`, "--stat"],
    deps.workspace,
  );
  const diffContentResult = deps.gitRunWithOutput(
    ["diff", `${baseBranch}...HEAD`],
    deps.workspace,
  );

  const diffValidation = deps.validateDiffBeforePush(
    diffStatResult.ok ? diffStatResult.stdout : "",
    diffContentResult.ok ? diffContentResult.stdout : "",
  );

  if (!diffValidation.valid) {
    log.logError(
      `Pre-push validation failed (${diffValidation.reason}): ${diffValidation.stats.filesChanged} files, ${diffValidation.stats.insertions} insertions, ${diffValidation.stats.deletions} deletions`,
    );
    log.logError(
      `Exit code ${diffValidation.exitCode} — PR will not be created`,
    );
    log.endRun(diffValidation.exitCode);
    process.exit(diffValidation.exitCode);
  }

  log.logWork(
    `Diff validation passed: ${diffValidation.stats.filesChanged} files, ${diffValidation.stats.insertions} insertions, ${diffValidation.stats.deletions} deletions`,
  );

  // --dry-run-push: show what would be pushed without actually pushing
  if (deps.dryRunPush) {
    log.logConfig("Dry-run mode — skipping push and PR creation");
    console.log("\n=== DRY RUN: Diff Summary ===");
    console.log(`Base branch: ${baseBranch}`);
    console.log(`Feature branch: ${branchName}`);
    console.log(`Files changed: ${diffValidation.stats.filesChanged}`);
    console.log(`Insertions: ${diffValidation.stats.insertions}`);
    console.log(`Deletions: ${diffValidation.stats.deletions}`);
    if (diffStatResult.ok) {
      console.log("\n--- Diff Stat ---");
      console.log(diffStatResult.stdout.trim());
    }
    console.log("\n=== END DRY RUN ===");
    log.endRun(deps.exitSuccess);
    process.exit(deps.exitSuccess);
  }

  // 3. Force-push branch to origin — AI branches are always authoritative
  if (!deps.pushBranch(branchName, { forceWithLease: true })) {
    log.logError(`Cannot push branch ${branchName} to origin`);
    process.exit(1);
  }

  // 4. Resolve issue key: --issue flag overrides branch-name extraction
  let issueKey: string | null =
    deps.targetIssueKey || deps.extractIssueKeyFromBranchName(branchName);

  // If only a bare number was extracted and source is Jira, try to
  // reconstruct the full key (e.g. "110" → "IR-110") via JIRA_PROJECT
  if (issueKey && /^\d+$/.test(issueKey) && deps.source === "jira") {
    const project =
      process.env.JIRA_PROJECT || process.env.JIRA_DEFAULT_PROJECT || "";
    if (project) {
      issueKey = `${project.toUpperCase()}-${issueKey}`;
      log.logWork(`Reconstructed Jira key: ${issueKey}`);
    }
  }

  if (!issueKey) {
    log.logError(`Cannot extract issue key from branch name: ${branchName}`);
    log.logError("Pass --issue IR-110 to specify it explicitly.");
    process.exit(1);
  }
  log.logWork(`Extracted issue key: ${issueKey}`);

  // 5. Look up the issue
  const isWorkItemId =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      issueKey,
    );
  const isJira = /^[A-Z]+-\d+$/.test(issueKey);
  let item: WorkItem | null = null;

  if (isWorkItemId) {
    item = await deps.fetchWorkItemDirectly(cfg, issueKey);
  } else if (isJira) {
    item = await deps.fetchJiraIssueDirectly(issueKey);
  } else {
    const num = parseInt(issueKey, 10);
    if (!isNaN(num)) {
      item = await deps.fetchIssueDirectly(cfg, num);
    }
  }

  if (!item) {
    log.logError(
      `Cannot find issue ${issueKey} — check --source flag and credentials`,
    );
    process.exit(1);
  }

  log.logWork(`Found issue: ${item.id} — ${item.title}`);

  // 6. Build enriched description
  let description = "";

  // Closes line for auto-merge
  if (item.url) {
    description += `Closes ${item.url}\n\n`;
  }

  // Issue key for reviewer routing
  description += `Issue: ${item.id}\n\n`;

  // Issue description for reviewer context
  if (isWorkItemId) {
    if (item.body) {
      description += `## Description\n\n${deps.truncate(item.body, 2000)}\n\n`;
    }
  } else if (isJira && deps.jiraClient.isConfigured()) {
    try {
      const jiraIssue = await deps.jiraClient.getIssue(item.id);
      const desc = jiraIssue.fields?.description;
      if (desc) {
        const descText =
          typeof desc === "string"
            ? desc
            : Array.isArray(
                  (desc as { content?: Array<{ text?: string }> }).content,
                )
              ? (desc as { content?: Array<{ text?: string }> }).content!
                  .map((block) => block.text || "")
                  .filter(Boolean)
                  .join("\n")
              : "";
        if (descText) {
          description += `## Description\n\n${deps.truncate(descText, 2000)}\n\n`;
        }
      }
    } catch {
      // Non-fatal: description enrichment is best-effort
    }
  }

  description += "_Generated by AiRemoteCoder autonomous agent._";

  // 7. Create PR/MR
  const platform = deps.detectRemotePlatform(deps.workspace);
  log.logGit(`Detected remote platform: ${platform}`);

  if (platform === "gitlab") {
    // Derive project path from git remote — more reliable than the Jira key
    const gitlabProject =
      deps.getGitLabProjectFromRemote(deps.workspace) ||
      process.env.GITLAB_DEFAULT_PROJECT ||
      cfg.repo ||
      item.repo;
    try {
      const resp = await axios.post<{
        success: boolean;
        mrIid?: number;
        url?: string;
        error?: string;
      }>(
        `${cfg.apiUrl}/api/autonomous-loop/mr`,
        {
          project: gitlabProject,
          title: `[AI] ${item.title}`,
          sourceBranch: branchName,
          targetBranch: deps.getBaseBranch(),
          description,
          removeSourceBranch: true,
        },
        { headers: deps.authHeaders(cfg) },
      );
      if (resp.data.success) {
        const mrUrl = resp.data.url ?? "";
        log.logPR(`Created MR !${resp.data.mrIid ?? ""}: ${mrUrl}`);
      } else {
        const errMsg = resp.data.error ?? "unknown error";
        if (/already exists/i.test(errMsg)) {
          log.logWork(
            "MR already exists for this branch — branch pushed successfully, reviewer will pick it up",
          );
        } else {
          log.logError(`GitLab MR creation failed: ${errMsg}`);
          process.exit(1);
        }
      }
    } catch (err) {
      log.logError(`GitLab MR creation failed: ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    // GitHub PR
    try {
      const resp = await axios.post<{
        success: boolean;
        prNumber: number;
        url: string;
        error?: string;
      }>(
        `${cfg.apiUrl}/api/autonomous-loop/pr`,
        {
          owner: item.owner || cfg.owner,
          repo: item.repo || cfg.repo,
          title: `[AI] ${item.title}`,
          head: branchName,
          base: "main",
          body: description,
          issueNumber: item.number,
        },
        { headers: deps.authHeaders(cfg) },
      );
      if (resp.data.success) {
        log.logPR(`Created PR #${resp.data.prNumber}: ${resp.data.url}`);
      } else {
        log.logError(
          `GitHub PR creation failed: ${resp.data.error || "unknown error"}`,
        );
        process.exit(1);
      }
    } catch (err) {
      log.logError(`GitHub PR creation failed: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  log.logWork("Publish complete");
}
