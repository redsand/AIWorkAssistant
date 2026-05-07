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
  --help               Show this help

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
 * Polls AIWorkAssistant for GitHub issues labelled ready-for-agent,
 * generates an implementation prompt, creates a feature branch, runs the
 * coding agent, detects the FIN completion signal, pushes the branch, and
 * opens a PR — then loops back for the next issue.
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

function checkoutBranch(branchName: string): boolean {
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

  if (current && current !== "main" && hasUncommittedChanges) {
    // On a different branch with changes — commit them so they aren't lost
    runLogger.logGit("Committing uncommitted changes on", current);
    const saved = stageAndCommit(`[AI] auto-save before switching from ${current}`);
    if (!saved) {
      runLogger.logGit("WARN", "Could not save all changes — some files may be left uncommitted");
    }
  }

  runLogger.logGit("Switching to main", "before creating new branch");
  if (!gitRun(["checkout", "main"], WORKSPACE)) {
    runLogger.logError("Failed to switch to main");
    return false;
  }

  runLogger.logGit("Creating branch", branchName);
  const create = gitRun(["checkout", "-b", branchName], WORKSPACE);
  if (!create) {
    runLogger.logGit("Switching to existing branch", branchName);
    if (!gitRun(["checkout", branchName], WORKSPACE)) {
      return false;
    }
    runLogger.logGit("Fast-forwarding existing branch from main", branchName);
    if (!gitRun(["merge", "--ff-only", "main"], WORKSPACE)) {
      runLogger.logGit("Cannot fast-forward — proceeding with current state", branchName);
    }
  }
  return true;
}

function pushBranch(branchName: string): boolean {
  runLogger.logGit("Pushing to origin", branchName);
  return gitRun(["push", "origin", branchName], WORKSPACE);
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

async function processWorkItem(cfg: ServerConfig, item: WorkItem): Promise<void> {
  if (processedIssues.has(item.number)) {
    runLogger.logSkip(`Issue #${item.number} already processed this session`);
    return;
  }

  runLogger.startRun(item.number, item.title);
  runLogger.logWork(`Starting issue #${item.number}: ${item.title}`);

  const generated = await generatePrompt(cfg, item);
  if (generated.skipped) {
    runLogger.logSkip(`Issue #${item.number}: ${generated.skipReason}`);
    runLogger.endRun(null);
    return;
  }

  const branchName = item.suggestedBranch;
  if (!checkoutBranch(branchName)) {
    runLogger.logError(`Could not create branch ${branchName} — skipping`);
    runLogger.endRun(1);
    return;
  }

  const { finDetected, exitCode } = await runAgent(generated.prompt);

  if (!finDetected && exitCode !== 0) {
    runLogger.log(`WARN`, `Agent exited with code ${exitCode} and no FIN signal — skipping push`);
    runLogger.endRun(exitCode);
    processedIssues.add(item.number);
    return;
  }

  if (!stageAndCommit(`[AI] ${item.title}`)) {
    runLogger.logError("Stage/commit failed — skipping push");
    runLogger.endRun(1);
    processedIssues.add(item.number);
    return;
  }

  if (!pushBranch(branchName)) {
    runLogger.logError(`Push failed — PR not created`);
    runLogger.endRun(1);
    processedIssues.add(item.number);
    return;
  }

  const pr = await createPR(cfg, item, branchName);
  if (pr) {
    runLogger.logPR(`Opened PR #${pr.prNumber}: ${pr.url}`);
    await notifyComplete(cfg, item, pr.prNumber, branchName, exitCode);
  }

  runLogger.endRun(exitCode);
  processedIssues.add(item.number);
}

async function pollLoop(cfg: ServerConfig): Promise<void> {
  let cycles = 0;
  runLogger.logConfig(`AiRemoteCoder started (agent: ${AGENT}, workspace: ${WORKSPACE}${USE_OLLAMA ? ", ollama: on" : ""})`);
  runLogger.logConfig(`Polling ${cfg.apiUrl} for label="${LABEL}"`);
  runLogger.logConfig(`Source: ${SOURCE}, Priority mode: ${PRIORITY}, Lookup: ${LOOKUP}`);

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

pollLoop(loadServerConfig());
