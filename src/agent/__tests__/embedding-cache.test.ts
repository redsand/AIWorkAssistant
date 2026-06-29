import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// embeddingService is a singleton — we have to swap its internal HTTP
// shape by mocking axios. Each test resets modules so the cache state
// + env override apply cleanly.

describe("EmbeddingService cache — skip the provider on repeat texts", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      EMBEDDING_CACHE: "true",
      EMBEDDING_CACHE_MAX: "200",
      EMBEDDING_CACHE_TTL_MS: "1800000",
      // Skip availability probe — assume reachable for the cache test.
      EMBEDDING_PROVIDER: "ollama",
      OLLAMA_API_URL: "http://test-ollama",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("second embed() of the same text returns cached result without hitting axios", async () => {
    const postSpy = vi.fn(async () => ({
      data: { embedding: [0.1, 0.2, 0.3] },
    }));
    vi.doMock("axios", () => ({
      default: { post: postSpy, get: vi.fn(async () => ({ data: {} })) },
      post: postSpy,
    }));

    const { embeddingService, __clearEmbeddingCacheForTests } = await import(
      "../embedding-service.js"
    );
    __clearEmbeddingCacheForTests();
    // Force-mark as available so embed() doesn't run the probe.
    (embeddingService as any).available = true;
    (embeddingService as any).lastCheck = Date.now();

    const first = await embeddingService.embed("hello world");
    const second = await embeddingService.embed("hello world");

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(second?.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it("different texts produce distinct cache entries — no collision", async () => {
    let callCount = 0;
    const postSpy = vi.fn(async () => {
      callCount++;
      return { data: { embedding: [callCount, callCount + 1] } };
    });
    vi.doMock("axios", () => ({
      default: { post: postSpy, get: vi.fn(async () => ({ data: {} })) },
      post: postSpy,
    }));

    const { embeddingService, __clearEmbeddingCacheForTests } = await import(
      "../embedding-service.js"
    );
    __clearEmbeddingCacheForTests();
    (embeddingService as any).available = true;
    (embeddingService as any).lastCheck = Date.now();

    const a = await embeddingService.embed("first text");
    const b = await embeddingService.embed("second text");

    expect(a?.embedding).toEqual([1, 2]);
    expect(b?.embedding).toEqual([2, 3]);
    expect(postSpy).toHaveBeenCalledTimes(2);
  });

  it("embedBatch returns cached entries for duplicates and only sends misses to the provider", async () => {
    // Track which TEXTS the provider was asked to embed, regardless of
    // whether the request hit the batch (/api/embed, input: string[])
    // or the per-item fallback (/api/embeddings, prompt: string).
    const askedFor: string[] = [];
    const postSpy = vi.fn(async (url: string, body: any) => {
      if (typeof url === "string" && url.endsWith("/api/embed")) {
        const inputs: string[] = Array.isArray(body?.input) ? body.input : [];
        inputs.forEach((t) => askedFor.push(t));
        return {
          data: {
            embeddings: inputs.map((t) => [t.length, t.length + 1]),
          },
        };
      }
      // /api/embeddings or /v1/embeddings — single-prompt shapes.
      const text = body?.prompt ?? body?.input ?? "";
      askedFor.push(text);
      return { data: { embedding: [text.length, text.length + 1] } };
    });
    vi.doMock("axios", () => ({
      default: { post: postSpy, get: vi.fn(async () => ({ data: {} })) },
      post: postSpy,
    }));

    const { embeddingService, __clearEmbeddingCacheForTests } = await import(
      "../embedding-service.js"
    );
    __clearEmbeddingCacheForTests();
    (embeddingService as any).available = true;
    (embeddingService as any).lastCheck = Date.now();

    // Prime the cache for "alpha" via single-embed
    await embeddingService.embed("alpha");
    askedFor.length = 0; // forget the priming call

    // Batch with mixed cache hits + misses
    const results = await embeddingService.embedBatch(["alpha", "beta", "alpha", "gamma"]);

    expect(results).toHaveLength(4);
    expect(results[0]?.embedding).toEqual([5, 6]); // alpha cached → length 5
    expect(results[2]?.embedding).toEqual([5, 6]); // alpha cached → length 5
    expect(results[1]?.embedding).toEqual([4, 5]); // beta length 4
    expect(results[3]?.embedding).toEqual([5, 6]); // gamma length 5

    // Only the two distinct cache-misses (beta + gamma) should reach
    // the provider — alpha was cached from the priming call.
    expect(askedFor.sort()).toEqual(["beta", "gamma"]);
  });

  it("disabled cache (EMBEDDING_CACHE=false) re-hits the provider every call", async () => {
    process.env.EMBEDDING_CACHE = "false";
    const postSpy = vi.fn(async () => ({
      data: { embedding: [9, 9, 9] },
    }));
    vi.doMock("axios", () => ({
      default: { post: postSpy, get: vi.fn(async () => ({ data: {} })) },
      post: postSpy,
    }));

    const { embeddingService, __clearEmbeddingCacheForTests } = await import(
      "../embedding-service.js"
    );
    __clearEmbeddingCacheForTests();
    (embeddingService as any).available = true;
    (embeddingService as any).lastCheck = Date.now();

    await embeddingService.embed("disabled-cache-test");
    await embeddingService.embed("disabled-cache-test");

    expect(postSpy).toHaveBeenCalledTimes(2);
  });
});
