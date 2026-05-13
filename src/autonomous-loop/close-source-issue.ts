/**
 * Close the originating source issue after the autonomous loop completes.
 *
 * Each platform has its own close mechanic:
 *   Jira   — post completion comment, find a Done-like transition, apply it
 *   GitLab — post an issue note, then close via stateEvent=close
 *   GitHub — post an issue comment, then close via state=closed
 *
 * All errors are non-fatal: a failure to comment or close is logged but never
 * rethrows, so the caller's flow is never interrupted.
 */

import type { JiraClient } from "../integrations/jira/jira-client";
import type { GitlabClient } from "../integrations/gitlab/gitlab-client";
import type { GithubClient } from "../integrations/github/github-client";

export interface CloseSourceIssueOptions {
  source: "jira" | "gitlab" | "github";
  /** Jira key (e.g. "IR-99"), GitLab "projectKey#iid", GitHub "owner/repo#number" */
  issueKey: string;
  mrIid?: number;
  mrUrl?: string;
  branchName?: string;
  exitCode?: number;
}

const DONE_TRANSITION_NAMES = ["done", "completed", "resolved", "closed"];

export async function closeSourceIssue(
  options: CloseSourceIssueOptions,
  jiraClient: JiraClient,
  gitlabClient: GitlabClient | null,
  githubClient: GithubClient | null,
): Promise<void> {
  const { source, issueKey, mrIid, mrUrl, branchName, exitCode } = options;

  const commentLines = [
    `✅ **Autonomous loop completed**`,
    ``,
    mrUrl ? `- MR: ${mrUrl}` : mrIid ? `- MR: !${mrIid}` : undefined,
    branchName ? `- Branch: \`${branchName}\`` : undefined,
    exitCode !== undefined ? `- Exit code: ${exitCode}` : undefined,
  ].filter((l): l is string => l !== undefined);
  const completionComment = commentLines.join("\n");

  switch (source) {
    case "jira": {
      // Post completion comment before transitioning so the audit trail is clear
      try {
        await jiraClient.addComment(issueKey, completionComment);
      } catch (err) {
        console.warn(`[closeSourceIssue] Failed to post comment on ${issueKey}:`, (err as Error).message);
      }

      try {
        const transitions = await jiraClient.getTransitions(issueKey);
        const doneTransition = transitions.find((t) =>
          DONE_TRANSITION_NAMES.some((n) => t.name.toLowerCase().includes(n)),
        );

        if (doneTransition) {
          await jiraClient.transitionIssue(issueKey, doneTransition.id);
          console.info(`[closeSourceIssue] Transitioned ${issueKey} to "${doneTransition.name}"`);
        } else {
          console.warn(
            `[closeSourceIssue] No "Done" transition found for ${issueKey}. Available: ${transitions.map((t) => t.name).join(", ")}`,
          );
        }
      } catch (err) {
        console.warn(`[closeSourceIssue] Failed to transition ${issueKey}:`, (err as Error).message);
      }
      break;
    }

    case "gitlab": {
      if (!gitlabClient) {
        console.warn("[closeSourceIssue] GitLab client not available — skipping");
        break;
      }
      // issueKey format: "projectKey#iid" e.g. "siem#42"
      const hashIdx = issueKey.lastIndexOf("#");
      const projectKey = hashIdx >= 0 ? issueKey.slice(0, hashIdx) : issueKey;
      const numericIid = hashIdx >= 0 ? parseInt(issueKey.slice(hashIdx + 1), 10) : NaN;

      if (!projectKey || isNaN(numericIid)) {
        console.warn(`[closeSourceIssue] Cannot parse GitLab issueKey "${issueKey}" — expected "projectKey#iid"`);
        break;
      }

      try {
        await gitlabClient.addIssueNote(projectKey, numericIid, completionComment);
      } catch (err) {
        console.warn(`[closeSourceIssue] Failed to add note on ${issueKey}:`, (err as Error).message);
      }

      try {
        await gitlabClient.editIssue(projectKey, numericIid, { stateEvent: "close" });
        console.info(`[closeSourceIssue] Closed GitLab issue ${issueKey}`);
      } catch (err) {
        console.warn(`[closeSourceIssue] Failed to close GitLab issue ${issueKey}:`, (err as Error).message);
      }
      break;
    }

    case "github": {
      if (!githubClient) {
        console.warn("[closeSourceIssue] GitHub client not available — skipping");
        break;
      }
      // issueKey format: "owner/repo#number" e.g. "hawkio/soc-agent#42"
      const [ownerRepo, issueNumStr] = issueKey.split("#");
      const [owner, repo] = (ownerRepo ?? "").split("/");
      const issueNumber = parseInt(issueNumStr ?? "", 10);

      if (!owner || !repo || isNaN(issueNumber)) {
        console.warn(`[closeSourceIssue] Cannot parse GitHub issueKey "${issueKey}" — expected "owner/repo#number"`);
        break;
      }

      try {
        await githubClient.addIssueComment(issueNumber, completionComment, owner, repo);
      } catch (err) {
        console.warn(`[closeSourceIssue] Failed to add comment on ${issueKey}:`, (err as Error).message);
      }

      try {
        await githubClient.updateIssue(issueNumber, { state: "closed" }, owner, repo);
        console.info(`[closeSourceIssue] Closed GitHub issue ${issueKey}`);
      } catch (err) {
        console.warn(`[closeSourceIssue] Failed to close GitHub issue ${issueKey}:`, (err as Error).message);
      }
      break;
    }
  }
}
