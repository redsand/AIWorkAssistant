/**
 * Pipeline completion notifications.
 *
 * Posts completion events to the AIWorkAssistant server so Jira/GitHub
 * statuses are updated after a PR is created.  Errors are non-fatal —
 * notification failure never blocks the pipeline.
 */

import axios from "axios";
import type { ServerConfig, WorkItem, PipelineLogger } from "./types";
import { detectRemotePlatform } from "./pr-creator";
import { closeSourceIssue } from "./close-source-issue";
import { jiraClient } from "../integrations/jira/jira-client";
import { gitlabClient } from "../integrations/gitlab/gitlab-client";
import { githubClient } from "../integrations/github/github-client";

const noop: PipelineLogger = {
  logGit: () => {},
  logError: () => {},
  logConfig: () => {},
  logWork: () => {},
  logAgent: () => {},
};

export function authHeaders(cfg: ServerConfig): Record<string, string> {
  return { Authorization: `Bearer ${cfg.apiKey}` };
}

export async function notifyComplete(
  cfg: ServerConfig,
  item: WorkItem,
  prNumber: number,
  branchName: string,
  exitCode: number | null,
  workspace: string,
  _logger: PipelineLogger = noop,
): Promise<void> {
  const platform = detectRemotePlatform(workspace);

  if (cfg.source === "jira" && platform === "gitlab") {
    try {
      await axios.post(
        `${cfg.apiUrl}/api/autonomous-loop/complete/jira`,
        {
          issueKey: item.id || String(item.number),
          branchName,
          mrIid: prNumber,
          agentExitCode: exitCode,
        },
        { headers: authHeaders(cfg) },
      );
    } catch {
      // non-fatal
    }

    // Close the Jira issue directly from the pipeline process as well,
    // so the ticket transitions to Done even when the server route cannot.
    try {
      await closeSourceIssue(
        {
          source: "jira",
          issueKey: item.id || String(item.number),
          mrIid: prNumber,
          branchName,
          exitCode: exitCode ?? undefined,
        },
        jiraClient,
        gitlabClient.isConfigured() ? gitlabClient : null,
        null,
      );
    } catch {
      // non-fatal
    }
    return;
  }

  try {
    await axios.post(
      `${cfg.apiUrl}/api/autonomous-loop/complete`,
      {
        owner: item.owner || cfg.owner,
        repo: item.repo || cfg.repo,
        issueNumber: item.number,
        prNumber,
        branchName,
        agentExitCode: exitCode,
      },
      { headers: authHeaders(cfg) },
    );
  } catch {
    // non-fatal
  }

  // Close the GitHub issue directly from the pipeline process.
  if (cfg.source === "github") {
    const owner = item.owner || cfg.owner;
    const repo = item.repo || cfg.repo;
    try {
      await closeSourceIssue(
        {
          source: "github",
          issueKey: `${owner}/${repo}#${item.number}`,
          mrIid: prNumber,
          branchName,
          exitCode: exitCode ?? undefined,
        },
        jiraClient,
        null,
        githubClient,
      );
    } catch {
      // non-fatal
    }
  }
}
