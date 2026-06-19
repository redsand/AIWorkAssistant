/**
 * Source updater — writes the rewritten ticket back to GitHub, GitLab, or
 * Jira and posts an audit comment.
 *
 * Abstracts over the three clients so the orchestrator only deals with a
 * single Source enum. Each platform's quirks:
 *   - GitHub: numeric issue number under owner/repo. updateIssue PATCH body.
 *   - GitLab: numeric IID under projectId. editIssue PUT description.
 *   - Jira:   string key (e.g. IR-82). updateIssue with description field.
 *
 * The audit comment always carries the [autorepair-v1] tag so a future run
 * can detect that this ticket has already been autorepaired (and avoid
 * double-rewriting).
 */

import { githubClient } from "../../integrations/github/github-client";
import { gitlabClient } from "../../integrations/gitlab/gitlab-client";
import { jiraClient } from "../../integrations/jira/jira-client";

export type Source = "github" | "gitlab" | "jira";

export interface TicketIdentifier {
  source: Source;
  /** GitHub: numeric issue number. GitLab: numeric IID. Jira: string key. */
  id: number | string;
  /** GitHub: owner/repo. GitLab: projectId. Jira: not needed. */
  owner?: string;
  repo?: string;
  projectId?: number | string;
}

export interface FetchedTicket {
  title: string;
  body: string;
  /** Platform-specific labels in their native form (string for Jira/GitLab, array for GitHub). */
  labels?: string[];
}

export interface SourceUpdateResult {
  /** Comment URL or id, when the platform returns one. */
  commentRef?: string;
  /** Was the ticket body updated? */
  bodyUpdated: boolean;
  /** Was the audit comment posted? */
  commentPosted: boolean;
}

export async function fetchTicket(t: TicketIdentifier): Promise<FetchedTicket> {
  if (t.source === "github") {
    const issue = await githubClient.getIssue(
      Number(t.id),
      t.owner,
      t.repo,
    );
    return {
      title: String(issue.title ?? ""),
      body: String(issue.body ?? ""),
      labels: Array.isArray(issue.labels)
        ? (issue.labels as Array<{ name?: string } | string>).map((l) =>
            typeof l === "string" ? l : String(l.name ?? ""),
          )
        : undefined,
    };
  }
  if (t.source === "gitlab") {
    const issue = await gitlabClient.getIssue(t.projectId, Number(t.id));
    return {
      title: String(issue.title ?? ""),
      body: String(issue.description ?? ""),
      labels: Array.isArray(issue.labels) ? issue.labels.map(String) : undefined,
    };
  }
  // jira
  const issue = await jiraClient.getIssue(String(t.id));
  const fields = (issue as { fields?: Record<string, unknown> })?.fields ?? {};
  return {
    title: String(fields.summary ?? ""),
    body: String(fields.description ?? ""),
    labels: Array.isArray(fields.labels)
      ? (fields.labels as unknown[]).map(String)
      : undefined,
  };
}

export async function updateTicketBody(
  t: TicketIdentifier,
  body: string,
  title?: string,
): Promise<void> {
  if (t.source === "github") {
    await githubClient.updateIssue(
      Number(t.id),
      { body, ...(title ? { title } : {}) },
      t.owner,
      t.repo,
    );
    return;
  }
  if (t.source === "gitlab") {
    await gitlabClient.editIssue(t.projectId, Number(t.id), {
      description: body,
      ...(title ? { title } : {}),
    });
    return;
  }
  // jira
  await jiraClient.updateIssue(String(t.id), {
    description: body,
    ...(title ? { summary: title } : {}),
  });
}

export async function postAuditComment(
  t: TicketIdentifier,
  comment: string,
): Promise<string | undefined> {
  if (t.source === "github") {
    const result = await githubClient.addIssueComment(
      Number(t.id),
      comment,
      t.owner,
      t.repo,
    );
    return result?.html_url ?? result?.url ?? undefined;
  }
  if (t.source === "gitlab") {
    await gitlabClient.addIssueNote(t.projectId, Number(t.id), comment);
    return undefined;
  }
  // jira
  const result = await jiraClient.addComment(String(t.id), comment);
  return (result as { id?: string })?.id;
}

/**
 * One-shot publish: post audit comment first (so even if updateIssue fails,
 * a human can see WHAT we tried) then update the body.
 */
export async function publishRepair(
  t: TicketIdentifier,
  opts: {
    newBody: string;
    newTitle?: string;
    auditComment: string;
  },
): Promise<SourceUpdateResult> {
  let commentRef: string | undefined;
  let commentPosted = false;
  let bodyUpdated = false;
  try {
    commentRef = await postAuditComment(t, opts.auditComment);
    commentPosted = true;
  } catch (err) {
    console.warn(
      `[autorepair] failed to post audit comment to ${t.source}:${t.id} — continuing with body update.`,
      err instanceof Error ? err.message : err,
    );
  }
  await updateTicketBody(t, opts.newBody, opts.newTitle);
  bodyUpdated = true;
  return { commentRef, bodyUpdated, commentPosted };
}
