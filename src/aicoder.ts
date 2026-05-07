#!/usr/bin/env tsx
import { spawn, spawnSync } from "child_process";
import axios from "axios";

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
  --repo <name>        GitHub repo to poll (overrides AICODER_REPO)
  --owner <name>       GitHub owner (overrides AICODER_OWNER)
  --agent <name>       Coding agent: codex | opencode | claude (default: codex)
  --label <label>      Issue label to filter (default: ready-for-agent)
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
 *   AICODER_AGENT       Coding agent binary: codex | opencode | claude (default: codex)
 *   AICODER_WORKSPACE   Working directory of the target repo (default: cwd)
 *   AICODER_POLL_MS     Poll interval in ms (default: 60000)
 *   AICODER_MAX_CYCLES  Max issues to process before stopping (default: unlimited)
 *   FIN_SIGNAL          Token to detect in agent stdout (default: FIN)
 */

const FIN_TOKEN = process.env.FIN_SIGNAL || "FIN";
const POLL_MS = parseInt(ARGV["poll-ms"] || process.env.AICODER_POLL_MS || "60000", 10);
const MAX_CYCLES = parseInt(ARGV["max-cycles"] || process.env.AICODER_MAX_CYCLES || "0", 10);
const WORKSPACE = ARGV.workspace || process.env.AICODER_WORKSPACE || process.cwd();
const AGENT = (ARGV.agent || process.env.AICODER_AGENT || "codex") as "codex" | "opencode" | "claude";
const LABEL = ARGV.label || process.env.AICODER_LABEL || "ready-for-agent";

interface ServerConfig {
  owner: string;
  repo: string;
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
    console.error("[ERROR] AIWORKASSISTANT_API_KEY is required");
    process.exit(1);
  }

  return {
    apiUrl,
    apiKey,
    owner: ARGV.owner || process.env.AICODER_OWNER || "",
    repo: ARGV.repo || process.env.AICODER_REPO || "",
  };
}

function authHeaders(cfg: ServerConfig): Record<string, string> {
  return { Authorization: `Bearer ${cfg.apiKey}` };
}

async function fetchWork(cfg: ServerConfig): Promise<WorkItem[]> {
  const params: Record<string, string> = { label: LABEL, limit: "5" };
  if (cfg.owner) params.owner = cfg.owner;
  if (cfg.repo) params.repo = cfg.repo;

  const resp = await axios.get<{ success: boolean; items: WorkItem[] }>(
    `${cfg.apiUrl}/api/autonomous-loop/work`,
    { headers: authHeaders(cfg), params },
  );
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
    console.error("[ERROR] PR creation failed:", (err as Error).message);
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
    console.error(`[GIT] git ${args.join(" ")} failed: ${result.stderr?.trim()}`);
    return false;
  }
  return true;
}

function checkoutBranch(branchName: string): boolean {
  console.log(`[GIT] Creating branch ${branchName}`);
  const create = gitRun(["checkout", "-b", branchName], WORKSPACE);
  if (!create) {
    console.log(`[GIT] Branch exists, switching to ${branchName}`);
    return gitRun(["checkout", branchName], WORKSPACE);
  }
  return true;
}

function pushBranch(branchName: string): boolean {
  console.log(`[GIT] Pushing ${branchName} to origin`);
  return gitRun(["push", "origin", branchName], WORKSPACE);
}

async function runAgent(prompt: string): Promise<RunResult> {
  return new Promise((resolve) => {
    console.log(`[AGENT] Starting ${AGENT}`);

    const agentArgs = buildAgentArgs(AGENT, prompt);
    const child = spawn(AGENT, agentArgs, {
      cwd: WORKSPACE,
      stdio: ["pipe", "pipe", "inherit"],
      shell: process.platform === "win32",
    });

    let finDetected = false;
    let outputBuf = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text);
      outputBuf += text;

      if (!finDetected && outputBuf.includes(FIN_TOKEN)) {
        finDetected = true;
        console.log(`\n[AGENT] FIN signal detected — stopping agent`);
        child.kill("SIGTERM");
      }
    });

    child.stdin?.end();

    child.on("close", (code) => {
      resolve({ finDetected, exitCode: code });
    });

    child.on("error", (err) => {
      console.error(`[AGENT] Failed to start ${AGENT}:`, err.message);
      resolve({ finDetected: false, exitCode: -1 });
    });
  });
}

function buildAgentArgs(agent: string, prompt: string): string[] {
  switch (agent) {
    case "codex":
      return ["--model", process.env.CODEX_MODEL || "o4-mini", "--approval-mode", "full-auto", "-q", prompt];
    case "opencode":
      return [prompt];
    case "claude":
      return ["-p", "--print", "--dangerously-skip-permissions", "--", prompt];
    default:
      return [prompt];
  }
}

const processedIssues = new Set<number>();

async function processWorkItem(cfg: ServerConfig, item: WorkItem): Promise<void> {
  if (processedIssues.has(item.number)) {
    console.log(`[SKIP] Issue #${item.number} already processed this session`);
    return;
  }

  console.log(`\n[WORK] Starting issue #${item.number}: ${item.title}`);

  const generated = await generatePrompt(cfg, item);
  if (generated.skipped) {
    console.log(`[SKIP] Issue #${item.number}: ${generated.skipReason}`);
    return;
  }

  const branchName = item.suggestedBranch;
  if (!checkoutBranch(branchName)) {
    console.error(`[ERROR] Could not create branch ${branchName} — skipping`);
    return;
  }

  const { finDetected, exitCode } = await runAgent(generated.prompt);

  if (!finDetected && exitCode !== 0) {
    console.warn(`[WARN] Agent exited with code ${exitCode} and no FIN signal — skipping push`);
    processedIssues.add(item.number);
    return;
  }

  if (!pushBranch(branchName)) {
    console.error(`[ERROR] Push failed — PR not created`);
    processedIssues.add(item.number);
    return;
  }

  const pr = await createPR(cfg, item, branchName);
  if (pr) {
    console.log(`[PR] Opened PR #${pr.prNumber}: ${pr.url}`);
    await notifyComplete(cfg, item, pr.prNumber, branchName, exitCode);
  }

  processedIssues.add(item.number);
}

async function pollLoop(cfg: ServerConfig): Promise<void> {
  let cycles = 0;
  console.log(`[START] AiRemoteCoder started (agent: ${AGENT}, workspace: ${WORKSPACE})`);
  console.log(`[CONFIG] Polling ${cfg.apiUrl} for label="${LABEL}"`);

  while (true) {
    if (MAX_CYCLES > 0 && cycles >= MAX_CYCLES) {
      console.log(`[STOP] Reached max cycles (${MAX_CYCLES})`);
      break;
    }

    try {
      const items = await fetchWork(cfg);

      if (items.length === 0) {
        console.log(`[POLL] No qualifying issues found — waiting ${POLL_MS / 1000}s`);
      } else {
        for (const item of items) {
          await processWorkItem(cfg, item);
        }
        cycles++;
      }
    } catch (err) {
      console.error("[ERROR]", (err as Error).message);
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

pollLoop(loadServerConfig());
