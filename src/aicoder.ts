#!/usr/bin/env tsx
import "dotenv/config";
import { spawn, spawnSync } from "child_process";
import axios from "axios";
import { OllamaLauncher } from "./integrations/ollama-launcher";
import { RunLogger } from "./integrations/ollama-launcher/run-logger";
import { prioritizeItems, type PriorityMode } from "./integrations/ollama-launcher/priority-sorter";
import { type TicketSourceType, type LookupMode } from "./integrations/source-resolver";
import type { ProviderType } from "./integrations/ollama-launcher";

function parseArgv(): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(`
aicoder — AiRemoteCoder autonomous coding agent

Usage: aicoder [options]

Options:
  --workspace <path>   Target project directory for git operations (default: cwd)
  --source <type>      Issue source: github | gitlab | jira | jitbit | auto (default: auto)
  --owner <name>       GitHub/GitLab owner (overrides server default)
  --repo <name>        Repository/project name (overrides server default)
  --agent <name>       Coding agent: codex | opencode | claude (default: claude)
  --ollama             Route agent through Ollama launcher (sets OPENAI_BASE_URL, etc.)
  --model <name>       Override model for the agent (e.g. glm-5.1:cloud)
  --label <label>      Issue label to filter (default: ready-for-agent)
  --priority <mode>    Ticket priority: label | auto (default: label)
  --lookup <mode>      Source auto-detect mode: memory | llm (default: memory)
  --poll-ms <ms>       Poll interval in milliseconds (default: 60000)
  --max-cycles <n>     Stop after n work cycles (0 = unlimited)
  --issue <number>     Work on a specific issue by number (skips polling, runs once)
  --base <branch>      Base branch to start from (default: main). Use this to chain PRs.
  --poll                Use legacy fire-and-forget poll mode (default: focused mode)
  --max-rework <n>      Max rework cycles per issue in focused mode (default: 5)
  --review-poll-ms <ms> Review result poll interval in focused mode (default: 30000)
  --wait-for-deps       Wait for unresolved dependencies instead of skipping
  --help                Show this help

Remote config (fetches everything else from AIWorkAssistant):
  AIWORKASSISTANT_URL      Base URL of the server (default: http://localhost:3050)
  AIWORKASSISTANT_API_KEY  API key for authentication (required)
`);
      process.exit(0);
    }
    if (argv[i].startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    } else if (argv[i] === "--ollama") {
      out["ollama"] = "true";
    }
  }
  return out;
}

const ARGV = parseArgv();

/**
 * AiRemoteCoder — autonomous coding agent (Agent 1 in the two-agent loop).
 *
 * Default mode (focused): Picks the highest-priority issue, codes it, creates
 * a PR, then waits for reviewer feedback. On rework, re-runs the agent on the
 * same branch and force-pushes until the PR passes review or max rework cycles
 * are exceeded. Dependency-aware: parses "depends on #N" from issue bodies and
 * branches from the dependency PR's branch when needed.
 *
 * Legacy mode (--poll): Fire-and-forget — codes, pushes, creates PR, moves on.
 *
 * Agent 2 (reviewer.ts) polls the resulting PRs, reviews them with AI,
 * and merges or injects a rework prompt back onto the original issue.
 *
 * Required env vars:
 *   AIWORKASSISTANT_URL      Base URL of the AIWorkAssistant server
 *   AIWORKASSISTANT_API_KEY  API key for authentication
 *
 * Optional env vars:
 *   AICODER_REPO        GitHub repo name (overrides server default)
 *   AICODER_OWNER       GitHub owner (overrides server default)
 *   AICODER_LABEL       Issue label to poll (default: ready-for-agent)
 *   AICODER_PRIORITY    Ticket priority mode: label | auto (default: label)
 *   AICODER_AGENT       Coding agent binary: codex | opencode | claude (default: claude)
 *   AICODER_WORKSPACE   Working directory of the target repo (default: cwd)
 *   AICODER_POLL_MS     Poll interval in ms (default: 60000)
 *   AICODER_MAX_CYCLES  Max issues to process before stopping (default: unlimited)
 *   AICODER_BASE_BRANCH Base branch for new branches (default: main)
 *   AICODER_POLL_MODE   Set to "true" for legacy fire-and-forget mode
 *   AICODER_MAX_REWORK  Max rework cycles per issue in focused mode (default: 5)
 *   AICODER_REVIEW_POLL_MS  Review poll interval in focused mode (default: 30000)
 *   AICODER_WAIT_FOR_DEPS   Set to "true" to wait for unresolved dependencies
 *   FIN_SIGNAL          Token to detect in agent stdout (default: FIN)
 */

const FIN_TOKEN = process.env.FIN_SIGNAL || "FIN";
const POLL_MS = parseInt(ARGV["poll-ms"] || process.env.AICODER_POLL_MS || "60000", 10);
const MAX_CYCLES = parseInt(ARGV["max-cycles"] || process.env.AICODER_MAX_CYCLES || "0", 10);
const WORKSPACE = ARGV.workspace || process.env.AICODER_WORKSPACE || process.cwd();
const AGENT = (ARGV.agent || process.env.AICODER_AGENT || "claude") as ProviderType;
const LABEL = ARGV.label || process.env.AICODER_LABEL || "ready-for-agent";
const PRIORITY = (ARGV.priority || process.env.AICODER_PRIORITY || "label") as PriorityMode;
const SOURCE = (ARGV.source || process.env.AICODER_SOURCE || "auto") as TicketSourceType | "auto";
const LOOKUP = (ARGV.lookup || process.env.AICODER_LOOKUP || "memory") as LookupMode;
const USE_OLLAMA = "ollama" in ARGV || process.env.AICODER_OLLAMA === "true";
const MODEL = ARGV.model || process.env.AICODER_MODEL || "";
const OLLAMA_URL = process.env.OLLAMA_API_URL || "http://localhost:11434";
const TARGET_ISSUE = ARGV.issue ? parseInt(ARGV.issue, 10) : null;
const BASE_BRANCH = ARGV.base || process.env.AICODER_BASE_BRANCH || "main";
const FOCUSED_MODE = !("poll" in ARGV || process.env.AICODER_POLL_MODE === "true");
const MAX_REWORK = parseInt(ARGV["max-rework"] || process.env.AICODER_MAX_REWORK || "5", 10);
const REVIEW_POLL_MS = parseInt(ARGV["review-poll-ms"] || process.env.AICODER_REVIEW_POLL_MS || "30000", 10);
const WAIT_FOR_DEPS = "wait-for-deps" in ARGV || process.env.AICODER_WAIT_FOR_DEPS === "true";

// Review result markers (must match reviewer.ts comment headers)
const REVIEW_PASSED_MARKER = "Review Passed";
const REVIEW_FAILED_MARKER = "Review Failed — Rework Required";
const REVIEW_POSTPONED_MARKER = "Review Postponed — Service Unavailable";

process.env.AICODER_AGENT = AGENT;
process.env.AICODER_MODEL = MODEL;
process.env.AICODER_OLLAMA = USE_OLLAMA ? "true" : "false";
const ollamaLauncher = USE_OLLAMA ? new OllamaLauncher({ ollamaUrl: OLLAMA_URL }) : null;
const runLogger = new RunLogger(WORKSPACE);

interface ServerConfig {
  owner: string;
  repo: string;
  source: string;
  apiUrl: string;
  apiKey: string;
}

interface WorkItem {
  id: string;
  number: number;
  title: string;
  url: string;
  owner: string;
  repo: string;
  suggestedBranch: string;
  labels?: string[];
}

interface GeneratedPrompt {
  prompt: string;
  skipped: boolean;
  skipReason: string | null;
}

interface RunResult {
  finDetected: boolean;
  exitCode: number | null;
}

function loadServerConfig(): ServerConfig {
  const apiUrl = (process.env.AIWORKASSISTANT_URL || "http://localhost:3050").replace(/\/$/, "");
  const apiKey = process.env.AIWORKASSISTANT_API_KEY || "";

  if (!apiKey) {
    const logger = new RunLogger(WORKSPACE);
    logger.logError("AIWORKASSISTANT_API_KEY is required");
    process.exit(1);
  }

  return {
    apiUrl,
    apiKey,
    owner: ARGV.owner || process.env.AICODER_OWNER || "",
    repo: ARGV.repo || process.env.AICODER_REPO || "",
    source: SOURCE,
  };
}

function authHeaders(cfg: ServerConfig): Record<string, string> {
  return { Authorization: `Bearer ${cfg.apiKey}` };
}

async function fetchWork(cfg: ServerConfig): Promise<WorkItem[]> {
  const params: Record<string, string> = { label: LABEL, limit: "5", source: cfg.source };
  if (cfg.owner) params.owner = cfg.owner;
  if (cfg.repo) params.repo = cfg.repo;

  const resp = await axios.get<{ success: boolean; items: WorkItem[]; error?: string }>(
    `${cfg.apiUrl}/api/autonomous-loop/work`,
    { headers: authHeaders(cfg), params },
  );
  if (!resp.data.success) {
    throw new Error(resp.data.error || "Server returned unsuccessful response");
  }
  return resp.data.items ?? [];
}

async function generatePrompt(
  cfg: ServerConfig,
  item: WorkItem,
): Promise<GeneratedPrompt> {
  const resp = await axios.post<GeneratedPrompt>(
    `${cfg.apiUrl}/api/ticket-bridge/prompt`,
    {
      source: {
        type: "github",
        id: `${item.owner || cfg.owner}/${item.repo || cfg.repo}#${item.number}`,
      },
      context: { includeCodebaseIndex: true, skipMissingCodingPrompt: true },
    },
    { headers: authHeaders(cfg) },
  );
  return resp.data;
}

async function createPR(
  cfg: ServerConfig,
  item: WorkItem,
  branchName: string,
): Promise<{ prNumber: number; url: string } | null> {
  try {
    const resp = await axios.post<{ success: boolean; prNumber: number; url: string }>(
      `${cfg.apiUrl}/api/autonomous-loop/pr`,
      {
        owner: item.owner || cfg.owner,
        repo: item.repo || cfg.repo,
        title: `[AI] ${item.title}`,
        head: branchName,
        base: "main",
        issueNumber: item.number,
      },
      { headers: authHeaders(cfg) },
    );
    return resp.data.success
      ? { prNumber: resp.data.prNumber, url: resp.data.url }
      : null;
  } catch (err) {
    runLogger.logError(`PR creation failed: ${(err as Error).message}`);
    return null;
  }
}

async function notifyComplete(
  cfg: ServerConfig,
  item: WorkItem,
  prNumber: number,
  branchName: string,
  exitCode: number | null,
): Promise<void> {
  try {
    await axios.post(
      `${cfg.apiUrl}/api/autonomous-loop/complete`,
      {
        owner: item.owner || cfg.owner,
        repo: item.repo || cfg.repo,
        issueNumber: item.number,
        prNumber,
        branchName,
        agentExitCode: exitCode,
      },
      { headers: authHeaders(cfg) },
    );
  } catch {
    // notification is non-fatal
  }
}

function gitRun(args: string[], cwd: string): boolean {
  const result = spawnSync("git", args, { cwd, stdio: "pipe", encoding: "utf-8" });
  if (result.status !== 0) {
    runLogger.logGit(`git ${args.join(" ")}`, `failed: ${result.stderr?.trim()}`);
    return false;
  }
  return true;
}

function getCurrentBranch(): string | null {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function pullAndUpdateBase(): boolean {
  runLogger.logGit("Pulling latest", BASE_BRANCH);
  if (!gitRun(["checkout", BASE_BRANCH], WORKSPACE)) {
    runLogger.logError(`Failed to switch to ${BASE_BRANCH}`);
    return false;
  }
  if (!gitRun(["pull", "--ff-only", "origin", BASE_BRANCH], WORKSPACE)) {
    runLogger.logGit("WARN", `Pull --ff-only failed — proceeding with local ${BASE_BRANCH}`);
  }
  return true;
}

function checkoutBranch(branchName: string, fromBranch?: string): boolean {
  // Already on the target branch — stage any pending changes and continue
  const current = getCurrentBranch();
  if (current === branchName) {
    runLogger.logGit("Already on branch", branchName);
    // Stage any leftover changes from a prior interrupted run
    stageAndCommit(`[AI] resume: staged pending changes`);
    return true;
  }

  // Stash or stage any uncommitted changes before switching branches
  const dirtyResult = spawnSync("git", ["diff", "--quiet"], {
    cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
  });
  const hasUncommittedChanges = dirtyResult.status !== 0;

  if (current && current !== (fromBranch || BASE_BRANCH) && hasUncommittedChanges) {
    // On a different branch with changes — commit them so they aren't lost
    runLogger.logGit("Committing uncommitted changes on", current);
    const saved = stageAndCommit(`[AI] auto-save before switching from ${current}`);
    if (!saved) {
      runLogger.logGit("WARN", "Could not save all changes — some files may be left uncommitted");
    }
  }

  // Start from the specified branch or pull latest base
  if (fromBranch) {
    runLogger.logGit("Fetching and checking out base branch", fromBranch);
    if (!gitRun(["fetch", "origin", fromBranch], WORKSPACE)) {
      runLogger.logGit("WARN", `Could not fetch ${fromBranch} — trying local checkout`);
    }
    if (!gitRun(["checkout", fromBranch], WORKSPACE)) {
      runLogger.logError(`Failed to checkout base branch ${fromBranch}`);
      return false;
    }
  } else {
    if (!pullAndUpdateBase()) {
      return false;
    }
  }

  runLogger.logGit("Creating branch", branchName);
  const create = gitRun(["checkout", "-b", branchName], WORKSPACE);
  if (!create) {
    runLogger.logGit("Switching to existing branch", branchName);
    if (!gitRun(["checkout", branchName], WORKSPACE)) {
      return false;
    }
    runLogger.logGit(`Fast-forwarding existing branch from ${BASE_BRANCH}`, branchName);
    if (!gitRun(["merge", "--ff-only", BASE_BRANCH], WORKSPACE)) {
      runLogger.logGit("Cannot fast-forward — proceeding with current state", branchName);
    }
  }
  return true;
}

function runTests(): boolean {
  runLogger.logGit("Running tests", "npm test");
  const result = spawnSync("npm", ["test"], {
    cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8", timeout: 300_000,
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const lastLines = stderr.split("\n").slice(-10).join("\n");
    runLogger.logError(`Tests failed:\n${lastLines || `exit code ${result.status}`}`);
    return false;
  }
  runLogger.logGit("Tests passed", "npm test");
  return true;
}

function pushBranch(branchName: string, force: boolean = false): boolean {
  const args = force ? ["push", "--force", "origin", branchName] : ["push", "origin", branchName];
  runLogger.logGit(force ? "Force pushing to origin" : "Pushing to origin", branchName);
  return gitRun(args, WORKSPACE);
}

function stageAndCommit(message: string): boolean {
  // Stage new, modified, and deleted files
  if (!gitRun(["add", "--all"], WORKSPACE)) {
    // --all can fail on reserved names (e.g. Windows "nul") or permission errors.
    // Fall back to staging only tracked-file changes, then add new files individually.
    runLogger.logGit("git add --all failed — retrying with tracked-only + new files", "");
    gitRun(["add", "-u"], WORKSPACE);
    // Collect untracked files (excluding .gitignore entries) and add them one by one
    const lsResult = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
    });
    if (lsResult.status === 0 && lsResult.stdout.trim()) {
      const newFiles = lsResult.stdout.trim().split("\n");
      for (const f of newFiles) {
        if (!f.trim()) continue;
        if (!gitRun(["add", f.trim()], WORKSPACE)) {
          runLogger.logGit("Skipping untrackable file", f.trim());
        }
      }
    }
  }

  // Check if there is anything staged to commit
  const status = spawnSync("git", ["diff", "--cached", "--quiet"], {
    cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
  });
  // exit code 1 means there ARE staged changes; 0 means nothing staged
  if (status.status === 0) {
    runLogger.logGit("Nothing staged to commit", "skipping commit");
    return true;
  }

  runLogger.logGit("Committing", message);
  if (!gitRun(["commit", "-m", message], WORKSPACE)) {
    runLogger.logError("git commit failed");
    return false;
  }
  return true;
}

// --- Dependency resolution ---

const DEPENDENCY_RE = /\b(?:depends\s+on|blocked\s+by|requires|prerequisite\s*:\s*)\s*#(\d+)/gi;

function parseDependencies(body: string): number[] {
  const nums = new Set<number>();
  let match: RegExpExecArray | null;
  const re = new RegExp(DEPENDENCY_RE.source, DEPENDENCY_RE.flags);
  while ((match = re.exec(body)) !== null) {
    nums.add(parseInt(match[1], 10));
  }
  return [...nums];
}

async function fetchIssueBody(
  ghToken: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<string> {
  const resp = await axios.get(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, {
    headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" },
  }).catch(() => null);
  return resp?.data?.body || "";
}

async function fetchLinkedIssues(
  ghToken: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<number[]> {
  const nums = new Set<number>();
  try {
    const resp = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/timeline`,
      {
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: "application/vnd.github.mockingbird-preview+json",
        },
        params: { per_page: 50 },
      },
    );
    const events = resp.data || [];
    for (const ev of events) {
      if (ev.event === "connected" || ev.event === "cross-referenced") {
        const refNum = ev.source?.issue?.number;
        if (refNum && refNum !== issueNumber) nums.add(refNum);
      }
    }
  } catch {
    // Timeline API may not be available; keyword parsing is the fallback
  }
  return [...nums];
}

async function findPRForIssue(
  ghToken: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<{ prNumber: number; branch: string; merged: boolean } | null> {
  const headers = { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" };
  for (const state of ["open", "closed"]) {
    try {
      const resp = await axios.get(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
        headers,
        params: { state, per_page: 100, sort: "updated", direction: "desc" },
      });
      for (const pr of resp.data || []) {
        const body: string = pr.body || "";
        if (body.match(new RegExp(`(?:closes|fixes|resolves)\\s+#${issueNumber}\\b`, "i"))) {
          return { prNumber: pr.number, branch: pr.head?.ref, merged: !!pr.merged_at };
        }
      }
    } catch {
      // Continue to next state
    }
  }
  return null;
}

async function resolveDependencyBranch(
  ghToken: string,
  owner: string,
  repo: string,
  depIssueNumbers: number[],
): Promise<{ branch: string; source: "merged" | "open_pr" } | null> {
  let openBranch: string | null = null;
  for (const depNum of depIssueNumbers) {
    const pr = await findPRForIssue(ghToken, owner, repo, depNum);
    if (!pr) {
      runLogger.logGit("Dependency has no PR yet", `#${depNum}`);
      return null; // unresolved dependency
    }
    if (pr.merged) {
      runLogger.logGit("Dependency merged", `#${depNum}`);
      // merged changes are in main already
      continue;
    }
    // open PR — use this branch as base
    runLogger.logGit("Dependency has open PR", `#${depNum} → ${pr.branch}`);
    openBranch = pr.branch;
  }
  // All merged → branch from main; some open → branch from the open PR
  return openBranch
    ? { branch: openBranch, source: "open_pr" }
    : { branch: BASE_BRANCH, source: "merged" };
}

// --- Review polling ---

async function pollForReviewResult(
  ghToken: string,
  owner: string,
  repo: string,
  prNumber: number,
  pollMs: number = REVIEW_POLL_MS,
): Promise<"passed" | "failed" | "postponed" | "merged" | "closed"> {
  const headers = { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" };
  while (true) {
    // Check PR state first
    try {
      const prResp = await axios.get(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, { headers });
      const pr = prResp.data;
      if (pr.merged_at) return "merged";
      if (pr.state === "closed") return "closed";
    } catch {
      // PR might not exist yet
    }

    // Check PR comments for review markers
    try {
      const commentsResp = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
        { headers, params: { per_page: 10, sort: "created", direction: "desc" } },
      );
      for (const c of commentsResp.data || []) {
        const body: string = c.body || "";
        if (body.includes(REVIEW_PASSED_MARKER)) return "passed";
        if (body.includes(REVIEW_FAILED_MARKER)) return "failed";
        if (body.includes(REVIEW_POSTPONED_MARKER)) return "postponed";
      }
    } catch {
      // Comments might not be available
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function fetchReworkPrompt(
  ghToken: string,
  owner: string,
  repo: string,
  prNumber: number,
  issueNumber: number,
): Promise<string | null> {
  const headers = { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" };
  // Check issue comments first (where the reviewer posts the coding prompt)
  try {
    const issueResp = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      { headers, params: { per_page: 20, sort: "created", direction: "desc" } },
    );
    for (const c of issueResp.data || []) {
      const body: string = c.body || "";
      if (body.includes("Rework from PR Review")) {
        return body;
      }
    }
  } catch {
    // Issue comments not available
  }
  // Also check PR comments (where review findings are posted)
  try {
    const prResp = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      { headers, params: { per_page: 20, sort: "created", direction: "desc" } },
    );
    for (const c of prResp.data || []) {
      const body: string = c.body || "";
      if (body.includes("Review Failed — Rework Required")) {
        return body;
      }
    }
  } catch {
    // PR comments not available
  }
  return null;
}

async function runAgent(prompt: string): Promise<RunResult> {
  if (ollamaLauncher) {
    return runAgentViaLauncher(prompt);
  }
  return runAgentDirect(prompt);
}

async function runAgentViaLauncher(prompt: string): Promise<RunResult> {
  return new Promise((resolve) => {
    runLogger.logAgent(`Starting ${AGENT} via Ollama launcher`);

    const options: import("./integrations/ollama-launcher").LaunchOptions = {
      provider: AGENT,
      prompt,
      cwd: WORKSPACE,
      ollamaUrl: OLLAMA_URL,
      model: MODEL || undefined,
    };

    ollamaLauncher!.launchStream(options).then((child) => {
      activeChild = child;
      let finDetected = false;
      let outputBuf = "";

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        process.stdout.write(text);
        outputBuf += text;

        if (!finDetected && outputBuf.includes(FIN_TOKEN)) {
          finDetected = true;
          runLogger.logAgent("FIN signal detected — stopping agent");
          child.kill("SIGTERM");
        }
      });

      child.on("close", (code) => {
        activeChild = null;
        resolve({ finDetected, exitCode: code });
      });

      child.on("error", (err) => {
        activeChild = null;
        runLogger.logError(`Launcher failed: ${err.message}`);
        resolve({ finDetected: false, exitCode: -1 });
      });
    }).catch((err) => {
      activeChild = null;
      runLogger.logError(`Failed to start ${AGENT} via launcher: ${err.message}`);
      resolve({ finDetected: false, exitCode: -1 });
    });
  });
}

async function runAgentDirect(prompt: string): Promise<RunResult> {
  return new Promise((resolve) => {
    runLogger.logAgent(`Starting ${AGENT}`);

    const agentArgs = buildAgentArgs(AGENT);
    const child = spawn(AGENT, agentArgs, {
      cwd: WORKSPACE,
      stdio: ["pipe", "pipe", "inherit"],
      shell: process.platform === "win32",
    });
    activeChild = child;

    let finDetected = false;
    let outputBuf = "";

    // Pipe prompt via stdin to avoid command-line length limits
    child.stdin?.write(prompt);
    child.stdin?.end();

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text);
      outputBuf += text;

      if (!finDetected && outputBuf.includes(FIN_TOKEN)) {
        finDetected = true;
        runLogger.logAgent("FIN signal detected — stopping agent");
        child.kill("SIGTERM");
      }
    });

    child.on("close", (code) => {
      activeChild = null;
      resolve({ finDetected, exitCode: code });
    });

    child.on("error", (err) => {
      activeChild = null;
      runLogger.logError(`Failed to start ${AGENT}: ${err.message}`);
      resolve({ finDetected: false, exitCode: -1 });
    });
  });
}

function buildAgentArgs(agent: string): string[] {
  switch (agent) {
    case "codex":
      return [
        "exec",
        "--model",
        process.env.CODEX_MODEL || "o4-mini",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
      ];
    case "opencode":
      return [];
    case "claude":
      return ["-p", "--print", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
    default:
      return [];
  }
}

const processedIssues = new Set<number>();

async function processWorkItem(cfg: ServerConfig, item: WorkItem): Promise<{ prNumber: number } | null> {
  if (processedIssues.has(item.number)) {
    runLogger.logSkip(`Issue #${item.number} already processed this session`);
    return null;
  }

  runLogger.startRun(item.number, item.title);
  runLogger.logWork(`Starting issue #${item.number}: ${item.title}`);

  // Resolve dependencies
  const ghToken = process.env.GITHUB_TOKEN;
  const owner = cfg.owner || process.env.GITHUB_DEFAULT_OWNER || "redsand";
  const repo = cfg.repo || process.env.AICODER_REPO || "";
  let fromBranch: string | undefined;

  if (ghToken && repo) {
    const body = await fetchIssueBody(ghToken, owner, repo, item.number);
    const keywordDeps = parseDependencies(body);
    const linkedDeps = await fetchLinkedIssues(ghToken, owner, repo, item.number);
    const allDeps = [...new Set([...keywordDeps, ...linkedDeps])];

    if (allDeps.length > 0) {
      runLogger.logGit("Found dependencies", allDeps.map((n) => `#${n}`).join(", "));
      const resolved = await resolveDependencyBranch(ghToken, owner, repo, allDeps);
      if (!resolved) {
        if (WAIT_FOR_DEPS) {
          runLogger.logGit("Waiting for dependencies", `will retry later`);
          runLogger.endRun(null);
          return null; // don't add to processedIssues so it retries
        }
        runLogger.logError(`Unresolved dependencies for #${item.number} — skipping`);
        runLogger.endRun(1);
        processedIssues.add(item.number);
        return null;
      }
      fromBranch = resolved.source === "open_pr" ? resolved.branch : undefined;
      runLogger.logGit("Base branch resolved", fromBranch || BASE_BRANCH);
    }
  }

  const generated = await generatePrompt(cfg, item);
  if (generated.skipped) {
    runLogger.logSkip(`Issue #${item.number}: ${generated.skipReason}`);
    runLogger.endRun(null);
    return null;
  }

  const branchName = item.suggestedBranch;
  if (!checkoutBranch(branchName, fromBranch)) {
    runLogger.logError(`Could not create branch ${branchName} — skipping`);
    runLogger.endRun(1);
    return null;
  }

  const { finDetected, exitCode } = await runAgent(generated.prompt);

  if (!finDetected && exitCode !== 0) {
    runLogger.log(`WARN`, `Agent exited with code ${exitCode} and no FIN signal — skipping push`);
    runLogger.endRun(exitCode);
    processedIssues.add(item.number);
    return null;
  }

  if (!stageAndCommit(`[AI] ${item.title}`)) {
    runLogger.logError("Stage/commit failed — skipping push");
    runLogger.endRun(1);
    processedIssues.add(item.number);
    return null;
  }

  if (!runTests()) {
    runLogger.logError("Tests failed — skipping push");
    runLogger.endRun(1);
    processedIssues.add(item.number);
    return null;
  }

  if (!pushBranch(branchName)) {
    runLogger.logError(`Push failed — PR not created`);
    runLogger.endRun(1);
    processedIssues.add(item.number);
    return null;
  }

  const pr = await createPR(cfg, item, branchName);
  if (pr) {
    runLogger.logPR(`Opened PR #${pr.prNumber}: ${pr.url}`);
    await notifyComplete(cfg, item, pr.prNumber, branchName, exitCode);
  }

  runLogger.endRun(exitCode);
  processedIssues.add(item.number);
  return pr ? { prNumber: pr.prNumber } : null;
}

async function focusedLoop(cfg: ServerConfig): Promise<void> {
  runLogger.logConfig(`AiRemoteCoder started in focused mode (agent: ${AGENT}, workspace: ${WORKSPACE}${USE_OLLAMA ? ", ollama: on" : ""}, base: ${BASE_BRANCH})`);
  const ghToken = process.env.GITHUB_TOKEN;
  const owner = cfg.owner || process.env.GITHUB_DEFAULT_OWNER || "redsand";
  const repo = cfg.repo || process.env.AICODER_REPO || "";

  // --issue <number>: work on a specific issue with review loop
  if (TARGET_ISSUE) {
    runLogger.logConfig(`Targeting issue #${TARGET_ISSUE} directly`);
    const items = await fetchWork(cfg);
    const target = items.find((i) => i.number === TARGET_ISSUE) ??
      await fetchIssueDirectly(cfg, TARGET_ISSUE);
    if (!target) {
      runLogger.logError(`Could not find issue #${TARGET_ISSUE}`);
      process.exit(1);
    }
    await focusedProcessWorkItem(cfg, target, ghToken, owner, repo);
    return;
  }

  runLogger.logConfig(`Polling ${cfg.apiUrl} for label="${LABEL}"`);
  runLogger.logConfig(`Source: ${SOURCE}, Priority mode: ${PRIORITY}, Lookup: ${LOOKUP}`);

  let cycles = 0;
  while (true) {
    if (MAX_CYCLES > 0 && cycles >= MAX_CYCLES) {
      runLogger.log("STOP", `Reached max cycles (${MAX_CYCLES})`);
      break;
    }

    try {
      const items = await fetchWork(cfg);
      if (items.length === 0) {
        runLogger.logPoll(`No qualifying issues found — waiting ${POLL_MS / 1000}s`);
      } else {
        const sorted = await prioritizeItems(items, PRIORITY, cfg.apiUrl, cfg.apiKey);
        runLogger.logConfig(`Prioritized ${sorted.length} issues (mode=${PRIORITY}): ${sorted.map((i) => `#${i.number}`).join(", ")}`);
        for (const item of sorted) {
          await focusedProcessWorkItem(cfg, item, ghToken, owner, repo);
        }
        cycles++;
      }
    } catch (err) {
      runLogger.logError((err as Error).message);
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function fetchIssueDirectly(cfg: ServerConfig, issueNumber: number): Promise<WorkItem | null> {
  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) {
    runLogger.logError("GITHUB_TOKEN required to fetch issue by number");
    return null;
  }
  const owner = cfg.owner || "redsand";
  const repo = cfg.repo || "AIWorkAssistant";
  const resp = await axios.get(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, {
    headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" },
  }).catch(() => null);

  if (!resp || !resp.data?.title) return null;

  const slug = resp.data.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return {
    id: String(issueNumber),
    number: issueNumber,
    title: resp.data.title,
    url: resp.data.html_url || "",
    owner,
    repo,
    suggestedBranch: `ai/issue-${issueNumber}-${slug}`,
    labels: (resp.data.labels || []).map((l: any) => typeof l === "string" ? l : l.name),
  };
}

async function focusedProcessWorkItem(
  cfg: ServerConfig,
  item: WorkItem,
  ghToken: string | undefined,
  owner: string,
  repo: string,
): Promise<void> {
  const result = await processWorkItem(cfg, item);
  if (!result || !ghToken || !repo) {
    return; // Failed or no token — can't poll for review
  }

  const prNumber = result.prNumber;
  runLogger.logConfig(`Waiting for review of PR #${prNumber} (polling every ${REVIEW_POLL_MS / 1000}s)`);

  let reworkCount = 0;
  let postponeTimeout = 0;
  const POSTPONE_MAX_MS = 30 * 60 * 1000; // 30 min max wait for service restoration

  while (true) {
    const reviewResult = await pollForReviewResult(ghToken, owner, repo, prNumber);

    if (reviewResult === "passed" || reviewResult === "merged") {
      runLogger.logConfig(`PR #${prNumber} passed review — pulling latest ${BASE_BRANCH}`);
      gitRun(["checkout", BASE_BRANCH], WORKSPACE);
      gitRun(["pull", "--ff-only", "origin", BASE_BRANCH], WORKSPACE);
      return;
    }

    if (reviewResult === "closed") {
      runLogger.logError(`PR #${prNumber} was closed without merge`);
      return;
    }

    if (reviewResult === "postponed") {
      postponeTimeout += REVIEW_POLL_MS;
      if (postponeTimeout >= POSTPONE_MAX_MS) {
        runLogger.logError(`Review service unavailable for ${POSTPONE_MAX_MS / 1000}s — giving up on PR #${prNumber}`);
        return;
      }
      runLogger.logPoll(`Review service unavailable — retrying in ${REVIEW_POLL_MS / 1000}s`);
      await new Promise((r) => setTimeout(r, REVIEW_POLL_MS));
      continue;
    }

    if (reviewResult === "failed") {
      reworkCount++;
      if (reworkCount > MAX_REWORK) {
        runLogger.logError(`PR #${prNumber} exceeded max rework cycles (${MAX_REWORK})`);
        return;
      }

      runLogger.logWork(`Rework cycle ${reworkCount}/${MAX_REWORK} for PR #${prNumber}`);

      // Extract the linked issue number from the PR body
      const issueMatch = (item.url || "").match(/#(\d+)/);
      const issueNumber = issueMatch ? parseInt(issueMatch[1], 10) : item.number;

      const reworkPrompt = await fetchReworkPrompt(ghToken, owner, repo, prNumber, issueNumber);
      if (!reworkPrompt) {
        runLogger.logError("Could not fetch rework prompt — skipping rework");
        return;
      }

      // Checkout the existing branch and re-run agent with rework prompt
      if (!gitRun(["checkout", item.suggestedBranch], WORKSPACE)) {
        runLogger.logError(`Could not checkout branch ${item.suggestedBranch} for rework`);
        return;
      }

      const { finDetected, exitCode } = await runAgent(reworkPrompt);
      if (!finDetected && exitCode !== 0) {
        runLogger.logError(`Rework agent exited with code ${exitCode} — stopping`);
        return;
      }

      if (!stageAndCommit(`[AI] rework #${reworkCount}: ${item.title}`)) {
        runLogger.logError("Rework stage/commit failed");
        return;
      }

      if (!runTests()) {
        runLogger.logError("Rework tests failed — stopping");
        return;
      }

      if (!pushBranch(item.suggestedBranch, true)) {
        runLogger.logError("Rework push failed");
        return;
      }

      runLogger.logConfig(`Rework pushed for PR #${prNumber} — waiting for review again`);
      continue;
    }

    // Unknown result — keep polling
    await new Promise((r) => setTimeout(r, REVIEW_POLL_MS));
  }
}

async function pollLoop(cfg: ServerConfig): Promise<void> {
  runLogger.logConfig(`AiRemoteCoder started in poll mode (agent: ${AGENT}, workspace: ${WORKSPACE}${USE_OLLAMA ? ", ollama: on" : ""}, base: ${BASE_BRANCH})`);

  // --issue <number>: work on a specific issue and exit (no polling)
  if (TARGET_ISSUE) {
    runLogger.logConfig(`Targeting issue #${TARGET_ISSUE} directly`);
    const items = await fetchWork(cfg);
    const target = items.find((i) => i.number === TARGET_ISSUE) ??
      await fetchIssueDirectly(cfg, TARGET_ISSUE);
    if (!target) {
      runLogger.logError(`Could not find issue #${TARGET_ISSUE}`);
      process.exit(1);
    }
    await processWorkItem(cfg, target);
    return;
  }

  runLogger.logConfig(`Polling ${cfg.apiUrl} for label="${LABEL}"`);
  runLogger.logConfig(`Source: ${SOURCE}, Priority mode: ${PRIORITY}, Lookup: ${LOOKUP}`);

  let cycles = 0;
  while (true) {
    if (MAX_CYCLES > 0 && cycles >= MAX_CYCLES) {
      runLogger.log("STOP", `Reached max cycles (${MAX_CYCLES})`);
      break;
    }

    try {
      const items = await fetchWork(cfg);

      if (items.length === 0) {
        runLogger.logPoll(`No qualifying issues found — waiting ${POLL_MS / 1000}s`);
      } else {
        const sorted = await prioritizeItems(items, PRIORITY, cfg.apiUrl, cfg.apiKey);
        runLogger.logConfig(`Prioritized ${sorted.length} issues (mode=${PRIORITY}): ${sorted.map((i) => `#${i.number}`).join(", ")}`);
        for (const item of sorted) {
          await processWorkItem(cfg, item);
        }
        cycles++;
      }
    } catch (err) {
      runLogger.logError((err as Error).message);
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// Kill active agent child process on exit
let activeChild: import("child_process").ChildProcess | null = null;

function cleanup() {
  if (activeChild && !activeChild.killed) {
    activeChild.kill("SIGTERM");
  }
}

process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

if (FOCUSED_MODE) {
  focusedLoop(loadServerConfig());
} else {
  pollLoop(loadServerConfig());
}
