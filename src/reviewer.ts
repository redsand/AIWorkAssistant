#!/usr/bin/env tsx
import "dotenv/config";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import axios from "axios";
import { gitlabClient } from "./integrations/gitlab/gitlab-client";
import { jiraClient } from "./integrations/jira/jira-client";
import { reviewAssistant } from "./code-review/review-assistant";
import type { ReviewStreamEvent } from "./code-review/review-assistant";
import { parseReviewFindings } from "./autonomous-loop/review-findings-parser";
import { recordGateFindings } from "./autonomous-loop/review-gate-state";
import { formatConvergenceReport, initConvergenceState, recordRoundFindings, checkConvergence, DEFAULT_CONVERGENCE_CONFIG } from "./autonomous-loop/convergence";
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
const mrSkipCounts = new Map<string, number>(); // mrKey → consecutive SHA-unchanged skips

/** Stop polling an MR after this many consecutive SHA-unchanged skips. */
const MAX_CONSECUTIVE_SKIPS = parseInt(process.env.MAX_CONSECUTIVE_SKIPS ?? "5", 10);

/** Backoff bounds for the outer poll loop when MRs are being skipped. */
const BASE_POLL_INTERVAL_MS = 30_000;
const MAX_POLL_INTERVAL_MS = 300_000;
let currentPollIntervalMs: number | null = null; // null = use config.pollIntervalMs

// ── Persistent reviewer state ────────────────────────────────────────────────
const REVIEWER_STATE_FILE = path.join(process.cwd(), ".aicoder", "reviewer-state.json");

interface ReviewerState {
  reviewedMRs: string[];
  reviewedMRShas: Record<string, string>;
  updatedAt: string;
}

function loadReviewerState(): void {
  try {
    if (fs.existsSync(REVIEWER_STATE_FILE)) {
      const data: ReviewerState = JSON.parse(fs.readFileSync(REVIEWER_STATE_FILE, "utf-8"));
      if (data.reviewedMRs) {
        data.reviewedMRs.forEach((key: string) => reviewedMRs.add(key));
      }
      if (data.reviewedMRShas) {
        Object.entries(data.reviewedMRShas).forEach(([key, sha]: [string, string]) => {
          reviewedMRShas.set(key, sha);
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
    if (currentSha && currentSha !== savedSha) {
      log.review(`MR !${mrNumber} SHA changed (${savedSha.slice(0, 8)} → ${currentSha.slice(0, 8)}) — scheduling re-review`);
      keysToReReview.push(mrKey);
    }
  }

  for (const key of keysToReReview) {
    reviewedMRs.delete(key);
    reviewedMRShas.delete(key);
  }

  if (keysToReReview.length > 0) {
    saveReviewerState();
  }
}

function saveReviewerState(): void {
  try {
    const dir = path.dirname(REVIEWER_STATE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const state: ReviewerState = {
      reviewedMRs: [...reviewedMRs],
      reviewedMRShas: Object.fromEntries(reviewedMRShas),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(REVIEWER_STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
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
            mrSkipCounts.delete(mrKey);
            // SHA changed → reset backoff
            currentPollIntervalMs = null;
          } else {
            // SHA unchanged — increment skip counter
            const skipCount = (mrSkipCounts.get(mrKey) ?? 0) + 1;
            mrSkipCounts.set(mrKey, skipCount);
            log.skip(`MR !${mr.number} already reviewed (SHA unchanged) — waiting for rework [skip ${skipCount}/${MAX_CONSECUTIVE_SKIPS}]`);

            if (skipCount >= MAX_CONSECUTIVE_SKIPS) {
              // Too many consecutive skips — stop polling this MR and report to Jira
              log.warn(`MR !${mr.number} skipped ${skipCount} times with no rework — posting convergence report`);

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

              // Clear state so the next aicoder push picks a clean slate
              reviewedMRs.delete(mrKey);
              reviewedMRShas.delete(mrKey);
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
          log.skip(`MR !${mr.number} already reviewed — waiting for rework`);
          continue;
        }
      }

      log.review(`Found AI MR !${mr.number} in ${target.source}:${target.name}: ${mr.title}`);
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
        recordGateFindings(gateFindings);
        log.step(`Persisted ${gateFindings.length} findings to review gate state`);
      }

      // Record the current commit SHA so we can detect when aicoder pushes rework
      const currentSha = await vcs.getLatestCommitSha(target.name, mr.number).catch(() => undefined);
      if (currentSha) {
        reviewedMRShas.set(mrKey, currentSha);
        log.sha(`MR !${mr.number} SHA: ${currentSha.slice(0, 8)}`);
      }

      reviewedMRs.add(mrKey);
      saveReviewerState();

      if (result.clean) {
        log.clean(`MR !${mr.number} passed review — merging`);
        const mergeStatus = await mergeWithSummary(vcs, target.name, mr, result);
        if (mergeStatus === "conflict") {
          // Remove from reviewed so the reviewer re-evaluates after aicoder rebases
          reviewedMRs.delete(mrKey);
          saveReviewerState();
        }
      } else if (isServiceUnavailable(result)) {
        log.warn(`MR !${mr.number} review service unavailable — postponing`);
        await postPostponed(vcs, target.name, mr, result);
        // Remove SHA so we don't skip on retry — the review didn't actually complete
        reviewedMRShas.delete(mrKey);
        reviewedMRs.delete(mrKey);
        saveReviewerState();
      } else if (result.findings.every((f) => f.severity === "medium" || f.severity === "low")) {
        // Only medium/low findings — approve with comments and create a tracking issue
        log.clean(`MR !${mr.number} passed review with comments — no critical/high findings, merging`);
        const mergeResult = await mergeWithSummary(vcs, target.name, mr, {
          ...result,
          clean: true,
          summary: `${result.summary} (approved with suggestions — no blocking findings)`,
        });
        if (mergeResult === "conflict") {
          reviewedMRs.delete(mrKey);
          saveReviewerState();
        }
        // Post suggestions as a comment and create a tracking issue
        await postSuggestionsWithTracking(target, vcs, target.name, mr, result);
      } else if (result.recommendation === "ready_for_human_review") {
        // Review recommends human review — don't merge, don't rework, just flag for human
        log.warn(`MR !${mr.number} flagged for human review — not merging or triggering rework`);
        await vcs.addComment(target.name, mr.number, `## 🟡 ${REVIEW_HUMAN_REVIEW_MARKER}\n\n${result.summary}\n\nThis MR has been reviewed and requires human judgment before merging. No automatic rework will be performed.\n\n${formatAgentStatus(result.agentStatus)}`);
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

// ── Convert CodeReview findings to ReviewFinding format ────────────────────────
function codeReviewToFindings(review: { mustFix?: string[]; securityConcerns?: string[]; migrationRisks?: string[]; shouldFix?: string[]; testGaps?: string[]; observabilityConcerns?: string[] }): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  const add = (
    items: string[],
    severity: ReviewFinding["severity"],
    category: ReviewFinding["category"],
  ) => {
    for (const text of items) {
      findings.push({
        severity,
        category,
        file: "unknown",
        message: text,
        suggestion: "See the full review comment on the PR.",
      });
    }
  };

  add(review.mustFix || [], "critical", "quality");
  add(review.securityConcerns || [], "high", "security");
  add(review.migrationRisks || [], "high", "quality");
  add(review.shouldFix || [], "medium", "quality");
  add(review.testGaps || [], "medium", "qa");
  add(review.observabilityConcerns || [], "low", "quality");

  return findings;
}

async function runMultiAgentReview(
  config: ReviewerConfig,
  target: RepoTarget,
  mrNumber: number,
  preFetchedDiff?: string,
): Promise<ReviewResult> {
  const remoteUrl = process.env.AIWORKASSISTANT_URL?.replace(/\/$/, "");
  const remoteKey = process.env.AIWORKASSISTANT_API_KEY;

  // For remote review, delegate to the server with streaming
  if (remoteUrl && remoteKey) {
    return runAiReviewStreaming(remoteUrl, remoteKey, target, config, mrNumber);
  }

  // Local review: use pre-fetched diff or fetch it
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

  try {
    const review = await reviewAssistant.reviewWithStreaming(
      target.source === "gitlab"
        ? { projectId: target.gitlabProject || config.gitlabProject, mrIid: mrNumber }
        : { owner: config.owner, repo: target.name, prNumber: mrNumber },
      (event: ReviewStreamEvent) => {
        if (event.type === "progress") {
          log.step(`[review] ${event.message}`);
        } else if (event.type === "stream") {
          // Show a brief snippet of the streaming AI output
          const snippet = (event.chunk || "").replace(/\n/g, " ").slice(0, 120);
          process.stdout.write(`${C.dim}[review stream] ${snippet}${C.reset}\n`);
        }
      },
    );

    const findings = codeReviewToFindings(review);
    const hasCriticalOrHigh = findings.some(
      (f) => f.severity === "critical" || f.severity === "high",
    );

    log.step(`Review complete: ${findings.length} findings, risk=${review.riskLevel}, rec=${review.recommendation}`);

    return {
      clean: !hasCriticalOrHigh,
      findings,
      summary: review.suggestedReviewComment || buildSummary(findings),
      recommendation: review.recommendation,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Streaming review failed, falling back to heuristic: ${message}`);
    // Fall back to local agent review
    const sec = runAgentReview(diff, "security", config.securityAgentCmd);
    const qa = runAgentReview(diff, "qa", config.qaAgentCmd);
    const qual = runAgentReview(diff, "quality", config.qualityAgentCmd);
    const findings: ReviewFinding[] = [...sec.findings, ...qa.findings, ...qual.findings];
    const hasCriticalOrHigh = findings.some((f) => f.severity === "critical" || f.severity === "high");
    return {
      clean: !hasCriticalOrHigh,
      findings,
      summary: buildSummary(findings),
      agentStatus: { security: sec.status, qa: qa.status, quality: qual.status },
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
    await vcs.merge(project, mr.number, `Merge [AI] ${mr.title}`, result.summary);
    log.merge(`MR !${mr.number} merged in ${project}`);

    // Close the originating source issue now that the MR is confirmed merged.
    const issueKey = vcs.extractLinkedIssueKey(mr.body ?? null)
      || vcs.extractIssueKeyFromBranch(mr.sourceBranch);
    if (issueKey) {
      const isJira = /^[A-Z]+-\d+$/.test(issueKey);
      await closeSourceIssue(
        {
          source: isJira ? "jira" : "gitlab",
          issueKey: isJira ? issueKey : `${project}#${issueKey}`,
          mrIid: mr.number,
        },
        jiraClient,
        gitlabClient.isConfigured() ? gitlabClient : null,
        null,
      ).catch((err) => {
        log.warn(`Could not close source issue ${issueKey} after merge: ${err instanceof Error ? err.message : err}`);
      });
    }

    return "merged";
  } catch (mergeErr) {
    const errMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
    const isConflict = /conflict|cannot_be_merged|rebase failed/i.test(errMsg);
    const isPipelineBlocked = /pipeline.*running|merge_when_pipeline|merge not allowed.*pipeline/i.test(errMsg);
    log.merge(`Failed to merge MR !${mr.number}: ${errMsg}`);

    if (isConflict) {
      await vcs.addComment(
        project,
        mr.number,
        `## ⚠️ Review Passed — ${REVIEW_MERGE_CONFLICT_MARKER}\n\n${result.summary}\n\n${agentLine}\n\nMerge could not be completed due to conflicts with the base branch: ${errMsg}\n\nThe autonomous agent will attempt to rebase and resolve conflicts.`,
      ).catch(() => {});
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

async function main(): Promise<void> {
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