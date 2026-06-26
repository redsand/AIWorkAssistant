/**
 * `--watch <issueKey>` CLI mode: switch onto the branch matching the
 * issue's suggestedBranch, find the existing PR (GitHub) or MR
 * (GitLab), and enter the review-and-rework loop directly without
 * creating a new PR. Extracted from src/aicoder.ts (2026-06-26).
 *
 * Returns void: every failure path logs and bails. The caller exits
 * the process around this — there is no recovery here.
 */
import axios from "axios";
import type { ServerConfig, WorkItem } from "../autonomous-loop/types";

export interface WatchIssueLogger {
  logConfig(message: string): void;
  logGit(action: string, detail?: string): void;
  logWork(message: string): void;
  logError(message: string): void;
}

export interface WatchIssueDeps {
  logger: WatchIssueLogger;
  workspace: string;

  gitRun: (args: string[], cwd: string) => boolean;
  gitRunWithOutput: (
    args: string[],
    cwd: string,
  ) => { ok: boolean; stdout: string; stderr: string };
  detectRemotePlatform: (workspace: string) => string;
  getGitLabProjectFromRemote: (workspace: string) => string | null | undefined;

  fetchIssueByKey: (
    cfg: ServerConfig,
    key: string,
  ) => Promise<WorkItem | null>;
  findExistingGitLabMR: (
    projectId: string,
    branchName: string,
  ) => Promise<{ iid: number } | null>;

  clearRunState: (issueKey?: string) => void;
  runReviewLoop: (
    cfg: ServerConfig,
    item: WorkItem,
    ghToken: string | undefined,
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<void>;
}

export async function watchIssue(
  deps: WatchIssueDeps,
  cfg: ServerConfig,
  issueKey: string,
): Promise<void> {
  const log = deps.logger;
  const item = await deps.fetchIssueByKey(cfg, issueKey);
  if (!item) {
    log.logError(`Could not find issue ${issueKey}`);
    return;
  }

  log.logWork(`Watching issue ${item.id}: ${item.title}`);

  // Ensure we're on the right branch
  const branchName = item.suggestedBranch;
  const currentBranch = deps.gitRunWithOutput(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    deps.workspace,
  );
  if (currentBranch.ok && currentBranch.stdout.trim() !== branchName) {
    log.logGit(`Switching to branch: ${branchName}`);
    if (!deps.gitRun(["checkout", branchName], deps.workspace)) {
      log.logError(`Cannot checkout branch ${branchName} — does it exist?`);
      return;
    }
  }

  // Find the existing PR/MR
  const platform = deps.detectRemotePlatform(deps.workspace);
  const ghToken = process.env.GITHUB_TOKEN;
  const owner = cfg.owner || process.env.GITHUB_DEFAULT_OWNER || "redsand";
  const repo = cfg.repo || process.env.AICODER_REPO || "";
  let prNumber: number | null = null;

  if (platform === "gitlab") {
    const projectId =
      deps.getGitLabProjectFromRemote(deps.workspace) ||
      item.repo ||
      cfg.repo ||
      process.env.GITLAB_DEFAULT_PROJECT ||
      "";
    if (!projectId) {
      log.logError("No GitLab project ID — cannot find MR");
      return;
    }
    const existingMR = await deps.findExistingGitLabMR(projectId, branchName);
    if (existingMR) {
      prNumber = existingMR.iid;
      log.logConfig(
        `Found existing MR !${prNumber} for branch ${branchName}`,
      );
    } else {
      log.logError(
        `No MR found for branch ${branchName} — use --publish to create one`,
      );
      return;
    }
  } else {
    if (!ghToken || !owner || !repo) {
      log.logError("GitHub credentials required — set GITHUB_TOKEN");
      return;
    }
    // Search for an open PR from this branch
    try {
      const resp = await axios.get<Array<{ number: number }>>(
        `https://api.github.com/repos/${owner}/${repo}/pulls`,
        {
          params: { state: "open", head: `${owner}:${branchName}` },
          headers: {
            Authorization: `Bearer ${ghToken}`,
            Accept: "application/vnd.github+json",
          },
        },
      );
      const prs = resp.data;
      if (prs.length > 0) {
        prNumber = prs[0].number;
        log.logConfig(
          `Found existing PR #${prNumber} for branch ${branchName}`,
        );
      } else {
        log.logError(
          `No PR found for branch ${branchName} — use --publish to create one`,
        );
        return;
      }
    } catch (err) {
      log.logError(
        `Failed to search for PR: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }
  }

  if (!prNumber) {
    log.logError("Could not find existing PR/MR");
    return;
  }

  // Clear any stale run state and enter the review loop
  deps.clearRunState(issueKey);
  await deps.runReviewLoop(cfg, item, ghToken, owner, repo, prNumber);
}
