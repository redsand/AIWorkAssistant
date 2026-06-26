/**
 * Transition the source issue (Jira / GitLab / GitHub / internal work
 * item) to "In Progress" before the agent starts work. Extracted from
 * src/aicoder.ts (2026-06-26) so processWorkItem doesn't carry four
 * provider branches inline.
 *
 * Returns `{ alreadyDone: true }` when the issue is already
 * Done / Closed / Archived at the source — caller should skip the issue.
 * The done-already branches also do their own bookkeeping (mark
 * processed, clear failed-attempt counter) via the injected deps so the
 * caller just needs to return null.
 */
import axios from "axios";
import type { ServerConfig, WorkItem } from "../autonomous-loop/types";

export interface IssueTransitionLogger {
  logWork(message: string): void;
  logSkip(message: string): void;
}

export interface IssueTransitionJiraClient {
  isConfigured(): boolean;
  getIssue(issueKey: string): Promise<{
    fields: { status?: { name?: string } };
  }>;
  getTransitions(
    issueKey: string,
  ): Promise<Array<{ id: string; name: string }>>;
  transitionIssue(
    issueKey: string,
    transitionId: string,
    comment: string,
  ): Promise<unknown>;
}

export interface IssueTransitionGitlabClient {
  isConfigured(): boolean;
  getIssue(
    projectId: string,
    issueIid: number,
  ): Promise<{ state?: string; labels?: string | string[] } | null>;
  editIssue(
    projectId: string,
    issueIid: number,
    fields: { labels: string },
  ): Promise<unknown>;
}

export interface IssueTransitionDeps {
  logger: IssueTransitionLogger;
  workspace: string;
  jiraClient: IssueTransitionJiraClient;
  gitlabClient: IssueTransitionGitlabClient;
  getGitLabProjectFromRemote: (workspace: string) => string | null | undefined;

  authHeaders: (cfg: ServerConfig) => Record<string, string>;
  trackStep: (
    runId: string,
    kind: "note" | "tool_call" | "error",
    message: string,
    extra?: { success?: boolean },
  ) => void;
  saveProcessedIssue: (issueKey: string) => void;
  clearFailedAttempt: (issueKey: string, workspace: string) => void;
}

export async function transitionIssueToInProgress(
  deps: IssueTransitionDeps,
  cfg: ServerConfig,
  item: WorkItem,
  runId: string,
  ghToken: string | undefined,
): Promise<{ alreadyDone: boolean }> {
  const isJiraIssue = /^[A-Z]+-\d+$/.test(item.id);

  if (cfg.source === "work_items") {
    try {
      const currentResp = await axios.get<{ status: string }>(
        `${cfg.apiUrl}/api/work-items/${item.id}`,
        { headers: deps.authHeaders(cfg) },
      );
      if (currentResp.data?.status === "active") {
        deps.logger.logWork(`${item.id} already active — keeping status`);
        deps.trackStep(runId, "note", `${item.id} already active`);
      } else if (
        currentResp.data?.status === "done" ||
        currentResp.data?.status === "archived"
      ) {
        deps.logger.logSkip(`${item.id} is already Done/Archived — skipping`);
        deps.saveProcessedIssue(item.id);
        deps.clearFailedAttempt(item.id, deps.workspace);
        return { alreadyDone: true };
      } else {
        await axios.patch(
          `${cfg.apiUrl}/api/work-items/${item.id}`,
          { status: "active" },
          {
            headers: {
              ...deps.authHeaders(cfg),
              "Content-Type": "application/json",
            },
          },
        );
        deps.logger.logWork(`Updated work item ${item.id} status → active`);
        deps.trackStep(
          runId,
          "note",
          `Work item ${item.id} status set to active`,
        );
      }
    } catch (err) {
      deps.logger.logWork(
        `Could not update work item ${item.id} status: ${err instanceof Error ? err.message : err}`,
      );
      deps.trackStep(
        runId,
        "note",
        `Work item status update failed: ${err instanceof Error ? err.message : err}`,
        { success: false },
      );
    }
    return { alreadyDone: false };
  }

  if (isJiraIssue && deps.jiraClient.isConfigured()) {
    try {
      const currentIssue = await deps.jiraClient.getIssue(item.id);
      const currentStatus =
        currentIssue.fields.status?.name?.toLowerCase() ?? "";
      const isDone = /done|closed|resolved|completed/i.test(currentStatus);
      if (isDone) {
        deps.logger.logSkip(
          `${item.id} is already Done/Closed at source — skipping (use --force-reopen to override)`,
        );
        deps.saveProcessedIssue(item.id);
        deps.clearFailedAttempt(item.id, deps.workspace);
        return { alreadyDone: true };
      }
      if (currentStatus === "in progress") {
        deps.logger.logWork(
          `${item.id} already In Progress — keeping status`,
        );
        deps.trackStep(
          runId,
          "note",
          `${item.id} already In Progress on Jira`,
        );
      } else {
        const transitions = await deps.jiraClient.getTransitions(item.id);
        const inProgress = transitions.find(
          (t) =>
            t.name === "In Progress" ||
            t.name === "in progress" ||
            t.name === "Start Progress",
        );
        if (inProgress) {
          await deps.jiraClient.transitionIssue(
            item.id,
            inProgress.id,
            "AiRemoteCoder started work on this issue.",
          );
          deps.logger.logWork(`Transitioned ${item.id} → In Progress`);
          deps.trackStep(
            runId,
            "note",
            `Transitioned ${item.id} to In Progress`,
          );
        } else {
          deps.logger.logWork(
            `No "In Progress" transition available for ${item.id} (available: ${transitions.map((t) => t.name).join(", ")})`,
          );
        }
      }
    } catch (err) {
      deps.logger.logWork(
        `Could not transition ${item.id} to In Progress: ${err instanceof Error ? err.message : err}`,
      );
      deps.trackStep(
        runId,
        "note",
        `Jira transition failed: ${err instanceof Error ? err.message : err}`,
        { success: false },
      );
    }
    return { alreadyDone: false };
  }

  if (cfg.source === "gitlab" && deps.gitlabClient.isConfigured()) {
    try {
      const projectId =
        deps.getGitLabProjectFromRemote(deps.workspace) ||
        item.repo ||
        process.env.GITLAB_DEFAULT_PROJECT ||
        "";
      const issueIid = item.number;
      if (projectId && issueIid) {
        const issue = await deps.gitlabClient.getIssue(projectId, issueIid);
        if (issue?.state === "closed") {
          deps.logger.logSkip(
            `${item.id} is already Closed at source — skipping`,
          );
          deps.saveProcessedIssue(item.id);
          deps.clearFailedAttempt(item.id, deps.workspace);
          return { alreadyDone: true };
        }
        const rawLabels: string | string[] = issue?.labels || [];
        const labelArray: string[] =
          typeof rawLabels === "string"
            ? rawLabels.split(",").map((l: string) => l.trim())
            : Array.isArray(rawLabels)
              ? rawLabels.map((l) =>
                  typeof l === "string" ? l.trim() : String(l),
                )
              : [];
        if (
          labelArray.some(
            (l: string) =>
              l.toLowerCase() === "in progress" ||
              l.toLowerCase() === "doing",
          )
        ) {
          deps.logger.logWork(
            `${item.id} already has In Progress label — keeping label`,
          );
          deps.trackStep(
            runId,
            "note",
            `${item.id} already In Progress on GitLab`,
          );
        } else {
          const newLabels = [...labelArray, "In Progress"].join(",");
          await deps.gitlabClient.editIssue(projectId, issueIid, {
            labels: newLabels,
          });
          deps.logger.logWork(
            `Added "In Progress" label to GitLab issue #${issueIid}`,
          );
          deps.trackStep(
            runId,
            "note",
            `GitLab issue #${issueIid} labeled In Progress`,
          );
        }
      }
    } catch (err) {
      deps.logger.logWork(
        `Could not label GitLab issue: ${err instanceof Error ? err.message : err}`,
      );
      deps.trackStep(
        runId,
        "note",
        `GitLab label failed: ${err instanceof Error ? err.message : err}`,
        { success: false },
      );
    }
    return { alreadyDone: false };
  }

  if (cfg.source === "github" && ghToken) {
    try {
      const owner =
        cfg.owner || process.env.GITHUB_DEFAULT_OWNER || "redsand";
      const repo = cfg.repo || process.env.AICODER_REPO || "";
      if (owner && repo && item.number) {
        const headers = {
          Authorization: `Bearer ${ghToken}`,
          Accept: "application/vnd.github+json",
        };
        const issueResp = await axios.get(
          `https://api.github.com/repos/${owner}/${repo}/issues/${item.number}`,
          { headers },
        );
        if (issueResp.data?.state === "closed") {
          deps.logger.logSkip(
            `${item.id} is already Closed at source — skipping`,
          );
          deps.saveProcessedIssue(item.id);
          deps.clearFailedAttempt(item.id, deps.workspace);
          return { alreadyDone: true };
        }
        const currentLabels: string[] = (issueResp.data?.labels || []).map(
          (l: { name?: string } | string) =>
            typeof l === "string" ? l : (l.name ?? ""),
        );
        if (currentLabels.some((l: string) => l.toLowerCase() === "in progress")) {
          deps.logger.logWork(
            `${item.id} already has "In Progress" label — keeping label`,
          );
          deps.trackStep(
            runId,
            "note",
            `${item.id} already In Progress on GitHub`,
          );
        } else {
          await axios.patch(
            `https://api.github.com/repos/${owner}/${repo}/issues/${item.number}`,
            { labels: [...currentLabels, "In Progress"] },
            { headers },
          );
          deps.logger.logWork(
            `Added "In Progress" label to GitHub issue #${item.number}`,
          );
          deps.trackStep(
            runId,
            "note",
            `GitHub issue #${item.number} labeled In Progress`,
          );
        }
      }
    } catch (err) {
      deps.logger.logWork(
        `Could not label GitHub issue: ${err instanceof Error ? err.message : err}`,
      );
      deps.trackStep(
        runId,
        "note",
        `GitHub label failed: ${err instanceof Error ? err.message : err}`,
        { success: false },
      );
    }
  }

  return { alreadyDone: false };
}
