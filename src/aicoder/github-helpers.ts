/**
 * GitHub REST API helpers extracted from src/aicoder.ts (2026-06-25).
 *
 * These don't go through the central github-client because they were
 * written before that client existed; eventually they could be migrated
 * there, but extracting them as-is keeps this split mechanical and
 * verifiable. The `axios` calls are intentionally direct so a future
 * client migration is a single-file change.
 */
import axios from "axios";
import type { ServerConfig, WorkItem } from "../autonomous-loop/types";

export interface GitHubHelpersLogger {
  logError(message: string): void;
}

/** Best-effort fetch of an issue's body. Empty string on any failure. */
export async function fetchIssueBody(
  ghToken: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<string> {
  const resp = await axios
    .get(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
      {
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: "application/vnd.github+json",
        },
      },
    )
    .catch(() => null);
  return resp?.data?.body || "";
}

/**
 * Locate the PR that closes a given issue. Scans open then closed PRs
 * (most-recent-first) looking for a body containing `closes #N`,
 * `fixes #N`, or `resolves #N`. Returns null when no such PR exists.
 */
export async function findPRForIssue(
  ghToken: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<{ prNumber: number; branch: string; merged: boolean } | null> {
  const headers = {
    Authorization: `Bearer ${ghToken}`,
    Accept: "application/vnd.github+json",
  };
  for (const state of ["open", "closed"]) {
    try {
      const resp = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/pulls`,
        {
          headers,
          params: { state, per_page: 100, sort: "updated", direction: "desc" },
        },
      );
      for (const pr of resp.data || []) {
        const body: string = pr.body || "";
        if (
          body.match(
            new RegExp(`(?:closes|fixes|resolves)\\s+#${issueNumber}\\b`, "i"),
          )
        ) {
          return {
            prNumber: pr.number,
            branch: pr.head?.ref,
            merged: !!pr.merged_at,
          };
        }
      }
    } catch {
      // Continue to next state
    }
  }
  return null;
}

/**
 * Fetch a GitHub issue by number and shape into a WorkItem. Returns null
 * when GITHUB_TOKEN is missing, the issue doesn't exist, or the request
 * fails. Logger is used to surface the missing-token case to operators.
 */
export async function fetchIssueDirectly(
  logger: GitHubHelpersLogger,
  cfg: ServerConfig,
  issueNumber: number,
): Promise<WorkItem | null> {
  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) {
    logger.logError("GITHUB_TOKEN required to fetch issue by number");
    return null;
  }
  const owner = cfg.owner || "redsand";
  const repo = cfg.repo || "AIWorkAssistant";
  const resp = await axios
    .get(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
      {
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: "application/vnd.github+json",
        },
      },
    )
    .catch(() => null);

  if (!resp || !resp.data?.title) return null;

  const slug = resp.data.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return {
    id: String(issueNumber),
    number: issueNumber,
    title: resp.data.title,
    url: resp.data.html_url || "",
    owner,
    repo,
    suggestedBranch: `ai/issue-${issueNumber}-${slug}`,
    labels: (resp.data.labels || []).map((l: any) =>
      typeof l === "string" ? l : l.name,
    ),
  };
}
