/**
 * Cross-platform review-result polling extracted from src/aicoder.ts
 * (2026-06-25). The pollers loop until they observe one of the review
 * markers in a PR/MR comment, or detect a merge/close/conflict via the
 * platform API itself.
 *
 * Marker constants are duplicated here (rather than imported from
 * aicoder.ts) so this module has no back-reference and can be tested in
 * isolation. They MUST stay in sync with the values aicoder.ts uses
 * when emitting reviews — there's a future improvement to move the
 * constants into a shared module both sides import.
 */
import axios from "axios";

export const REVIEW_PASSED_MARKER = "Review Passed";
export const REVIEW_FAILED_MARKER = "Review Failed — Rework Required";
export const REVIEW_POSTPONED_MARKER = "Review Postponed — Service Unavailable";
export const REVIEW_MERGE_CONFLICT_MARKER = "Merge Failed — Conflict Requires Rebase";
export const REVIEW_HUMAN_REVIEW_MARKER = "Review Requires Human — Ready for Human Review";

export type ReviewOutcome =
  | "passed"
  | "failed"
  | "postponed"
  | "merged"
  | "conflict"
  | "closed"
  | "human_review";

export interface GitLabReviewPollClient {
  getMergeRequest(projectId: string, mrIid: number): Promise<{ state?: string }>;
  listMergeRequestNotes(
    projectId: string,
    mrIid: number,
    order: "asc" | "desc",
  ): Promise<Array<{
    body?: string | null;
    created_at?: string;
    author?: { username?: string };
  }>>;
  getMergeRequestStatus(projectId: string, mrIid: number): Promise<{
    conflicts?: boolean;
    mergeStatus?: string;
  }>;
}

function humanReviewCommentHasActionableFindings(body: string): boolean {
  return (
    /\b(src|tests|scripts|web|server)\/[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|json|md)\b/i.test(body) ||
    /\b[\w.-]+\.(ts|tsx|js|jsx|mjs|cjs|py|json|md):\d+\b/i.test(body) ||
    /\b(findings?|must fix|blocking|bug|security|test gap|fix):/i.test(body) ||
    body.includes("### Findings") ||
    body.includes("Findings (must fix)")
  );
}

/**
 * Poll a GitHub PR for one of the review-marker comments. Resolves when
 * any terminal state is reached (merged, closed, passed, failed, etc.).
 * `sinceIso` filters out comments older than the last push so a previous
 * review cycle doesn't re-trigger us.
 */
export async function pollForReviewResult(
  ghToken: string,
  owner: string,
  repo: string,
  prNumber: number,
  pollMs: number,
  sinceIso?: string,
): Promise<ReviewOutcome> {
  const headers = {
    Authorization: `Bearer ${ghToken}`,
    Accept: "application/vnd.github+json",
  };
  const since = sinceIso ? new Date(sinceIso) : null;
  // Bare axios calls have no default timeout — a stalled TCP connection
  // (observed live: an ESTABLISHED-but-silent socket to GitHub) hangs the
  // promise forever with no error, no log, and no recovery, wedging the
  // whole review-polling loop indefinitely. Every other HTTP client in
  // this codebase sets a timeout; this one didn't.
  const REQUEST_TIMEOUT_MS = 30_000;
  while (true) {
    try {
      const prResp = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
        { headers, timeout: REQUEST_TIMEOUT_MS },
      );
      const pr = prResp.data;
      if (pr.merged_at) return "merged";
      if (pr.state === "closed") return "closed";
      if (pr.mergeable === false && pr.mergeable_state === "dirty") return "conflict";
    } catch {
      // PR might not exist yet, or request timed out — retry next cycle
    }

    try {
      // GitHub's per-issue comments endpoint
      // (/repos/{owner}/{repo}/issues/{n}/comments) does NOT support the
      // `sort`/`direction` query params — those only apply to the
      // repo-wide comments endpoint. This endpoint always returns
      // comments in ascending (oldest-first) order regardless of what's
      // passed. Passing per_page:10 here silently truncated to the 10
      // OLDEST comments, so once a PR/issue accumulated more than 10
      // comments the newest ones — including the terminal review-marker
      // comment the whole loop is waiting on — were never fetched,
      // wedging review_polling forever with no error and no log.
      // Fetch a generous page and sort client-side instead of trusting
      // server-side params that don't apply to this endpoint.
      const commentsResp = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
        {
          headers,
          params: { per_page: 100 },
          timeout: REQUEST_TIMEOUT_MS,
        },
      );
      const comments = [...(commentsResp.data || [])].sort(
        (a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime(),
      );
      for (const c of comments) {
        if (since && c.created_at && new Date(c.created_at) < since) continue;
        const body: string = c.body || "";
        if (body.includes(REVIEW_PASSED_MARKER)) return "passed";
        if (body.includes(REVIEW_FAILED_MARKER)) return "failed";
        if (body.includes(REVIEW_POSTPONED_MARKER)) return "postponed";
        if (body.includes(REVIEW_MERGE_CONFLICT_MARKER)) return "conflict";
        if (body.includes(REVIEW_HUMAN_REVIEW_MARKER)) {
          return humanReviewCommentHasActionableFindings(body) ? "failed" : "human_review";
        }
      }
    } catch {
      // Comments might not be available, or request timed out — retry next cycle
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * GitLab MR equivalent. Only consults merge-conflict status after a
 * reviewer has commented — GitLab routinely returns "cannot_be_merged"
 * on freshly-created MRs before its own background check completes.
 */
export async function pollForGitLabReviewResult(
  client: GitLabReviewPollClient,
  projectId: string,
  mrIid: number,
  pollMs: number,
  sinceIso?: string,
): Promise<ReviewOutcome> {
  while (true) {
    try {
      const mr = await client.getMergeRequest(projectId, mrIid);
      if (mr.state === "merged") return "merged";
      if (mr.state === "closed") return "closed";
    } catch {
      // MR might not be accessible
    }

    let hasReviewNote = false;
    try {
      const notes = await client.listMergeRequestNotes(projectId, mrIid, "desc");
      for (const note of notes) {
        if (sinceIso && note.created_at && new Date(note.created_at) < new Date(sinceIso)) continue;
        const body: string = note.body || "";
        if (body.includes(REVIEW_PASSED_MARKER)) return "passed";
        if (body.includes(REVIEW_FAILED_MARKER)) return "failed";
        if (body.includes(REVIEW_POSTPONED_MARKER)) return "postponed";
        if (body.includes(REVIEW_MERGE_CONFLICT_MARKER)) return "conflict";
        if (body.includes(REVIEW_HUMAN_REVIEW_MARKER)) {
          return humanReviewCommentHasActionableFindings(body) ? "failed" : "human_review";
        }
        if (
          note.author?.username !== "aicoder" &&
          note.author?.username !== "AiRemoteCoder"
        ) {
          hasReviewNote = true;
        }
      }
    } catch {
      // Notes might not be available
    }

    if (hasReviewNote) {
      try {
        const status = await client.getMergeRequestStatus(projectId, mrIid);
        if (status.conflicts || status.mergeStatus === "cannot_be_merged") return "conflict";
      } catch {
        // Status check failed — continue polling
      }
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}
