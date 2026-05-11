#!/usr/bin/env tsx
import "dotenv/config";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import { OllamaLauncher } from "./integrations/ollama-launcher";
import { RunLogger } from "./integrations/ollama-launcher/run-logger";
import { prioritizeItems, type PriorityMode } from "./integrations/ollama-launcher/priority-sorter";
import { createStreamFormatter } from "./integrations/ollama-launcher/stream-formatter";
import { type TicketSourceType, type LookupMode, SourceResolver } from "./integrations/source-resolver";
import { jiraClient } from "./integrations/jira/jira-client";
import { gitlabClient } from "./integrations/gitlab/gitlab-client";
import { agentRunDatabase } from "./agent-runs/database";
import type { AgentRunStepCreate } from "./agent-runs/types";
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
const TARGET_ISSUE_KEY = ARGV.issue || null;
const BASE_BRANCH_CANDIDATES = [ARGV.base || process.env.AICODER_BASE_BRANCH, "main", "master"].filter(Boolean) as string[];
const BASE_BRANCH = BASE_BRANCH_CANDIDATES[0];
const FOCUSED_MODE = !("poll" in ARGV || process.env.AICODER_POLL_MODE === "true");
const MAX_REWORK = parseInt(ARGV["max-rework"] || process.env.AICODER_MAX_REWORK || "5", 10);
const REVIEW_POLL_MS = parseInt(ARGV["review-poll-ms"] || process.env.AICODER_REVIEW_POLL_MS || "30000", 10);
const WAIT_FOR_DEPS = "wait-for-deps" in ARGV || process.env.AICODER_WAIT_FOR_DEPS === "true";

// Review result markers (must match reviewer.ts comment headers)
const REVIEW_PASSED_MARKER = "Review Passed";
const REVIEW_FAILED_MARKER = "Review Failed — Rework Required";
const REVIEW_POSTPONED_MARKER = "Review Postponed — Service Unavailable";
const REVIEW_MERGE_CONFLICT_MARKER = "Merge Failed — Conflict Requires Rebase";

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

type TestSuiteKind = "unit" | "integration" | "all";
type TestSuiteOutcome = "pass" | "fail" | "timeout" | "spawn_error";

interface TestSuiteResult {
  passed: boolean;
  output: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  error: string | null;
  kind: TestSuiteOutcome;
}

interface ProjectConfig {
  type: "node" | "python" | "rust" | "go" | "make" | "unknown";
  testCommand: string[];
  unitTestCommand: string[];
  integrationTestCommand: string[];
  coverageCommand: string[];
  buildCommand: string[];
  hasTests: boolean;
}

/**
 * Find a Python test subdirectory by searching for common test layouts.
 * Searches for directories matching one of `keywords` at any depth under
 * common test roots (tests/, test/, src/test/, <package>/test/).
 * Returns the relative path from `workspace` (e.g. "hawkSoar/test/unit")
 * or undefined if no match found.
 */
function findPythonTestDir(workspace: string, keywords: string[]): string | undefined {
  // Gather candidate root directories to search under
  const topDirs = fs.readdirSync(workspace, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  // Common test roots: tests/, test/, and <package>/test/ (for src-layout packages)
  const testRoots = ["tests", "test"];
  for (const top of topDirs) {
    const subTest = path.join(top, "test");
    const subTests = path.join(top, "tests");
    if (fs.existsSync(path.join(workspace, subTest))) testRoots.push(subTest);
    if (fs.existsSync(path.join(workspace, subTests))) testRoots.push(subTests);
  }

  for (const root of testRoots) {
    const rootPath = path.join(workspace, root);
    if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) continue;

    // Direct child: tests/unit/, test/integration/
    for (const kw of keywords) {
      const direct = path.join(workspace, root, kw);
      if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) {
        // Return forward-slash relative path
        return path.relative(workspace, direct).replace(/\\/g, "/");
      }
    }

    // Nested: tests/<package>/unit/, e.g. tests/hawkSoar/unit/
    try {
      const entries = fs.readdirSync(rootPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        for (const kw of keywords) {
          const nested = path.join(workspace, root, entry.name, kw);
          if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) {
            return path.relative(workspace, nested).replace(/\\/g, "/");
          }
        }
      }
    } catch {
      // Permission or OS error — skip this root
    }
  }

  return undefined;
}

function detectProjectConfig(workspace: string): ProjectConfig {
  const envTest = process.env.AICODER_TEST_CMD;
  const envUnit = process.env.AICODER_UNIT_TEST_CMD;
  const envIntegration = process.env.AICODER_INTEGRATION_TEST_CMD;
  const envCoverage = process.env.AICODER_COVERAGE_CMD;

  if (envTest) {
    const testCmd = envTest.split(" ");
    return {
      type: "unknown",
      testCommand: testCmd,
      unitTestCommand: envUnit ? envUnit.split(" ") : testCmd,
      integrationTestCommand: envIntegration ? envIntegration.split(" ") : testCmd,
      coverageCommand: envCoverage ? envCoverage.split(" ") : [],
      buildCommand: [],
      hasTests: true,
    };
  }

  const pkgJsonPath = path.join(workspace, "package.json");
  const pyprojectPath = path.join(workspace, "pyproject.toml");
  const setupPyPath = path.join(workspace, "setup.py");
  const pytestIniPath = path.join(workspace, "pytest.ini");
  const cargoPath = path.join(workspace, "Cargo.toml");
  const goModPath = path.join(workspace, "go.mod");
  const makefilePath = path.join(workspace, "Makefile");

  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
      const scripts = pkg.scripts ?? {};
      const testCmd: string[] = "test" in scripts ? ["npm", "test"] : [];
      const hasTestScript = "test" in scripts;
      const unitCmd: string[] = "test-unit" in scripts
        ? ["npm", "run", "test-unit"]
        : hasTestScript ? ["npm", "test", "--", "tests/unit"] : [];
      const integrationCmd: string[] = "test-integration" in scripts
        ? ["npm", "run", "test-integration"]
        : hasTestScript ? ["npm", "test", "--", "tests/integration"] : [];
      const coverageCmd: string[] = "test:coverage" in scripts
        ? ["npm", "run", "test:coverage"]
        : [];
      const buildCmd: string[] = "build" in scripts
        ? ["npm", "run", "build"]
        : [];
      return {
        type: "node",
        testCommand: testCmd,
        unitTestCommand: envUnit ? envUnit.split(" ") : unitCmd,
        integrationTestCommand: envIntegration ? envIntegration.split(" ") : integrationCmd,
        coverageCommand: envCoverage ? envCoverage.split(" ") : coverageCmd,
        buildCommand: buildCmd,
        hasTests: hasTestScript,
      };
    } catch {
      return { type: "node", testCommand: [], unitTestCommand: [], integrationTestCommand: [], coverageCommand: [], buildCommand: [], hasTests: false };
    }
  }

  if (fs.existsSync(pyprojectPath) || fs.existsSync(setupPyPath) || fs.existsSync(pytestIniPath)) {
    // Auto-detect test directories instead of hardcoding conventions.
    // Common layouts: tests/unit/, hawkSoar/test/unit/, src/test/unit/, etc.
    const unitDir = findPythonTestDir(workspace, ["unit", "units"]);
    const integrationDir = findPythonTestDir(workspace, ["integration", "integrations", "functional", "e2e"]);

    return {
      type: "python",
      testCommand: ["pytest"],
      unitTestCommand: envUnit ? envUnit.split(" ") : unitDir ? ["pytest", unitDir] : ["pytest"],
      integrationTestCommand: envIntegration ? envIntegration.split(" ") : integrationDir ? ["pytest", integrationDir] : ["pytest"],
      coverageCommand: envCoverage ? envCoverage.split(" ") : ["pytest", "--cov"],
      buildCommand: [],
      hasTests: true,
    };
  }

  if (fs.existsSync(cargoPath)) {
    return {
      type: "rust",
      testCommand: ["cargo", "test"],
      unitTestCommand: envUnit ? envUnit.split(" ") : ["cargo", "test", "--lib"],
      integrationTestCommand: envIntegration ? envIntegration.split(" ") : ["cargo", "test"],
      coverageCommand: [],
      buildCommand: ["cargo", "build"],
      hasTests: true,
    };
  }

  if (fs.existsSync(goModPath)) {
    return {
      type: "go",
      testCommand: ["go", "test", "./..."],
      unitTestCommand: envUnit ? envUnit.split(" ") : ["go", "test", "./...", "-short"],
      integrationTestCommand: envIntegration ? envIntegration.split(" ") : ["go", "test", "./..."],
      coverageCommand: [],
      buildCommand: ["go", "build", "./..."],
      hasTests: true,
    };
  }

  if (fs.existsSync(makefilePath)) {
    const makeContent = fs.readFileSync(makefilePath, "utf-8");
    const hasTarget = (name: string) => new RegExp(`^${name}:`, "m").test(makeContent);
    const testCmd: string[] = hasTarget("test") ? ["make", "test"] : [];
    const unitCmd: string[] = hasTarget("test-unit") ? ["make", "test-unit"] : testCmd.length > 0 ? ["make", "test"] : [];
    const integrationCmd: string[] = hasTarget("test-integration") ? ["make", "test-integration"] : testCmd.length > 0 ? ["make", "test"] : [];
    const coverageCmd: string[] = hasTarget("test-coverage") ? ["make", "test-coverage"] : [];
    const buildCmd: string[] = hasTarget("build") ? ["make", "build"] : [];
    return {
      type: "make",
      testCommand: testCmd,
      unitTestCommand: envUnit ? envUnit.split(" ") : unitCmd,
      integrationTestCommand: envIntegration ? envIntegration.split(" ") : integrationCmd,
      coverageCommand: envCoverage ? envCoverage.split(" ") : coverageCmd,
      buildCommand: buildCmd,
      hasTests: testCmd.length > 0,
    };
  }

  return {
    type: "unknown",
    testCommand: [],
    unitTestCommand: [],
    integrationTestCommand: [],
    coverageCommand: [],
    buildCommand: [],
    hasTests: false,
  };
}

let projectConfig: ProjectConfig | null = null;
function getProjectConfig(): ProjectConfig {
  if (!projectConfig) {
    projectConfig = detectProjectConfig(WORKSPACE);
    runLogger.logConfig(`Detected project type: ${projectConfig.type}, test: ${projectConfig.testCommand.join(" ") || "none"}`);
  }
  return projectConfig;
}

const UNIT_TEST_TIMEOUT = parseInt(process.env.AICODER_UNIT_TEST_TIMEOUT || "180000", 10);
const INTEGRATION_TEST_TIMEOUT = parseInt(process.env.AICODER_INTEGRATION_TEST_TIMEOUT || "300000", 10);
const BASELINE_MAX_FIX_ATTEMPTS = parseInt(process.env.AICODER_BASELINE_MAX_FIX || "2", 10);

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
  // Determine source type: Jira keys (IR-82, PROJ-123) vs numeric GitHub issues
  const isJira = /^[A-Z]+-\d+$/.test(item.id);
  const sourceType = isJira ? "jira" : "github";
  const sourceId = isJira
    ? item.id
    : `${item.owner || cfg.owner}/${item.repo || cfg.repo}#${item.number}`;

  const resp = await axios.post<GeneratedPrompt>(
    `${cfg.apiUrl}/api/ticket-bridge/prompt`,
    {
      source: {
        type: sourceType,
        id: sourceId,
      },
      context: { includeCodebaseIndex: true, skipMissingCodingPrompt: true },
    },
    { headers: authHeaders(cfg) },
  );
  return resp.data;
}

/**
 * Detect whether the git remote origin points to GitHub, GitLab, or unknown.
 * Returns "github" for github.com URLs, "gitlab" for gitlab.* URLs, "unknown" otherwise.
 */
function detectRemotePlatform(cwd: string): "github" | "gitlab" | "unknown" {
  const result = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd, stdio: "pipe", encoding: "utf-8",
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    return "unknown";
  }
  const url = result.stdout.trim().toLowerCase();
  if (url.includes("github.com")) return "github";
  if (url.includes("gitlab")) return "gitlab";
  return "unknown";
}

async function createPR(
  cfg: ServerConfig,
  item: WorkItem,
  branchName: string,
): Promise<{ prNumber: number; url: string } | null> {
  const platform = detectRemotePlatform(WORKSPACE);
  runLogger.logGit(`Detected remote platform: ${platform}`);

  if (platform === "gitlab") {
    // Create a GitLab merge request instead of a GitHub PR
    try {
      const resp = await axios.post<{ success: boolean; mrIid?: number; url?: string; error?: string }>(
        `${cfg.apiUrl}/api/autonomous-loop/mr`,
        {
          project: item.repo || cfg.repo,
          title: `[AI] ${item.title}`,
          sourceBranch: branchName,
          targetBranch: BASE_BRANCH,
          description: item.url ? `Closes ${item.url}\n\nIssue: ${item.id}\n\n_Generated by AiRemoteCoder autonomous agent._` : `Issue: ${item.id}\n\n_Generated by AiRemoteCoder autonomous agent._`,
          removeSourceBranch: true,
        },
        { headers: authHeaders(cfg) },
      );
      if (resp.data.success) {
        return { prNumber: resp.data.mrIid ?? 0, url: resp.data.url ?? "" };
      }
      runLogger.logError(`GitLab MR creation failed: ${resp.data.error ?? "unknown error"}`);
      return null;
    } catch (err) {
      runLogger.logError(`GitLab MR creation failed: ${(err as Error).message}`);
      return null;
    }
  }

  // Default: GitHub PR
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
  const platform = detectRemotePlatform(WORKSPACE);

  // For Jira sources on GitLab, post completion to the Jira endpoint
  if (cfg.source === "jira" && platform === "gitlab") {
    try {
      await axios.post(
        `${cfg.apiUrl}/api/autonomous-loop/complete/jira`,
        {
          issueKey: item.id || String(item.number),
          branchName,
          mrIid: prNumber,
          agentExitCode: exitCode,
        },
        { headers: authHeaders(cfg) },
      );
    } catch {
      // notification is non-fatal
    }
    return;
  }

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

function gitRunWithOutput(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, stdio: "pipe", encoding: "utf-8" });
  if (result.status !== 0) {
    runLogger.logGit(`git ${args.join(" ")}`, `failed: ${result.stderr?.trim()}`);
  }
  return {
    ok: result.status === 0,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function getCurrentBranch(): string | null {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function isRebaseInProgress(cwd: string): boolean {
  const gitDir = path.join(cwd, ".git");
  return fs.existsSync(path.join(gitDir, "rebase-merge"))
      || fs.existsSync(path.join(gitDir, "rebase-apply"));
}

/**
 * Recover from a stuck rebase state. Tries git rebase --abort first,
 * then removes blocking files and retries, then manually cleans up
 * .git/rebase-merge/ and .git/rebase-apply/ as a last resort.
 * Never uses git reset --hard — always preserves working tree changes.
 */
function recoverFromRebase(cwd: string): boolean {
  if (!isRebaseInProgress(cwd)) return true;

  runLogger.logGit("WARN", "Mid-rebase state detected — attempting recovery");

  // Step 1: Try a clean abort
  if (gitRun(["rebase", "--abort"], cwd)) return true;

  // Step 2: Abort may fail because git can't move/remove locked untracked files.
  // Parse stderr for the file paths blocking the operation.
  runLogger.logGit("WARN", "git rebase --abort failed — attempting to remove blocking files");
  const abortResult = gitRunWithOutput(["rebase", "--abort"], cwd);
  const abortErr = abortResult.stderr;

  // Extract file paths from error messages like:
  //   "error: unable to unlink old 'path/to/file.log': Invalid argument"
  //   "The following untracked working tree files would be overwritten by checkout:"
  const unlinkMatches = abortErr.matchAll(/unable to unlink old '([^']+)'/g);
  const overwriteSection = abortErr.match(/The following untracked working tree files would be overwritten by checkout:\s*\n((?:\s+.+\n?)+)/);

  const blockingFiles: string[] = [];
  for (const m of unlinkMatches) blockingFiles.push(m[1]);
  if (overwriteSection) {
    overwriteSection[1].split("\n").forEach(line => {
      const f = line.trim();
      if (f) blockingFiles.push(f);
    });
  }

  // Try to remove each blocking file
  for (const filePath of blockingFiles) {
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
    try {
      fs.unlinkSync(absPath);
      runLogger.logGit("Removed blocking file", filePath);
    } catch {
      // File may be locked — try renaming it out of the way
      try {
        const bakPath = absPath + ".blocking.bak";
        fs.renameSync(absPath, bakPath);
        runLogger.logGit("Renamed blocking file", `${filePath} -> ${bakPath}`);
      } catch {
        runLogger.logGit("WARN", `Could not remove or rename blocking file: ${filePath}`);
      }
    }
  }

  // Step 3: Retry abort after clearing blocking files
  if (gitRun(["rebase", "--abort"], cwd)) {
    runLogger.logGit("Rebase abort succeeded after removing blocking files");
    return true;
  }

  // Step 4: Manual cleanup — read original HEAD BEFORE removing rebase state
  runLogger.logGit("WARN", "Manual rebase cleanup — reading orig-head before removing state");
  const gitDir = path.join(cwd, ".git");
  let origHead: string | null = null;
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const origHeadPath = path.join(gitDir, dir, "orig-head");
    try {
      if (fs.existsSync(origHeadPath)) {
        origHead = fs.readFileSync(origHeadPath, "utf-8").trim();
        runLogger.logGit("Read orig-head", origHead);
      }
    } catch { /* file may not exist */ }
  }

  // Now remove the rebase state directories
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const dirPath = path.join(gitDir, dir);
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  }

  // Soft reset to preserve all staged/working tree changes
  const resetTarget = origHead || "HEAD";
  if (!gitRun(["reset", "--soft", resetTarget], cwd)) {
    runLogger.logGit("WARN", "git reset --soft failed — trying git reset --soft HEAD");
    gitRun(["reset", "--soft", "HEAD"], cwd);
  }

  runLogger.logGit("Rebase recovery completed — repo should be in a clean state");
  return !isRebaseInProgress(cwd);
}

/**
 * Ensure the workspace is in a clean, usable state. Fixes:
 * 1. Mid-rebase states
 * 2. Unmerged paths from failed merges/stash pops
 * 3. Dirty working tree (uncommitted changes)
 * 4. Detached HEAD state
 * Returns true if the workspace is clean, false if recovery failed.
 */
function ensureCleanWorkspace(): boolean {
  // 1. Recover from mid-rebase
  if (isRebaseInProgress(WORKSPACE)) {
    runLogger.logGit("WARN", "Mid-rebase state detected during workspace cleanup");
    if (!recoverFromRebase(WORKSPACE)) {
      runLogger.logError("Could not recover from mid-rebase state");
      return false;
    }
  }

  // 2. Check for unmerged paths
  const statusResult = spawnSync("git", ["status", "--porcelain"], {
    cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
  });
  if (statusResult.status === 0) {
    const unmerged = statusResult.stdout.trim().split("\n")
      .filter(line => /^(DD|AU|UD|UA|DU|UU|AA)/.test(line))
      .map(line => line.slice(3).trim())
      .filter(Boolean);

    if (unmerged.length > 0) {
      runLogger.logGit("WARN", `Found ${unmerged.length} unmerged path(s) — resolving`);
      for (const file of unmerged) {
        // Accept whatever is in the working tree (likely partial resolution)
        if (!gitRun(["add", "--", file], WORKSPACE)) {
          // If add fails, the file may have been deleted — remove from index
          gitRun(["rm", "--", file], WORKSPACE);
        }
      }
      // Commit the resolution
      stageAndCommit("[AI] auto-resolved unmerged paths");
    }
  }

  // 3. Commit any dirty working tree changes
  const dirtyResult = spawnSync("git", ["diff", "--quiet"], {
    cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
  });
  const hasUncommittedChanges = dirtyResult.status !== 0;

  const cachedResult = spawnSync("git", ["diff", "--cached", "--quiet"], {
    cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
  });
  const hasStagedChanges = cachedResult.status !== 0;

  if (hasUncommittedChanges || hasStagedChanges) {
    runLogger.logGit("Committing uncommitted changes during workspace cleanup");
    stageAndCommit("[AI] auto-cleanup: committing pending changes");
  }

  // 4. Check for detached HEAD
  const branch = getCurrentBranch();
  if (branch === "HEAD" || branch === null) {
    runLogger.logGit("WARN", "Detached HEAD detected — switching to base branch");
    gitRun(["checkout", getBaseBranch()], WORKSPACE);
  }

  return true;
}

/**
 * Resolve the actual default branch by checking git remote HEAD,
 * then falling back to trying each candidate branch that exists locally.
 */
/**
 * Force-checkout a branch, handling untracked file conflicts.
 * If checkout fails because untracked files would be overwritten,
 * stages and commits those files to preserve them, then retries.
 * Falls back to git stash --include-untracked if staging fails.
 */
function forceCheckout(branch: string, cwd: string): boolean {
  // Try a clean checkout first
  const firstAttempt = gitRunWithOutput(["checkout", branch], cwd);
  if (firstAttempt.ok) return true;

  // Parse the "would be overwritten by checkout" error to find conflicting files
  const stderr = firstAttempt.stderr;

  const overwriteMatch = stderr.match(/The following untracked working tree files would be overwritten by checkout:\s*\n((?:\s+.+\n?)+)/);
  if (!overwriteMatch) {
    runLogger.logError(`Could not checkout ${branch} — no recognizable conflict pattern`);
    return false;
  }

  const conflictingFiles = overwriteMatch[1]
    .split("\n")
    .map(l => l.trim())
    .filter(f => f);

  if (conflictingFiles.length === 0) {
    runLogger.logError(`Could not checkout ${branch} — untracked conflict but no files found`);
    return false;
  }

  runLogger.logGit("Staging conflicting untracked files before checkout", conflictingFiles.join(", "));
  // Stage and commit conflicting files to preserve them
  for (const f of conflictingFiles) {
    if (!gitRun(["add", f], cwd)) {
      runLogger.logGit("WARN", `Could not stage ${f} — may need manual resolution`);
    }
  }
  stageAndCommit(`[AI] auto-save: preserve untracked files before checkout of ${branch}`);

  // Retry checkout
  if (gitRun(["checkout", branch], cwd)) return true;

  // Last resort: stash everything including untracked, checkout, then pop
  runLogger.logGit("WARN", "Checkout still failed — stashing all changes including untracked");
  gitRun(["stash", "--include-untracked"], cwd);
  if (!gitRun(["checkout", branch], cwd)) {
    runLogger.logError(`Could not checkout ${branch} even after stashing`);
    safeStashPop(cwd);
    return false;
  }
  safeStashPop(cwd);
  return true;
}

/** Get list of files with conflict markers in the working tree. */
function getConflictFiles(): string[] {
  const statusResult = spawnSync("git", ["status", "--porcelain"], {
    cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
  });
  if (statusResult.status !== 0) return [];
  return statusResult.stdout.trim().split("\n")
    .filter(line => /^(DD|AU|UD|UA|DU|UU|AA)/.test(line))
    .map(line => line.slice(3).trim())
    .filter(Boolean);
}

/** Pop stash and handle any conflicts that arise from the pop. */
function safeStashPop(cwd: string): boolean {
  if (!gitRun(["stash", "pop"], cwd)) {
    // Stash pop had conflicts — resolve them
    runLogger.logGit("WARN", "Stash pop had conflicts — auto-resolving");
    const branchFiles = getBranchModifiedFiles();
    resolveConflictsInWorkingTree(branchFiles, false);
    stageAndCommit("[AI] auto-resolved stash pop conflicts");
    return false; // stash entry was consumed by pop, but had conflicts
  }
  return true;
}

/**
 * Get the list of files modified by the current branch compared to the base branch.
 * Used to determine which files the AI changed, so we can decide conflict resolution strategy.
 */
function getBranchModifiedFiles(): string[] {
  // Try comparing against the remote base branch first
  let result = spawnSync("git", ["diff", "--name-only", `origin/${getBaseBranch()}`], {
    cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
  });
  if (result.status === 0) {
    const files = result.stdout.trim().split("\n").filter(Boolean);
    if (files.length > 0) return files;
  }

  // Fallback: compare against the local base branch (may not be fetched)
  result = spawnSync("git", ["diff", "--name-only", getBaseBranch()], {
    cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
  });
  if (result.status === 0) {
    const files = result.stdout.trim().split("\n").filter(Boolean);
    if (files.length > 0) return files;
  }

  // Last resort: if on an AI branch, diff against HEAD~N where N is branch commit count
  const current = getCurrentBranch();
  if (current && current.startsWith("ai/")) {
    const mergeBase = spawnSync("git", ["merge-base", "HEAD", getBaseBranch()], {
      cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
    });
    if (mergeBase.status === 0) {
      const base = mergeBase.stdout.trim();
      result = spawnSync("git", ["diff", "--name-only", base], {
        cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
      });
      if (result.status === 0) {
        return result.stdout.trim().split("\n").filter(Boolean);
      }
    }
  }

  // All methods failed — return empty (callers should handle this)
  return [];
}

/**
 * Resolve git conflicts in the working tree. For files modified by the AI branch,
 * accept the AI's version. For files NOT modified by the AI branch,
 * accept the base branch version.
 *
 * IMPORTANT: During rebase, git's --ours/--theirs semantics are INVERTED:
 *   --ours = base branch (the branch being rebased onto)
 *   --theirs = feature branch (the commits being replayed)
 * So during rebase, we use --theirs for AI files and --ours for base files.
 */
function resolveConflictsInWorkingTree(branchFiles: string[], isRebase: boolean = false): number {
  const statusResult = spawnSync("git", ["status", "--porcelain"], {
    cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
  });
  if (statusResult.status !== 0) return 0;

  const conflictFiles = statusResult.stdout.trim().split("\n")
    .filter(line => line.startsWith("UU") || line.startsWith("AA") || line.startsWith("DU") || line.startsWith("UD"))
    .map(line => line.slice(3).trim());

  if (conflictFiles.length === 0) return 0;

  // If branchFiles is empty, default to keeping AI changes (ours in merge, theirs in rebase)
  // rather than discarding all AI work
  const branchFileSet = new Set(branchFiles);
  const aiFileDefault = branchFileSet.size === 0;

  let resolvedCount = 0;

  for (const file of conflictFiles) {
    const isAiFile = aiFileDefault || branchFileSet.has(file);

    if (isRebase) {
      // During rebase: --theirs = feature branch (AI), --ours = base branch
      if (isAiFile) {
        runLogger.logGit("Resolving conflict (rebase: accept AI/theirs)", file);
        gitRun(["checkout", "--theirs", "--", file], WORKSPACE);
      } else {
        runLogger.logGit("Resolving conflict (rebase: accept base/ours)", file);
        gitRun(["checkout", "--ours", "--", file], WORKSPACE);
      }
    } else {
      // During merge: --ours = feature branch (AI), --theirs = base branch
      if (isAiFile) {
        runLogger.logGit("Resolving conflict (merge: accept AI/ours)", file);
        gitRun(["checkout", "--ours", "--", file], WORKSPACE);
      } else {
        runLogger.logGit("Resolving conflict (merge: accept base/theirs)", file);
        gitRun(["checkout", "--theirs", "--", file], WORKSPACE);
      }
    }
    gitRun(["add", "--", file], WORKSPACE);
    resolvedCount++;
  }

  return resolvedCount;
}

/**
 * Perform a local rebase with conflict resolution. Returns true if the rebase
 * completed successfully (with or without conflicts that were auto-resolved).
 */
async function rebaseAndResolveConflicts(branchName: string): Promise<boolean> {
  runLogger.logGit("Starting local rebase with conflict resolution", branchName);

  // Stage any uncommitted changes first
  stageAndCommit("[AI] auto-save before rebase");

  // Recover from any stuck rebase state
  if (isRebaseInProgress(WORKSPACE)) {
    if (!recoverFromRebase(WORKSPACE)) {
      runLogger.logError("Could not recover from mid-rebase state before conflict rebase");
      return false;
    }
  }

  // Fetch latest base branch
  if (!gitRun(["fetch", "origin", getBaseBranch()], WORKSPACE)) {
    runLogger.logError("Failed to fetch latest base branch for rebase");
    return false;
  }

  // Ensure we're on the feature branch
  if (!forceCheckout(branchName, WORKSPACE)) {
    runLogger.logError(`Could not checkout ${branchName} for rebase`);
    return false;
  }

  // Get the list of files this branch modifies (before rebase)
  const branchFiles = getBranchModifiedFiles();
  runLogger.logGit("Branch modifies files", branchFiles.join(", "));

  // Attempt rebase
  const rebaseResult = gitRunWithOutput(["rebase", `origin/${getBaseBranch()}`], WORKSPACE);

  if (rebaseResult.ok) {
    runLogger.logGit("Rebase completed cleanly (no conflicts)");
    return true;
  }

  // Rebase had conflicts — try LLM-assisted resolution first, then fall back to dumb resolution
  runLogger.logGit("Rebase has conflicts — attempting resolution");

  // Step 1: Try LLM-assisted conflict resolution
  const conflictFileList = getConflictFiles();
  if (conflictFileList.length > 0) {
    runLogger.logGit(`Attempting LLM conflict resolution for ${conflictFileList.length} file(s)`);
    const conflictPrompt = buildConflictResolutionPrompt(conflictFileList, branchName);
    const llmResult = await runAgent(conflictPrompt);
    if (llmResult.finDetected || llmResult.exitCode === 0) {
      // Check if the agent actually resolved all conflicts
      const remainingConflicts = getConflictFiles();
      if (remainingConflicts.length === 0) {
        // Stage the resolved files and continue the rebase
        gitRun(["add", "--all"], WORKSPACE);
        const continueResult = spawnSync("git", ["rebase", "--continue"], {
          cwd: WORKSPACE,
          stdio: "pipe",
          encoding: "utf-8",
          env: { ...process.env, GIT_EDITOR: "true" },
        });
        if (continueResult.status === 0) {
          runLogger.logGit(`Rebase completed with LLM conflict resolution`);
          return true;
        }
        // If continue failed but no more conflicts, try again
        if (!isRebaseInProgress(WORKSPACE)) {
          runLogger.logGit("Rebase completed after LLM resolution and continue");
          return true;
        }
        runLogger.logGit("LLM resolved conflicts but rebase continue had issues — falling back to dumb resolution");
      } else {
        runLogger.logGit(`LLM left ${remainingConflicts.length} conflict(s) — falling back to dumb resolution`);
      }
    }
  }

  // Step 2: Fall back to dumb --ours/--theirs resolution
  let resolvedTotal = 0;
  let maxRounds = 10; // Safety limit for multiple conflict rounds

  while (maxRounds-- > 0) {
    resolveConflictsInWorkingTree(branchFiles, true);
    if (resolvedCount === 0) break;
    resolvedTotal += resolvedCount;

    // Continue the rebase after resolving conflicts
    const continueResult = spawnSync("git", ["rebase", "--continue"], {
      cwd: WORKSPACE,
      stdio: "pipe",
      encoding: "utf-8",
      env: { ...process.env, GIT_EDITOR: "true" },
    });

    if (continueResult.status === 0) {
      // Rebase completed successfully after conflict resolution
      runLogger.logGit(`Rebase completed with ${resolvedTotal} conflict(s) auto-resolved`);
      return true;
    }

    // Check if rebase is still in progress (more conflicts to resolve)
    if (!isRebaseInProgress(WORKSPACE)) {
      // Rebase failed but is not in progress — something else went wrong
      runLogger.logError(`Rebase continue failed: ${continueResult.stderr}`);
      if (!gitRun(["rebase", "--abort"], WORKSPACE)) {
        recoverFromRebase(WORKSPACE);
      }
      return false;
    }
    // More conflicts — loop again
  }

  if (resolvedTotal === 0) {
    runLogger.logGit("Rebase failed but no conflict files found — aborting rebase");
    if (!gitRun(["rebase", "--abort"], WORKSPACE)) {
      recoverFromRebase(WORKSPACE);
    }
    return false;
  }

  runLogger.logGit(`Rebase completed with ${resolvedTotal} conflict(s) auto-resolved`);
  return true;
}

function resolveBaseBranch(): string {
  // Try git remote HEAD first (e.g., refs/remotes/origin/master)
  const headResult = spawnSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
    cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
  });
  if (headResult.status === 0) {
    const match = headResult.stdout.trim().match(/refs\/remotes\/origin\/(.+)/);
    if (match) {
      const resolved = match[1];
      runLogger.logGit("Base branch resolved from remote HEAD", resolved);
      return resolved;
    }
  }

  // Fall back: try each candidate until one exists as a local or remote branch
  for (const candidate of BASE_BRANCH_CANDIDATES) {
    const verify = spawnSync("git", ["rev-parse", "--verify", candidate], {
      cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
    });
    if (verify.status === 0) {
      runLogger.logGit("Base branch resolved from local", candidate);
      return candidate;
    }
    // Also try as remote ref
    const remoteVerify = spawnSync("git", ["rev-parse", "--verify", `origin/${candidate}`], {
      cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
    });
    if (remoteVerify.status === 0) {
      runLogger.logGit("Base branch resolved from remote", candidate);
      return candidate;
    }
  }

  // Last resort: use whatever branch we're on
  const current = getCurrentBranch();
  runLogger.logGit("WARN", `Could not resolve base branch — using current: ${current}`);
  return current ?? "main";
}

let _resolvedBaseBranch: string | null = null;
function getBaseBranch(): string {
  if (!_resolvedBaseBranch) {
    _resolvedBaseBranch = resolveBaseBranch();
  }
  return _resolvedBaseBranch;
}

function pullAndUpdateBase(): boolean {
  // Recover from any stuck rebase state before attempting checkout
  if (isRebaseInProgress(WORKSPACE)) {
    runLogger.logGit("WARN", "Mid-rebase state detected — recovering before pull");
    if (!recoverFromRebase(WORKSPACE)) {
      runLogger.logError("Could not recover from mid-rebase state — skipping pull");
      return false;
    }
  }
  const base = getBaseBranch();
  const previousBranch = getCurrentBranch();
  runLogger.logGit("Pulling latest", base);
  if (!forceCheckout(base, WORKSPACE)) {
    runLogger.logError(`Failed to switch to ${base}`);
    return false;
  }
  if (!gitRun(["pull", "--ff-only", "origin", base], WORKSPACE)) {
    runLogger.logError(`Pull --ff-only failed for ${base} — base branch may be stale`);
    // Restore previous branch if we switched
    if (previousBranch && previousBranch !== base) {
      forceCheckout(previousBranch, WORKSPACE);
    }
    return false;
  }
  return true;
}

async function checkoutBranch(branchName: string, fromBranch?: string): Promise<boolean> {
  // Recover from any stuck rebase state before doing anything
  if (isRebaseInProgress(WORKSPACE)) {
    runLogger.logGit("WARN", "Mid-rebase state detected — recovering");
    if (!recoverFromRebase(WORKSPACE)) {
      runLogger.logError("Could not recover from mid-rebase state");
      return false;
    }
  }

  // Already on the target branch — stage any pending changes, then rebase onto base
  const current = getCurrentBranch();
  if (current === branchName) {
    runLogger.logGit("Already on branch", branchName);
    // Stage any leftover changes from a prior interrupted run
    stageAndCommit(`[AI] resume: staged pending changes`);
    // Pull latest base, then rebase this branch onto it
    if (!pullAndUpdateBase()) {
      runLogger.logGit("WARN", `Could not pull latest ${getBaseBranch()} before rebase`);
    }
    runLogger.logGit("Rebasing onto latest", getBaseBranch());
    if (!forceCheckout(branchName, WORKSPACE)) {
      runLogger.logGit("WARN", `Could not switch back to ${branchName} after pull`);
    }
    gitRun(["rebase", getBaseBranch()], WORKSPACE);
    if (!await resolveRebaseConflictsInPlace(branchName)) {
      return false;
    }
    return true;
  }

  // Stage/commit ALL uncommitted changes before switching branches.
  // This includes .gitignore edits, leftover agent output, etc.
  const dirtyResult = spawnSync("git", ["diff", "--quiet"], {
    cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
  });
  const hasUncommittedChanges = dirtyResult.status !== 0;

  if (hasUncommittedChanges) {
    runLogger.logGit("Committing uncommitted changes before branch switch", current || "(detached)");
    const saved = stageAndCommit(`[AI] auto-save before switching from ${current || "detached"}`);
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
    if (!forceCheckout(fromBranch, WORKSPACE)) {
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
    // Branch already exists — checkout and rebase onto latest base
    runLogger.logGit("Switching to existing branch", branchName);
    if (!forceCheckout(branchName, WORKSPACE)) {
      // Checkout failed even with force — try stash with untracked files included
      runLogger.logGit("Stashing all changes (including untracked) before checkout");
      gitRun(["stash", "--include-untracked"], WORKSPACE);
      if (!forceCheckout(branchName, WORKSPACE)) {
        runLogger.logError(`Could not checkout branch ${branchName}`);
        safeStashPop(WORKSPACE);
        return false;
      }
      // Stage any changes on the target branch before rebasing
      stageAndCommit(`[AI] resume: staged pending changes on ${branchName}`);
      runLogger.logGit("Rebasing existing branch onto latest", getBaseBranch());
      gitRun(["rebase", getBaseBranch()], WORKSPACE);
      if (!await resolveRebaseConflictsInPlace(branchName)) {
        safeStashPop(WORKSPACE);
        return false;
      }
      safeStashPop(WORKSPACE);
    } else {
      // Successfully checked out — stage any dirty changes, then rebase
      stageAndCommit(`[AI] resume: staged pending changes on ${branchName}`);
      runLogger.logGit("Rebasing existing branch onto latest", getBaseBranch());
      gitRun(["rebase", getBaseBranch()], WORKSPACE);
      if (!await resolveRebaseConflictsInPlace(branchName)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * When a `git rebase` was just attempted and has conflicts in progress,
 * resolve them directly (dumb + LLM) without aborting and starting over.
 * Returns true if rebase completed (with or without conflict resolution).
 */
async function resolveRebaseConflictsInPlace(branchName: string): Promise<boolean> {
  if (!isRebaseInProgress(WORKSPACE)) {
    // Rebase succeeded cleanly or was not attempted — check the result
    return gitRun(["rebase", getBaseBranch()], WORKSPACE) || false;
  }

  // Rebase is in progress with conflicts — resolve them
  runLogger.logGit("Rebase has conflicts — resolving in place");
  const branchFiles = getBranchModifiedFiles();

  // Step 1: Dumb resolution (--ours/--theirs)
  resolveConflictsInWorkingTree(branchFiles, true);

  // Step 2: Check for remaining conflicts and try LLM
  const remainingConflicts = getConflictFiles();
  if (remainingConflicts.length > 0) {
    runLogger.logGit(`Attempting LLM conflict resolution for ${remainingConflicts.length} remaining file(s)`);
    const conflictPrompt = buildConflictResolutionPrompt(remainingConflicts, branchName);
    const llmResult = await runAgent(conflictPrompt);
    if (llmResult.finDetected || llmResult.exitCode === 0) {
      const afterLlm = getConflictFiles();
      if (afterLlm.length === 0) {
        gitRun(["add", "--all"], WORKSPACE);
      }
    }
  }

  // Stage everything and try to continue the rebase
  gitRun(["add", "--all"], WORKSPACE);
  const continueResult = spawnSync("git", ["rebase", "--continue"], {
    cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8",
    env: { ...process.env, GIT_EDITOR: "true" },
  });

  if (continueResult.status === 0 || !isRebaseInProgress(WORKSPACE)) {
    runLogger.logGit("Rebase completed after conflict resolution");
    return true;
  }

  // Still stuck — abort
  runLogger.logError("Could not resolve rebase conflicts — aborting rebase");
  if (!gitRun(["rebase", "--abort"], WORKSPACE)) {
    recoverFromRebase(WORKSPACE);
  }
  return false;
}

function runTestSuite(suiteKind: TestSuiteKind = "all"): TestSuiteResult {
  const cfg = getProjectConfig();

  let command: string[];
  let timeout: number;

  switch (suiteKind) {
    case "unit":
      command = cfg.unitTestCommand;
      timeout = UNIT_TEST_TIMEOUT;
      break;
    case "integration":
      command = cfg.integrationTestCommand;
      timeout = INTEGRATION_TEST_TIMEOUT;
      break;
    default:
      command = cfg.testCommand;
      timeout = 300_000;
  }

  if (command.length === 0) {
    runLogger.logConfig(`No ${suiteKind} test command detected — skipping`);
    return { passed: true, output: `No ${suiteKind} test command detected — skipping`, exitCode: 0, signal: null, timedOut: false, error: null, kind: "pass" };
  }

  runLogger.logGit(`Running ${suiteKind} tests`, command.join(" "));
  const result = spawnSync(command[0], command.slice(1), {
    cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8", timeout,
  });

  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();
  const combined = `${stdout}\n${stderr}`;
  const spawnError = result.error?.message ?? null;
  const timedOut = (result as any).timedOut === true;
  const signal = result.signal ?? null;

  let kind: TestSuiteOutcome;
  if (result.status === 0) {
    kind = "pass";
  } else if (spawnError) {
    kind = "spawn_error";
  } else if (timedOut || (result.status === null && signal)) {
    kind = "timeout";
  } else {
    kind = "fail";
  }

  const passed = kind === "pass";

  if (!passed) {
    const lastLines = combined.split("\n").slice(-15).join("\n");
    switch (kind) {
      case "spawn_error":
        runLogger.logError(`${suiteKind} tests could not start: ${spawnError}`);
        break;
      case "timeout":
        runLogger.logError(`${suiteKind} tests timed out after ${timeout}ms${signal ? ` (killed by ${signal})` : ""}${lastLines ? `\n${lastLines}` : ""}`);
        break;
      default:
        runLogger.logError(`${suiteKind} tests failed (exit code ${result.status}):\n${lastLines || "no output captured"}`);
    }
  } else {
    runLogger.logGit(`${suiteKind} tests passed`, command.join(" "));
  }

  return { passed, output: combined, exitCode: result.status, signal, timedOut, error: spawnError, kind };
}

function checkCoverage(): { passed: boolean; kind: TestSuiteOutcome } {
  const cfg = getProjectConfig();

  if (cfg.coverageCommand.length === 0) {
    runLogger.logConfig("No coverage command detected — skipping coverage check");
    return { passed: true, kind: "pass" };
  }

  runLogger.logGit("Checking coverage thresholds", cfg.coverageCommand.join(" "));
  const result = spawnSync(cfg.coverageCommand[0], cfg.coverageCommand.slice(1), {
    cwd: WORKSPACE, stdio: "pipe", encoding: "utf-8", timeout: 300_000,
  });

  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();
  const combined = `${stdout}\n${stderr}`;
  const spawnError = result.error?.message ?? null;
  const timedOut = (result as any).timedOut === true;
  const signal = result.signal ?? null;

  let kind: TestSuiteOutcome;
  if (result.status === 0) {
    kind = "pass";
  } else if (spawnError) {
    kind = "spawn_error";
  } else if (timedOut || (result.status === null && signal)) {
    kind = "timeout";
  } else {
    kind = "fail";
  }

  if (kind !== "pass") {
    const lastLines = combined.split("\n").slice(-20).join("\n");
    switch (kind) {
      case "spawn_error":
        runLogger.logError(`Coverage check could not start: ${spawnError}`);
        break;
      case "timeout":
        runLogger.logError(`Coverage check timed out after 300000ms${signal ? ` (killed by ${signal})` : ""}${lastLines ? `\n${lastLines}` : ""}`);
        break;
      default:
        runLogger.logError(`Coverage check failed (exit code ${result.status}):\n${lastLines || "no output captured"}`);
    }
    return { passed: false, kind };
  }

  runLogger.logGit("Coverage thresholds met");
  return { passed: true, kind };
}

function buildConflictResolutionPrompt(conflictFiles: string[], branchName: string): string {
  // Read conflict markers from each file
  const conflictSections: string[] = [];
  const maxFileLen = 4000;
  const maxTotalLen = 12000;
  let totalLen = 0;

  for (const file of conflictFiles.slice(0, 8)) { // Limit to 8 files
    try {
      const filePath = path.isAbsolute(file) ? file : path.join(WORKSPACE, file);
      const content = fs.readFileSync(filePath, "utf-8");
      // Extract only the conflict sections (between <<<<<<< and >>>>>>>)
      const conflictBlocks: string[] = [];
      const lines = content.split("\n");
      let inConflict = false;
      let blockLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith("<<<<<<<")) {
          inConflict = true;
          blockLines = [line];
        } else if (line.startsWith(">>>>>>>")) {
          blockLines.push(line);
          conflictBlocks.push(blockLines.join("\n"));
          blockLines = [];
          inConflict = false;
        } else if (inConflict) {
          blockLines.push(line);
        }
      }
      if (conflictBlocks.length > 0) {
        const section = `### ${file}\n\n${conflictBlocks.join("\n\n")}`;
        const truncated = section.length > maxFileLen ? section.slice(0, maxFileLen) + "\n...(truncated)" : section;
        conflictSections.push(truncated);
        totalLen += truncated.length;
        if (totalLen > maxTotalLen) break;
      }
    } catch {
      // File may have been deleted or be binary — skip it
    }
  }

  const conflictContent = conflictSections.join("\n\n");
  const baseBranch = getBaseBranch();

  return `# URGENT: Resolve Git Merge Conflicts

The branch \`${branchName}\` has merge conflicts when rebasing onto \`${baseBranch}\`.

You must resolve ALL conflict markers in the files listed below. The conflict markers look like:

\`\`\`
<<<<<<< HEAD (base branch changes)
... base branch version ...
=======
... feature branch (your) version ...
>>>>>>> ${branchName} (your changes)
\`\`\`

## Conflict Sections

${conflictContent || "(Could not read conflict files — resolve conflicts manually in the working directory)"}

## Instructions

1. **Read each conflict carefully.** Understand what the base branch changed and what your branch changed.
2. **Merge both sides intelligently.** Do NOT just pick one side. Preserve both changes where they don't directly conflict.
3. **Remove ALL conflict markers** (<<<<<<<, =======, >>>>>>>). Every single one must be gone.
4. **Preserve the intent of both branches.** The base branch changes may include important fixes or updates. Your changes implement the feature. Both should be preserved where possible.
5. **If changes truly conflict** (same function, same line), prefer the feature branch version but incorporate any base branch improvements that don't directly clash.
6. **Run the project tests after resolving** to verify your resolution doesn't break anything.

Focus ONLY on resolving the conflicts. Do not add new features or make unrelated changes.`;
}

function buildBaselineFixPrompt(testOutput: string, item: WorkItem): string {
  const maxOutputLen = 8000;
  const truncatedOutput = testOutput.length > maxOutputLen
    ? testOutput.slice(testOutput.length - maxOutputLen)
    : testOutput;
  const cfg = getProjectConfig();
  const testCmd = cfg.testCommand.join(" ") || "npm test";

  return `# URGENT: Fix Failing Baseline Tests

The existing test suite is currently failing on the branch for issue #${item.number}: ${item.title}.

Before implementing new work, the existing tests must pass. The test failure output is below.

## Test Failure Output

\`\`\`
${truncatedOutput}
\`\`\`

## Instructions

1. **Read the test failure output carefully.** Identify which test files and assertions are failing.
2. **Fix the root cause.** This is typically a missing import, a type error, a configuration issue, or a test that references code that was recently changed.
3. **Do NOT skip or delete failing tests.** Fix the underlying code or update tests only if they test incorrect/outdated behavior.
4. **Run \`${testCmd}\` locally after each fix** to verify your changes resolve the failures.
5. **Commit your fix** with a descriptive message like "fix: resolve baseline test failure in X".

Focus ONLY on fixing the failing tests. Do not implement new features or make unrelated changes.`;
}

async function fixBaselineTests(_cfg: ServerConfig, item: WorkItem): Promise<boolean> {
  const cfg = getProjectConfig();

  if (!cfg.hasTests) {
    runLogger.logConfig("No test infrastructure detected — skipping baseline check");
    return true;
  }

  runLogger.logWork("Running baseline test check before agent starts");

  const baseline = runTestSuite("all");
  if (baseline.passed) {
    runLogger.logConfig("Baseline tests passed — proceeding");
    return true;
  }

  if (baseline.kind === "timeout") {
    runLogger.logError("Baseline tests timed out — cannot auto-fix a timeout. Increase timeout or investigate workspace setup.");
    return false;
  }

  if (baseline.kind === "spawn_error") {
    runLogger.logError(`Baseline tests could not start: ${baseline.error} — check that the test runner is available in the workspace.`);
    return false;
  }

  runLogger.logError("Baseline tests FAILED — attempting to fix");

  let attempts = 0;
  const maxAttempts = Math.min(BASELINE_MAX_FIX_ATTEMPTS, MAX_REWORK);
  let lastOutput = baseline.output;

  while (attempts < maxAttempts) {
    attempts++;
    runLogger.logWork(`Baseline fix attempt ${attempts}/${maxAttempts}`);

    const fixPrompt = buildBaselineFixPrompt(lastOutput, item);
    const { finDetected, exitCode } = await runAgent(fixPrompt);

    if (!finDetected && exitCode !== 0) {
      runLogger.logError(`Baseline fix agent exited with code ${exitCode ?? "unknown"} — stopping`);
      return false;
    }

    if (!stageAndCommit(`[AI] baseline test fix attempt ${attempts}`)) {
      runLogger.logError("Baseline fix stage/commit failed — stopping");
      return false;
    }

    const retest = runTestSuite("all");
    if (retest.passed) {
      runLogger.logConfig(`Baseline tests fixed after attempt ${attempts}`);
      return true;
    }

    runLogger.logError(`Baseline tests still failing after attempt ${attempts}`);
    lastOutput = retest.output;
  }

  runLogger.logError(`Baseline tests still failing after ${maxAttempts} fix attempts — aborting`);
  return false;
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

async function findMRForIssue(
  projectId: string,
  issueNumber: number,
): Promise<{ mrIid: number; branch: string; merged: boolean } | null> {
  if (!gitlabClient.isConfigured()) return null;
  for (const state of ["opened", "closed", "merged"] as const) {
    try {
      const mrs = await gitlabClient.getMergeRequests(projectId, state);
      for (const mr of mrs || []) {
        const desc: string = mr.description || "";
        if (desc.match(new RegExp(`(?:closes|fixes|resolves)\\s+#${issueNumber}\\b`, "i"))) {
          return { mrIid: mr.iid, branch: mr.source_branch, merged: mr.state === "merged" };
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
  const platform = detectRemotePlatform(WORKSPACE);
  let openBranch: string | null = null;
  for (const depNum of depIssueNumbers) {
    if (platform === "gitlab") {
      const projectId = repo || process.env.GITLAB_DEFAULT_PROJECT || "";
      if (!projectId) continue;
      const mr = await findMRForIssue(projectId, depNum);
      if (!mr) {
        runLogger.logGit("Dependency has no MR yet", `!${depNum}`);
        return null; // unresolved dependency
      }
      if (mr.merged) {
        runLogger.logGit("Dependency merged", `!${depNum}`);
        continue;
      }
      runLogger.logGit("Dependency has open MR", `!${depNum} → ${mr.branch}`);
      openBranch = mr.branch;
    } else {
      const pr = await findPRForIssue(ghToken, owner, repo, depNum);
      if (!pr) {
        runLogger.logGit("Dependency has no PR yet", `#${depNum}`);
        return null; // unresolved dependency
      }
      if (pr.merged) {
        runLogger.logGit("Dependency merged", `#${depNum}`);
        continue;
      }
      runLogger.logGit("Dependency has open PR", `#${depNum} → ${pr.branch}`);
      openBranch = pr.branch;
    }
  }
  // All merged → branch from main; some open → branch from the open PR
  return openBranch
    ? { branch: openBranch, source: "open_pr" }
    : { branch: getBaseBranch(), source: "merged" };
}

// --- Review polling ---

async function pollForReviewResult(
  ghToken: string,
  owner: string,
  repo: string,
  prNumber: number,
  pollMs: number = REVIEW_POLL_MS,
): Promise<"passed" | "failed" | "postponed" | "merged" | "conflict" | "closed"> {
  const headers = { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" };
  while (true) {
    // Check PR state first
    try {
      const prResp = await axios.get(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, { headers });
      const pr = prResp.data;
      if (pr.merged_at) return "merged";
      if (pr.state === "closed") return "closed";
      // Detect merge conflicts via GitHub API
      if (pr.mergeable === false && pr.mergeable_state === "dirty") return "conflict";
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
        if (body.includes(REVIEW_MERGE_CONFLICT_MARKER)) return "conflict";
      }
    } catch {
      // Comments might not be available
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function pollForGitLabReviewResult(
  projectId: string,
  mrIid: number,
  pollMs: number = REVIEW_POLL_MS,
): Promise<"passed" | "failed" | "postponed" | "merged" | "conflict" | "closed"> {
  while (true) {
    // Check MR state first
    try {
      const mr = await gitlabClient.getMergeRequest(projectId, mrIid);
      if (mr.state === "merged") return "merged";
      if (mr.state === "closed") return "closed";
      // Detect merge conflicts via GitLab API
      const status = await gitlabClient.getMergeRequestStatus(projectId, mrIid);
      if (status.conflicts || status.mergeStatus === "cannot_be_merged") return "conflict";
    } catch {
      // MR might not be accessible
    }

    // Check MR notes for review markers
    try {
      const notes = await gitlabClient.listMergeRequestNotes(projectId, mrIid, "desc");
      for (const note of notes) {
        const body: string = note.body || "";
        if (body.includes(REVIEW_PASSED_MARKER)) return "passed";
        if (body.includes(REVIEW_FAILED_MARKER)) return "failed";
        if (body.includes(REVIEW_POSTPONED_MARKER)) return "postponed";
        if (body.includes(REVIEW_MERGE_CONFLICT_MARKER)) return "conflict";
      }
    } catch {
      // Notes might not be available
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

async function fetchGitLabReworkPrompt(
  projectId: string,
  mrIid: number,
): Promise<string | null> {
  try {
    const notes = await gitlabClient.listMergeRequestNotes(projectId, mrIid, "desc");
    for (const note of notes) {
      const body: string = note.body || "";
      if (body.includes("Rework from PR Review")) {
        return body;
      }
      if (body.includes("Review Failed — Rework Required")) {
        return body;
      }
    }
  } catch {
    // Notes not available
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
  if (!prompt) {
    runLogger.logError("No prompt provided to agent — skipping");
    return { finDetected: false, exitCode: -1 };
  }
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
      const formatter = createStreamFormatter(AGENT, WORKSPACE);

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        const formatted = formatter.push(text);
        if (formatted) process.stdout.write(formatted);
        outputBuf += text;

        if (!finDetected && outputBuf.includes(FIN_TOKEN)) {
          finDetected = true;
          runLogger.logAgent("FIN signal detected — stopping agent");
          child.kill("SIGTERM");
        }
      });

      child.on("close", (code) => {
        const remaining = formatter.flush();
        if (remaining) process.stdout.write(remaining);
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
    const formatter = createStreamFormatter(AGENT, WORKSPACE);

    // Pipe prompt via stdin to avoid command-line length limits
    child.stdin?.write(prompt);
    child.stdin?.end();

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      const formatted = formatter.push(text);
      if (formatted) process.stdout.write(formatted);
      outputBuf += text;

      if (!finDetected && outputBuf.includes(FIN_TOKEN)) {
        finDetected = true;
        runLogger.logAgent("FIN signal detected — stopping agent");
        child.kill("SIGTERM");
      }
    });

    child.on("close", (code) => {
      const remaining = formatter.flush();
      if (remaining) process.stdout.write(remaining);
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

const processedIssues = new Set<string>();

// Persist processed issues across restarts
const PROCESSED_FILE = path.join(WORKSPACE || process.cwd(), ".aicoder", "processed-issues.json");

function loadProcessedIssues(): void {
  try {
    if (fs.existsSync(PROCESSED_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROCESSED_FILE, "utf-8"));
      if (Array.isArray(data)) {
        data.forEach((id: string) => processedIssues.add(id));
        if (processedIssues.size > 0) {
          runLogger.logConfig(`Resumed with ${processedIssues.size} previously processed issue(s)`);
        }
      }
    }
  } catch {
    // File doesn't exist or is corrupt — start fresh
  }
}

function saveProcessedIssue(issueKey: string): void {
  processedIssues.add(issueKey);
  try {
    const dir = path.dirname(PROCESSED_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...processedIssues], null, 2), "utf-8");
  } catch (err) {
    // Persistence failure is non-fatal
    runLogger.logWork(`Could not persist processed issue: ${err instanceof Error ? err.message : err}`);
  }
}

// Agent-runs tracking: record aicoder steps to the database for API visibility
let currentRunStepOrder = 0;

function trackStep(runId: string, stepType: AgentRunStepCreate["stepType"], content: string, extra?: Partial<Pick<AgentRunStepCreate, "toolName" | "success" | "errorMessage" | "durationMs">>): void {
  try {
    currentRunStepOrder++;
    agentRunDatabase.addStep({
      runId,
      stepType,
      toolName: extra?.toolName ?? null,
      content,
      sanitizedParams: null,
      success: extra?.success ?? true,
      errorMessage: extra?.errorMessage ?? null,
      durationMs: extra?.durationMs ?? null,
      stepOrder: currentRunStepOrder,
    });
    agentRunDatabase.touchRun(runId);
  } catch {
    // Non-fatal: tracking should never crash the aicoder
  }
}

async function processWorkItem(cfg: ServerConfig, item: WorkItem): Promise<{ prNumber: number } | null> {
  const issueKey = item.id || String(item.number);
  if (processedIssues.has(issueKey)) {
    runLogger.logSkip(`Issue ${issueKey} already processed`);
    return null;
  }

  runLogger.startRun(item.number, item.title);
  runLogger.logWork(`Starting issue ${issueKey}: ${item.title}`);

  // Create agent-runs record for API visibility
  currentRunStepOrder = 0;
  const run = agentRunDatabase.startRun({
    userId: "aicoder",
    mode: `issue:${issueKey}`,
  });
  trackStep(run.id, "note", `Starting work on ${issueKey}: ${item.title}`);

  const startTime = Date.now();

  // Transition Jira issues to "In Progress" so escalation doesn't pick them up
  const isJiraIssue = /^[A-Z]+-\d+$/.test(item.id);
  if (isJiraIssue && jiraClient.isConfigured()) {
    try {
      const transitions = await jiraClient.getTransitions(item.id);
      const inProgress = transitions.find((t: any) =>
        t.name === "In Progress" || t.name === "in progress" || t.name === "Start Progress"
      );
      if (inProgress) {
        await jiraClient.transitionIssue(item.id, inProgress.id, "AiRemoteCoder started work on this issue.");
        runLogger.logWork(`Transitioned ${item.id} → In Progress`);
        trackStep(run.id, "note", `Transitioned ${item.id} to In Progress`);
      } else {
        runLogger.logWork(`No "In Progress" transition available for ${item.id} (available: ${transitions.map((t: any) => t.name).join(", ")})`);
      }
    } catch (err) {
      runLogger.logWork(`Could not transition ${item.id} to In Progress: ${err instanceof Error ? err.message : err}`);
      trackStep(run.id, "note", `Jira transition failed: ${err instanceof Error ? err.message : err}`, { success: false });
    }
  }

  // Resolve dependencies
  const ghToken = process.env.GITHUB_TOKEN;
  const owner = cfg.owner || process.env.GITHUB_DEFAULT_OWNER || "redsand";
  const repo = cfg.repo || process.env.AICODER_REPO || "";
  let fromBranch: string | undefined;

  // Parse dependencies from issue body
  let depBody = "";
  if (isJiraIssue && jiraClient.isConfigured()) {
    try {
      const jiraIssue = await jiraClient.getIssue(item.id);
      depBody = jiraIssue?.fields?.description || "";
    } catch { /* Jira fetch failed, skip dependency resolution */ }
  } else if (ghToken && repo) {
    depBody = await fetchIssueBody(ghToken, owner, repo, item.number);
  }

  const keywordDeps = parseDependencies(depBody);
  const allDeps = [...new Set(keywordDeps)];

  if (allDeps.length > 0) {
    runLogger.logGit("Found dependencies", allDeps.map((n) => `#${n}`).join(", "));
    const resolved = await resolveDependencyBranch(ghToken || "", owner, repo, allDeps);
    if (!resolved) {
      if (WAIT_FOR_DEPS) {
        runLogger.logGit("Waiting for dependencies", `will retry later`);
        runLogger.endRun(null);
        return null; // don't add to processedIssues so it retries
      }
      runLogger.logError(`Unresolved dependencies for #${item.number} — skipping`);
      runLogger.endRun(1);
      saveProcessedIssue(issueKey);
      return null;
    }
    fromBranch = resolved.source === "open_pr" ? resolved.branch : undefined;
    runLogger.logGit("Base branch resolved", fromBranch || getBaseBranch());
  }

  const generated = await generatePrompt(cfg, item);
  if (generated.skipped) {
    runLogger.logSkip(`Issue #${item.number}: ${generated.skipReason}`);
    runLogger.endRun(null);
    return null;
  }

  const branchName = item.suggestedBranch;
  if (!await checkoutBranch(branchName, fromBranch)) {
    runLogger.logError(`Could not create branch ${branchName} — skipping`);
    runLogger.endRun(1);
    trackStep(run.id, "tool_call", `Branch checkout failed: ${branchName}`, { toolName: "git_checkout", success: false });
    agentRunDatabase.failRun(run.id, `Could not create branch ${branchName}`);
    return null;
  }
  trackStep(run.id, "tool_call", `Checked out branch: ${branchName}${fromBranch ? ` (from ${fromBranch})` : ""}`, { toolName: "git_checkout" });

  // TDD: Run baseline tests first; if they fail, try to fix before starting work
  if (!(await fixBaselineTests(cfg, item))) {
    runLogger.logError("Baseline tests could not be fixed — aborting. Issue will be retried.");
    runLogger.endRun(1);
    // Don't save to processedIssues — allow retry on next aicoder cycle
    trackStep(run.id, "tool_call", "Baseline tests failed", { toolName: "test_baseline", success: false });
    agentRunDatabase.failRun(run.id, "Baseline tests could not be fixed");
    return null;
  }

  const agentStartTime = Date.now();
  trackStep(run.id, "note", `Running ${AGENT} agent...`);
  const { finDetected, exitCode } = await runAgent(generated.prompt);
  const agentDuration = Date.now() - agentStartTime;
  trackStep(run.id, "model_response", `Agent finished (FIN=${finDetected}, exit=${exitCode}, ${agentDuration}ms)`, { toolName: AGENT, durationMs: agentDuration, success: finDetected || exitCode === 0 });

  if (!finDetected && exitCode !== 0) {
    runLogger.log(`WARN`, `Agent exited with code ${exitCode} and no FIN signal — skipping push`);
    runLogger.endRun(exitCode);
    saveProcessedIssue(issueKey);
    agentRunDatabase.failRun(run.id, `Agent exited with code ${exitCode}, no FIN signal`);
    return null;
  }

  if (!stageAndCommit(`[AI] ${item.title}`)) {
    runLogger.logError("Stage/commit failed — skipping push");
    runLogger.endRun(1);
    saveProcessedIssue(issueKey);
    trackStep(run.id, "tool_call", "Stage & commit failed", { toolName: "git_commit", success: false });
    agentRunDatabase.failRun(run.id, "Stage/commit failed");
    return null;
  }
  trackStep(run.id, "tool_call", "Staged and committed changes", { toolName: "git_commit" });

  // TDD: Run unit tests first (fast fail)
  const unitResult = runTestSuite("unit");
  if (!unitResult.passed) {
    runLogger.logError(`Unit tests ${unitResult.kind} — skipping integration tests and push. Issue will be retried.`);
    runLogger.endRun(1);
    // Don't save to processedIssues — allow retry on next aicoder cycle
    trackStep(run.id, "tool_call", `Unit tests ${unitResult.kind}`, { toolName: "test_unit", success: false, errorMessage: unitResult.kind });
    agentRunDatabase.failRun(run.id, `Unit tests ${unitResult.kind}`);
    return null;
  }
  trackStep(run.id, "tool_call", "Unit tests passed", { toolName: "test_unit" });

  // TDD: Run integration tests (only if unit tests passed)
  const integrationResult = runTestSuite("integration");
  if (!integrationResult.passed) {
    runLogger.logError(`Integration tests ${integrationResult.kind} — skipping push. Issue will be retried.`);
    runLogger.endRun(1);
    // Don't save to processedIssues — allow retry on next aicoder cycle
    trackStep(run.id, "tool_call", `Integration tests ${integrationResult.kind}`, { toolName: "test_integration", success: false, errorMessage: integrationResult.kind });
    agentRunDatabase.failRun(run.id, `Integration tests ${integrationResult.kind}`);
    return null;
  }
  trackStep(run.id, "tool_call", "Integration tests passed", { toolName: "test_integration" });

  // TDD: Check coverage thresholds
  const coverageResult = checkCoverage();
  if (!coverageResult.passed) {
    runLogger.logError(`Coverage check ${coverageResult.kind} — skipping push. Issue will be retried.`);
    runLogger.endRun(1);
    // Don't save to processedIssues — allow retry on next aicoder cycle
    trackStep(run.id, "tool_call", `Coverage check ${coverageResult.kind}`, { toolName: "coverage", success: false });
    agentRunDatabase.failRun(run.id, `Coverage check ${coverageResult.kind}`);
    return null;
  }

  if (!pushBranch(branchName)) {
    runLogger.logError(`Push failed — PR not created`);
    runLogger.endRun(1);
    saveProcessedIssue(issueKey);
    trackStep(run.id, "tool_call", "Push failed", { toolName: "git_push", success: false });
    agentRunDatabase.failRun(run.id, "Push failed");
    return null;
  }
  trackStep(run.id, "tool_call", `Pushed branch: ${branchName}`, { toolName: "git_push" });

  const pr = await createPR(cfg, item, branchName);
  if (pr) {
    const platform = detectRemotePlatform(WORKSPACE);
    const label = platform === "gitlab" ? "MR" : "PR";
    runLogger.logPR(`Opened ${label} #${pr.prNumber}: ${pr.url}`);
    trackStep(run.id, "tool_call", `Created PR #${pr.prNumber}: ${pr.url}`, { toolName: "create_pr" });
    await notifyComplete(cfg, item, pr.prNumber, branchName, exitCode);
  }

  const totalDuration = Date.now() - startTime;
  agentRunDatabase.completeRun(run.id, { model: AGENT, toolLoopCount: currentRunStepOrder, totalTokens: 0 });
  trackStep(run.id, "note", `Completed in ${(totalDuration / 1000).toFixed(1)}s${pr ? ` — PR #${pr.prNumber}` : ""}`);
  runLogger.endRun(exitCode);
  saveProcessedIssue(issueKey);
  return pr ? { prNumber: pr.prNumber } : null;
}

async function focusedLoop(cfg: ServerConfig): Promise<void> {
  runLogger.logConfig(`AiRemoteCoder started in focused mode (agent: ${AGENT}, workspace: ${WORKSPACE}${USE_OLLAMA ? ", ollama: on" : ""}, base: ${BASE_BRANCH})`);
  const ghToken = process.env.GITHUB_TOKEN;
  const owner = cfg.owner || process.env.GITHUB_DEFAULT_OWNER || "redsand";
  const repo = cfg.repo || process.env.AICODER_REPO || "";

  // --issue <key>: work on a specific issue with review loop
  if (TARGET_ISSUE_KEY) {
    runLogger.logConfig(`Targeting issue ${TARGET_ISSUE_KEY} directly`);
    const target = await fetchIssueByKey(cfg, TARGET_ISSUE_KEY);
    if (!target) {
      runLogger.logError(`Could not find issue ${TARGET_ISSUE_KEY}`);
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
        // Process only the first (highest-priority) item per cycle.
        // After it merges, the next cycle will pull latest main and pick the next item,
        // preventing cascading merge conflicts across independent branches.
        const item = sorted[0];
        await focusedProcessWorkItem(cfg, item, ghToken, owner, repo);
        cycles++;
      }
    } catch (err) {
      runLogger.logError((err as Error).message);
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/**
 * Resolves an issue key to the correct source system and fetches it.
 * Uses SourceResolver for smart routing — Jira-style keys (IR-82, PROJ-123)
 * go to Jira, numeric keys go to GitHub, and the resolver's memory/cache
 * is consulted for anything ambiguous.
 */
async function fetchIssueByKey(cfg: ServerConfig, key: string): Promise<WorkItem | null> {
  const resolver = new SourceResolver(WORKSPACE, LOOKUP, cfg.apiUrl, cfg.apiKey);

  // If --source is explicitly set (not "auto"), trust it; otherwise resolve
  const source = cfg.source !== "auto"
    ? (cfg.source as TicketSourceType)
    : await resolver.resolve(key, "");

  runLogger.logConfig(`Resolved issue ${key} → source: ${source}`);

  if (source === "jira") {
    return fetchJiraIssueDirectly(key);
  }

  // Default: treat as a numeric GitHub issue number
  const num = parseInt(key, 10);
  if (Number.isNaN(num)) {
    runLogger.logError(`Issue key "${key}" resolved to GitHub but is not a number. Use --source jira for Jira keys.`);
    return null;
  }
  return fetchIssueDirectly(cfg, num);
}

async function fetchJiraIssueDirectly(key: string): Promise<WorkItem | null> {
  if (!jiraClient.isConfigured()) {
    runLogger.logError("Jira client not configured — set JIRA_* env vars for Jira issue lookups");
    return null;
  }
  try {
    const issue = await jiraClient.getIssue(key);
    const fields = issue.fields as typeof issue.fields & { labels?: any[] };
    const slug = (fields?.summary ?? issue.key ?? key)
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    return {
      id: key,
      number: parseInt(key.replace(/^[A-Z]+-/, ""), 10) || 0,
      title: fields?.summary ?? key,
      url: `${process.env.JIRA_BASE_URL ?? "https://hawksolutionstech.atlassian.net"}/browse/${key}`,
      owner: "",
      repo: "",
      suggestedBranch: `ai/issue-${key.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${slug}`,
      labels: (fields?.labels ?? []).map((l: any) => typeof l === "string" ? l : l.name),
    };
  } catch (err) {
    runLogger.logError(`Failed to fetch Jira issue ${key}: ${err instanceof Error ? err.message : err}`);
    return null;
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
  try {
    await focusedProcessWorkItemInner(cfg, item, ghToken, owner, repo);
  } finally {
    // Always clean up the workspace before returning to the poll loop
    ensureCleanWorkspace();
  }
}

async function focusedProcessWorkItemInner(
  cfg: ServerConfig,
  item: WorkItem,
  ghToken: string | undefined,
  owner: string,
  repo: string,
): Promise<void> {
  const result = await processWorkItem(cfg, item);
  if (!result) {
    return; // Failed to create PR/MR
  }

  const platform = detectRemotePlatform(WORKSPACE);
  const label = platform === "gitlab" ? "MR" : "PR";
  const prNumber = result.prNumber;

  // For GitLab, we don't need ghToken/repo for review polling
  if (platform !== "gitlab" && (!ghToken || !repo)) {
    return; // No GitHub token — can't poll for review
  }

  runLogger.logConfig(`Waiting for review of ${label} #${prNumber} (polling every ${REVIEW_POLL_MS / 1000}s)`);

  let reworkCount = 0;
  let postponeTimeout = 0;
  const POSTPONE_MAX_MS = 30 * 60 * 1000; // 30 min max wait for service restoration

  while (true) {
    // Poll for review result using platform-appropriate method
    let reviewResult: "passed" | "failed" | "postponed" | "merged" | "conflict" | "closed";

    if (platform === "gitlab") {
      const projectId = item.repo || cfg.repo || process.env.GITLAB_DEFAULT_PROJECT || "";
      if (!projectId) {
        runLogger.logError("No GitLab project ID — cannot poll for review");
        return;
      }
      reviewResult = await pollForGitLabReviewResult(projectId, prNumber);
    } else {
      if (!ghToken || !owner || !repo) {
        runLogger.logError("No GitHub credentials — cannot poll for review");
        return;
      }
      reviewResult = await pollForReviewResult(ghToken, owner, repo, prNumber);
    }

    if (reviewResult === "passed" || reviewResult === "merged") {
      runLogger.logConfig(`${label} #${prNumber} passed review — pulling latest ${getBaseBranch()}`);
      forceCheckout(getBaseBranch(), WORKSPACE);
      gitRun(["pull", "--ff-only", "origin", getBaseBranch()], WORKSPACE);
      return;
    }

    if (reviewResult === "closed") {
      runLogger.logError(`${label} #${prNumber} was closed without merge`);
      return;
    }

    if (reviewResult === "postponed") {
      postponeTimeout += REVIEW_POLL_MS;
      if (postponeTimeout >= POSTPONE_MAX_MS) {
        runLogger.logError(`Review service unavailable for ${POSTPONE_MAX_MS / 1000}s — giving up on ${label} #${prNumber}`);
        return;
      }
      runLogger.logPoll(`Review service unavailable — retrying in ${REVIEW_POLL_MS / 1000}s`);
      await new Promise((r) => setTimeout(r, REVIEW_POLL_MS));
      continue;
    }

    if (reviewResult === "conflict") {
      reworkCount++;
      if (reworkCount > MAX_REWORK) {
        runLogger.logError(`${label} #${prNumber} exceeded max rework cycles (${MAX_REWORK}) after conflict resolution attempts`);
        return;
      }

      runLogger.logWork(`Conflict resolution cycle ${reworkCount}/${MAX_REWORK} for ${label} #${prNumber}`);

      // Perform local rebase with conflict resolution
      if (!await rebaseAndResolveConflicts(item.suggestedBranch)) {
        runLogger.logError(`Could not resolve conflicts for ${label} #${prNumber} — manual intervention required`);
        return;
      }

      // Force-push the rebased branch
      if (!pushBranch(item.suggestedBranch, true)) {
        runLogger.logError("Force push after rebase failed");
        return;
      }

      runLogger.logConfig(`Rebased and force-pushed ${item.suggestedBranch} — waiting for review again`);
      continue;
    }

    if (reviewResult === "failed") {
      reworkCount++;
      if (reworkCount > MAX_REWORK) {
        runLogger.logError(`${label} #${prNumber} exceeded max rework cycles (${MAX_REWORK})`);
        return;
      }

      runLogger.logWork(`Rework cycle ${reworkCount}/${MAX_REWORK} for ${label} #${prNumber}`);

      // Extract the linked issue number from the PR/MR body
      const issueMatch = (item.url || "").match(/#(\d+)/);
      const issueNumber = issueMatch ? parseInt(issueMatch[1], 10) : item.number;

      // Fetch rework prompt — use appropriate method based on platform
      let reworkPrompt: string | null = null;
      if (platform === "gitlab") {
        const projectId = item.repo || cfg.repo || process.env.GITLAB_DEFAULT_PROJECT || "";
        if (projectId) {
          reworkPrompt = await fetchGitLabReworkPrompt(projectId, prNumber);
        }
      } else if (ghToken && owner && repo) {
        reworkPrompt = await fetchReworkPrompt(ghToken, owner, repo, prNumber, issueNumber);
      }

      if (!reworkPrompt) {
        runLogger.logError("Could not fetch rework prompt — skipping rework");
        return;
      }

      // Checkout the existing branch and re-run agent with rework prompt
      if (!forceCheckout(item.suggestedBranch, WORKSPACE)) {
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

      // TDD: Tiered test gate after rework
      const reworkUnitResult = runTestSuite("unit");
      if (!reworkUnitResult.passed) {
        runLogger.logError(`Rework unit tests ${reworkUnitResult.kind} — stopping`);
        return;
      }
      const reworkIntegrationResult = runTestSuite("integration");
      if (!reworkIntegrationResult.passed) {
        runLogger.logError(`Rework integration tests ${reworkIntegrationResult.kind} — stopping`);
        return;
      }
      const reworkCoverageResult = checkCoverage();
      if (!reworkCoverageResult.passed) {
        runLogger.logError(`Rework coverage check ${reworkCoverageResult.kind} — stopping`);
        return;
      }

      if (!pushBranch(item.suggestedBranch, true)) {
        runLogger.logError("Rework push failed");
        return;
      }

      runLogger.logConfig(`Rework pushed for ${label} #${prNumber} — waiting for review again`);
      continue;
    }

    // Unknown result — keep polling
    await new Promise((r) => setTimeout(r, REVIEW_POLL_MS));
  }
}

async function pollLoop(cfg: ServerConfig): Promise<void> {
  runLogger.logConfig(`AiRemoteCoder started in poll mode (agent: ${AGENT}, workspace: ${WORKSPACE}${USE_OLLAMA ? ", ollama: on" : ""}, base: ${BASE_BRANCH})`);

  // --issue <key>: work on a specific issue and exit (no polling)
  if (TARGET_ISSUE_KEY) {
    runLogger.logConfig(`Targeting issue ${TARGET_ISSUE_KEY} directly`);
    const target = await fetchIssueByKey(cfg, TARGET_ISSUE_KEY);
    if (!target) {
      runLogger.logError(`Could not find issue ${TARGET_ISSUE_KEY}`);
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

process.on("SIGINT", () => { cleanup(); ensureCleanWorkspace(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); ensureCleanWorkspace(); process.exit(143); });

/**
 * Ensure `nul` is in .gitignore for the workspace.
 * On Windows, `nul` is a reserved device name — if it exists as a file,
 * `git add --all` fails. Adding it to .gitignore prevents this.
 * Commits the change immediately so it doesn't block branch switches.
 */
function ensureNulInGitignore(workspace: string): void {
  // Kept for backward compatibility — now delegates to ensureGitignoreEntries
  ensureGitignoreEntries(workspace, ["nul", "*.log.bak", ".aicoder/"]);
}

function ensureGitignoreEntries(workspace: string, entries: string[]): void {
  const gitignorePath = path.join(workspace, ".gitignore");
  try {
    let content = "";
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, "utf-8");
    }
    const lines = content.split(/\r?\n/);
    const missing = entries.filter(e => !lines.some(line => line.trim() === e));
    if (missing.length > 0) {
      const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
      const addition = missing.join("\n") + "\n";
      fs.writeFileSync(gitignorePath, content + separator + addition, "utf-8");
      runLogger.logConfig(`Added ${missing.join(", ")} to .gitignore`);
      // Commit the .gitignore change so it doesn't block later branch switches
      gitRun(["add", ".gitignore"], workspace);
      gitRun(["commit", "-m", `[AI] update .gitignore: add ${missing.join(", ")}`], workspace);
    }
  } catch (err) {
    runLogger.logError(`Failed to update .gitignore: ${(err as Error).message}`);
  }
}
ensureNulInGitignore(WORKSPACE);

// Recover from any mid-rebase state left by a previous run BEFORE modifying git state
ensureCleanWorkspace();

// Ensure temp/build directories that commonly block git operations are also ignored
ensureGitignoreEntries(WORKSPACE, [
  ".build-tmp/",
  ".pip-tmp/",
  ".pytest_tmp/",
  "packaging-test-*/",
  "*.egg-info/",
]);

loadProcessedIssues();

// Mark any stale aicoder runs (from a previous crash) as failed
try {
  const stale = agentRunDatabase.markStaleRunsAsFailed(30);
  if (stale > 0) {
    runLogger.logConfig(`Marked ${stale} stale agent run(s) as failed`);
  }
} catch {
  // Non-fatal
}

if (FOCUSED_MODE) {
  focusedLoop(loadServerConfig());
} else {
  pollLoop(loadServerConfig());
}
