import type { TicketSourceType } from "../integrations/source-resolver";

export function normalizeGithubRepoConfig(params: {
  source: TicketSourceType | "auto";
  owner: string;
  repo: string;
}): { owner: string; repo: string } {
  const owner = params.owner.trim();
  const repo = params.repo.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "");
  const slash = repo.indexOf("/");
  if (slash < 0) return { owner, repo };

  const repoOwner = repo.slice(0, slash).trim();
  const repoName = repo.slice(slash + 1).trim();
  if (!repoOwner || !repoName || repoName.includes("/")) return { owner, repo };

  const shouldNormalize =
    params.source === "github" ||
    (params.source === "auto" && (!owner || owner.toLowerCase() === repoOwner.toLowerCase())) ||
    owner.toLowerCase() === repoOwner.toLowerCase();

  if (!shouldNormalize) return { owner, repo };
  return { owner: owner || repoOwner, repo: repoName };
}
