import { afterEach, describe, expect, it, vi } from "vitest";

const originalArgv = process.argv;

async function loadArgParser(argv: string[]) {
  vi.resetModules();
  process.argv = ["node", "src/aicoder.ts", ...argv];
  return import("../../../src/autonomous-loop/arg-parser");
}

describe("aicoder arg parser provider aliases", () => {
  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("treats --provider ollama as --ollama", async () => {
    const parser = await loadArgParser(["--provider", "ollama", "--model", "kimi-k2.6:cloud"]);

    expect(parser.USE_OLLAMA).toBe(true);
    expect(parser.API_PROVIDER).toBeNull();
    expect(parser.MODEL).toBe("kimi-k2.6:cloud");
  });

  it("treats --provider zai as --api zai", async () => {
    const parser = await loadArgParser(["--provider", "zai", "--model", "glm-5.1"]);

    expect(parser.USE_OLLAMA).toBe(false);
    expect(parser.API_PROVIDER).toBe("zai");
    expect(parser.MODEL).toBe("glm-5.1");
  });

  it("treats --provider opencode as --api opencode", async () => {
    const parser = await loadArgParser(["--provider", "opencode", "--model", "DeepSeek V4 Pro"]);

    expect(parser.USE_OLLAMA).toBe(false);
    expect(parser.API_PROVIDER).toBe("opencode");
    expect(parser.MODEL).toBe("DeepSeek V4 Pro");
  });

  it("maps --provider zia typo to zai", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const parser = await loadArgParser(["--provider", "zia", "--model", "glm-5.1"]);

    expect(parser.API_PROVIDER).toBe("zai");
    expect(parser.MODEL).toBe("glm-5.1");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("zia"),
    );
    warnSpy.mockRestore();
  });

  it("warns on truly unknown provider", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const parser = await loadArgParser(["--provider", "unknown-provider"]);

    expect(parser.API_PROVIDER).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unknown-provider"),
    );
    warnSpy.mockRestore();
  });

  it("parses boolean flags, shorthands, and value options", async () => {
    const parser = await loadArgParser([
      "--ollama",
      "--poll",
      "--claude",
      "--debug",
      "--enable-baseline",
      "--skip-agent",
      "--skip-tests",
      "--skip-prompt-check",
      "--skip-poll",
      "--dry-run-push",
      "--force-done",
      "--cleanup-merged",
      "--resume-run",
      "--discard-run",
      "-f",
      "--workspace",
      "C:/work",
      "--label",
      "agent-ready",
      "--sprint",
      "sprint-1",
      "--priority",
      "auto",
      "--source",
      "github",
      "--lookup",
      "llm",
      "--poll-ms",
      "123",
      "--max-cycles",
      "2",
      "--issue",
      "206",
      "--publish",
      "ai/issue-206",
      "--base",
      "develop",
      "--max-rework",
      "3",
      "--review-poll-ms",
      "5",
    ]);

    expect(parser.USE_OLLAMA).toBe(true);
    expect(parser.FOCUSED_MODE).toBe(false);
    expect(parser.AGENT).toBe("claude");
    expect(parser.DEBUG).toBe(true);
    expect(parser.ENABLE_BASELINE).toBe(true);
    expect(parser.SKIP_AGENT).toBe(true);
    expect(parser.SKIP_TESTS).toBe(true);
    expect(parser.SKIP_PROMPT_CHECK).toBe(true);
    expect(parser.SKIP_POLL).toBe(true);
    expect(parser.DRY_RUN_PUSH).toBe(true);
    expect(parser.FORCE_DONE).toBe(true);
    expect(parser.CLEANUP_MERGED).toBe(true);
    expect(parser.RESUME_RUN).toBe(true);
    expect(parser.DISCARD_RUN).toBe(true);
    expect(parser.FORCE_REPROCESS).toBe(true);
    expect(parser.WORKSPACE).toBe("C:/work");
    expect(parser.LABEL).toBe("agent-ready");
    expect(parser.SPRINT).toBe("sprint-1");
    expect(parser.PRIORITY).toBe("auto");
    expect(parser.SOURCE).toBe("github");
    expect(parser.LOOKUP).toBe("llm");
    expect(parser.POLL_MS).toBe(123);
    expect(parser.MAX_CYCLES).toBe(2);
    expect(parser.TARGET_ISSUE_KEY).toBe("206");
    expect(parser.PUBLISH_BRANCH).toBe("ai/issue-206");
    expect(parser.BASE_BRANCH_CANDIDATES[0]).toBe("develop");
    expect(parser.MAX_REWORK).toBe(3);
    expect(parser.REVIEW_POLL_MS).toBe(5);
  });

  it("disables baseline tests by default", async () => {
    const parser = await loadArgParser([]);

    expect(parser.ENABLE_BASELINE).toBe(false);
  });

  it("enables baseline tests via --enable-baseline", async () => {
    const parser = await loadArgParser(["--enable-baseline"]);

    expect(parser.ENABLE_BASELINE).toBe(true);
  });

  it("enables baseline tests via AICODER_ENABLE_BASELINE env var", async () => {
    process.env.AICODER_ENABLE_BASELINE = "true";
    const parser = await loadArgParser([]);
    delete process.env.AICODER_ENABLE_BASELINE;

    expect(parser.ENABLE_BASELINE).toBe(true);
  });

  it("makes --watch a forced discard-run cycle", async () => {
    const parser = await loadArgParser(["--codex", "--watch", "206"]);

    expect(parser.AGENT).toBe("codex");
    expect(parser.WATCH_ISSUE).toBe("206");
    expect(parser.FORCE_REPROCESS).toBe(true);
    expect(parser.DISCARD_RUN).toBe(true);
  });

  it("rejects unknown agent names", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit ${code}`);
    }) as never);

    await expect(loadArgParser(["--agent", "cursor"])).rejects.toThrow("exit 2");
    expect(console.error).toHaveBeenCalledWith(
      'Unknown agent "cursor". Valid: codex, opencode, claude',
    );
  });
});
