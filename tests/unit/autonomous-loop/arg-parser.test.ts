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
});
