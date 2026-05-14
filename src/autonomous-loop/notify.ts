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
}
