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
      CLAIMKIT_LLM_TOTAL_TIMEOUT_MS: "3000",
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

describe("AIProviderLLMAdapter.generateJson — response cache", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...originalEnv,
      CLAIMKIT_LLM_TIMEOUT_MS: "5000",
      CLAIMKIT_LLM_TOTAL_TIMEOUT_MS: "10000",
      CLAIMKIT_LLM_MAX_ATTEMPTS: "1",
      CLAIMKIT_LLM_CACHE: "true",
      CLAIMKIT_LLM_CACHE_MAX: "200",
      CLAIMKIT_LLM_CACHE_TTL_MS: "300000",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("second identical generateJson returns the cached value without re-hitting the provider", async () => {
    const chatSpy = vi.fn(async () => ({
      content: '{"plan":"investigate"}',
      model: "test-model",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }));
    const provider = { name: "ollama", chat: chatSpy, completion: vi.fn() } as any;

    const { AIProviderLLMAdapter, __clearJsonResponseCacheForTests } =
      await import("../claimkit-llm-adapter.js");
    __clearJsonResponseCacheForTests();
    const adapter = new AIProviderLLMAdapter(provider);
    const msgs = [{ role: "user" as const, content: "what's the plan?" }];

    const first = await adapter.generateJson(msgs, {} as any);
    const second = await adapter.generateJson(msgs, {} as any);

    expect(first).toEqual({ plan: "investigate" });
    expect(second).toEqual({ plan: "investigate" });
    expect(chatSpy).toHaveBeenCalledTimes(1);
  });

  it("different message content produces different cache entries — no cross-contamination", async () => {
    const chatSpy = vi.fn(async (req: any) => ({
      content: req.messages[0].content.includes("plan A")
        ? '{"answer":"a"}'
        : '{"answer":"b"}',
      model: "test-model",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }));
    const provider = { name: "ollama", chat: chatSpy, completion: vi.fn() } as any;

    const { AIProviderLLMAdapter, __clearJsonResponseCacheForTests } =
      await import("../claimkit-llm-adapter.js");
    __clearJsonResponseCacheForTests();
    const adapter = new AIProviderLLMAdapter(provider);

    const a = await adapter.generateJson([{ role: "user", content: "plan A" }], {} as any);
    const b = await adapter.generateJson([{ role: "user", content: "plan B" }], {} as any);

    expect(a).toEqual({ answer: "a" });
    expect(b).toEqual({ answer: "b" });
    expect(chatSpy).toHaveBeenCalledTimes(2);
  });

  it("disabled cache (CLAIMKIT_LLM_CACHE=false) skips lookup and re-hits the provider", async () => {
    process.env.CLAIMKIT_LLM_CACHE = "false";
    const chatSpy = vi.fn(async () => ({
      content: '{"x":1}',
      model: "test-model",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }));
    const provider = { name: "ollama", chat: chatSpy, completion: vi.fn() } as any;

    const { AIProviderLLMAdapter, __clearJsonResponseCacheForTests } =
      await import("../claimkit-llm-adapter.js");
    __clearJsonResponseCacheForTests();
    const adapter = new AIProviderLLMAdapter(provider);
    const msgs = [{ role: "user" as const, content: "ping" }];

    await adapter.generateJson(msgs, {} as any);
    await adapter.generateJson(msgs, {} as any);

    expect(chatSpy).toHaveBeenCalledTimes(2);
  });

  it("expired entries (past TTL) fall through to the provider", async () => {
    process.env.CLAIMKIT_LLM_CACHE_TTL_MS = "10"; // 10ms — easy to expire
    const chatSpy = vi.fn(async () => ({
      content: '{"v":1}',
      model: "test-model",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }));
    const provider = { name: "ollama", chat: chatSpy, completion: vi.fn() } as any;

    const { AIProviderLLMAdapter, __clearJsonResponseCacheForTests } =
      await import("../claimkit-llm-adapter.js");
    __clearJsonResponseCacheForTests();
    const adapter = new AIProviderLLMAdapter(provider);
    const msgs = [{ role: "user" as const, content: "ping" }];

    await adapter.generateJson(msgs, {} as any);
    await new Promise((r) => setTimeout(r, 25));
    await adapter.generateJson(msgs, {} as any);

    expect(chatSpy).toHaveBeenCalledTimes(2);
  });
});
