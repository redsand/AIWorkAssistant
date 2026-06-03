import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("axios");
vi.mock("../../../src/config/env", () => ({
  env: {
    EMBEDDING_PROVIDER: "ollama",
    EMBEDDING_MODEL: "nomic-embed-text",
    EMBEDDING_OLLAMA_FALLBACK_MODEL: "nomic-embed-text",
    OLLAMA_API_URL: "http://localhost:11434",
    OLLAMA_API_KEY: "",
    OLLAMA_MODEL: "llama3",
    OPENAI_API_URL: "https://api.openai.com/v1",
    OPENAI_API_KEY: "",
    OPENAI_MODEL: "gpt-4o",
    ZAI_API_URL: "https://api.z.ai/v1",
    ZAI_API_KEY: "",
    ZAI_MODEL: "GLM-5",
    OPENCODE_API_URL: "https://opencode.ai/v1",
    OPENCODE_API_KEY: "",
    RAG_EMBEDDING_MODEL: "",
    AI_PROVIDER: "ollama",
  },
}));

import axios from "axios";

const mockPost = vi.mocked(axios.post);

// Helper — resolves with a successful embedding response
function embeddingOk(dims = 768) {
  return Promise.resolve({
    status: 200,
    data: { embedding: new Array(dims).fill(0.1) },
  });
}

// Helper — rejects with a model-not-found Ollama error
function modelNotFound(model: string) {
  const err = Object.assign(new Error(`model "${model}" not found`), {
    response: {
      status: 404,
      data: { error: `model "${model}" not found, try pulling it first` },
    },
  });
  return Promise.reject(err);
}

// Helper — rejects with a generic connection error
function connectionRefused() {
  return Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:11434"));
}

// Helper — resolves with a successful pull response
function pullOk() {
  return Promise.resolve({ status: 200, data: { status: "success" } });
}

describe("EmbeddingService — auto-pull logic", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns available immediately when Ollama responds on first check", async () => {
    mockPost.mockResolvedValueOnce(embeddingOk());
    const { embeddingService } = await import("../../../src/agent/embedding-service");

    const ok = await embeddingService.isAvailable();
    expect(ok).toBe(true);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("auto-pulls and retries when Ollama returns model-not-found (404)", async () => {
    mockPost
      .mockImplementationOnce(() => modelNotFound("nomic-embed-text")) // checkOllama fails
      .mockResolvedValueOnce(pullOk())                                 // /api/pull
      .mockResolvedValueOnce(embeddingOk());                           // retry

    const { embeddingService } = await import("../../../src/agent/embedding-service");

    const ok = await embeddingService.isAvailable();
    expect(ok).toBe(true);
    expect(mockPost).toHaveBeenCalledTimes(3);

    // Second call — pull attempt already consumed; should use cached available=true
    const ok2 = await embeddingService.isAvailable();
    expect(ok2).toBe(true);
    expect(mockPost).toHaveBeenCalledTimes(3); // no extra calls
  });

  it("does not pull again when pull already attempted (pullAttempted guard)", async () => {
    mockPost
      .mockImplementationOnce(() => modelNotFound("nomic-embed-text")) // checkOllama fails
      .mockRejectedValueOnce(new Error("pull failed"))                 // /api/pull fails
      // next isAvailable() call resets the interval, re-checks
      .mockImplementationOnce(() => modelNotFound("nomic-embed-text")); // still failing

    const { embeddingService } = await import("../../../src/agent/embedding-service");

    // First check — triggers pull attempt which fails
    const ok1 = await embeddingService.isAvailable();
    expect(ok1).toBe(false);

    // Force re-check by simulating cache expiry (hack the lastCheck)
    (embeddingService as any).lastCheck = 0;
    (embeddingService as any).available = null;

    // Second check — pullAttempted is true, so no pull, straight model-not-found → false
    const ok2 = await embeddingService.isAvailable();
    expect(ok2).toBe(false);

    // Pull was only called once
    const pullCalls = mockPost.mock.calls.filter((c) =>
      String(c[0]).includes("/api/pull"),
    );
    expect(pullCalls).toHaveLength(1);
  });

  it("falls back to TF-IDF (returns false) when pull fails and no other provider works", async () => {
    mockPost
      .mockImplementationOnce(() => modelNotFound("nomic-embed-text")) // checkOllama fails
      .mockRejectedValueOnce(new Error("network error"));               // /api/pull fails

    const { embeddingService } = await import("../../../src/agent/embedding-service");

    const ok = await embeddingService.isAvailable();
    expect(ok).toBe(false);
  });

  it("returns false on connection-refused without attempting a pull", async () => {
    mockPost.mockImplementationOnce(() => connectionRefused());

    const { embeddingService } = await import("../../../src/agent/embedding-service");

    const ok = await embeddingService.isAvailable();
    expect(ok).toBe(false);
    // No /api/pull call — connection refused is not a model-not-found error
    const pullCalls = mockPost.mock.calls.filter((c) =>
      String(c[0]).includes("/api/pull"),
    );
    expect(pullCalls).toHaveLength(0);
  });

  it("isModelNotFoundError identifies 404 responses", async () => {
    const { embeddingService } = await import("../../../src/agent/embedding-service");
    const check = (embeddingService as any).isModelNotFoundError.bind(embeddingService);

    expect(check({ response: { status: 404 } })).toBe(true);
    expect(check({ response: { status: 500 } })).toBe(false);
    expect(check({ message: "model not found" })).toBe(true);
    expect(check({ response: { data: { error: "no model named foo" } } })).toBe(true);
    expect(check({ response: { data: { error: "does not exist" } } })).toBe(true);
    expect(check({ message: "connection refused" })).toBe(false);
    expect(check(null)).toBe(false);
    expect(check(undefined)).toBe(false);
    expect(check("string error")).toBe(false);
  });

  it("embed() returns null when not available", async () => {
    mockPost.mockRejectedValueOnce(new Error("unavailable"));

    const { embeddingService } = await import("../../../src/agent/embedding-service");
    const result = await embeddingService.embed("hello");
    expect(result).toBeNull();
  });
});
