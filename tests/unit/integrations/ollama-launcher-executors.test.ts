import { describe, expect, it } from "vitest";

import { ClaudeExecutor } from "../../../src/integrations/ollama-launcher/executors";

describe("ClaudeExecutor Ollama routing", () => {
  it("passes a Claude alias instead of raw Ollama model names to Claude CLI", () => {
    const executor = new ClaudeExecutor();

    const { args } = executor.buildCommand(
      {
        provider: "claude",
        prompt: "test",
        ollamaUrl: "http://localhost:11434",
        model: "glm-5.1:cloud",
      },
      "claude",
      "glm-5.1:cloud",
    );

    expect(args).toContain("--model");
    expect(args).toContain("opus");
    expect(args).not.toContain("glm-5.1:cloud");
  });

  it("sets Claude and OpenAI-compatible env vars for Ollama", () => {
    const executor = new ClaudeExecutor();

    const env = executor.buildEnv(
      {
        provider: "claude",
        prompt: "test",
        ollamaUrl: "http://localhost:11434",
      },
      "http://localhost:11434",
    );

    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:11434");
    expect(env.OPENAI_BASE_URL).toBe("http://localhost:11434/v1");
    expect(env.ANTHROPIC_API_KEY).toBeTruthy();
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-5.1:cloud");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("glm-5.1:cloud");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("glm-5.1:cloud");
  });

  it("passes native Claude models when Ollama routing is disabled", () => {
    const executor = new ClaudeExecutor();

    const { args } = executor.buildCommand(
      {
        provider: "claude",
        prompt: "test",
        model: "claude-sonnet-4-6",
      },
      "claude",
      "claude-sonnet-4-6",
    );

    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-6");
  });
});
