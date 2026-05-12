#!/usr/bin/env tsx
import "dotenv/config";
import { execSync } from "child_process";
import axios from "axios";
import { gitlabClient } from "./integrations/gitlab/gitlab-client";
import { jiraClient } from "./integrations/jira/jira-client";

// ── ANSI color helpers ──────────────────────────────────────────────────────
const useColor = process.stdout.isTTY && process.env.NO_COLOR !== "1";
const C = {
  reset: useColor ? "\x1b[0m" : "",
  bold: useColor ? "\x1b[1m" : "",
  dim: useColor ? "\x1b[2m" : "",
  red: useColor ? "\x1b[31m" : "",
  green: useColor ? "\x1b[32m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  blue: useColor ? "\x1b[34m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  gray: useColor ? "\x1b[90m" : "",
};

const log = {
  start: (msg: string) => console.log(`${C.cyan}${C.bold}[START]${C.reset} ${msg}`),
  config: (msg: string) => console.log(`${C.blue}[CONFIG]${C.reset} ${msg}`),
  poll: (msg: string) => console.log(`${C.cyan}[POLL]${C.reset} ${msg}`),
  review: (msg: string) => console.log(`${C.yellow}${C.bold}[REVIEW]${C.reset} ${msg}`),
  sha: (msg: string) => console.log(`${C.gray}[SHA]${C.reset} ${msg}`),
  finding: (msg: string) => console.log(`${C.red}  ✗ ${msg}${C.reset}`),
  clean: (msg: string) => console.log(`${C.green}  ✓ ${msg}${C.reset}`),
  merge: (msg: string) => console.log(`${C.green}${C.bold}[MERGE]${C.reset} ${msg}`),
  rework: (msg: string) => console.log(`${C.yellow}${C.bold}[REWORK]${C.reset} ${msg}`),
  skip: (msg: string) => console.log(`${C.dim}[SKIP]${C.reset} ${msg}`),
  error: (msg: string) => console.error(`${C.red}${C.bold}[ERROR]${C.reset} ${msg}`),
  warn: (msg: string) => console.log(`${C.yellow}[WARN]${C.reset} ${msg}`),
  jira: (msg: string) => console.log(`${C.blue}[JIRA]${C.reset} ${msg}`),
  gitlab: (msg: string) => console.log(`${C.cyan}[GitLab]${C.reset} ${msg}`),
  step: (msg: string) => console.log(`${C.dim}  → ${msg}${C.reset}`),
};

// Review result markers (must match aicoder.ts markers)
const REVIEW_MERGE_CONFLICT_MARKER = "Merge Failed — Conflict Requires Rebase";

function parseArgv(): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(`
reviewer — AIWorkAssistant autonomous PR/MR review agent

Usage: reviewer [options]

Options:
  --source <type>        Source platform: github | gitlab (default: github)
  --repo <name>         Comma-separated repos/projects to watch (overrides REVIEW_REPOS)
  --owner <name>        GitHub owner (overrides GITHUB_DEFAULT_OWNER)
  --gitlab-project <id> GitLab project path or ID (overrides GITLAB_DEFAULT_PROJECT)
  --poll-ms <ms>        Poll interval in milliseconds (default: 30000)
  --help                 Show this help

Remote config (fetches everything else from AIWorkAssistant):
  AIWORKASSISTANT_URL      Base URL of the server (default: http://localhost:3050)
  AIWORKASSISTANT_API_KEY  API key for authentication (required)

Local config (.env):
  GITHUB_TOKEN              GitHub personal access token
  GITHUB_DEFAULT_OWNER      Default repo owner
  REVIEW_REPOS              Comma-separated repo names to watch
  REVIEW_SOURCE             Source platform: github | gitlab (default: github)
  REVIEW_POLL_INTERVAL_MS   Poll interval (default: 30000)
  SECURITY_AGENT_CMD        External security review command
  QA_AGENT_CMD              External QA review command
  QUALITY_AGENT_CMD         External code quality command

GitLab-specific:
  GITLAB_DEFAULT_PROJECT    GitLab project path (e.g. siem/octorepl)
  GITLAB_TOKEN              GitLab personal access token

Jira (for re-linking review failures):
  JIRA_BASE_URL             Jira instance URL
  JIRA_EMAIL                Jira user email
  JIRA_API_TOKEN            Jira API token
`);
      process.exit(0);
    }
    if (argv[i].startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

const ARGV = parseArgv();

type SourceType = "github" | "gitlab";

interface RepoTarget {
  name: string;
  source: SourceType;
  gitlabProject?: string; // for gitlab targets, the project path
}

interface ReviewerConfig {
  source: SourceType;
  githubToken: string;
  owner: string;
  reviewRepos: string[];
  pollIntervalMs: number;
  securityAgentCmd: string;
  qaAgentCmd: string;
  qualityAgentCmd: string;
  gitlabProject: string;
}

/** Parse repo entries like "github:AIWorkAssistant" or "gitlab:siem/octorepl" or plain "my-repo" */
function parseRepoTargets(
  repos: string[],
  defaultSource: SourceType,
  defaultGitlabProject: string,
): RepoTarget[] {
  return repos.map((entry) => {
    const trimmed = entry.trim();
    if (trimmed.startsWith("github:")) {
      return { name: trimmed.slice(7), source: "github" as SourceType };
    }
    if (trimmed.startsWith("gitlab:")) {
      return { name: trimmed.slice(7), source: "gitlab" as SourceType, gitlabProject: trimmed.slice(7) };
    }
    // Unprefixed: use default source
    if (defaultSource === "gitlab") {
      return { name: trimmed, source: "gitlab" as SourceType, gitlabProject: defaultGitlabProject || trimmed };
    }
    return { name: trimmed, source: defaultSource };
  });
}

interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  category: "security" | "qa" | "quality";
  file: string;
  line?: number;
  message: string;
  suggestion: string;
}

interface ReviewResult {
  clean: boolean;
  findings: ReviewFinding[];
  summary: string;
  agentStatus?: Record<string, "passed" | "failed">;
  serviceUnavailable?: boolean;
}

async function loadConfig(): Promise<ReviewerConfig> {
  const remoteUrl = (process.env.AIWORKASSISTANT_URL || "http://localhost:3050").replace(/\/$/, "");
  const remoteKey = process.env.AIWORKASSISTANT_API_KEY;

  if (remoteKey) {
    log.config(`Fetching reviewer config from ${remoteUrl}`);
    const response = await axios.get<ReviewerConfig>(
      `${remoteUrl}/api/reviewer/config`,
      { headers: { Authorization: `Bearer ${remoteKey}` } },
    );
    const cfg = response.data;
    if (ARGV.repo) cfg.reviewRepos = ARGV.repo.split(",").filter(Boolean);
    if (ARGV.owner) cfg.owner = ARGV.owner;
    if (ARGV["poll-ms"]) cfg.pollIntervalMs = parseInt(ARGV["poll-ms"], 10);
    cfg.source = (ARGV.source || process.env.REVIEW_SOURCE || cfg.source || "github") as SourceType;
    cfg.gitlabProject = ARGV["gitlab-project"] || process.env.GITLAB_DEFAULT_PROJECT || cfg.gitlabProject || "";
    log.config(`Remote config loaded (source: ${cfg.source}, repos: ${cfg.reviewRepos.join(", ") || "none"})`);
    return cfg;
  }

  log.config("No AIWORKASSISTANT_API_KEY — using local .env config only");
  return {
    source: (ARGV.source || process.env.REVIEW_SOURCE || "github") as SourceType,
    githubToken: process.env.GITHUB_TOKEN || "",
    owner: ARGV.owner || process.env.GITHUB_DEFAULT_OWNER || "redsand",
    reviewRepos: (ARGV.repo || process.env.REVIEW_REPOS || "").split(",").filter(Boolean),
    pollIntervalMs: parseInt(ARGV["poll-ms"] || process.env.REVIEW_POLL_INTERVAL_MS || "30000", 10),
    securityAgentCmd: process.env.SECURITY_AGENT_CMD || "review-agent --category security",
    qaAgentCmd: process.env.QA_AGENT_CMD || "review-agent --category qa",
    qualityAgentCmd: process.env.QUALITY_AGENT_CMD || "review-agent --category quality",
    gitlabProject: ARGV["gitlab-project"] || process.env.GITLAB_DEFAULT_PROJECT || "",
  };
}

// ---------------------------------------------------------------------------
// GitHub client (inline, as before)
// ---------------------------------------------------------------------------
function makeGithubClient(token: string, owner: string) {
  const client = axios.create({
    baseURL: "https://api.github.com",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    timeout: 30_000,
  });

  return {
    async listOpenPRs(repo: string): Promise<any[]> {
      const res = await client.get(`/repos/${owner}/${repo}/pulls`, {
        params: { state: "open", per_page: 50, sort: "updated", direction: "desc" },
      });
      log.step(`Found ${res.data.length} open PRs in ${owner}/${repo}`);
      return res.data;
    },

    async getPRDiff(repo: string, prNumber: number): Promise<string> {
      const res = await client.get(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
        headers: { Accept: "application/vnd.github.v3.diff" },
      });
      return res.data as string;
    },

    async listIssueComments(repo: string, issueNumber: number): Promise<any[]> {
      const res = await client.get(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
        params: { per_page: 100 },
      });
      return res.data;
    },

    async addIssueComment(repo: string, issueNumber: number, body: string): Promise<void> {
      await client.post(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
    },

    async addLabel(repo: string, issueNumber: number, label: string): Promise<void> {
      await client.post(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, { labels: [label] });
    },

    async mergePR(repo: string, prNumber: number, commitTitle: string, commitMessage: string): Promise<void> {
      await client.put(`/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
        commit_title: commitTitle,
        commit_message: commitMessage,
      });
    },

    async getPRHeadSha(repo: string, prNumber: number): Promise<string | undefined> {
      const res = await client.get(`/repos/${owner}/${repo}/pulls/${prNumber}`);
      return res.data?.head?.sha;
    },
  };
}

// ---------------------------------------------------------------------------
// Platform-agnostic interfaces
// ---------------------------------------------------------------------------
interface MergeRequest {
  number: number;
  title: string;
  body: string | null;
  author: string;
  diff: string;
  sourceBranch?: string;
}

interface VcsClient {
  listOpenMergeRequests(project: string): Promise<MergeRequest[]>;
  getDiff(project: string, mrNumber: number): Promise<string>;
  addComment(project: string, mrNumber: number, body: string): Promise<void>;
  listComments(project: string, mrNumber: number): Promise<Array<{ body: string }>>;
  merge(project: string, mrNumber: number, title: string, message: string): Promise<void>;
  addLabelToIssue(project: string, issueNumber: number, label: string): Promise<void>;
  addCommentToIssue(project: string, issueNumber: number, body: string): Promise<void>;
  extractLinkedIssueKey(mrBody: string | null): string | null;
  extractIssueKeyFromBranch(branchName: string | undefined): string | null;
  getLatestCommitSha(project: string, mrNumber: number): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// GitHub VCS adapter
// ---------------------------------------------------------------------------
class GithubVcsClient implements VcsClient {
  constructor(private gh: ReturnType<typeof makeGithubClient>) {}

  async listOpenMergeRequests(repo: string): Promise<MergeRequest[]> {
    const prs = await this.gh.listOpenPRs(repo);
    return prs.map((pr: any) => ({
      number: pr.number,
      title: pr.title,
      body: pr.body || null,
      author: pr.user?.login || "",
      diff: "",
      sourceBranch: pr.head?.ref,
    }));
  }

  async getDiff(repo: string, prNumber: number): Promise<string> {
    return this.gh.getPRDiff(repo, prNumber);
  }

  async addComment(repo: string, mrNumber: number, body: string): Promise<void> {
    return this.gh.addIssueComment(repo, mrNumber, body);
  }

  async listComments(repo: string, mrNumber: number): Promise<Array<{ body: string }>> {
    return this.gh.listIssueComments(repo, mrNumber);
  }

  async merge(repo: string, mrNumber: number, title: string, message: string): Promise<void> {
    return this.gh.mergePR(repo, mrNumber, title, message);
  }

  async addLabelToIssue(repo: string, issueNumber: number, label: string): Promise<void> {
    return this.gh.addLabel(repo, issueNumber, label);
  }

  async addCommentToIssue(repo: string, issueNumber: number, body: string): Promise<void> {
    return this.gh.addIssueComment(repo, issueNumber, body);
  }

  extractLinkedIssueKey(mrBody: string | null): string | null {
    const match = (mrBody || "").match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
    return match ? match[1] : null;
  }

  extractIssueKeyFromBranch(branchName: string | undefined): string | null {
    if (!branchName) return null;
    // Match GitHub-style branch: ai/issue-51-...
    const numMatch = branchName.match(/issue-(\d+)/i);
    return numMatch ? numMatch[1] : null;
  }

  async getLatestCommitSha(repo: string, prNumber: number): Promise<string | undefined> {
    return this.gh.getPRHeadSha(repo, prNumber);
  }
}

// ---------------------------------------------------------------------------
// GitLab + Jira VCS adapter
// ---------------------------------------------------------------------------
class GitlabJiraVcsClient implements VcsClient {
  constructor(private projectId: string) {}

  async listOpenMergeRequests(_project: string): Promise<MergeRequest[]> {
    const mrs = await gitlabClient.getMergeRequests(this.projectId, "opened");
    return (mrs || []).map((mr: any) => ({
      number: mr.iid,
      title: mr.title,
      body: mr.description || null,
      author: mr.author?.username || "",
      diff: "",
      sourceBranch: mr.source_branch,
    }));
  }

  async getDiff(_project: string, mrNumber: number): Promise<string> {
    const changes = await gitlabClient.getMergeRequestChanges(this.projectId, mrNumber);
    return (changes.changes || [])
      .map((c: any) => {
        const header = `diff --git a/${c.old_path} b/${c.new_path}\n`;
        const mode = c.new_file ? "new file" : c.deleted_file ? "deleted file" : "";
        const modeLine = mode ? `${mode} mode 100644\n` : "";
        return header + modeLine + (c.diff || "");
      })
      .join("\n");
  }

  async addComment(_project: string, mrNumber: number, body: string): Promise<void> {
    return gitlabClient.addMergeRequestComment(this.projectId, mrNumber, body);
  }

  async listComments(_project: string, mrNumber: number): Promise<Array<{ body: string }>> {
    const notes = await gitlabClient.listMergeRequestNotes(this.projectId, mrNumber, "desc");
    return (notes || []).map((n: any) => ({ body: n.body }));
  }

  async merge(_project: string, mrNumber: number, title: string, message: string): Promise<void> {
    // Check for conflicts before attempting merge
    const status = await gitlabClient.getMergeRequestStatus(this.projectId, mrNumber);

    if (status.conflicts || status.mergeStatus === "cannot_be_merged") {
      // Attempt rebase to resolve conflicts
      try {
        await gitlabClient.rebaseMergeRequest(this.projectId, mrNumber);
        // Wait for rebase to complete (poll up to 60s)
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const current = await gitlabClient.getMergeRequestStatus(this.projectId, mrNumber);
          if (current.mergeStatus === "can_be_merged") break;
          if (current.mergeStatus === "cannot_be_merged") {
            throw new Error("Rebase completed but conflicts still exist");
          }
        }
      } catch (rebaseErr) {
        const rebaseMsg = rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
        throw new Error(`Cannot merge MR !${mrNumber}: conflicts detected and rebase failed — ${rebaseMsg}`);
      }
    }

    await gitlabClient.acceptMergeRequest(this.projectId, mrNumber, {
      squashCommitMessage: `${title}\n\n${message}`,
      shouldRemoveSourceBranch: true,
    });
  }

  async addLabelToIssue(_project: string, _issueNumber: number, _label: string): Promise<void> {
    // GitLab issues not supported for re-labeling in reviewer context;
    // Jira is used for issue tracking instead
  }

  async addCommentToIssue(_project: string, _issueNumber: number, _body: string): Promise<void> {
    // GitLab issues not used; Jira is the issue tracker
  }

  extractLinkedIssueKey(mrBody: string | null): string | null {
    const body = mrBody || "";
    // Match Jira keys after closes/fixes/resolves (e.g. "Closes IR-82")
    const jiraMatch = body.match(/(?:closes|fixes|resolves)\s+([A-Z]+-\d+)/i);
    if (jiraMatch) return jiraMatch[1];
    // Match "Issue: IR-82" line added by aicoder
    const issueLine = body.match(/^Issue:\s*([A-Z]+-\d+)/m);
    if (issueLine) return issueLine[1];
    // Also match bare Jira keys anywhere in the description
    const bareMatch = body.match(/\b([A-Z]+-\d+)\b/);
    return bareMatch ? bareMatch[1] : null;
  }

  extractIssueKeyFromBranch(branchName: string | undefined): string | null {
    if (!branchName) return null;
    // Match Jira-style branch: ai/issue-ir-82-... or ai/issue-IR-82-...
    const jiraBranch = branchName.match(/issue-([a-z]+-\d+)/i);
    if (jiraBranch) return jiraBranch[1].toUpperCase();
    // Match numeric branch: ai/issue-51-...
    const numBranch = branchName.match(/issue-(\d+)/i);
    return numBranch ? numBranch[1] : null;
  }

  async getLatestCommitSha(_project: string, mrNumber: number): Promise<string | undefined> {
    const mr = await gitlabClient.getMergeRequest(this.projectId, mrNumber);
    return mr.sha;
  }
}

// ---------------------------------------------------------------------------
// Jira helpers for re-linking review failures
// ---------------------------------------------------------------------------
async function addCommentToJiraIssue(key: string, body: string): Promise<void> {
  if (!jiraClient.isConfigured()) {
    log.warn(`Jira not configured — cannot post comment on ${key}`);
    return;
  }
  try {
    await jiraClient.addComment(key, body);
    log.jira(`Posted rework prompt on ${key}`);
  } catch (err) {
    log.error(`Failed to post Jira comment on ${key}: ${err instanceof Error ? err.message : err}`);
  }
}

async function addLabelToJiraIssue(key: string, label: string): Promise<void> {
  if (!jiraClient.isConfigured()) {
    log.warn(`Jira not configured — cannot add label ${label} to ${key}`);
    return;
  }
  try {
    await jiraClient.addLabels(key, [label]);
    log.jira(`Added label "${label}" to ${key}`);
  } catch (err) {
    log.warn(`Could not add "${label}" label to Jira issue ${key}: ${err instanceof Error ? err.message : err}`);
  }
}

// ---------------------------------------------------------------------------
// Review logic
// ---------------------------------------------------------------------------
async function runAiReview(
  remoteUrl: string,
  remoteKey: string,
  target: RepoTarget,
  config: ReviewerConfig,
  prNumber: number,
): Promise<ReviewResult> {
  log.review(`Delegating PR #${prNumber} review to AIWorkAssistant`);
  try {
    const owner = target.source === "gitlab" ? (target.gitlabProject || config.gitlabProject) : config.owner;
    const requestBody: Record<string, unknown> = {
      owner,
      repo: target.name,
      prNumber,
      source: target.source,
    };
    if (target.source === "gitlab" && target.gitlabProject) {
      requestBody.gitlabProject = target.gitlabProject;
    }

    const response = await axios.post<{
      success: boolean;
      clean?: boolean;
      findings?: ReviewFinding[];
      summary?: string;
      error?: string;
    }>(
      `${remoteUrl}/api/reviewer/review`,
      requestBody,
      { headers: { Authorization: `Bearer ${remoteKey}` } },
    );

    const data = response.data;
    if (!data.success) {
      throw new Error(data.error ?? "Unknown review error");
    }

    const findings = data.findings ?? [];
    return {
      clean: data.clean ?? false,
      findings,
      summary: data.summary ?? buildSummary(findings),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`AI review failed: ${message}`);
    return {
      clean: false,
      serviceUnavailable: true,
      findings: [{
        severity: "critical",
        category: "security",
        file: "*",
        message: `AI review service unavailable: ${message}`,
        suggestion: "Re-run review after the AI review service is restored. Do not merge without review.",
      }],
      summary: `AI review unavailable — blocking merge. Error: ${message}`,
    };
  }
}

const reviewedMRs = new Set<string>(); // "project/mrNumber"
const reviewedMRShas = new Map<string, string>(); // mrKey → last_commit_sha

function isServiceUnavailable(result: ReviewResult): boolean {
  return result.serviceUnavailable === true ||
    result.findings.some((f) => f.message.startsWith("AI review service unavailable"));
}

async function postPostponed(
  vcs: VcsClient,
  project: string,
  mr: { number: number; title: string },
  result: ReviewResult,
): Promise<void> {
  await vcs.addComment(
    project,
    mr.number,
    `## ⚠️ Review Postponed — Service Unavailable\n\n${result.summary}\n\nThe review service could not be reached. No rework prompt will be posted. Review will be retried on the next cycle.`,
  );
  log.rework(`MR !${mr.number} review postponed due to service unavailability`);
}

async function pollMergeRequests(
  config: ReviewerConfig,
): Promise<void> {
  const targets = parseRepoTargets(config.reviewRepos, config.source, config.gitlabProject);

  // Also add the gitlab project if source is gitlab and no explicit gitlab targets exist
  if (config.source === "gitlab" && config.gitlabProject && !targets.some((t) => t.source === "gitlab")) {
    targets.push({ name: config.gitlabProject, source: "gitlab", gitlabProject: config.gitlabProject });
  }

  if (targets.length === 0) {
    log.poll("No repos/projects to monitor");
    return;
  }

  for (const target of targets) {
    log.poll(`Checking ${target.source}:${target.name} for open MRs/PRs`);
    const vcs = getVcsClient(target, config);
    let mrs: MergeRequest[];
    try {
      mrs = await vcs.listOpenMergeRequests(target.name);
    } catch (err) {
      log.error(`Failed to fetch MRs/PRs from ${target.source}:${target.name}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    log.poll(`${target.source}:${target.name} returned ${mrs.length} open MRs/PRs`);

    for (const mr of mrs) {
      if (!mr.author.includes("ai") && !mr.title.startsWith("[AI]")) continue;

      const mrKey = `${target.source}:${target.name}/${mr.number}`;
      if (reviewedMRs.has(mrKey)) {
        // Already reviewed — check if MR has been updated since (new push from aicoder rework)
        const lastSha = reviewedMRShas.get(mrKey);
        if (lastSha) {
          const currentSha = await vcs.getLatestCommitSha(target.name, mr.number).catch(() => undefined);
          if (currentSha && currentSha !== lastSha) {
            log.review(`MR !${mr.number} has new commits (SHA: ${lastSha.slice(0,8)} → ${currentSha.slice(0,8)}) — re-reviewing`);
            reviewedMRs.delete(mrKey);
          } else {
            log.skip(`MR !${mr.number} already reviewed (SHA unchanged) — waiting for rework`);
            continue;
          }
        } else {
          log.skip(`MR !${mr.number} already reviewed — waiting for rework`);
          continue;
        }
      }

      log.review(`Found AI MR !${mr.number} in ${target.source}:${target.name}: ${mr.title}`);
      log.step("Fetching diff and running review...");

      const result = await runMultiAgentReview(config, target, mr.number);

      // Record the current commit SHA so we can detect when aicoder pushes rework
      const currentSha = await vcs.getLatestCommitSha(target.name, mr.number).catch(() => undefined);
      if (currentSha) {
        reviewedMRShas.set(mrKey, currentSha);
        log.sha(`MR !${mr.number} SHA: ${currentSha.slice(0, 8)}`);
      }

      reviewedMRs.add(mrKey);

      if (result.clean) {
        log.clean(`MR !${mr.number} passed review — merging`);
        const mergeStatus = await mergeWithSummary(vcs, target.name, mr, result);
        if (mergeStatus === "conflict") {
          // Remove from reviewed so the reviewer re-evaluates after aicoder rebases
          reviewedMRs.delete(mrKey);
        }
      } else if (isServiceUnavailable(result)) {
        log.warn(`MR !${mr.number} review service unavailable — postponing`);
        await postPostponed(vcs, target.name, mr, result);
        // Remove SHA so we don't skip on retry — the review didn't actually complete
        reviewedMRShas.delete(mrKey);
        reviewedMRs.delete(mrKey);
      } else {
        log.rework(`MR !${mr.number} needs rework — ${result.findings.length} findings (${result.summary})`);
        for (const f of result.findings) {
          log.finding(`[${f.severity}] ${f.category} ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message.slice(0, 100)}`);
        }
        await postReworkPrompt(vcs, target.name, mr, result);
        // Keep in reviewedMRs and reviewedMRShas so we don't re-review
        // until aicoder pushes new commits (SHA changes)
      }
    }
  }
}

function getVcsClient(target: RepoTarget, config: ReviewerConfig): VcsClient {
  if (target.source === "gitlab") {
    return new GitlabJiraVcsClient(target.gitlabProject || config.gitlabProject);
  }
  return new GithubVcsClient(makeGithubClient(config.githubToken, config.owner));
}

async function runMultiAgentReview(
  config: ReviewerConfig,
  target: RepoTarget,
  mrNumber: number,
): Promise<ReviewResult> {
  const remoteUrl = process.env.AIWORKASSISTANT_URL?.replace(/\/$/, "");
  const remoteKey = process.env.AIWORKASSISTANT_API_KEY;

  // For remote review, delegate to the server
  if (remoteUrl && remoteKey) {
    return runAiReview(remoteUrl, remoteKey, target, config, mrNumber);
  }

  // Local review: fetch diff and run agents
  const vcs = getVcsClient(target, config);
  const diff = await vcs.getDiff(target.name, mrNumber);

  const sec = runAgentReview(diff, "security", config.securityAgentCmd);
  const qa = runAgentReview(diff, "qa", config.qaAgentCmd);
  const qual = runAgentReview(diff, "quality", config.qualityAgentCmd);

  const findings: ReviewFinding[] = [...sec.findings, ...qa.findings, ...qual.findings];
  const agentStatus: Record<string, "passed" | "failed"> = {
    security: sec.status,
    qa: qa.status,
    quality: qual.status,
  };

  const hasCriticalOrHigh = findings.some(
    (f) => f.severity === "critical" || f.severity === "high",
  );

  return {
    clean: !hasCriticalOrHigh,
    findings,
    summary: buildSummary(findings),
    agentStatus,
  };
}

function runAgentReview(
  diff: string,
  category: "security" | "qa" | "quality",
  cmd: string,
): { findings: ReviewFinding[]; status: "passed" | "failed" } {
  try {
    const output = execSync(cmd, {
      input: diff,
      encoding: "utf-8",
      timeout: 300_000,
    });
    return { findings: JSON.parse(output) as ReviewFinding[], status: "passed" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`${category} agent failed: ${message}`);
    return {
      status: "failed",
      findings: [{
        severity: "critical",
        category,
        file: "*",
        message: `${category} review agent failed: ${message}`,
        suggestion: `Fix the ${category} agent and re-run review before merging.`,
      }],
    };
  }
}

function formatAgentStatus(agentStatus?: Record<string, "passed" | "failed">): string {
  if (!agentStatus) return "**Review agents:** Security ✓ | QA ✓ | Quality ✓";
  const fmt = (cat: string, label: string) =>
    agentStatus[cat] === "failed" ? `${label} ✗ (failed)` : `${label} ✓`;
  return `**Review agents:** ${fmt("security", "Security")} | ${fmt("qa", "QA")} | ${fmt("quality", "Quality")}`;
}

function buildSummary(findings: ReviewFinding[]): string {
  if (findings.length === 0) return "No findings. Code is clean.";
  const grouped = { critical: 0, high: 0, medium: 0, low: 0 };
  findings.forEach((f) => grouped[f.severity]++);
  return `Findings: ${findings.length} total — Critical: ${grouped.critical}, High: ${grouped.high}, Medium: ${grouped.medium}, Low: ${grouped.low}`;
}

async function mergeWithSummary(
  vcs: VcsClient,
  project: string,
  mr: { number: number; title: string },
  result: ReviewResult,
): Promise<"merged" | "conflict" | "failed"> {
  const agentLine = formatAgentStatus(result.agentStatus);
  try {
    await vcs.addComment(
      project,
      mr.number,
      `## ✅ Review Passed — Merging\n\n${result.summary}\n\n${agentLine}\n\nMerging now.`,
    );
    await vcs.merge(project, mr.number, `Merge [AI] ${mr.title}`, result.summary);
    log.merge(`MR !${mr.number} merged in ${project}`);
    return "merged";
  } catch (mergeErr) {
    const errMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
    const isConflict = /conflict|cannot_be_merged|rebase failed/i.test(errMsg);
    log.merge(`Failed to merge MR !${mr.number}: ${errMsg}`);

    if (isConflict) {
      await vcs.addComment(
        project,
        mr.number,
        `## ⚠️ Review Passed — ${REVIEW_MERGE_CONFLICT_MARKER}\n\n${result.summary}\n\n${agentLine}\n\nMerge could not be completed due to conflicts with the base branch: ${errMsg}\n\nThe autonomous agent will attempt to rebase and resolve conflicts.`,
      ).catch(() => {});
      return "conflict";
    } else {
      await vcs.addComment(
        project,
        mr.number,
        `## ⚠️ Review Passed — Merge Failed\n\n${result.summary}\n\n${agentLine}\n\nMerge could not be completed automatically: ${errMsg}\n\nManual merge required.`,
      ).catch(() => {});
      return "failed";
    }
  }
}

async function postReworkPrompt(
  vcs: VcsClient,
  project: string,
  mr: { number: number; title: string; body: string | null; sourceBranch?: string },
  result: ReviewResult,
): Promise<void> {
  await vcs.addComment(project, mr.number, formatReviewFindings(result));

  let issueKey = vcs.extractLinkedIssueKey(mr.body);
  if (!issueKey) {
    // Fallback: extract from branch name (e.g. ai/issue-ir-82-slug)
    issueKey = vcs.extractIssueKeyFromBranch(mr.sourceBranch);
  }
  if (!issueKey) {
    log.warn(`MR !${mr.number} has no linked issue in description or branch name — cannot post rework prompt`);
    return;
  }

  // Determine if this is a Jira key (e.g. IR-63) or a numeric issue (e.g. #42)
  const isJiraKey = /^[A-Z]+-\d+$/.test(issueKey);

  if (isJiraKey) {
    await addCommentToJiraIssue(issueKey, buildReworkPrompt(result));
    await addLabelToJiraIssue(issueKey, "ready-for-agent");
    log.rework(`Posted rework prompt on Jira ${issueKey} for MR !${mr.number}`);
  } else {
    // Numeric GitHub issue
    const issueNumber = parseInt(issueKey, 10);
    await vcs.addCommentToIssue(project, issueNumber, buildReworkPrompt(result));
    await vcs.addLabelToIssue(project, issueNumber, "ready-for-agent").catch(() => {
      log.warn(`Could not add ready-for-agent label to issue #${issueNumber}`);
    });
    log.rework(`Posted rework prompt on issue #${issueNumber} for MR !${mr.number}`);
  }
}

function formatReviewFindings(result: ReviewResult): string {
  const lines = result.findings.map(
    (f) =>
      `- **[${f.severity.toUpperCase()}]** [${f.category}] ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}\n  → Suggestion: ${f.suggestion}`,
  );
  return `## ❌ Review Failed — Rework Required\n\n${result.summary}\n\n### Findings\n${lines.join("\n")}\n\nA rework prompt has been added to the linked issue. AiRemoteCoder will pick it up.`;
}

function buildReworkPrompt(result: ReviewResult): string {
  const tasks = result.findings
    .filter((f) => f.severity === "critical" || f.severity === "high")
    .map(
      (f) =>
        `- Fix [${f.severity}] ${f.category} issue in ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}\n  Apply: ${f.suggestion}`,
    );

  return `## Coding Prompt\n\n### Rework from PR Review\n\nThe following issues must be fixed before merge:\n\n${tasks.join("\n")}\n\n### Reasoning\nThese findings were identified by the security, QA, and code quality review agents. All critical and high severity issues must be resolved. Re-run the full implementation addressing each finding.`;
}

async function main(): Promise<void> {
  log.start("AIWorkAssistant review agent started");
  const config = await loadConfig();

  const source = config.source;
  const targets = parseRepoTargets(config.reviewRepos, config.source, config.gitlabProject);
  log.config(`Source: ${source}, targets: ${targets.map((t) => `${t.source}:${t.name}`).join(", ") || "none"}`);

  if (config.reviewRepos.length === 0 && source === "github") {
    log.warn("No REVIEW_REPOS configured — nothing to watch on GitHub");
  }
  if (source === "gitlab" && !config.gitlabProject && !targets.some((t) => t.source === "gitlab")) {
    log.error("No GITLAB_DEFAULT_PROJECT configured — set it in .env or pass --gitlab-project");
    process.exit(1);
  }
  if (targets.some((t) => t.source === "github") && !config.githubToken) {
    log.error("No GitHub token — set GITHUB_TOKEN for GitHub repos");
    process.exit(1);
  }
  if (targets.some((t) => t.source === "gitlab") && !gitlabClient.isConfigured()) {
    log.error("GitLab not configured — set GITLAB_TOKEN and GITLAB_BASE_URL in .env");
    process.exit(1);
  }

  while (true) {
    try {
      await pollMergeRequests(config);
    } catch (err) {
      console.error("[ERROR]", err);
    }
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
}

main();