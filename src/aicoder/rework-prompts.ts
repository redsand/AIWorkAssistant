/**
 * Cross-platform rework-prompt retrieval extracted from src/aicoder.ts
 * (2026-06-25). When a reviewer marks a PR/MR as "Review Failed", they
 * also post a "Rework from PR Review" comment containing the next prompt
 * for the aicoder. These fetchers find that comment so the loop can pass
 * it back to the coding agent.
 *
 * GitHub: scan issue comments (where reviewers post the prompt) then
 * fall back to PR comments. GitLab: scan the linked Jira issue's
 * comments first when applicable, then MR notes.
 */
import axios from "axios";

const REWORK_MARKER = "Rework from PR Review";
const REVIEW_FAILED_MARKER = "Review Failed — Rework Required";

export interface GitLabReworkClient {
  listMergeRequestNotes(
    projectId: string,
    mrIid: number,
    order: "asc" | "desc",
  ): Promise<Array<{ body?: string | null; created_at?: string }>>;
}

export interface JiraReworkClient {
  isConfigured(): boolean;
  getComments(issueKey: string): Promise<
    Array<{ body?: string; created?: string }>
  >;
}

/**
 * Fetch the rework prompt for a GitHub PR. Looks at the linked issue's
 * comments first (where the reviewer normally posts it), then falls back
 * to PR comments. Returns null when no rework comment exists after
 * `sinceTimestamp`.
 */
export async function fetchReworkPrompt(
  ghToken: string,
  owner: string,
  repo: string,
  prNumber: number,
  issueNumber: number,
  sinceTimestamp?: string,
): Promise<string | null> {
  const headers = {
    Authorization: `Bearer ${ghToken}`,
    Accept: "application/vnd.github+json",
  };
  const since = sinceTimestamp ? new Date(sinceTimestamp) : null;

  try {
    const issueResp = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      { headers, params: { per_page: 20, sort: "created", direction: "desc" } },
    );
    for (const c of issueResp.data || []) {
      const body: string = c.body || "";
      const created = c.created_at ? new Date(c.created_at) : null;
      if (since && created && created < since) continue;
      if (body.includes(REWORK_MARKER)) return body;
    }
  } catch {
    // Issue comments not available
  }

  try {
    const prResp = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      { headers, params: { per_page: 20, sort: "created", direction: "desc" } },
    );
    for (const c of prResp.data || []) {
      const body: string = c.body || "";
      const created = c.created_at ? new Date(c.created_at) : null;
      if (since && created && created < since) continue;
      if (body.includes(REVIEW_FAILED_MARKER)) return body;
    }
  } catch {
    // PR comments not available
  }
  return null;
}

/**
 * Fetch the rework prompt for a GitLab MR. When the issue is a Jira
 * issue, checks Jira comments first (reviewers may post there); falls
 * back to MR notes.
 */
export async function fetchGitLabReworkPrompt(
  gitlabClient: GitLabReworkClient,
  jiraClient: JiraReworkClient,
  projectId: string,
  mrIid: number,
  sinceTimestamp?: string,
  issueKey?: string,
): Promise<string | null> {
  if (issueKey && /^[A-Z]+-\d+$/.test(issueKey) && jiraClient.isConfigured()) {
    try {
      const comments = await jiraClient.getComments(issueKey);
      const since = sinceTimestamp ? new Date(sinceTimestamp) : null;
      const newestFirst = [...comments].sort(
        (a, b) =>
          new Date(b.created || 0).getTime() - new Date(a.created || 0).getTime(),
      );
      for (const comment of newestFirst) {
        const body = comment.body || "";
        const created = comment.created ? new Date(comment.created) : null;
        if (since && created && created < since) continue;
        if (body.includes(REWORK_MARKER)) return body;
      }
    } catch {
      // Fall back to MR notes below.
    }
  }

  try {
    const notes = await gitlabClient.listMergeRequestNotes(projectId, mrIid, "desc");
    const since = sinceTimestamp ? new Date(sinceTimestamp) : null;
    for (const note of notes) {
      const body: string = note.body || "";
      const created = note.created_at ? new Date(note.created_at) : null;
      if (since && created && created < since) continue;
      if (body.includes(REWORK_MARKER)) return body;
      if (body.includes(REVIEW_FAILED_MARKER)) return body;
    }
  } catch {
    // Notes not available
  }
  return null;
}
