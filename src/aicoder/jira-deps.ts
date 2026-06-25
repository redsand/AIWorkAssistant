/**
 * Jira-side helpers that need to talk to the API (not pure transforms).
 * Extracted from src/aicoder.ts (2026-06-25) as part of the staged split.
 *
 * The Jira client + logger are injected so callers in tests can supply
 * mocks. aicoder.ts wires both to its singletons.
 */
import type { WorkItem } from "../autonomous-loop/types";
import { isDoneStatus } from "./jira-helpers";

export interface JiraClientLike {
  isConfigured(): boolean;
  getIssue(key: string): Promise<{
    key?: string;
    fields: {
      summary?: string;
      status?: { name?: string };
      labels?: unknown[];
      [key: string]: unknown;
    };
  }>;
}

export interface JiraDepsLogger {
  logError(message: string): void;
}

/**
 * For each `issueKey`, check whether the issue is in a done-ish state and
 * return human-readable strings for any that are NOT done. Used as a
 * dependency gate before starting work on an issue that depends on others.
 *
 * Network or auth errors are caught per-issue and surfaced as
 * "could not verify" entries — the caller can decide whether to skip or
 * proceed.
 */
export async function getUnresolvedJiraDependencies(
  client: JiraClientLike,
  issueKeys: string[],
): Promise<string[]> {
  const unresolved: string[] = [];
  for (const issueKey of issueKeys) {
    try {
      const depIssue = await client.getIssue(issueKey);
      const status = depIssue.fields.status?.name ?? "";
      if (!isDoneStatus(status)) {
        unresolved.push(`${issueKey} (${status || "unknown status"})`);
      }
    } catch (err) {
      unresolved.push(
        `${issueKey} (${err instanceof Error ? err.message : "could not verify status"})`,
      );
    }
  }
  return unresolved;
}

/**
 * Fetch a Jira issue by key and shape it into a `WorkItem`. Returns null
 * (and logs an error) when the client isn't configured or the fetch fails.
 * The labels field is normalized to a string[] regardless of whether the
 * API returned strings or {name} objects.
 */
export async function fetchJiraIssueDirectly(
  client: JiraClientLike,
  logger: JiraDepsLogger,
  key: string,
): Promise<WorkItem | null> {
  if (!client.isConfigured()) {
    logger.logError(
      "Jira client not configured — set JIRA_* env vars for Jira issue lookups",
    );
    return null;
  }
  try {
    const issue = await client.getIssue(key);
    const fields = issue.fields as typeof issue.fields & { labels?: unknown[] };
    const slug = (fields?.summary ?? issue.key ?? key)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "");
    return {
      id: key,
      number: parseInt(key.replace(/^[A-Z]+-/, ""), 10) || 0,
      title: fields?.summary ?? key,
      url: `${process.env.JIRA_BASE_URL ?? "https://hawksolutionstech.atlassian.net"}/browse/${key}`,
      owner: "",
      repo: "",
      suggestedBranch: `ai/issue-${key.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${slug}`,
      labels: (fields?.labels ?? []).map((l) =>
        typeof l === "string" ? l : (l as { name?: string })?.name ?? "",
      ).filter(Boolean) as string[],
    };
  } catch (err) {
    logger.logError(
      `Failed to fetch Jira issue ${key}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}
