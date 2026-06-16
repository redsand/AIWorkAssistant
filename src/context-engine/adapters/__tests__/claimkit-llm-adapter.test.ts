import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AIProvider } from "../../../agent/providers/types";

const makeProvider = (chatImpl: any): AIProvider => ({
  chat: vi.fn(chatImpl),
  completion: vi.fn(),
} as any);

describe("AIProviderLLMAdapter failure handling", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...originalEnv,
      CLAIMKIT_LLM_TIMEOUT_MS: "1000",
      CLAIMKIT_LLM_MAX_ATTEMPTS: "1",
      CLAIMKIT_LLM_FATAL_FALLBACK: "false",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("propagates non-retryable (auth) errors instead of falling back", async () => {
    const provider = makeProvider(async () => {
      const err = new Error("Unauthorized: invalid api key") as any;
      err.status = 401;
      throw err;
    });

    const { AIProviderLLMAdapter } = await import("../claimkit-llm-adapter.js");
    const adapter = new AIProviderLLMAdapter(provider);
    await expect(adapter.generateText([{ role: "user", content: "hi" }])).rejects.toThrow(
      "Unauthorized",
    );
  });

  it("falls back to MemoryLLMAdapter on transient errors", async () => {
    const provider = makeProvider(async () => {
      const err = new Error("Gateway timeout") as any;
      err.status = 504;
      throw err;
    });

    const { AIProviderLLMAdapter } = await import("../claimkit-llm-adapter.js");
    const adapter = new AIProviderLLMAdapter(provider);
    const result = await adapter.generateText([{ role: "user", content: "hi" }]);

    expect(result.text.length).toBeGreaterThan(0);
    expect(result.model).toBe("claimkit-memory-llm");
  });

  it("falls back on all errors when CLAIMKIT_LLM_FATAL_FALLBACK is true", async () => {
    process.env.CLAIMKIT_LLM_FATAL_FALLBACK = "true";
    const provider = makeProvider(async () => {
      const err = new Error("Bad request") as any;
      err.status = 400;
      throw err;
    });

    const { AIProviderLLMAdapter } = await import("../claimkit-llm-adapter.js");
    const adapter = new AIProviderLLMAdapter(provider);
    const result = await adapter.generateText([{ role: "user", content: "hi" }]);

    expect(result.text.length).toBeGreaterThan(0);
    expect(result.model).toBe("claimkit-memory-llm");
  });
});

describe("stripJsonFromLlmResponse", () => {
  it("strips fenced JSON", async () => {
    const { stripJsonFromLlmResponse } = await import("../claimkit-llm-adapter.js");
    expect(stripJsonFromLlmResponse("```json\n{\"a\":1}\n```")).toBe('{"a":1}');
  });

  it("extracts bare JSON object", async () => {
    const { stripJsonFromLlmResponse } = await import("../claimkit-llm-adapter.js");
    expect(stripJsonFromLlmResponse("prefix {\"a\":1} suffix")).toBe('{"a":1}');
  });
});
