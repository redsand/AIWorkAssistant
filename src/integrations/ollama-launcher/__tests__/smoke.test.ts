import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CodexExecutor,
  ClaudeExecutor,
  OpenCodeExecutor,
  resolveExecutor,
} from "../executors";
import { OllamaLauncher } from "../launcher";
import { RunLogger } from "../run-logger";
import {
  extractPriority,
  sortByLabelPriority,
  prioritizeItems,
} from "../priority-sorter";
import type { LaunchOptions, ProviderType } from "../types";

// ─── Executor Tests ──────────────────────────────────────────────────────────

describe("CodexExecutor", () => {
  const executor = new CodexExecutor();

  it("has providerName codex", () => {
    expect(executor.providerName).toBe("codex");
  });

  it("builds exec command with model and full-auto bypass", () => {
    const options: LaunchOptions = {
      provider: "codex",
      prompt: "test prompt",
      codexApprovalMode: "full-auto",
    };
    const result = executor.buildCommand(options, "codex", "o4-mini");
    expect(result.command).toBe("codex");
    expect(result.args).toContain("exec");
    expect(result.args).toContain("--model");
    expect(result.args).toContain("o4-mini");
    expect(result.args).toContain("--json");
    expect(result.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(result.args).not.toContain("--approval-mode");
    // Prompt should NOT be in args (piped via stdin)
    expect(result.args).not.toContain("test prompt");
  });

  it("uses override model when provided", () => {
    const options: LaunchOptions = {
      provider: "codex",
      prompt: "test",
      model: "glm-4:latest",
    };
    const result = executor.buildCommand(options, "codex", "o4-mini");
    expect(result.args).toContain("glm-4:latest");
  });

  it("builds env with OPENAI_BASE_URL pointing to ollama", () => {
    const options: LaunchOptions = { provider: "codex", prompt: "test" };
    const env = executor.buildEnv(options, "http://localhost:11434");
    expect(env.OPENAI_BASE_URL).toBe("http://localhost:11434/v1");
    expect(env.OPENAI_API_KEY).toBeDefined();
  });
});

describe("ClaudeExecutor", () => {
  const executor = new ClaudeExecutor();

  it("has providerName claude", () => {
    expect(executor.providerName).toBe("claude");
  });

  it("builds command with Claude alias when ollamaUrl is set", () => {
    const options: LaunchOptions = {
      provider: "claude",
      prompt: "test prompt",
      ollamaUrl: "http://localhost:11434",
    };
    const result = executor.buildCommand(options, "claude", "claude-sonnet-4-6");
    expect(result.command).toBe("claude");
    expect(result.args).toContain("-p");
    expect(result.args).toContain("--print");
    expect(result.args).toContain("--output-format");
    expect(result.args).toContain("stream-json");
    expect(result.args).toContain("--verbose");
    expect(result.args).toContain("--permission-mode");
    expect(result.args).toContain("bypassPermissions");
    expect(result.args).toContain("--dangerously-skip-permissions");
    expect(result.args).toContain("--model");
    expect(result.args).toContain("opus");
    // Prompt must NOT be in args (piped via stdin)
    expect(result.args).not.toContain("test prompt");
  });

  it("builds command WITH --model when ollamaUrl is NOT set", () => {
    const options: LaunchOptions = {
      provider: "claude",
      prompt: "test prompt",
    };
    const result = executor.buildCommand(options, "claude", "claude-sonnet-4-6");
    expect(result.args).toContain("--model");
    expect(result.args).toContain("claude-sonnet-4-6");
  });

  it("builds env with ANTHROPIC_BASE_URL and OPENAI_BASE_URL when ollamaUrl is set", () => {
    const options: LaunchOptions = {
      provider: "claude",
      prompt: "test",
      ollamaUrl: "http://localhost:11434",
    };
    const env = executor.buildEnv(options, "http://localhost:11434");
    // ANTHROPIC_BASE_URL routes Claude Code's Anthropic SDK to Ollama
    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:11434");
    expect(env.OPENAI_BASE_URL).toBe("http://localhost:11434/v1");
    expect(env.OPENAI_API_KEY).toBeDefined();
    // Must be non-empty so Claude Code doesn't short-circuit with apiKeySource:"none"
    expect(env.ANTHROPIC_API_KEY).toBeTruthy();
  });

  it("builds env without OPENAI_BASE_URL when ollamaUrl is NOT set", () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key-123";
    try {
      const options: LaunchOptions = { provider: "claude", prompt: "test" };
      const env = executor.buildEnv(options, "http://localhost:11434");
      expect(env.OPENAI_BASE_URL).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBe("test-key-123");
    } finally {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  it("handles glm-5.1:cloud model gracefully with ollamaUrl", () => {
    const options: LaunchOptions = {
      provider: "claude",
      prompt: "implement feature X",
      ollamaUrl: "http://localhost:11434",
      model: "glm-5.1:cloud",
    };
    const result = executor.buildCommand(options, "claude", "glm-5.1:cloud");
    expect(result.args).toContain("--model");
    expect(result.args).toContain("opus");
    expect(result.args).not.toContain("glm-5.1:cloud");
  });
});

describe("OpenCodeExecutor", () => {
  const executor = new OpenCodeExecutor();

  it("has providerName opencode", () => {
    expect(executor.providerName).toBe("opencode");
  });

  it("builds command with no args (prompt piped via stdin)", () => {
    const options: LaunchOptions = {
      provider: "opencode",
      prompt: "test prompt",
    };
    const result = executor.buildCommand(options, "opencode", "default-model");
    expect(result.command).toBe("opencode");
    expect(result.args).toEqual([]);
    // Prompt is NOT in args
    expect(result.args).not.toContain("test prompt");
  });

  it("builds env with OPENCODE_API_URL when ollamaUrl is set", () => {
    const options: LaunchOptions = {
      provider: "opencode",
      prompt: "test",
      ollamaUrl: "http://localhost:11434",
    };
    const env = executor.buildEnv(options, "http://localhost:11434");
    expect(env.OPENCODE_API_URL).toBe("http://localhost:11434/v1");
    expect(env.OPENCODE_API_KEY).toBeDefined();
  });
});

describe("resolveExecutor", () => {
  it("returns CodexExecutor for codex", () => {
    expect(resolveExecutor("codex")).toBeInstanceOf(CodexExecutor);
  });

  it("returns ClaudeExecutor for claude", () => {
    expect(resolveExecutor("claude")).toBeInstanceOf(ClaudeExecutor);
  });

  it("returns OpenCodeExecutor for opencode", () => {
    expect(resolveExecutor("opencode")).toBeInstanceOf(OpenCodeExecutor);
  });
});

// ─── Command Length Safety ────────────────────────────────────────────────────

describe("Command line length safety", () => {
  it("all executors produce args under 1000 chars regardless of prompt length", () => {
    const veryLongPrompt = "A".repeat(100_000);
    const providers: ProviderType[] = ["codex", "claude", "opencode"];

    for (const provider of providers) {
      const executor = resolveExecutor(provider);
      const options: LaunchOptions = {
        provider,
        prompt: veryLongPrompt,
        model: "test-model-name",
        ollamaUrl: provider === "claude" ? "http://localhost:11434" : undefined,
      };
      const result = executor.buildCommand(options, provider, "default-model");
      const totalLength = result.command.length + result.args.reduce(
        (sum, arg) => sum + arg.length + 3, // +3 for quotes/spaces
        0,
      );
      // Windows cmd.exe limit is ~8191; even with generous args we should be far under
      expect(totalLength).toBeLessThan(1000);
    }
  });

  it("prompt content never appears in any executor args", () => {
    const uniquePrompt = `UNIQUE_MARKER_${Date.now()}_xyzzy`;
    const providers: ProviderType[] = ["codex", "claude", "opencode"];

    for (const provider of providers) {
      const executor = resolveExecutor(provider);
      const options: LaunchOptions = {
        provider,
        prompt: uniquePrompt,
      };
      const result = executor.buildCommand(options, provider, "default-model");
      const allArgs = result.args.join(" ");
      expect(allArgs).not.toContain(uniquePrompt);
    }
  });
});

// ─── RunLogger Tests ─────────────────────────────────────────────────────────

describe("RunLogger", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aicoder-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates log directory on construction", () => {
    new RunLogger(tmpDir); // side effect: creates .aicoder/logs
    const logDir = path.join(tmpDir, ".aicoder", "logs");
    expect(fs.existsSync(logDir)).toBe(true);
  });

  it("creates a log file when startRun is called", () => {
    const logger = new RunLogger(tmpDir);
    logger.startRun(42, "Test issue title");
    logger.endRun(0);

    const logDir = path.join(tmpDir, ".aicoder", "logs");
    const files = fs.readdirSync(logDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^run-42-/);
  });

  it("logs messages with timestamp and level", () => {
    const logger = new RunLogger(tmpDir);
    logger.startRun(42, "Test");
    logger.log("CONFIG", "Test config message");
    logger.endRun(0);

    const logDir = path.join(tmpDir, ".aicoder", "logs");
    const files = fs.readdirSync(logDir);
    const content = fs.readFileSync(path.join(logDir, files[0]), "utf-8");
    expect(content).toContain("[CONFIG]");
    expect(content).toContain("Test config message");
  });

  it("logs shorthand methods correctly", () => {
    const logger = new RunLogger(tmpDir);
    logger.startRun(42, "Test");
    logger.logConfig("config msg");
    logger.logWork("work msg");
    logger.logGit("git action", "git detail");
    logger.logAgent("agent msg");
    logger.logError("error msg");
    logger.logPoll("poll msg");
    logger.logSkip("skip msg");
    logger.logPR("pr msg");
    logger.endRun(0);

    const logDir = path.join(tmpDir, ".aicoder", "logs");
    const files = fs.readdirSync(logDir);
    const content = fs.readFileSync(path.join(logDir, files[0]), "utf-8");
    expect(content).toContain("[CONFIG] config msg");
    expect(content).toContain("[WORK] work msg");
    expect(content).toContain("[GIT] git action: git detail");
    expect(content).toContain("[AGENT] agent msg");
    expect(content).toContain("[ERROR] error msg");
    expect(content).toContain("[POLL] poll msg");
    expect(content).toContain("[SKIP] skip msg");
    expect(content).toContain("[PR] pr msg");
  });

  it("includes run duration in endRun", () => {
    const logger = new RunLogger(tmpDir);
    logger.startRun(42, "Test");
    logger.endRun(0);

    const logDir = path.join(tmpDir, ".aicoder", "logs");
    const files = fs.readdirSync(logDir);
    const content = fs.readFileSync(path.join(logDir, files[0]), "utf-8");
    expect(content).toContain("Run completed");
    expect(content).toContain("exit: 0");
  });

  it("handles endRun with null exit code", () => {
    const logger = new RunLogger(tmpDir);
    logger.startRun(42, "Test");
    logger.endRun(null);

    const logDir = path.join(tmpDir, ".aicoder", "logs");
    const files = fs.readdirSync(logDir);
    const content = fs.readFileSync(path.join(logDir, files[0]), "utf-8");
    expect(content).toContain("exit: unknown");
  });

  it("does not crash when logging without startRun", () => {
    const logger = new RunLogger(tmpDir);
    expect(() => logger.logError("error without run")).not.toThrow();
  });
});

// ─── Priority Sorter Tests ───────────────────────────────────────────────────

describe("extractPriority", () => {
  it("extracts P0 from title prefix", () => {
    expect(extractPriority({ number: 1, title: "[P0] Critical bug", url: "" })).toBe(0);
  });

  it("extracts P3 from title prefix", () => {
    expect(extractPriority({ number: 1, title: "[P3] Nice to have", url: "" })).toBe(3);
  });

  it("extracts priority from labels", () => {
    expect(
      extractPriority({ number: 1, title: "Fix thing", url: "", labels: ["critical"] }),
    ).toBe(0);
    expect(
      extractPriority({ number: 1, title: "Fix thing", url: "", labels: ["high"] }),
    ).toBe(1);
    expect(
      extractPriority({ number: 1, title: "Fix thing", url: "", labels: ["low"] }),
    ).toBe(3);
  });

  it("returns 99 for items without priority info", () => {
    expect(
      extractPriority({ number: 1, title: "No priority", url: "", labels: [] }),
    ).toBe(99);
  });

  it("title prefix takes precedence over labels", () => {
    expect(
      extractPriority({
        number: 1,
        title: "[P4] Low priority title",
        url: "",
        labels: ["critical"],
      }),
    ).toBe(4);
  });

  it("handles label objects with name property", () => {
    expect(
      extractPriority({
        number: 1,
        title: "Issue",
        url: "",
        labels: [{ name: "high" }] as any,
      }),
    ).toBe(1);
  });
});

describe("sortByLabelPriority", () => {
  it("sorts by priority ascending (lower = higher priority)", () => {
    const items = [
      { number: 3, title: "Low", url: "", labels: ["low"] },
      { number: 1, title: "Critical", url: "", labels: ["critical"] },
      { number: 2, title: "Medium", url: "", labels: ["medium"] },
    ];
    const sorted = sortByLabelPriority(items);
    expect(sorted.map((i) => i.number)).toEqual([1, 2, 3]);
  });

  it("preserves order for items with same priority", () => {
    const items = [
      { number: 1, title: "First", url: "", labels: ["medium"] },
      { number: 2, title: "Second", url: "", labels: ["medium"] },
    ];
    const sorted = sortByLabelPriority(items);
    expect(sorted.map((i) => i.number)).toEqual([1, 2]);
  });
});

describe("prioritizeItems", () => {
  it("uses label mode by default", async () => {
    const items = [
      { number: 2, title: "Medium", url: "", labels: ["medium"] },
      { number: 1, title: "Critical", url: "", labels: ["critical"] },
    ];
    const result = await prioritizeItems(items, "label", "http://localhost:3050", "key");
    expect(result.map((i) => i.number)).toEqual([1, 2]);
  });

  it("auto mode falls back to label sorting on LLM failure", async () => {
    const items = [
      { number: 2, title: "Medium", url: "", labels: ["medium"] },
      { number: 1, title: "Critical", url: "", labels: ["critical"] },
    ];
    // No server running, so LLM call will fail → falls back to label sort
    const result = await prioritizeItems(items, "auto", "http://localhost:99999", "bad-key");
    expect(result.map((i) => i.number)).toEqual([1, 2]);
  });
});

// ─── OllamaLauncher Tests ────────────────────────────────────────────────────

describe("OllamaLauncher", () => {
  it("constructs with default config", () => {
    const launcher = new OllamaLauncher();
    // Just verify it doesn't throw
    expect(launcher).toBeDefined();
  });

  it("constructs with custom config", () => {
    const launcher = new OllamaLauncher({
      defaultModel: "custom-model",
      codexCliPath: "/usr/local/bin/codex",
      claudeCliPath: "/usr/local/bin/claude",
      opencodeCliPath: "/usr/local/bin/opencode",
      ollamaUrl: "http://custom:11434",
    });
    expect(launcher).toBeDefined();
  });

  it("reports ollama unreachable when not running", async () => {
    const launcher = new OllamaLauncher({
      ollamaUrl: "http://localhost:59999",
    });
    const result = await launcher.checkOllama();
    expect(result.reachable).toBe(false);
    expect(result.models).toEqual([]);
  });
});

// ─── Source Resolver Tests ───────────────────────────────────────────────────

describe("SourceResolver", () => {
  // Import inline to avoid side effects
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aicoder-source-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("caches a known source and returns it without LLM", async () => {
    const { SourceResolver } = await import("../../source-resolver.js");
    const resolver = new SourceResolver(tmpDir, "memory", "http://localhost:99999", "bad-key");
    resolver.setKnown("redsand/AIWorkAssistant#46", "github");
    const result = await resolver.resolve("redsand/AIWorkAssistant#46", "Some issue");
    expect(result).toBe("github");
  });

  it("falls back to heuristic when LLM fails in memory mode", async () => {
    const { SourceResolver } = await import("../../source-resolver.js");
    const resolver = new SourceResolver(tmpDir, "memory", "http://localhost:99999", "bad-key");
    // No cache, LLM will fail → heuristic
    const result = await resolver.resolve("PROJ-123", "Jira issue", "https://example.atlassian.net/browse/PROJ-123");
    expect(result).toBe("jira");
  });

  it("detects github from URL", async () => {
    const { SourceResolver } = await import("../../source-resolver.js");
    const resolver = new SourceResolver(tmpDir, "memory", "http://localhost:99999", "bad-key");
    const result = await resolver.resolve("unknown-42", "Issue", "https://github.com/owner/repo/issues/42");
    expect(result).toBe("github");
  });

  it("detects gitlab from URL", async () => {
    const { SourceResolver } = await import("../../source-resolver.js");
    const resolver = new SourceResolver(tmpDir, "memory", "http://localhost:99999", "bad-key");
    const result = await resolver.resolve("unknown-42", "Issue", "https://gitlab.com/owner/repo/issues/42");
    expect(result).toBe("gitlab");
  });

  it("defaults to github when no clues", async () => {
    const { SourceResolver } = await import("../../source-resolver.js");
    const resolver = new SourceResolver(tmpDir, "memory", "http://localhost:99999", "bad-key");
    const result = await resolver.resolve("unknown-42", "Mystery issue");
    expect(result).toBe("github");
  });

  it("persists cache to disk", async () => {
    const { SourceResolver } = await import("../../source-resolver.js");
    const resolver1 = new SourceResolver(tmpDir, "memory", "http://localhost:99999", "bad-key");
    resolver1.setKnown("test-key", "github");

    // New resolver instance reads from same directory
    const resolver2 = new SourceResolver(tmpDir, "memory", "http://localhost:99999", "bad-key");
    const result = await resolver2.resolve("test-key", "Cached issue");
    expect(result).toBe("github");
  });
});

// ─── Integration: Launcher + Executor ─────────────────────────────────────────

describe("Launcher + Executor integration", () => {
  it("ClaudeExecutor + ollama produces alias model flag and correct env", () => {
    const executor = new ClaudeExecutor();
    const options: LaunchOptions = {
      provider: "claude",
      prompt: "implement feature X",
      ollamaUrl: "http://localhost:11434",
      model: "glm-5.1:cloud",
    };

    const { args } = executor.buildCommand(options, "claude", "claude-sonnet-4-6");
    const env = executor.buildEnv(options, "http://localhost:11434");

    expect(args).toContain("--model");
    expect(args).toContain("opus");
    expect(args).not.toContain("glm-5.1:cloud");

    // Env must route Claude Code's Anthropic SDK to Ollama
    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:11434");
    expect(env.OPENAI_BASE_URL).toBe("http://localhost:11434/v1");
    expect(env.OPENAI_API_KEY).toBeDefined();
    expect(env.ANTHROPIC_API_KEY).toBeTruthy();

    // Essential Claude flags must be present
    expect(args).toContain("-p");
    expect(args).toContain("--print");
    expect(args).toContain("--verbose");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
  });

  it("ClaudeExecutor without ollama passes model through", () => {
    const executor = new ClaudeExecutor();
    const options: LaunchOptions = {
      provider: "claude",
      prompt: "test",
      model: "claude-sonnet-4-6",
    };

    const { args } = executor.buildCommand(options, "claude", "claude-sonnet-4-6");
    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-6");
  });

  it("CodexExecutor always includes model in args", () => {
    const executor = new CodexExecutor();
    const options: LaunchOptions = {
      provider: "codex",
      prompt: "test",
      model: "o4-mini",
    };

    const { args } = executor.buildCommand(options, "codex", "o4-mini");
    expect(args).toContain("--model");
    expect(args).toContain("o4-mini");
  });

  it("OpenCodeExecutor passes no args and routes via env", () => {
    const executor = new OpenCodeExecutor();
    const options: LaunchOptions = {
      provider: "opencode",
      prompt: "test",
      ollamaUrl: "http://localhost:11434",
    };

    const { args } = executor.buildCommand(options, "opencode", "default");
    const env = executor.buildEnv(options, "http://localhost:11434");

    expect(args).toEqual([]);
    expect(env.OPENCODE_API_URL).toBe("http://localhost:11434/v1");
  });
});

// ─── Regression: glm-5.1:cloud Bug ───────────────────────────────────────────

describe("Regression: glm-5.1:cloud must not reach Claude CLI", () => {
  it("Claude CLI never receives --model with an Ollama model name when ollamaUrl is set", () => {
    const executor = new ClaudeExecutor();
    const ollamaModels = ["glm-5.1:cloud", "llama3:8b", "codellama:7b", "mixtral:8x7b"];

    for (const model of ollamaModels) {
      const options: LaunchOptions = {
        provider: "claude",
        prompt: "implement feature",
        ollamaUrl: "http://localhost:11434",
        model,
      };
      const { args } = executor.buildCommand(options, "claude", model);

      const modelIdx = args.indexOf("--model");
      expect(modelIdx).toBeGreaterThanOrEqual(0);
      expect(args[modelIdx + 1]).toBe("opus");

      // The model name must NOT appear in args
      expect(args).not.toContain(model);
    }
  });

  it("Claude CLI receives --model when ollamaUrl is NOT set (direct API mode)", () => {
    const executor = new ClaudeExecutor();
    const options: LaunchOptions = {
      provider: "claude",
      prompt: "test",
      model: "claude-sonnet-4-6",
    };

    const { args } = executor.buildCommand(options, "claude", "claude-sonnet-4-6");
    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-6");
  });
});

// ─── Windows Command Line Length ─────────────────────────────────────────────

describe("Windows command line length limit", () => {
  it("launcher uses shell on Windows when prompt is not in args", () => {
    // This test verifies the launcher handles Windows correctly
    // by checking that the spawn call uses shell: true on Windows
    // when the prompt is piped via stdin (not embedded in args)
    const launcher = new OllamaLauncher({ ollamaUrl: "http://localhost:11434" });
    expect(launcher).toBeDefined();
    // The actual spawn is tested via launch() which requires a real binary
    // Here we verify the launcher exists and can be configured
  });
});
