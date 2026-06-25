/**
 * Git clone authentication helpers for the runner system.
 *
 * Two strategies, used in order of preference:
 *
 *   1. findLocalCloneForRemote — scan a search root for an existing local
 *      clone whose `origin` matches the target remote. If found, the runner
 *      can `git worktree add` from it (no network, no auth — git treats it
 *      as a local operation, same trick as the kanban worktree feature).
 *
 *   2. injectGitCredentials — falls back to a fresh `git clone` and rewrites
 *      ssh-style URLs to https + embeds the env-provided GITHUB_TOKEN or
 *      GITLAB_TOKEN. Matches the pattern used in autonomous-loop/git-ops.ts
 *      `ensureOriginRemote` so credentials live in one place.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Normalize a remote URL so SSH and HTTPS variants of the same repo compare
 * equal. Strips scheme, user, .git suffix, trailing slashes, lowercases the
 * whole thing. Not cryptographic — just enough to spot a match.
 */
export function normalizeRemoteUrl(url: string): string {
  return url
    .trim()
    .replace(/^git@([^:]+):/i, "$1/")           // git@host:path → host/path
    .replace(/^ssh:\/\/(?:[^@/]+@)?/i, "")      // ssh://user@host/path → host/path
    .replace(/^https?:\/\/(?:[^@/]+@)?/i, "")   // https://user:pass@host/path → host/path
    .replace(/\.git\/?$/i, "")                  // drop .git suffix
    .replace(/\/$/, "")                         // drop trailing slash
    .toLowerCase();
}

/**
 * Convert a git@host:path-style URL to https://host/path. No-op for URLs
 * that are already http(s). Used before credential injection because the
 * env tokens authenticate over HTTPS, not SSH.
 */
export function toHttpsUrl(url: string): string {
  const sshMatch = url.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2]}`;
  }
  const sshSchemeMatch = url.match(/^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);
  if (sshSchemeMatch) {
    return `https://${sshSchemeMatch[1]}/${sshSchemeMatch[2]}`;
  }
  return url;
}

/**
 * Embed env-provided credentials into an HTTPS URL. Returns the original URL
 * unchanged if no matching token is available — caller can still attempt the
 * clone (might succeed via git credential helper or public access).
 *
 *   github.com / *.github.* → https://x-access-token:GITHUB_TOKEN@host/path
 *   GITLAB_BASE_URL host / *gitlab* → https://oauth2:GITLAB_TOKEN@host/path
 *
 * Caller is responsible for keeping the credentialed URL out of logs.
 */
export function injectGitCredentials(url: string): string {
  const httpsUrl = toHttpsUrl(url);
  const match = httpsUrl.match(/^(https?:)\/\/(?:[^@/]+@)?([^/]+)(\/.+)$/i);
  if (!match) return httpsUrl;
  const [, scheme, host, rest] = match;
  const hostLower = host.toLowerCase();

  // GitHub: token uses x-access-token user; works for github.com + Enterprise.
  if (hostLower === "github.com" || hostLower.endsWith(".github.com")) {
    const token = process.env.GITHUB_TOKEN;
    if (token) return `${scheme}//x-access-token:${token}@${host}${rest}`;
  }

  // GitLab: oauth2 user with PAT. Match by configured base url or generic.
  const gitlabBase = (process.env.GITLAB_BASE_URL || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
    .toLowerCase();
  const looksLikeGitlab =
    (gitlabBase && hostLower === gitlabBase) || /gitlab/.test(hostLower);
  if (looksLikeGitlab) {
    const token = process.env.GITLAB_TOKEN;
    if (token) return `${scheme}//oauth2:${token}@${host}${rest}`;
  }

  return httpsUrl;
}

/**
 * Strip credentials from a URL for safe logging. Never log the output of
 * injectGitCredentials directly — pipe it through this first.
 */
export function redactCredentials(url: string): string {
  return url.replace(/^(\w+:\/\/)[^@/]+@/, "$1<redacted>@");
}

/**
 * Scan a directory for a local clone whose `origin` matches the given
 * remote URL. Best-effort: only one level deep (sibling directories of the
 * worktree root). Skips dotfile directories and anything that doesn't have
 * a `.git` entry.
 *
 * Returns absolute path of the matching repo, or null if none found.
 */
export function findLocalCloneForRemote(
  remoteUrl: string,
  searchRoot: string,
): string | null {
  if (!remoteUrl) return null;
  if (!fs.existsSync(searchRoot)) return null;
  const target = normalizeRemoteUrl(remoteUrl);
  if (!target) return null;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(searchRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const repoDir = path.join(searchRoot, entry.name);
    const gitEntry = path.join(repoDir, ".git");
    if (!fs.existsSync(gitEntry)) continue;
    const result = spawnSync(
      "git",
      ["-C", repoDir, "config", "--get", "remote.origin.url"],
      { encoding: "utf8", stdio: "pipe" },
    );
    if (result.status !== 0) continue;
    const originUrl = result.stdout.trim();
    if (!originUrl) continue;
    if (normalizeRemoteUrl(originUrl) === target) {
      return path.resolve(repoDir);
    }
  }
  return null;
}
