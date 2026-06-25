/**
 * GitLab helpers extracted from src/aicoder.ts (2026-06-25). Mirrors the
 * shape of github-helpers.ts but uses the project's gitlab-client.
 *
 * `findMRForIssue` scans MRs (opened/closed/merged) for a description
 * referencing `closes #N` / `fixes #N` / `resolves #N`.
 */

export interface GitLabClientLike {
  isConfigured(): boolean;
  getMergeRequests(
    projectId: string,
    state: "opened" | "closed" | "merged",
  ): Promise<Array<{
    iid: number;
    description?: string | null;
    source_branch?: string;
    state?: string;
  }>>;
}

/**
 * Locate the MR that closes a given GitLab issue. Returns null when the
 * client isn't configured, when no MR has a matching close keyword, or
 * when all requests fail.
 */
export async function findMRForIssue(
  client: GitLabClientLike,
  projectId: string,
  issueNumber: number,
): Promise<{ mrIid: number; branch: string; merged: boolean } | null> {
  if (!client.isConfigured()) return null;
  for (const state of ["opened", "closed", "merged"] as const) {
    try {
      const mrs = await client.getMergeRequests(projectId, state);
      for (const mr of mrs || []) {
        const desc: string = mr.description || "";
        if (
          desc.match(
            new RegExp(
              `(?:closes|fixes|resolves)\\s+#${issueNumber}\\b`,
              "i",
            ),
          )
        ) {
          return {
            mrIid: mr.iid,
            branch: mr.source_branch || "",
            merged: mr.state === "merged",
          };
        }
      }
    } catch {
      // Continue to next state
    }
  }
  return null;
}
