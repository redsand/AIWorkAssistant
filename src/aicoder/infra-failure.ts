/**
 * Escalation helper for "the coding agent couldn't even start" failures.
 * Extracted from src/aicoder.ts (2026-06-25).
 *
 * When this fires, we mark the issue as processed (so the polling loop
 * doesn't immediately try it again), record it in `blocked` so the
 * current process won't pick it up either, and post a Jira comment so
 * a human knows the agent is wedged. Stderr is bounded to the last 2KB
 * so a runaway agent can't dump megabytes into Jira.
 */

export interface InfraFailureJiraClient {
  isConfigured(): boolean;
  addComment(issueKey: string, body: string): Promise<unknown>;
}

export interface InfraFailureCallbacks {
  /** Set so the current process refuses to retry the issue. */
  markBlocked: (issueKey: string) => void;
  /** Persist the "processed" state so other processes also skip. */
  markProcessed: (issueKey: string) => void;
}

export async function escalateAgentInfrastructureFailure(
  jiraClient: InfraFailureJiraClient,
  callbacks: InfraFailureCallbacks,
  issueKey: string,
  stderr: string | undefined,
): Promise<void> {
  const details = stderr?.slice(-2000) || "Agent failed before producing output.";
  const body = [
    "## Agent Infrastructure Failure",
    "",
    `The coding agent failed before implementation could run. Aicoder is stopping retries for ${issueKey} in this process instead of looping on the same ticket.`,
    "",
    "```text",
    details,
    "```",
  ].join("\n");

  callbacks.markBlocked(issueKey);
  callbacks.markProcessed(issueKey);

  if (jiraClient.isConfigured()) {
    try {
      await jiraClient.addComment(issueKey, body);
    } catch {
      // Best-effort — Jira may be down, but we've still blocked locally.
    }
  }
}
