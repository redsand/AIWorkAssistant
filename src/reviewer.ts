#!/usr/bin/env tsx
import "dotenv/config";
import { providerSettings } from "./agent/provider-settings";
providerSettings.applyPersistedSelection();
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import axios from "axios";
import { gitlabClient } from "./integrations/gitlab/gitlab-client";
import { jiraClient } from "./integrations/jira/jira-client";
import { reviewAssistant } from "./code-review/review-assistant";
import type { ReviewStreamEvent } from "./code-review/review-assistant";
import { aiClient } from "./agent/opencode-client";
import { parseReviewFindings } from "./autonomous-loop/review-findings-parser";
import { recordGateFindings } from "./autonomous-loop/review-gate-state";
import { formatConvergenceReport, initConvergenceState, recordRoundFindings, checkConvergence, DEFAULT_CONVERGENCE_CONFIG } from "./autonomous-loop/convergence";
import { loadConvergenceState } from "./autonomous-loop/convergence-state";
import { closeSourceIssue } from "./autonomous-loop/close-source-issue";

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
const REVIEW_HUMAN_REVIEW_MARKER = "Review Requires Human — Ready for Human Review";

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
  --poll-ms <ms>        Poll interval in milliseconds (default: 30000); use 0 for one-shot (run once and exit)
  --workspace-path <path> Base directory containing local clones of all repos (e.g. ../ or /home/user/repos).
                          The reviewer resolves each MR's workspace as <workspace-path>/<repo-name>.
                          Enables file/git tool access during review. Also set via REVIEW_WORKSPACE_PATH env var.
  --provider <name>     AI provider: opencode | zai | ollama | openai (overrides AI_PROVIDER env)
  --model <name>        Model name for the selected provider (overrides env defaults)
  --url <url>           Base URL for the selected provider (overrides OLLAMA_API_URL / OPENAI_API_URL / etc.)
  --review-mr <n>       Force a fresh review of MR/PR number n and exit
  --merge-mr <n>        Force-merge MR/PR number n, close the linked issue, and exit
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
  REGRESSION_AGENT_CMD       External regression detection command

GitLab-specific:
  GITLAB_DEFAULT_PROJECT    GitLab project path (e.g. siem/octorepl)
  GITLAB_TOKEN              GitLab personal access token

Jira (for re-linking review failures):
  JIRA_BASE_URL             Jira instance URL
  JIRA_EMAIL                Jira user email
  JIRA_API_TOKEN            Jira API token
`);
      process.exit(0);
    } else if (argv[i] === "--ollama") {
      out["provider"] = "ollama";
    } else if (argv[i] === "--zai") {
      out["provider"] = "zai";
    } else if (argv[i] === "--opencode") {
      out["provider"] = "opencode";
    } else if (argv[i].startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
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
  regressionAgentCmd: string;
  gitlabProject: string;
  /** Base directory containing local repo clones — reviewer resolves <workspacePath>/<repo-name> per MR. */
  workspacePath?: string;
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
  category: "security" | "qa" | "quality" | "regression";
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
  recommendation?: string;
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
    // Auto-detect source from repo prefixes when --source not explicitly set
    let effectiveSource: string | undefined = ARGV.source || process.env.REVIEW_SOURCE;
    if (!effectiveSource && cfg.reviewRepos.length > 0) {
      const hasGithubPrefix = cfg.reviewRepos.some((r) => r.trim().startsWith("github:"));
      const hasGitlabPrefix = cfg.reviewRepos.some((r) => r.trim().startsWith("gitlab:"));
      if (hasGithubPrefix && !hasGitlabPrefix) effectiveSource = "github";
      else if (hasGitlabPrefix && !hasGithubPrefix) effectiveSource = "gitlab";
    }
    cfg.source = (effectiveSource || cfg.source || "github") as SourceType;
    cfg.gitlabProject = ARGV["gitlab-project"] || process.env.GITLAB_DEFAULT_PROJECT || cfg.gitlabProject || "";
    cfg.workspacePath = ARGV["workspace-path"] || process.env.REVIEW_WORKSPACE_PATH || undefined;
    log.config(`Remote config loaded (source: ${cfg.source}, repos: ${cfg.reviewRepos.join(", ") || "none"}${cfg.workspacePath ? `, workspace: ${cfg.workspacePath}` : ""})`);
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
    regressionAgentCmd: process.env.REGRESSION_AGENT_CMD || "",
    gitlabProject: ARGV["gitlab-project"] || process.env.GITLAB_DEFAULT_PROJECT || "",
    workspacePath: ARGV["workspace-path"] || process.env.REVIEW_WORKSPACE_PATH || undefined,
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
      if (res.data.length > 0) {
        log.step(`Found ${res.data.length} open PRs in ${owner}/${repo}`);
      }
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

    async addIssueComment(issueNumber: number, body: string, _owner?: string, _repo?: string): Promise<void> {
      const o = _owner || owner;
      const r = _repo || "";
      await client.post(`/repos/${o}/${r}/issues/${issueNumber}/comments`, { body });
    },

    async updateIssue(issueNumber: number, params: { state?: string }, _owner?: string, _repo?: string): Promise<void> {
      const o = _owner || owner;
      const r = _repo || "";
      await client.patch(`/repos/${o}/${r}/issues/${issueNumber}`, params);
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
    return this.gh.addIssueComment(mrNumber, body, undefined, repo);
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
    return this.gh.addIssueComment(issueNumber, body, undefined, repo);
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
    // Match Jira browse URL (e.g. "Closes https://company.atlassian.net/browse/IR-82")
    const urlMatch = body.match(/\/browse\/([A-Z]+-\d+)/);
    if (urlMatch) return urlMatch[1];
    // Match bare Jira keys after closes/fixes/resolves (e.g. "Closes IR-82")
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
    const mr = await gitlabClient.getMergeRequest(this.projectId, mrNumber).catch(() => null);
    if (!mr || mr.state === "merged" || mr.state === "closed") return undefined;
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

/** Extract the linked Jira/issue key from an MR and format it for log output. */
function mrIssueTag(vcs: VcsClient, mr: { body: string | null; sourceBranch?: string }): string {
  const key = vcs.extractLinkedIssueKey(mr.body) || vcs.extractIssueKeyFromBranch(mr.sourceBranch);
  return key ? ` [${key}]` : "";
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
      recommendation?: string;
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
      recommendation: data.recommendation,
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

const reviewedMRs = new Set<string>(); // "source:project/mrNumber"
const reviewedMRShas = new Map<string, string>(); // mrKey → last_commit_sha
const reviewedMRTimes = new Map<string, number>(); // mrKey → Date.now() of last review
const mrSkipCounts = new Map<string, number>(); // mrKey → consecutive SHA-unchanged skips
const mrConflictCounts = new Map<string, number>(); // mrKey → consecutive merge-conflict retries

/** Stop polling an MR after this many consecutive SHA-unchanged skips. */
const MAX_CONSECUTIVE_SKIPS = parseInt(process.env.MAX_CONSECUTIVE_SKIPS ?? "5", 10);

/** Minimum time (ms) between re-reviews of the same MR on SHA change.
 *  Prevents double-review when aicoder pushes during or right after a review cycle. */
const MIN_RE_REVIEW_INTERVAL_MS = parseInt(process.env.MIN_RE_REVIEW_INTERVAL_MS ?? "120000", 10);

/** Backoff bounds for the outer poll loop when MRs are being skipped. */
const BASE_POLL_INTERVAL_MS = 30_000;
const MAX_POLL_INTERVAL_MS = 300_000;
let currentPollIntervalMs: number | null = null; // null = use config.pollIntervalMs

// ── Persistent reviewer state ────────────────────────────────────────────────
// Resolve lazily: workspacePath may be set after module load via --workspace-path
function getReviewerStateFile(): string {
  const ws = ARGV["workspace-path"] || process.env.REVIEW_WORKSPACE_PATH || process.cwd();
  return path.join(ws, ".aicoder", "reviewer-state.json");
}

interface ReviewerState {
  reviewedMRs: string[];
  reviewedMRShas: Record<string, string>;
  reviewedMRTimes: Record<string, number>;
  mrSkipCounts?: Record<string, number>;
  mrConflictCounts?: Record<string, number>;
  updatedAt: string;
}

function loadReviewerState(): void {
  try {
    if (fs.existsSync(getReviewerStateFile())) {
      const data: ReviewerState = JSON.parse(fs.readFileSync(getReviewerStateFile(), "utf-8"));
      if (data.reviewedMRs) {
        data.reviewedMRs.forEach((key: string) => reviewedMRs.add(key));
      }
      if (data.reviewedMRShas) {
        Object.entries(data.reviewedMRShas).forEach(([key, sha]: [string, string]) => {
          reviewedMRShas.set(key, sha);
        });
      }
      if (data.reviewedMRTimes) {
        Object.entries(data.reviewedMRTimes).forEach(([key, time]: [string, number]) => {
          reviewedMRTimes.set(key, time);
        });
      }
      if (data.mrSkipCounts) {
        Object.entries(data.mrSkipCounts).forEach(([key, count]: [string, number]) => {
          mrSkipCounts.set(key, count);
        });
      }
      if (data.mrConflictCounts) {
        Object.entries(data.mrConflictCounts).forEach(([key, count]: [string, number]) => {
          mrConflictCounts.set(key, count);
        });
      }
      const total = reviewedMRs.size;
      if (total > 0) {
        log.config(`Resumed with ${total} previously reviewed MR(s)`);
      }
    }
  } catch (err) {
    log.warn(`Could not load reviewer state: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * On startup, verify saved SHAs against the remote and remove stale entries.
 * If an MR has been force-pushed (SHA changed) since we last reviewed it,
 * remove it from reviewedMRs so it gets re-reviewed.
 */
async function verifyReviewerState(config: ReviewerConfig): Promise<void> {
  if (reviewedMRShas.size === 0) return;

  const targets = parseRepoTargets(config.reviewRepos, config.source, config.gitlabProject);
  const hasExplicitSourcePrefixes = config.reviewRepos.every((r) => r.trim().startsWith("github:") || r.trim().startsWith("gitlab:"));
  if (!hasExplicitSourcePrefixes && config.source === "gitlab" && config.gitlabProject && !targets.some((t) => t.source === "gitlab")) {
    targets.push({ name: config.gitlabProject, source: "gitlab", gitlabProject: config.gitlabProject });
  }

  const keysToReReview: string[] = [];

  for (const [mrKey, savedSha] of reviewedMRShas) {
    // Parse mrKey: "source:project/number"
    const match = mrKey.match(/^(\w+):(.+)\/(\d+)$/);
    if (!match) {
      keysToReReview.push(mrKey);
      continue;
    }
    const [, source, project, mrNumberStr] = match;
    const mrNumber = parseInt(mrNumberStr, 10);

    const target = targets.find((t) => t.source === source && t.name === project);
    if (!target) continue; // Can't verify — skip

    const vcs = getVcsClient(target, config);
    const currentSha = await vcs.getLatestCommitSha(target.name, mrNumber).catch(() => undefined);

    if (!currentSha) {
      // MR not found or already merged/closed — remove from state so it's never re-checked
      log.config(`MR !${mrNumber} no longer open (merged or closed) — removing from reviewer state`);
      keysToReReview.push(mrKey);
    } else if (currentSha !== savedSha) {
      log.review(`MR !${mrNumber} SHA changed (${savedSha.slice(0, 8)} → ${currentSha.slice(0, 8)}) — scheduling re-review`);
      keysToReReview.push(mrKey);
    }
  }

  for (const key of keysToReReview) {
    reviewedMRs.delete(key);
    reviewedMRShas.delete(key);
    reviewedMRTimes.delete(key);
    mrSkipCounts.delete(key);
    mrConflictCounts.delete(key);
  }

  if (keysToReReview.length > 0) {
    saveReviewerState();
  }
}

function saveReviewerState(): void {
  try {
    const dir = path.dirname(getReviewerStateFile());
    fs.mkdirSync(dir, { recursive: true });
    const state: ReviewerState = {
      reviewedMRs: [...reviewedMRs],
      reviewedMRShas: Object.fromEntries(reviewedMRShas),
      reviewedMRTimes: Object.fromEntries(reviewedMRTimes),
      mrSkipCounts: Object.fromEntries(mrSkipCounts),
      mrConflictCounts: Object.fromEntries(mrConflictCounts),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(getReviewerStateFile(), JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    log.warn(`Could not persist reviewer state: ${err instanceof Error ? err.message : err}`);
  }
}

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

  // Add the default gitlab project if source is gitlab and no explicit gitlab targets exist,
  // BUT only if the user didn't specify all repos with explicit source prefixes.
  // When all repos have "github:" or "gitlab:" prefixes, the user chose exactly which
  // platforms to review — don't add unrequested gitlab projects.
  const hasExplicitSourcePrefixes = config.reviewRepos.every((r) => r.trim().startsWith("github:") || r.trim().startsWith("gitlab:"));
  if (!hasExplicitSourcePrefixes && config.source === "gitlab" && config.gitlabProject && !targets.some((t) => t.source === "gitlab")) {
    targets.push({ name: config.gitlabProject, source: "gitlab", gitlabProject: config.gitlabProject });
  }

  if (targets.length === 0) {
    log.poll("No repos/projects to monitor");
    return;
  }

  for (const target of targets) {
    const vcs = getVcsClient(target, config);
    let mrs: MergeRequest[];
    try {
      mrs = await vcs.listOpenMergeRequests(target.name);
    } catch (err) {
      log.error(`Failed to fetch MRs/PRs from ${target.source}:${target.name}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    if (mrs.length > 0) {
      log.poll(`${target.source}:${target.name} returned ${mrs.length} open MRs/PRs`);

    for (const mr of mrs) {
      if (!mr.author.includes("ai") && !mr.title.startsWith("[AI]")) continue;

      const mrKey = `${target.source}:${target.name}/${mr.number}`;
      if (reviewedMRs.has(mrKey)) {
        // Already reviewed — check if MR has been updated since (new push from aicoder rework)
        const lastSha = reviewedMRShas.get(mrKey);
        if (lastSha) {
          const currentSha = await vcs.getLatestCommitSha(target.name, mr.number).catch(() => undefined);
          const issueTag = mrIssueTag(vcs, mr);
          if (currentSha && currentSha !== lastSha) {
            // Cooldown check: don't re-review if the last review was too recent.
            // This prevents double-review when aicoder pushes during or right after
            // a review cycle (e.g. aicoder was still running tests when reviewer
            // picked up the initial MR).
            const lastReviewTime = reviewedMRTimes.get(mrKey);
            const elapsed = lastReviewTime ? Date.now() - lastReviewTime : Infinity;
            if (lastReviewTime && elapsed < MIN_RE_REVIEW_INTERVAL_MS) {
              const remaining = Math.round((MIN_RE_REVIEW_INTERVAL_MS - elapsed) / 1000);
              log.skip(`MR !${mr.number}${issueTag} SHA changed but last review was ${Math.round(elapsed / 1000)}s ago — waiting ${remaining}s for aicoder to settle`);
              continue;
            }
            log.review(`MR !${mr.number}${issueTag} has new commits (SHA: ${lastSha.slice(0,8)} → ${currentSha.slice(0,8)}) — re-reviewing`);
            reviewedMRs.delete(mrKey);
            reviewedMRTimes.delete(mrKey);
            mrSkipCounts.delete(mrKey);
            // SHA changed → reset backoff
            currentPollIntervalMs = null;
          } else {
            // SHA unchanged — increment skip counter
            const skipCount = (mrSkipCounts.get(mrKey) ?? 0) + 1;
            mrSkipCounts.set(mrKey, skipCount);
            log.skip(`MR !${mr.number}${issueTag} already reviewed (SHA unchanged) — waiting for rework [skip ${skipCount}/${MAX_CONSECUTIVE_SKIPS}]`);

            if (skipCount >= MAX_CONSECUTIVE_SKIPS) {
              // Too many consecutive skips — stop polling this MR and report to Jira
              log.warn(`MR !${mr.number}${issueTag} skipped ${skipCount} times with no rework — posting convergence report`);

              const convergenceState = recordRoundFindings(initConvergenceState(), [], false);
              const convergence = checkConvergence(convergenceState, DEFAULT_CONVERGENCE_CONFIG);
              const report = formatConvergenceReport(
                { ...convergence, reason: "empty_prs", message: `Reviewer skipped MR !${mr.number} ${skipCount} times (SHA unchanged). The aicoder has not pushed new commits. Stopping poll — will resume when the aicoder pushes a rework.` },
                convergenceState,
                DEFAULT_CONVERGENCE_CONFIG,
              );

              // Post to Jira if we can identify the linked issue
              const issueKey = vcs.extractLinkedIssueKey(mr.body) || vcs.extractIssueKeyFromBranch(mr.sourceBranch);
              if (issueKey && /^[A-Z]+-\d+$/.test(issueKey) && jiraClient.isConfigured()) {
                await addCommentToJiraIssue(issueKey, report).catch((err) => {
                  log.warn(`Could not post convergence report to Jira ${issueKey}: ${err instanceof Error ? err.message : err}`);
                });
              }

              // Keep reviewedMRShas entry so the MR is NOT re-reviewed on the same SHA.
              // Only remove it when aicoder pushes new commits (SHA changes in verifyReviewerState).
              // Deleting the SHA here would cause an immediate re-review with the same diff,
              // posting a duplicate rework prompt.
              reviewedMRs.delete(mrKey);
              mrSkipCounts.delete(mrKey);
              currentPollIntervalMs = null;
            } else {
              // Apply exponential backoff: each skip doubles the wait, capped at MAX_POLL_INTERVAL_MS
              const base = currentPollIntervalMs ?? BASE_POLL_INTERVAL_MS;
              currentPollIntervalMs = Math.min(base * 1.5, MAX_POLL_INTERVAL_MS);
            }
            continue;
          }
        } else {
          log.skip(`MR !${mr.number}${mrIssueTag(vcs, mr)} already reviewed — waiting for rework`);
          continue;
        }
      }

      log.review(`Found AI MR !${mr.number}${mrIssueTag(vcs, mr)} in ${target.source}:${target.name}: ${mr.title}`);
      log.step("Fetching diff and running review...");

      // Check for empty MR — skip review and DO NOT merge empty diffs
      const diff = await vcs.getDiff(target.name, mr.number);
      if (!diff || diff.trim().length === 0) {
        log.warn(`MR !${mr.number} has no changes (empty diff) — skipping review, not merging`);
        await vcs.addComment(target.name, mr.number, "## ⚠️ Empty MR — No Changes Detected\n\nThis MR has no code changes. It will not be reviewed or merged. Please add substantive changes or close this MR.");
        reviewedMRs.add(mrKey);
        saveReviewerState();
        continue;
      }

      const result = await runMultiAgentReview(config, target, mr.number, diff);

      // Persist structured findings for review gate and convergence detection
      const gateFindings = parseReviewFindings("", result.findings);
      if (gateFindings.length > 0) {
        recordGateFindings(gateFindings, mrKey);
        log.step(`Persisted ${gateFindings.length} findings to review gate state`);
      }

      // Record the current commit SHA so we can detect when aicoder pushes rework
      const currentSha = await vcs.getLatestCommitSha(target.name, mr.number).catch(() => undefined);
      if (currentSha) {
        reviewedMRShas.set(mrKey, currentSha);
        log.sha(`MR !${mr.number} SHA: ${currentSha.slice(0, 8)}`);
      }

      reviewedMRs.add(mrKey);
      reviewedMRTimes.set(mrKey, Date.now());
      saveReviewerState();

      const tag = mrIssueTag(vcs, mr);
      if (result.clean) {
        log.clean(`MR !${mr.number}${tag} passed review — merging`);
        const mergeStatus = await mergeWithSummary(vcs, target.name, target.source, config.owner, config.githubToken, mr, result);
        if (mergeStatus === "conflict") {
          // Track conflict retries — after MAX_CONFLICT_RETRIES, post convergence and stop polling
          const conflictCount = (mrConflictCounts.get(mrKey) ?? 0) + 1;
          mrConflictCounts.set(mrKey, conflictCount);
          const MAX_CONFLICT_RETRIES = 3;
          if (conflictCount >= MAX_CONFLICT_RETRIES) {
            log.warn(`MR !${mr.number}${tag} merge conflict ${conflictCount} times — posting convergence report and stopping poll`);
            const convergenceState = recordRoundFindings(initConvergenceState(), [], false);
            const convergence = checkConvergence(convergenceState, DEFAULT_CONVERGENCE_CONFIG);
            const report = formatConvergenceReport(
              { ...convergence, reason: "max_rework", message: `Reviewer could not merge MR !${mr.number} after ${conflictCount} conflict attempts. Aicoder must rebase and resolve conflicts manually.` },
              convergenceState,
              DEFAULT_CONVERGENCE_CONFIG,
            );
            const issueKey = vcs.extractLinkedIssueKey(mr.body) || vcs.extractIssueKeyFromBranch(mr.sourceBranch);
            if (issueKey && /^[A-Z]+-\d+$/.test(issueKey) && jiraClient.isConfigured()) {
              await addCommentToJiraIssue(issueKey, report).catch(() => {});
            }
            mrConflictCounts.delete(mrKey);
          }
          // Keep in reviewedMRs — the SHA-unchanged skip logic will prevent re-review
          // until aicoder pushes new commits (SHA changes in verifyReviewerState).
          saveReviewerState();
        }
      } else if (isServiceUnavailable(result)) {
        log.warn(`MR !${mr.number}${tag} review service unavailable — postponing`);
        await postPostponed(vcs, target.name, mr, result);
        // Remove SHA so we don't skip on retry — the review didn't actually complete
        reviewedMRShas.delete(mrKey);
        reviewedMRs.delete(mrKey);
        saveReviewerState();
      } else if (result.findings.every((f) => f.severity === "medium" || f.severity === "low") &&
                 !result.findings.some((f) => f.severity === "medium" && f.category === "qa")) {
        // Only medium/low non-test-gap findings — approve with comments and create a tracking issue.
        // Test gaps (medium/qa) are blocking: the agent must write the tests first.
        log.clean(`MR !${mr.number}${tag} passed review with comments — no critical/high findings, merging`);
        const mergeResult = await mergeWithSummary(vcs, target.name, target.source, config.owner, config.githubToken, mr, {
          ...result,
          clean: true,
          summary: `${result.summary} (approved with suggestions — no blocking findings)`,
        });
        if (mergeResult === "conflict") {
          const conflictCount = (mrConflictCounts.get(mrKey) ?? 0) + 1;
          mrConflictCounts.set(mrKey, conflictCount);
          const MAX_CONFLICT_RETRIES = 3;
          if (conflictCount >= MAX_CONFLICT_RETRIES) {
            log.warn(`MR !${mr.number}${tag} merge conflict ${conflictCount} times — posting convergence report and stopping poll`);
            const convergenceState = recordRoundFindings(initConvergenceState(), [], false);
            const convergence = checkConvergence(convergenceState, DEFAULT_CONVERGENCE_CONFIG);
            const report = formatConvergenceReport(
              { ...convergence, reason: "max_rework", message: `Reviewer could not merge MR !${mr.number} after ${conflictCount} conflict attempts. Aicoder must rebase and resolve conflicts manually.` },
              convergenceState,
              DEFAULT_CONVERGENCE_CONFIG,
            );
            const issueKey = vcs.extractLinkedIssueKey(mr.body) || vcs.extractIssueKeyFromBranch(mr.sourceBranch);
            if (issueKey && /^[A-Z]+-\d+$/.test(issueKey) && jiraClient.isConfigured()) {
              await addCommentToJiraIssue(issueKey, report).catch(() => {});
            }
            mrConflictCounts.delete(mrKey);
          }
          saveReviewerState();
        }
        // Post suggestions as a comment and create a tracking issue
        await postSuggestionsWithTracking(target, vcs, target.name, mr, result);
      } else if (result.recommendation === "ready_for_human_review") {
        // Review recommends human review — don't merge, don't rework, just flag for human
        log.warn(`MR !${mr.number}${tag} flagged for human review — not merging or triggering rework`);
        await vcs.addComment(target.name, mr.number, `## 🟡 ${REVIEW_HUMAN_REVIEW_MARKER}\n\n${result.summary}\n\nThis MR has been reviewed and requires human judgment before merging. No automatic rework will be performed.\n\n${formatAgentStatus(result.agentStatus)}`);
      } else {
        log.rework(`MR !${mr.number}${tag} needs rework — ${result.findings.length} findings (${result.summary})`);
        for (const f of result.findings) {
          log.finding(`[${f.severity}] ${f.category} ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message.slice(0, 100)}`);
        }
        await postReworkPrompt(vcs, target.name, mr, result);
        // Keep in reviewedMRs and reviewedMRShas so we don't re-review
        // until aicoder pushes new commits (SHA changes)
      }
    }
    } // if mrs.length > 0
  }
}

function getVcsClient(target: RepoTarget, config: ReviewerConfig): VcsClient {
  if (target.source === "gitlab") {
    return new GitlabJiraVcsClient(target.gitlabProject || config.gitlabProject);
  }
  return new GithubVcsClient(makeGithubClient(config.githubToken, config.owner));
}

// ── Convert CodeReview findings to ReviewFinding format ────────────────────────
// Implementation lives in src/code-review/findings-adapter.ts (shared with reviewer-config.ts)
import { findingFromText as _findingFromText, codeReviewToFindings as _codeReviewToFindings } from "./code-review/findings-adapter";

function codeReviewToFindings(review: { mustFix?: string[]; securityConcerns?: string[]; migrationRisks?: string[]; shouldFix?: string[]; testGaps?: string[]; observabilityConcerns?: string[] }): ReviewFinding[] {
  return _codeReviewToFindings(review) as ReviewFinding[];
}

/**
 * Resolve the local checkout path for a given target.
 * workspacePath is a base directory (e.g. "../" or "/home/user/repos").
 * The repo name is the last segment of the project path:
 *   siem/hawk-soar-cloud-v3  →  hawk-soar-cloud-v3
 *   AIWorkAssistant          →  AIWorkAssistant
 */
function resolveRepoWorkspace(config: ReviewerConfig, target: RepoTarget): string | undefined {
  if (!config.workspacePath) return undefined;
  const projectPath = target.gitlabProject || target.name;
  const repoName = projectPath.split("/").pop() || projectPath;
  const base = path.resolve(config.workspacePath);
  // If workspacePath already points directly at the repo (ends with repoName), don't append again.
  const lastSegment = path.basename(base);
  const resolved =
    lastSegment.toLowerCase() === repoName.toLowerCase() ? base : path.resolve(base, repoName);
  if (!fs.existsSync(resolved)) {
    log.warn(`Workspace path ${resolved} does not exist — skipping tool-assisted review for ${repoName}`);
    return undefined;
  }
  return resolved;
}

async function runMultiAgentReview(
  config: ReviewerConfig,
  target: RepoTarget,
  mrNumber: number,
  preFetchedDiff?: string,
): Promise<ReviewResult> {
  const remoteUrl = process.env.AIWORKASSISTANT_URL?.replace(/\/$/, "");
  const remoteKey = process.env.AIWORKASSISTANT_API_KEY;

  // When a workspace path is configured, always use the local tool-assisted path.
  // The remote server cannot access the local filesystem, so delegating to it would
  // bypass tool use entirely.
  const repoWorkspace = resolveRepoWorkspace(config, target);
  if (repoWorkspace) {
    log.config(`Workspace configured — using local tool-assisted review (bypassing remote)`);
    return runLocalStreamingReview(config, target, mrNumber, preFetchedDiff);
  }

  // No workspace: delegate to remote server if configured, otherwise review locally
  if (remoteUrl && remoteKey) {
    return runAiReviewStreaming(remoteUrl, remoteKey, target, config, mrNumber);
  }

  return runLocalStreamingReview(config, target, mrNumber, preFetchedDiff);
}

/**
 * Local streaming review — uses reviewAssistant directly with real-time console output.
 */
async function runLocalStreamingReview(
  config: ReviewerConfig,
  target: RepoTarget,
  mrNumber: number,
  preFetchedDiff?: string,
): Promise<ReviewResult> {
  const vcs = getVcsClient(target, config);
  const diff = preFetchedDiff ?? await vcs.getDiff(target.name, mrNumber);

  log.review(`Fetching diff for ${target.source}:${target.name} MR !${mrNumber} (${diff.length} chars)`);
  log.step("Running AI code review with streaming output...");

  const repoWorkspace = resolveRepoWorkspace(config, target);
  if (repoWorkspace) log.config(`Using workspace: ${repoWorkspace}`);

  try {
    const review = await reviewAssistant.reviewWithStreaming(
      target.source === "gitlab"
        ? { projectId: target.gitlabProject || config.gitlabProject, mrIid: mrNumber, workspacePath: repoWorkspace }
        : { owner: config.owner, repo: target.name, prNumber: mrNumber },
      (event: ReviewStreamEvent) => {
        if (event.type === "progress") {
          log.step(`[review] ${event.message}`);
        } else if (event.type === "thinking") {
          // Show a brief snippet of the AI's reasoning
          const snippet = (event.chunk || "").replace(/\n/g, " ").slice(0, 120);
          process.stdout.write(`${C.dim}[review thinking] ${snippet}${C.reset}\n`);
        } else if (event.type === "stream") {
          // Show a brief snippet of the streaming AI output
          const snippet = (event.chunk || "").replace(/\n/g, " ").slice(0, 120);
          process.stdout.write(`${C.dim}[review stream] ${snippet}${C.reset}\n`);
        }
      },
    );

    const findings = codeReviewToFindings(review);

    log.step(`Review complete: ${findings.length} findings, risk=${review.riskLevel}, rec=${review.recommendation}`);

    // Run regression detection to catch accidental feature loss
    const regression = await runRegressionReview(diff, config.regressionAgentCmd);
    findings.push(...regression.findings);
    const hasCriticalOrHigh = findings.some(
      (f) => f.severity === "critical" || f.severity === "high",
    );

    return {
      clean: !hasCriticalOrHigh,
      findings,
      summary: review.suggestedReviewComment || buildSummary(findings),
      recommendation: review.recommendation,
      agentStatus: { regression: regression.status },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Streaming review failed, falling back to heuristic: ${message}`);
    // Fall back to local agent review
    const sec = runAgentReview(diff, "security", config.securityAgentCmd);
    const qa = runAgentReview(diff, "qa", config.qaAgentCmd);
    const qual = runAgentReview(diff, "quality", config.qualityAgentCmd);
    const reg = await runRegressionReview(diff, config.regressionAgentCmd);
    const findings: ReviewFinding[] = [...sec.findings, ...qa.findings, ...qual.findings, ...reg.findings];
    const hasCriticalOrHigh = findings.some((f) => f.severity === "critical" || f.severity === "high");
    return {
      clean: !hasCriticalOrHigh,
      findings,
      summary: buildSummary(findings),
      agentStatus: { security: sec.status, qa: qa.status, quality: qual.status, regression: reg.status },
      recommendation: hasCriticalOrHigh ? "needs_changes" : "ready_for_human_review",
    };
  }
}

/**
 * Remote streaming review — calls the server's SSE endpoint with real-time progress.
 */
async function runAiReviewStreaming(
  remoteUrl: string,
  remoteKey: string,
  target: RepoTarget,
  config: ReviewerConfig,
  prNumber: number,
): Promise<ReviewResult> {
  log.review(`Delegating PR #${prNumber} review to AIWorkAssistant (streaming)`);
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

  // Try the streaming endpoint first
  try {
    const response = await fetch(`${remoteUrl}/api/reviewer/review/stream`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${remoteKey}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok || !response.body) {
      // Streaming not available — fall back to regular endpoint
      log.step("Streaming endpoint not available — using standard review");
      return runAiReview(remoteUrl, remoteKey, target, config, prNumber);
    }

    log.step("Streaming review response...");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalResult: ReviewResult | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process SSE events
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data) continue;

        try {
          const event = JSON.parse(data);
          if (event.type === "progress") {
            log.step(`[review] ${event.message}`);
          } else if (event.type === "thinking") {
            const snippet = (event.chunk || "").replace(/\n/g, " ").slice(0, 120);
            process.stdout.write(`${C.dim}[review thinking] ${snippet}${C.reset}\n`);
          } else if (event.type === "stream") {
            const snippet = (event.chunk || "").replace(/\n/g, " ").slice(0, 120);
            process.stdout.write(`${C.dim}[review stream] ${snippet}${C.reset}\n`);
          } else if (event.type === "result") {
            finalResult = {
              clean: event.data?.clean ?? false,
              findings: event.data?.findings ?? [],
              summary: event.data?.summary ?? buildSummary(event.data?.findings ?? []),
              agentStatus: event.data?.agentStatus,
              recommendation: event.data?.recommendation,
            };
          }
        } catch {
          // Not JSON — skip
        }
      }
    }

    if (finalResult) {
      return finalResult;
    }

    // No result from stream — fall back
    log.warn("Streaming review ended without result — falling back to standard review");
    return runAiReview(remoteUrl, remoteKey, target, config, prNumber);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Streaming review failed: ${message} — falling back to standard review`);
    return runAiReview(remoteUrl, remoteKey, target, config, prNumber);
  }
}

// ---------------------------------------------------------------------------
// Regression detection — AI-driven analysis for accidental feature loss
// ---------------------------------------------------------------------------

const REGRESSION_SYSTEM_PROMPT = `You are a regression detection specialist. Analyze the provided git diff for signs of ACCIDENTAL feature removal — code that was likely deleted unintentionally during a rebase, merge conflict resolution, or refactor.

Do NOT flag intentional cleanup, refactoring, or code that has a clear replacement in the diff.

Look specifically for these patterns:

1. DELETED IMPORTS: An import line removed ("-import ...") where the imported module is not referenced by any added code in the diff.

2. REMOVED ROUTE REGISTRATIONS: Lines like server.register(...), app.get/post/use(...), router.use(...), or express.static(...) that were deleted without replacement.

3. REMOVED INITIALIZATION: Database connection setup, middleware registration, server startup listeners, or async initialization blocks that were deleted.

4. REBASE ARTIFACTS: Large contiguous blocks of deletions (10+ lines) with no corresponding additions nearby — often indicates one side of a conflict was silently dropped.

5. REMOVED EXPORTS: Public function/class/constant exports deleted without replacement or migration.

6. CONFIGURATION/PLUGIN REMOVAL: Module registration, plugin setup, or configuration binding lines removed.

CRITICAL RULES:
- Only flag deletions that appear ACCIDENTAL (no replacement code, no migration in the diff)
- If the deletion is accompanied by new code that replaces it, do NOT flag it
- Test file deletions are nearly always intentional — do NOT flag them
- Doc comment or whitespace-only deletions are never regressions
- Provide the specific file path from the diff header for each finding
- Give line numbers from the @@ hunk headers where possible

Respond with ONLY this JSON structure (no markdown fences, no text before or after):
{
  "findings": [
    {
      "severity": "critical|high|medium|low",
      "file": "path/to/file.ts",
      "line": 45,
      "message": "Brief description of what was removed and why it looks accidental",
      "suggestion": "Specific action to verify or restore the removed code"
    }
  ]
}

If no regressions are detected, return: {"findings": []}`;

async function runRegressionReview(
  diff: string,
  regressionAgentCmd: string,
): Promise<{ findings: ReviewFinding[]; status: "passed" | "failed" }> {
  // Delegate to external CLI if configured
  if (regressionAgentCmd) {
    return runAgentReview(diff, "regression", regressionAgentCmd);
  }

  // Use AI client directly
  if (!aiClient.isConfigured()) {
    return {
      status: "failed",
      findings: [{
        severity: "medium",
        category: "regression",
        file: "*",
        message: "Regression analysis skipped — AI client not configured",
        suggestion: "Review the diff manually for accidental feature removals, especially in server entry points and route files.",
      }],
    };
  }

  try {
    const response = await aiClient.chat({
      messages: [
        { role: "system", content: REGRESSION_SYSTEM_PROMPT },
        { role: "user", content: diff },
      ],
      temperature: 0.3,
      maxTokens: 16384,
      jsonMode: true,
    });

    const content = response.content.trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const findings: ReviewFinding[] = (parsed.findings || []).map((f: any) => ({
        severity: f.severity || "medium",
        category: "regression" as const,
        file: f.file || "unknown",
        line: f.line,
        message: f.message || "Potential regression detected",
        suggestion: f.suggestion || "Review this deletion to confirm it was intentional.",
      }));
      return { findings, status: "passed" };
    }

    return {
      status: "failed",
      findings: [{
        severity: "medium",
        category: "regression",
        file: "*",
        message: "Regression analysis could not parse AI response",
        suggestion: "Review the diff manually for accidental feature removals.",
      }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Regression agent failed: ${message}`);
    return {
      status: "failed",
      findings: [{
        severity: "medium",
        category: "regression",
        file: "*",
        message: `Regression analysis unavailable: ${message}`,
        suggestion: "Review the diff manually for signs of accidental feature removal before merging.",
      }],
    };
  }
}

function runAgentReview(
  diff: string,
  category: "security" | "qa" | "quality" | "regression",
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
  if (!agentStatus) return "**Review agents:** Security ✓ | QA ✓ | Quality ✓ | Regression ✓";
  const fmt = (cat: string, label: string) =>
    agentStatus[cat] === "failed" ? `${label} ✗ (failed)` : `${label} ✓`;
  return `**Review agents:** ${fmt("security", "Security")} | ${fmt("qa", "QA")} | ${fmt("quality", "Quality")} | ${fmt("regression", "Regression")}`;
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
  source: SourceType,
  owner: string,
  githubToken: string,
  mr: { number: number; title: string; body?: string | null; sourceBranch?: string },
  result: ReviewResult,
): Promise<"merged" | "conflict" | "failed"> {
  const agentLine = formatAgentStatus(result.agentStatus);
  try {
    await vcs.addComment(
      project,
      mr.number,
      `## ✅ Review Passed — Merging\n\n${result.summary}\n\n${agentLine}\n\nMerging now.`,
    );

    // Post the same review comment to the original source issue for continuity
    const reviewComment = `## ✅ Review Passed — Merged\n\n${result.summary}\n\n${agentLine}\n\nMR has been reviewed and merged.`;
    await postReviewToSourceIssue(vcs, project, mr, reviewComment);

    // Retry up to 3 times on 422 — GitLab sometimes returns 422 transiently while
    // computing mergeability (pipeline checks, branch protection status, etc.).
    const MAX_MERGE_RETRIES = 3;
    const RETRY_DELAY_MS = 5000;
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= MAX_MERGE_RETRIES; attempt++) {
      try {
        await vcs.merge(project, mr.number, `Merge [AI] ${mr.title}`, result.summary);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        const is422 = /status code 422|422/.test(lastErr.message);
        if (is422 && attempt < MAX_MERGE_RETRIES) {
          log.warn(`MR !${mr.number} merge returned 422 — retrying in ${RETRY_DELAY_MS / 1000}s (attempt ${attempt}/${MAX_MERGE_RETRIES})`);
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        } else {
          break;
        }
      }
    }
    if (lastErr) throw lastErr;

    log.merge(`MR !${mr.number} merged in ${project}`);

    // Close the originating source issue now that the MR is confirmed merged.
    const issueKey = vcs.extractLinkedIssueKey(mr.body ?? null)
      || vcs.extractIssueKeyFromBranch(mr.sourceBranch);
    if (issueKey) {
      const isJira = /^[A-Z]+-\d+$/.test(issueKey);
      const isGithub = source === "github";
      await closeSourceIssue(
        {
          source: isJira ? "jira" : isGithub ? "github" : "gitlab",
          issueKey: isJira
            ? issueKey
            : isGithub
              ? `${owner}/${project}#${issueKey}`
              : `${project}#${issueKey}`,
          mrIid: mr.number,
        },
        jiraClient,
        !isGithub && gitlabClient.isConfigured() ? gitlabClient : null,
        isGithub ? (makeGithubClient(githubToken, owner) as any) : null,
      ).catch((err) => {
        log.warn(`Could not close source issue ${issueKey} after merge: ${err instanceof Error ? err.message : err}`);
      });
    }

    return "merged";
  } catch (mergeErr) {
    const errMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
    const isConflict = /conflict|cannot_be_merged|rebase failed/i.test(errMsg);
    const isPipelineBlocked = /pipeline.*running|merge_when_pipeline|merge not allowed.*pipeline/i.test(errMsg);
    const is422 = /status code 422|422/.test(errMsg);
    log.error(`Failed to merge MR !${mr.number}: ${errMsg}${is422 ? " (422 — MR may need approval, pipeline must pass, or branch protection applies — retry or merge manually)" : ""}`);

    if (isConflict) {
      await vcs.addComment(
        project,
        mr.number,
        `## ⚠️ Review Passed — ${REVIEW_MERGE_CONFLICT_MARKER}\n\n${result.summary}\n\n${agentLine}\n\nMerge could not be completed due to conflicts with the base branch: ${errMsg}\n\nThe autonomous agent will attempt to rebase and resolve conflicts.`,
      ).catch(() => {});
      // Post review to source issue even when merge conflicts — the review itself was clean
      await postReviewToSourceIssue(vcs, project, mr,
        `## ⚠️ Review Passed — Merge Conflict\n\n${result.summary}\n\n${agentLine}\n\nMerge failed due to conflicts: ${errMsg}`).catch(() => {});
      return "conflict";
    } else if (isPipelineBlocked) {
      await vcs.addComment(
        project,
        mr.number,
        `## ⏳ Review Passed — Merge Pending Pipeline\n\n${result.summary}\n\n${agentLine}\n\nMerge is waiting for the pipeline to complete: ${errMsg}\n\nThis MR will be merged automatically when the pipeline succeeds.`,
      ).catch(() => {});
      return "merged";
    } else {
      await vcs.addComment(
        project,
        mr.number,
        `## ⚠️ Review Passed — Merge Failed\n\n${result.summary}\n\n${agentLine}\n\nMerge could not be completed automatically: ${errMsg}\n\nManual merge required.`,
      ).catch(() => {});
      // Post review to source issue even when merge fails — the review itself passed
      await postReviewToSourceIssue(vcs, project, mr,
        `## ⚠️ Review Passed — Merge Failed\n\n${result.summary}\n\n${agentLine}\n\nMerge failed: ${errMsg}`).catch(() => {});
      return "failed";
    }
  }
}

/**
 * Post the same review comment to the original source issue that was posted on the MR/PR.
 * This ensures the issue tracker has a complete record of what happened during review.
 */
async function postReviewToSourceIssue(
  vcs: VcsClient,
  project: string,
  mr: { number: number; title: string; body?: string | null; sourceBranch?: string },
  reviewComment: string,
): Promise<void> {
  let issueKey = vcs.extractLinkedIssueKey(mr.body ?? null);
  if (!issueKey) {
    issueKey = vcs.extractIssueKeyFromBranch(mr.sourceBranch);
  }
  if (!issueKey) {
    log.warn(`MR !${mr.number} has no linked issue — cannot post review comment to source issue`);
    return;
  }

  // Add MR reference header to the comment for the issue
  const issueBody = `## Review Complete for MR !${mr.number}\n\n${reviewComment}`;

  const isJiraKey = /^[A-Z]+-\d+$/.test(issueKey);
  if (isJiraKey && jiraClient.isConfigured()) {
    await addCommentToJiraIssue(issueKey, issueBody);
    log.jira(`Posted review summary on Jira ${issueKey} for MR !${mr.number}`);
  } else if (isJiraKey) {
    log.warn(`Jira not configured — cannot post review to ${issueKey}`);
  } else {
    const issueNumber = parseInt(issueKey, 10);
    if (isNaN(issueNumber)) {
      log.warn(`Could not parse issue number from key "${issueKey}"`);
      return;
    }
    await vcs.addCommentToIssue(project, issueNumber, issueBody);
    log.rework(`Posted review summary on issue #${issueNumber} for MR !${mr.number}`);
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

  // Determine if this is a Jira key (e.g. IR-63) or a numeric issue (e.g. #42).
  // Branch names like ai/issue-106-... extract as plain numbers. When Jira is
  // configured, reconstruct the full key using JIRA_PROJECT so the label lands
  // on the right Jira ticket instead of going to the no-op GitLab path.
  let isJiraKey = /^[A-Z]+-\d+$/.test(issueKey);
  if (!isJiraKey && /^\d+$/.test(issueKey) && jiraClient.isConfigured()) {
    const jiraProject = process.env.JIRA_PROJECT || process.env.JIRA_DEFAULT_PROJECT || "";
    if (jiraProject) {
      issueKey = `${jiraProject}-${issueKey}`;
      isJiraKey = true;
      log.config(`Reconstructed Jira key from numeric branch: ${issueKey}`);
    }
  }

  // Convergence guard: if aicoder already exhausted its retry budget for this issue,
  // do not re-add the ready-for-agent label — that would restart the loop indefinitely.
  // Post the findings as a comment only, and flag for human review.
  if (isJiraKey) {
    const convState = loadConvergenceState(issueKey);
    if (convState.roundNumber > 0) {
      const convCheck = checkConvergence(convState, DEFAULT_CONVERGENCE_CONFIG);
      if (convCheck.shouldStop) {
        log.warn(`Convergence already fired for ${issueKey} (${convCheck.reason}, round ${convState.roundNumber}) — posting findings as comment only, NOT re-labeling ready-for-agent`);
        await addCommentToJiraIssue(
          issueKey,
          `## ⚠️ Review Findings — Human Review Required\n\nThe autonomous agent has exhausted its retry budget for this issue (${convCheck.reason} after ${convState.roundNumber} rounds). The following findings were identified but could not be automatically resolved:\n\n${buildReworkPrompt(result)}\n\n**Please review manually.**`,
        );
        return;
      }
    }
    await addCommentToJiraIssue(issueKey, buildReworkPrompt(result));
    // Also post the review findings to the source issue for continuity
    await postReviewToSourceIssue(vcs, project, mr, formatReviewFindings(result));
    await addLabelToJiraIssue(issueKey, "ready-for-agent");
    log.rework(`Posted rework prompt on Jira ${issueKey} for MR !${mr.number}`);
  } else {
    // Numeric GitHub issue
    const issueNumber = parseInt(issueKey, 10);
    await vcs.addCommentToIssue(project, issueNumber, buildReworkPrompt(result));
    // Also post the review findings to the source issue for continuity
    await postReviewToSourceIssue(vcs, project, mr, formatReviewFindings(result));
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
  // Test gaps (medium/qa) are listed first — they are the most commonly skipped
  // because the agent prioritizes code fixes. Putting them first ensures they
  // are addressed before the agent runs out of turns.
  const testGapTasks = result.findings
    .filter((f) => f.severity === "medium" && f.category === "qa")
    .map((f) => `- Write tests for ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}`);

  const blockingTasks = result.findings
    .filter((f) => f.severity === "critical" || f.severity === "high")
    .map(
      (f) =>
        `- Fix [${f.severity}] ${f.category} issue in ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}`,
    );

  const testSection = testGapTasks.length > 0
    ? `### Required Tests (do these first)\n\n${testGapTasks.join("\n")}\n\n`
    : "";

  const fixSection = blockingTasks.length > 0
    ? `### Required Fixes\n\n${blockingTasks.join("\n")}\n`
    : "";

  // Include the AI-generated review comment as the primary guidance — it contains
  // specific, actionable suggestions that the structured findings list cannot carry.
  const reviewGuidance = result.summary && result.summary !== buildSummary(result.findings)
    ? `\n### Reviewer Notes\n\n${result.summary}\n`
    : "";

  return `## Coding Prompt\n\n### Rework from PR Review\n\nThe following must be completed before merge:\n\n${testSection}${fixSection}${reviewGuidance}\n### Reasoning\nThese findings were identified by the security, QA, code quality, and regression review agents. All critical and high severity issues must be resolved and all test gaps must be filled. Re-run the full implementation addressing each item.`;
}

async function postSuggestionsWithTracking(
  target: RepoTarget,
  vcs: VcsClient,
  project: string,
  mr: { number: number; title: string; body: string | null; sourceBranch?: string },
  result: ReviewResult,
): Promise<void> {
  // Post suggestions as a comment on the MR
  const suggestionLines = result.findings.map(
    (f) =>
      `- **[${f.severity.toUpperCase()}]** [${f.category}] ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}\n  → Suggestion: ${f.suggestion}`,
  );
  const commentBody = `## ✅ Review Passed with Suggestions\n\n${result.summary}\n\nNo blocking (critical/high) findings were identified. The suggestions below are non-blocking improvements:\n\n${suggestionLines.join("\n")}\n\nA tracking item has been created for these suggestions.`;
  await vcs.addComment(project, mr.number, commentBody);

  // Determine the origin issue key from the MR body or branch
  let issueKey = vcs.extractLinkedIssueKey(mr.body);
  if (!issueKey) {
    issueKey = vcs.extractIssueKeyFromBranch(mr.sourceBranch);
  }

  const isJiraKey = issueKey ? /^[A-Z]+-\d+$/.test(issueKey) : false;
  const suggestionComment = buildSuggestionComment(result);

  if (isJiraKey && jiraClient.isConfigured()) {
    // Origin is Jira — post suggestions on the Jira ticket
    await addCommentToJiraIssue(issueKey!, suggestionComment);
    log.jira(`Posted suggestions on Jira ${issueKey} for MR !${mr.number}`);
  } else if (target.source === "gitlab") {
    // Origin is GitLab — create a GitLab issue for tracking
    const gitlabProject = target.gitlabProject || project;
    try {
      const issue = await gitlabClient.createIssue(gitlabProject, {
        title: `[Review Suggestions] MR !${mr.number}: ${mr.title}`,
        description: buildSuggestionIssueBody(mr, result),
        labels: "review-suggestions",
      });
      log.gitlab(`Created GitLab tracking issue #${issue.iid} for MR !${mr.number} suggestions`);
    } catch (err) {
      log.warn(`Could not create GitLab tracking issue: ${err instanceof Error ? err.message : err}`);
    }
  } else if (issueKey && /^\d+$/.test(issueKey)) {
    // Origin is a GitHub issue — post suggestions as a comment on the linked issue
    await vcs.addCommentToIssue(project, parseInt(issueKey, 10), suggestionComment);
    log.rework(`Posted suggestions on GitHub issue #${issueKey} for MR !${mr.number}`);
  } else {
    log.warn(`MR !${mr.number} has no linked issue — cannot create tracking item for suggestions`);
  }
}

function buildSuggestionComment(result: ReviewResult): string {
  const items = result.findings.map(
    (f) =>
      `- [${f.severity.toUpperCase()}/${f.category}] ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}\n  Suggestion: ${f.suggestion}`,
  );
  return `## Non-blocking Review Suggestions\n\nThe following suggestions were noted during review but are not blocking:\n\n${items.join("\n")}\n\nThese can be addressed in a future iteration.`;
}

function buildSuggestionIssueBody(
  mr: { number: number; title: string },
  result: ReviewResult,
): string {
  const items = result.findings.map(
    (f) =>
      `- [${f.severity.toUpperCase()}/${f.category}] ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}\n  Suggestion: ${f.suggestion}`,
  );
  return `## Non-blocking Review Suggestions for MR !${mr.number}\n\nOrigin: ${mr.title}\n\n${items.join("\n")}\n\nThese suggestions were identified during code review but are not blocking.`;
}

/**
 * Search all configured targets for the given MR number.
 * Returns the first match along with its target and VCS client.
 * For GitLab, also tries the repo's own name as the project ID since
 * parseRepoTargets may assign the wrong defaultGitlabProject.
 */
async function findMrAcrossTargets(
  config: ReviewerConfig,
  mrNumber: number,
): Promise<{ mr: MergeRequest; target: RepoTarget; vcs: VcsClient } | null> {
  const targets = parseRepoTargets(config.reviewRepos, config.source, config.gitlabProject);

  // Prefer GitLab targets; for each, try both the configured gitlabProject and the
  // repo name itself (which may be the actual project path, e.g. siem/hawk-soar-cloud-v3)
  for (const target of targets) {
    const candidateProjects = new Set<string>();
    if (target.gitlabProject) candidateProjects.add(target.gitlabProject);
    if (target.source === "gitlab" && target.name.includes("/")) candidateProjects.add(target.name);

    for (const project of candidateProjects) {
      const syntheticTarget: RepoTarget = { ...target, gitlabProject: project };
      const vcs = getVcsClient(syntheticTarget, config);
      try {
        const mrs = await vcs.listOpenMergeRequests(syntheticTarget.name);
        const mr = mrs.find((m) => m.number === mrNumber);
        if (mr) return { mr, target: syntheticTarget, vcs };
      } catch {
        // try next candidate
      }
    }
    // Non-GitLab targets have no candidateProjects — try the target directly
    if (candidateProjects.size === 0) {
      const vcs = getVcsClient(target, config);
      try {
        const mrs = await vcs.listOpenMergeRequests(target.name);
        const mr = mrs.find((m) => m.number === mrNumber);
        if (mr) return { mr, target, vcs };
      } catch {
        // try next target
      }
    }
  }
  return null;
}

async function forceReviewMr(mrNumber: number): Promise<void> {
  loadReviewerState();
  const config = await loadConfig();

  const found = await findMrAcrossTargets(config, mrNumber);
  if (!found) {
    log.error(`MR !${mrNumber} not found in any configured target — it may be already merged or closed`);
    process.exit(1);
  }
  const { mr, target, vcs } = found;
  log.config(`Found MR !${mrNumber} in ${target.source}:${target.gitlabProject || target.name}`);

  const mrKey = `${target.source}:${target.gitlabProject || target.name}/${mrNumber}`;
  reviewedMRs.delete(mrKey);
  reviewedMRShas.delete(mrKey);
  reviewedMRTimes.delete(mrKey);
  mrSkipCounts.delete(mrKey);
  mrConflictCounts.delete(mrKey);
  saveReviewerState();
  log.config(`Cleared cached state for MR !${mrNumber}`);

  const diff = await vcs.getDiff(target.name, mrNumber);
  if (!diff || diff.trim().length === 0) {
    log.warn(`MR !${mrNumber} has no diff — nothing to review`);
    process.exit(0);
  }

  log.review(`Running review for MR !${mrNumber} in ${target.source}:${target.gitlabProject || target.name}`);
  const result = await runMultiAgentReview(config, target, mrNumber, diff);

  const currentSha = await vcs.getLatestCommitSha(target.name, mrNumber).catch(() => undefined);
  if (currentSha) reviewedMRShas.set(mrKey, currentSha);
  reviewedMRs.add(mrKey);
  saveReviewerState();

  if (result.clean || (result.findings.every((f) => f.severity === "medium" || f.severity === "low") &&
      !result.findings.some((f) => f.severity === "medium" && f.category === "qa"))) {
    log.clean(`MR !${mrNumber} is clean — merging`);
    await mergeWithSummary(vcs, target.name, target.source, config.owner, config.githubToken, mr, result);
  } else {
    log.rework(`MR !${mrNumber} has ${result.findings.length} findings — posting rework`);
    for (const f of result.findings) {
      log.finding(`  [${f.severity}] ${f.category} ${f.file}: ${f.message.slice(0, 100)}`);
    }
    await postReworkPrompt(vcs, target.name, mr, result);
  }
}

async function forceMergeMr(mrNumber: number): Promise<void> {
  loadReviewerState();
  const config = await loadConfig();

  const found = await findMrAcrossTargets(config, mrNumber);
  if (!found) {
    log.error(`MR !${mrNumber} not found in any configured target — it may be already merged or closed`);
    process.exit(1);
  }
  const { mr, target, vcs } = found;
  log.config(`Force-merging MR !${mrNumber}: ${mr.title}`);
  const status = await mergeWithSummary(vcs, target.name, target.source, config.owner, config.githubToken, mr, {
    clean: true,
    findings: [],
    summary: "Force-merged via `reviewer --merge-mr`",
    recommendation: "approve",
  });
  if (status === "merged") {
    log.clean(`MR !${mrNumber} merged`);
  } else {
    log.error(`MR !${mrNumber} merge ${status} — check the MR on GitLab for details`);
    process.exit(1);
  }
}

/**
 * Apply --provider and --model CLI overrides by setting process.env before
 * the provider singleton is used. Then refresh the cached aiClient so it
 * picks up the new env values.
 */
function applyProviderOverrides(): void {
  const provider = ARGV.provider as string | undefined;
  const model = ARGV.model as string | undefined;
  const url = ARGV.url as string | undefined;
  if (!provider && !model && !url) return;

  if (provider) {
    const valid = ["opencode", "zai", "ollama", "openai"];
    if (!valid.includes(provider)) {
      log.error(`Unknown provider "${provider}". Valid: ${valid.join(", ")}`);
      process.exit(1);
    }
    process.env.AI_PROVIDER = provider;
  }

  if (model) {
    const resolvedProvider = (provider || process.env.AI_PROVIDER || "opencode").toLowerCase();
    switch (resolvedProvider) {
      case "zai":
        process.env.ZAI_MODEL = model;
        break;
      case "ollama":
        process.env.OLLAMA_MODEL = model;
        break;
      case "openai":
        process.env.OPENAI_MODEL = model;
        break;
      default:
        process.env.OPENCODE_MODEL = model;
        break;
    }
  }

  if (url) {
    const resolvedProvider = (provider || process.env.AI_PROVIDER || "opencode").toLowerCase();
    switch (resolvedProvider) {
      case "zai":
        process.env.ZAI_API_URL = url;
        break;
      case "ollama":
        process.env.OLLAMA_API_URL = url;
        break;
      case "openai":
        process.env.OPENAI_API_URL = url;
        break;
      default:
        process.env.OPENCODE_API_URL = url;
        break;
    }
  }

  // Refresh the cached provider singleton so it picks up the overridden env vars
  aiClient.refresh();

  const providerName = aiClient.providerName;
  const modelName = aiClient.modelName || model || "(default)";
  log.config(`Provider override: ${providerName} / ${modelName}`);
}

async function main(): Promise<void> {
  // Apply --provider/--model overrides before any provider usage
  applyProviderOverrides();

  // One-shot commands — handle and exit before entering the poll loop
  const reviewMr = ARGV["review-mr"] ? parseInt(ARGV["review-mr"], 10) : null;
  const mergeMr = ARGV["merge-mr"] ? parseInt(ARGV["merge-mr"], 10) : null;
  if (reviewMr !== null) { await forceReviewMr(reviewMr); process.exit(0); }
  if (mergeMr !== null) { await forceMergeMr(mergeMr); process.exit(0); }

  log.start("AIWorkAssistant review agent started");
  loadReviewerState();
  const config = await loadConfig();

  // Verify saved SHAs against remote — re-review any MRs that have new commits
  await verifyReviewerState(config);

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
    if (config.pollIntervalMs === 0) {
      log.config("poll-ms=0: one-shot mode — exiting after first cycle");
      break;
    }
    const waitMs = currentPollIntervalMs ?? config.pollIntervalMs;
    if (currentPollIntervalMs !== null) {
      log.poll(`Backoff active — next poll in ${Math.round(waitMs / 1000)}s (base: ${config.pollIntervalMs / 1000}s)`);
    }
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

main();