/**
 * CLI argument parsing and derived runtime constants.
 *
 * Exported as named constants so every module can import exactly what it
 * needs without re-parsing argv.  This module has no side effects beyond
 * reading process.argv and process.env — safe to import anywhere.
 */

import { EXIT_SUCCESS } from "../aicoder-pipeline";
import type { ProviderType } from "../integrations/ollama-launcher";
import type { TicketSourceType, LookupMode } from "../integrations/source-resolver";
import type { PriorityMode } from "../integrations/ollama-launcher/priority-sorter";
import "../agent/provider-settings"; // side-effect: applies persisted provider/model to process.env

export function parseArgv(): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(`
aicoder — AiRemoteCoder autonomous coding agent

Usage: aicoder [options]

Options:
  --workspace <path>   Target project directory for git operations (default: cwd)
  --source <type>      Issue source: github | gitlab | jira | jitbit | work_items | auto (default: auto)
  --owner <name>       GitHub/GitLab owner (overrides server default)
  --repo <name>        Repository/project name (overrides server default)
  --sprint <n>         Limit autonomous pickup to a sprint (e.g. 1, sprint-1)
  --agent <name>       Coding agent: codex | opencode | claude (default: claude)
  --claude             Shorthand for --agent claude
  --codex              Shorthand for --agent codex
  --opencode           Route through OpenCode Go API (sets OPENAI_BASE_URL to OPENCODE_API_URL)
  --zai                Route through Z.ai API (sets OPENAI_BASE_URL to ZAI_BASE_URL)
  --ollama             Route agent through Ollama launcher (sets OPENAI_BASE_URL, etc.)
  --provider <name>    Provider alias: ollama | zai | opencode
  --model <name>       Override model for the agent (e.g. glm-5.1:cloud)
  --label <label>      Issue label to filter (default: ready-for-agent)
  --priority <mode>    Ticket priority: label | auto (default: label)
  --lookup <mode>      Source auto-detect mode: memory | llm (default: memory)
  --poll-ms <ms>       Poll interval in milliseconds (default: 60000)
  --max-cycles <n>     Stop after n work cycles (0 = unlimited)
  --issue <number>     Work on a specific issue by number (skips polling, runs once)
  --publish <branch>   Create PR/MR from an existing branch and exit
  --watch <key>        Watch an existing PR/MR for review feedback and rework (issue key or number)
  --enable-baseline   Run baseline test check before agent starts (default: skip)
  --skip-agent        Skip agent execution — commit/test/push existing changes only
  --skip-tests        Skip all tests and coverage checks — just commit and push
  --skip-prompt-check Pick up tickets even without a ## Coding Prompt section (uses ticket body as prompt)
  --skip-poll         Run one work cycle and exit without polling (useful for manual testing)
  --resume-run        Resume from saved run state (if available)
  --discard-run       Discard saved run state and start fresh
  -f, --force         Force re-processing of an already-processed issue
  --debug             Write raw LLM stream events to .aicoder/logs/ for inspection
  --base <branch>      Base branch to start from (default: main). Use this to chain PRs.
  --poll                Use legacy fire-and-forget poll mode (default: focused mode)
  --max-rework <n>      Max rework cycles per issue in focused mode (default: 10)
  --review-poll-ms <ms> Review result poll interval in focused mode (default: 30000)
  --wait-for-deps       Wait for unresolved dependencies instead of skipping
  --dry-run-push        Show what would be pushed without actually pushing (for debugging)
  --force-done          Override review gate — allow Done transition with unresolved findings (audited)
  --cleanup-merged      One-shot sweep: delete every local ai/* branch already merged into base and exit
  --autorepair-status <key>  Print autorepair gate state for an issue and exit
  --autorepair-release <key> Manually release a PAUSED/ESCALATED autorepair gate and exit
  --autorepair-clear <key>   Wipe the autorepair gate file for an issue and exit
  --no-autorepair       Disable autorepair for this run (always escalate to human on convergence)
  --help                Show this help

Remote config (fetches everything else from AIWorkAssistant):
  AIWORKASSISTANT_URL      Base URL of the server (default: http://localhost:3050)
  AIWORKASSISTANT_API_KEY  API key for authentication (required)
`);
      process.exit(EXIT_SUCCESS);
    }
    // Check known boolean/shorthand flags BEFORE the generic key=value handler so
    // that e.g. `--opencode somevalue` doesn't get swallowed as a key-value pair.
    if (argv[i] === "--ollama") {
      out["ollama"] = "true";
    } else if (argv[i] === "--zai") {
      out["api"] = "zai";
    } else if (argv[i] === "--opencode") {
      out["api"] = "opencode";
    } else if (argv[i] === "--poll") {
      out["poll"] = "true";
    } else if (argv[i] === "--claude") {
      out["agent"] = "claude";
    } else if (argv[i] === "--codex") {
      out["agent"] = "codex";
    } else if (argv[i] === "--debug") {
      out["debug"] = "true";
    } else if (argv[i] === "--enable-baseline") {
      out["enable-baseline"] = "true";
    } else if (argv[i] === "--skip-agent") {
      out["skip-agent"] = "true";
    } else if (argv[i] === "--skip-tests") {
      out["skip-tests"] = "true";
    } else if (argv[i] === "--skip-prompt-check") {
      out["skip-prompt-check"] = "true";
    } else if (argv[i] === "--skip-poll") {
      out["skip-poll"] = "true";
    } else if (argv[i] === "--dry-run-push") {
      out["dry-run-push"] = "true";
    } else if (argv[i] === "--force-done") {
      out["force-done"] = "true";
    } else if (argv[i] === "--cleanup-merged") {
      out["cleanup-merged"] = "true";
    } else if (argv[i] === "--resume-run") {
      out["resume-run"] = "true";
    } else if (argv[i] === "--discard-run") {
      out["discard-run"] = "true";
    } else if (argv[i] === "--force" || argv[i] === "-f") {
      out["force"] = "true";
    } else if (argv[i] === "--watch" && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      out["watch"] = argv[i + 1];
      i++;
      out["force"] = "true";
      out["discard-run"] = "true";
    } else if (argv[i].startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

export const ARGV = parseArgv();

export const FIN_TOKEN = process.env.FIN_SIGNAL || "FIN";
export const FIN_ESCAPED = FIN_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const FIN_REGEX = new RegExp(`(?:^|\\s)${FIN_ESCAPED}(?:$|\\s)`);
export const FIN_LINE_REGEX = new RegExp(`^${FIN_ESCAPED}$`, "m");

export const POLL_MS = parseInt(ARGV["poll-ms"] || process.env.AICODER_POLL_MS || "60000", 10);
export const MAX_CYCLES = parseInt(ARGV["max-cycles"] || process.env.AICODER_MAX_CYCLES || "0", 10);
export const WORKSPACE = ARGV.workspace || process.env.AICODER_WORKSPACE || process.cwd();

function normalizeAgentName(value: string): ProviderType {
  const normalized = value.toLowerCase();
  if (normalized === "codex" || normalized === "opencode" || normalized === "claude") return normalized;
  console.error(`Unknown agent "${value}". Valid: codex, opencode, claude`);
  process.exit(2);
}

export const AGENT = normalizeAgentName(ARGV.agent || process.env.AICODER_AGENT || "claude");
export const LABEL = ARGV.label || process.env.AICODER_LABEL || "ready-for-agent";
export const SPRINT = ARGV.sprint || process.env.AICODER_SPRINT || "";
export const PRIORITY = (ARGV.priority || process.env.AICODER_PRIORITY || "label") as PriorityMode;
export const SOURCE = (ARGV.source || process.env.AICODER_SOURCE || "auto") as TicketSourceType | "auto";
export const LOOKUP = (ARGV.lookup || process.env.AICODER_LOOKUP || "memory") as LookupMode;
const CLI_PROVIDER_RAW = (ARGV.provider || "").toLowerCase();
const PROVIDER_ALIASES: Record<string, string> = { zia: "zai" };
const CLI_PROVIDER = PROVIDER_ALIASES[CLI_PROVIDER_RAW] || CLI_PROVIDER_RAW;
if (ARGV.provider && CLI_PROVIDER !== CLI_PROVIDER_RAW) {
  console.warn(`[aicoder] Unrecognized provider "${ARGV.provider}" — did you mean "${CLI_PROVIDER}"?`);
}
if (CLI_PROVIDER && CLI_PROVIDER !== "opencode" && CLI_PROVIDER !== "zai" && CLI_PROVIDER !== "ollama") {
  console.warn(`[aicoder] Unknown provider "${CLI_PROVIDER}" — expected opencode, zai, or ollama`);
}
export const USE_OLLAMA = "ollama" in ARGV || CLI_PROVIDER === "ollama";
export const API_PROVIDER = (
  ARGV.api || (CLI_PROVIDER === "opencode" || CLI_PROVIDER === "zai" ? CLI_PROVIDER : null)
) as "opencode" | "zai" | null;
export const DEBUG = "debug" in ARGV || process.env.AICODER_DEBUG === "true";
export const ENABLE_BASELINE = "enable-baseline" in ARGV || process.env.AICODER_ENABLE_BASELINE === "true";
export const SKIP_AGENT = "skip-agent" in ARGV || process.env.AICODER_SKIP_AGENT === "true";
export const SKIP_TESTS = "skip-tests" in ARGV || process.env.AICODER_SKIP_TESTS === "true";
export const SKIP_PROMPT_CHECK = "skip-prompt-check" in ARGV || process.env.AICODER_SKIP_PROMPT_CHECK === "true";
export const RESUME_RUN = "resume-run" in ARGV;
export const DISCARD_RUN = "discard-run" in ARGV;
export const FORCE_REPROCESS = "force" in ARGV;
export const WATCH_ISSUE = ARGV.watch || null;

function defaultModel(agent: ProviderType, apiProvider: "opencode" | "zai" | null): string {
  if (apiProvider === "opencode" || agent === "opencode") {
    return process.env.OPENCODE_MODEL || "glm-5";
  }
  if (apiProvider === "zai") {
    return process.env.ZAI_MODEL || process.env.CODEX_MODEL || "gpt-5.5";
  }
  return process.env.CODEX_MODEL || "gpt-5.5";
}

export const MODEL = ARGV.model || (AGENT === "codex" && !API_PROVIDER && !USE_OLLAMA ? "" : process.env.AICODER_MODEL || defaultModel(AGENT, API_PROVIDER));
export const OLLAMA_URL = process.env.OLLAMA_API_URL || "http://localhost:11434";
export const TARGET_ISSUE_KEY = ARGV.issue || null;
export const PUBLISH_BRANCH = ARGV.publish || null;

// Autorepair CLI commands. When set, aicoder runs the command and exits
// instead of starting a work cycle. See src/autonomous-loop/ticket-autorepair/.
export const AUTOREPAIR_STATUS_KEY = ARGV["autorepair-status"] || null;
export const AUTOREPAIR_RELEASE_KEY = ARGV["autorepair-release"] || null;
export const AUTOREPAIR_CLEAR_KEY = ARGV["autorepair-clear"] || null;
export const AUTOREPAIR_DISABLED = "no-autorepair" in ARGV;
export const BASE_BRANCH_CANDIDATES = [
  ARGV.base || process.env.AICODER_BASE_BRANCH,
  "main",
  "master",
].filter(Boolean) as string[];
export const FOCUSED_MODE = !("poll" in ARGV || process.env.AICODER_POLL_MODE === "true");
export const SKIP_POLL = "skip-poll" in ARGV || process.env.AICODER_SKIP_POLL === "true";
export const MAX_REWORK = parseInt(ARGV["max-rework"] || process.env.AICODER_MAX_REWORK || "10", 10);
export const REVIEW_POLL_MS = parseInt(ARGV["review-poll-ms"] || process.env.AICODER_REVIEW_POLL_MS || "30000", 10);
export const WAIT_FOR_DEPS = "wait-for-deps" in ARGV || process.env.AICODER_WAIT_FOR_DEPS === "true";
export const DRY_RUN_PUSH = "dry-run-push" in ARGV || process.env.AICODER_DRY_RUN_PUSH === "true";
export const FORCE_DONE = "force-done" in ARGV || process.env.AICODER_FORCE_DONE === "true";
export const CLEANUP_MERGED = "cleanup-merged" in ARGV;

export const UNIT_TEST_TIMEOUT = parseInt(process.env.AICODER_UNIT_TEST_TIMEOUT || "300000", 10);
export const INTEGRATION_TEST_TIMEOUT = parseInt(process.env.AICODER_INTEGRATION_TEST_TIMEOUT || "600000", 10);
