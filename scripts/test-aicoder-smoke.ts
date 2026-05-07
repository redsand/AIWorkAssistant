#!/usr/bin/env tsx
/**
 * End-to-end smoke test for aicoder.
 *
 * Validates the full pipeline from executor configuration to process spawning:
 *   1. Executor command generation (no prompt in args, correct flags)
 *   2. Ollama routing for Claude (model name skipped, env vars set)
 *   3. Stdin prompt piping (prompt NOT in args)
 *   4. Windows command line length safety
 *   5. Run logger output
 *   6. Priority sorting
 *   7. Source resolver caching and heuristic fallback
 *   8. Branch runner dry run
 *   9. Full aicoder launch (requires real binary)
 *
 * Usage:
 *   npx tsx scripts/test-aicoder-smoke.ts           # Run unit-level checks
 *   npx tsx scripts/test-aicoder-smoke.ts --live     # Also test real agent launch
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn, spawnSync } from "child_process";

import {
  CodexExecutor,
  ClaudeExecutor,
  OpenCodeExecutor,
  resolveExecutor,
} from "../src/integrations/ollama-launcher/executors";
import { OllamaLauncher } from "../src/integrations/ollama-launcher";
import { RunLogger } from "../src/integrations/ollama-launcher/run-logger";
import {
  extractPriority,
  sortByLabelPriority,
  prioritizeItems,
} from "../src/integrations/ollama-launcher/priority-sorter";
import { SourceResolver } from "../src/integrations/source-resolver";
import type { LaunchOptions, ProviderType } from "../src/integrations/ollama-launcher/types";
import { branchRunner } from "../src/integrations/ticket-bridge/branch-runner";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;

function check(name: string, fn: () => boolean): void {
  try {
    if (fn()) {
      console.log(`  ✓ ${name}`);
      passCount++;
    } else {
      console.log(`  ✗ ${name} — assertion failed`);
      failCount++;
    }
  } catch (err: any) {
    console.log(`  ✗ ${name} — ${err.message}`);
    failCount++;
  }
}

async function checkAsync(name: string, fn: () => Promise<boolean>): Promise<void> {
  try {
    if (await fn()) {
      console.log(`  ✓ ${name}`);
      passCount++;
    } else {
      console.log(`  ✗ ${name} — assertion failed`);
      failCount++;
    }
  } catch (err: any) {
    console.log(`  ✗ ${name} — ${err.message}`);
    failCount++;
  }
}

// ─── 1. Executor Command Generation ──────────────────────────────────────────

function testExecutorCommands(): void {
  console.log("\n=== Executor Command Generation ===\n");

  check("CodexExecutor includes model and approval mode", () => {
    const ex = new CodexExecutor();
    const { args } = ex.buildCommand(
      { provider: "codex", prompt: "test", codexApprovalMode: "full-auto" },
      "codex",
      "o4-mini",
    );
    return args.includes("--model") && args.includes("o4-mini") && args.includes("--approval-mode");
  });

  check("ClaudeExecutor includes --verbose flag", () => {
    const ex = new ClaudeExecutor();
    const { args } = ex.buildCommand(
      { provider: "claude", prompt: "test" },
      "claude",
      "claude-sonnet-4-6",
    );
    return args.includes("--verbose");
  });

  check("ClaudeExecutor includes --output-format stream-json", () => {
    const ex = new ClaudeExecutor();
    const { args } = ex.buildCommand(
      { provider: "claude", prompt: "test" },
      "claude",
      "claude-sonnet-4-6",
    );
    return args.includes("--output-format") && args[args.indexOf("--output-format") + 1] === "stream-json";
  });

  check("OpenCodeExecutor has no args", () => {
    const ex = new OpenCodeExecutor();
    const { args } = ex.buildCommand(
      { provider: "opencode", prompt: "test" },
      "opencode",
      "default",
    );
    return args.length === 0;
  });

  check("resolveExecutor returns correct types", () => {
    return (
      resolveExecutor("codex") instanceof CodexExecutor &&
      resolveExecutor("claude") instanceof ClaudeExecutor &&
      resolveExecutor("opencode") instanceof OpenCodeExecutor
    );
  });
}

// ─── 2. Ollama Routing for Claude ────────────────────────────────────────────

function testOllamaRouting(): void {
  console.log("\n=== Ollama Routing for Claude ===\n");

  check("ClaudeExecutor skips --model when ollamaUrl is set", () => {
    const ex = new ClaudeExecutor();
    const { args } = ex.buildCommand(
      { provider: "claude", prompt: "test", ollamaUrl: "http://localhost:11434", model: "glm-5.1:cloud" },
      "claude",
      "glm-5.1:cloud",
    );
    return !args.includes("--model") && !args.includes("glm-5.1:cloud");
  });

  check("ClaudeExecutor sets OPENAI_BASE_URL when ollamaUrl is set", () => {
    const ex = new ClaudeExecutor();
    const env = ex.buildEnv(
      { provider: "claude", prompt: "test", ollamaUrl: "http://localhost:11434" },
      "http://localhost:11434",
    );
    return env.OPENAI_BASE_URL === "http://localhost:11434/v1";
  });

  check("ClaudeExecutor sets ANTHROPIC_API_KEY when ollamaUrl is set", () => {
    const ex = new ClaudeExecutor();
    const env = ex.buildEnv(
      { provider: "claude", prompt: "test", ollamaUrl: "http://localhost:11434" },
      "http://localhost:11434",
    );
    return "ANTHROPIC_API_KEY" in env;
  });

  check("ClaudeExecutor passes --model when ollamaUrl is NOT set", () => {
    const ex = new ClaudeExecutor();
    const { args } = ex.buildCommand(
      { provider: "claude", prompt: "test", model: "claude-sonnet-4-6" },
      "claude",
      "claude-sonnet-4-6",
    );
    return args.includes("--model") && args.includes("claude-sonnet-4-6");
  });

  check("CodexExecutor always sets OPENAI_BASE_URL", () => {
    const ex = new CodexExecutor();
    const env = ex.buildEnv(
      { provider: "codex", prompt: "test" },
      "http://localhost:11434",
    );
    return env.OPENAI_BASE_URL === "http://localhost:11434/v1";
  });

  check("OpenCodeExecutor sets OPENCODE_API_URL when ollamaUrl is set", () => {
    const ex = new OpenCodeExecutor();
    const env = ex.buildEnv(
      { provider: "opencode", prompt: "test", ollamaUrl: "http://localhost:11434" },
      "http://localhost:11434",
    );
    return env.OPENCODE_API_URL === "http://localhost:11434/v1";
  });
}

// ─── 3. Prompt Not in Args (Windows cmd.exe safety) ─────────────────────────

function testPromptNotInArgs(): void {
  console.log("\n=== Prompt Not in Args (Windows cmd.exe safety) ===\n");

  const longPrompt = "A".repeat(100_000);
  const providers: ProviderType[] = ["codex", "claude", "opencode"];

  for (const provider of providers) {
    check(`${provider}: prompt not in args`, () => {
      const executor = resolveExecutor(provider);
      const { args } = executor.buildCommand(
        { provider, prompt: longPrompt, ollamaUrl: provider === "claude" ? "http://localhost:11434" : undefined },
        provider,
        "default-model",
      );
      const allArgs = args.join(" ");
      return !allArgs.includes(longPrompt.substring(0, 50));
    });

    check(`${provider}: total arg length under 1000 chars`, () => {
      const executor = resolveExecutor(provider);
      const { command, args } = executor.buildCommand(
        { provider, prompt: longPrompt, ollamaUrl: provider === "claude" ? "http://localhost:11434" : undefined },
        provider,
        "default-model",
      );
      const totalLength = command.length + args.reduce((sum, arg) => sum + arg.length + 3, 0);
      return totalLength < 1000;
    });
  }
}

// ─── 4. Run Logger ───────────────────────────────────────────────────────────

function testRunLogger(): void {
  console.log("\n=== Run Logger ===\n");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aicoder-smoke-"));
  const logger = new RunLogger(tmpDir);

  check("RunLogger creates .aicoder/logs directory", () => {
    return fs.existsSync(path.join(tmpDir, ".aicoder", "logs"));
  });

  logger.startRun(99, "Smoke test issue");
  logger.logConfig("Config message");
  logger.logWork("Work message");
  logger.logGit("Created branch", "ai/issue-99-test");
  logger.logAgent("Agent started");
  logger.logError("Error message");
  logger.logPoll("Poll message");
  logger.logSkip("Skip message");
  logger.logPR("PR #42 opened");
  logger.endRun(0);

  const logDir = path.join(tmpDir, ".aicoder", "logs");
  const files = fs.readdirSync(logDir);

  check("RunLogger creates log file after startRun", () => {
    return files.length === 1 && files[0].startsWith("run-99-");
  });

  if (files.length > 0) {
    const content = fs.readFileSync(path.join(logDir, files[0]), "utf-8");

    check("RunLogger contains CONFIG message", () => content.includes("[CONFIG]"));
    check("RunLogger contains WORK message", () => content.includes("[WORK]"));
    check("RunLogger contains GIT message", () => content.includes("[GIT]"));
    check("RunLogger contains AGENT message", () => content.includes("[AGENT]"));
    check("RunLogger contains ERROR message", () => content.includes("[ERROR]"));
    check("RunLogger contains POLL message", () => content.includes("[POLL]"));
    check("RunLogger contains SKIP message", () => content.includes("[SKIP]"));
    check("RunLogger contains PR message", () => content.includes("[PR]"));
    check("RunLogger contains duration in endRun", () => content.includes("Run completed"));
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ─── 5. Priority Sorting ────────────────────────────────────────────────────

function testPrioritySorting(): void {
  console.log("\n=== Priority Sorting ===\n");

  check("P0 title has highest priority", () => {
    return extractPriority({ number: 1, title: "[P0] Critical", url: "" }) === 0;
  });

  check("P4 title has lower priority", () => {
    return extractPriority({ number: 1, title: "[P4] Low", url: "" }) === 4;
  });

  check("Label-based sorting orders by priority", () => {
    const items = [
      { number: 3, title: "Low", url: "", labels: ["low"] },
      { number: 1, title: "Critical", url: "", labels: ["critical"] },
      { number: 2, title: "Medium", url: "", labels: ["medium"] },
    ];
    const sorted = sortByLabelPriority(items);
    return sorted[0].number === 1 && sorted[1].number === 2 && sorted[2].number === 3;
  });

  check("Title prefix takes priority over labels", () => {
    return extractPriority({
      number: 1,
      title: "[P4] Actually low",
      url: "",
      labels: ["critical"],
    }) === 4;
  });

  check("No priority info defaults to 99", () => {
    return extractPriority({ number: 1, title: "No priority info", url: "", labels: [] }) === 99;
  });
}

// ─── 6. Source Resolver ─────────────────────────────────────────────────────

async function testSourceResolver(): Promise<void> {
  console.log("\n=== Source Resolver ===\n");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aicoder-source-"));

  await checkAsync("Cache persists across instances", async () => {
    const resolver1 = new SourceResolver(tmpDir, "memory", "http://localhost:99999", "bad-key");
    resolver1.setKnown("test-repo#1", "github");
    const resolver2 = new SourceResolver(tmpDir, "memory", "http://localhost:99999", "bad-key");
    const result = await resolver2.resolve("test-repo#1", "Cached");
    return result === "github";
  });

  await checkAsync("Jira key pattern detected by heuristic", async () => {
    const resolver = new SourceResolver(tmpDir, "memory", "http://localhost:99999", "bad-key");
    const result = await resolver.resolve("PROJ-123", "Jira issue");
    return result === "jira";
  });

  await checkAsync("GitHub URL detected by heuristic", async () => {
    const resolver = new SourceResolver(tmpDir, "memory", "http://localhost:99999", "bad-key");
    const result = await resolver.resolve("owner/repo#42", "Issue", "https://github.com/owner/repo/issues/42");
    return result === "github";
  });

  await checkAsync("GitLab URL detected by heuristic", async () => {
    const resolver = new SourceResolver(tmpDir, "memory", "http://localhost:99999", "bad-key");
    const result = await resolver.resolve("42", "Issue", "https://gitlab.com/owner/repo/issues/42");
    return result === "gitlab";
  });

  await checkAsync("Defaults to github with no clues", async () => {
    const resolver = new SourceResolver(tmpDir, "memory", "http://localhost:99999", "bad-key");
    const result = await resolver.resolve("unknown-42", "Mystery issue");
    return result === "github";
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ─── 7. Branch Runner Dry Run ───────────────────────────────────────────────

function testBranchRunnerDryRun(): void {
  console.log("\n=== Branch Runner Dry Run ===\n");

  check("makeBranchName creates valid git branch names", () => {
    const name = branchRunner.makeBranchName(
      { type: "github", id: "redsand/AIWorkAssistant#46" },
      "Add feature X with special characters!",
    );
    // Should be lowercase, no spaces, no special chars
    return /^[a-z0-9/-]+$/.test(name) && !name.includes(" ");
  });

  check("makeBranchName handles GitHub issue format", () => {
    const name = branchRunner.makeBranchName(
      { type: "github", id: "owner/repo#123" },
      "Fix login bug",
    );
    return name.includes("123") && name.includes("fix-login-bug");
  });

  check("makeBranchName handles Jira key format", () => {
    const name = branchRunner.makeBranchName(
      { type: "jira", id: "PROJ-456" },
      "Update API endpoint",
    );
    return name.includes("proj") && name.includes("456");
  });

  check("makeBranchName handles roadmap format", () => {
    const name = branchRunner.makeBranchName(
      { type: "roadmap", id: "item-789" },
      "Refactor auth module",
    );
    return name.includes("roadmap");
  });

  check("dryRun returns preview steps", () => {
    const result = branchRunner.dryRun({
      source: { type: "github", id: "owner/repo#46" },
      prompt: "Test prompt",
      title: "Test issue",
      autoBranch: true,
      agent: "claude",
      workspace: process.cwd(),
    });
    return result.length > 0 && result[0].includes("[DRY RUN]");
  });
}

// ─── 8. OllamaLauncher ─────────────────────────────────────────────────────

async function testOllamaLauncher(): Promise<void> {
  console.log("\n=== OllamaLauncher ===\n");

  await checkAsync("checkOllama reports unreachable for bad port", async () => {
    const launcher = new OllamaLauncher({ ollamaUrl: "http://localhost:59999" });
    const result = await launcher.checkOllama();
    return !result.reachable;
  });

  check("OllamaLauncher accepts custom default model", () => {
    const launcher = new OllamaLauncher({ defaultModel: "custom-model" });
    return launcher !== undefined;
  });
}

// ─── 9. Live Agent Launch (requires --live flag) ────────────────────────────

async function testLiveLaunch(): Promise<void> {
  console.log("\n=== Live Agent Launch (requires --live flag) ===\n");

  const agent = process.env.AICODER_AGENT || "claude";
  const workspace = process.cwd();

  // Check if the CLI binary exists
  const checkCmd = process.platform === "win32" ? "where" : "which";
  const checkResult = spawnSync(checkCmd, [agent], { shell: true, stdio: "pipe", encoding: "utf-8" });

  if (checkResult.status !== 0) {
    console.log(`  ⚠ Agent binary "${agent}" not found in PATH — skipping live launch`);
    return;
  }

  console.log(`  Found ${agent} at: ${checkResult.stdout.trim()}`);

  const launcher = new OllamaLauncher({ defaultModel: "claude-sonnet-4-6" });
  const prompt = "Say OK and nothing else. Then output FIN on its own line.";

  try {
    const result = await launcher.launch({
      provider: agent as ProviderType,
      prompt,
      cwd: workspace,
    });

    check("Live launch returns a result", () => result !== null);
    check("Live launch has exitCode", () => result.exitCode !== undefined);

    console.log(`  Live launch exitCode: ${result.exitCode}`);
    console.log(`  Live launch duration: ${result.duration}ms`);

    if (result.stdout) {
      console.log(`  Live launch stdout (first 500 chars): ${result.stdout.substring(0, 500)}`);
    }
    if (result.stderr) {
      console.log(`  Live launch stderr (first 500 chars): ${result.stderr.substring(0, 500)}`);
    }
  } catch (err: any) {
    console.log(`  ✗ Live launch failed: ${err.message}`);
    failCount++;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const isLive = process.argv.includes("--live");

  console.log("╔══════════════════════════════════════╗");
  console.log("║   aicoder end-to-end smoke test      ║");
  console.log("╚══════════════════════════════════════╝");

  testExecutorCommands();
  testOllamaRouting();
  testPromptNotInArgs();
  testRunLogger();
  testPrioritySorting();
  await testSourceResolver();
  testBranchRunnerDryRun();
  await testOllamaLauncher();

  if (isLive) {
    await testLiveLaunch();
  }

  console.log("\n══════════════════════════════════════");
  console.log(`  Results: ${passCount} passed, ${failCount} failed`);
  console.log("══════════════════════════════════════\n");

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});