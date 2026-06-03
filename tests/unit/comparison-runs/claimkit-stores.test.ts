import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockCreateRedisClient = vi.fn();
const mockConnectRedis = vi.fn();
const mockCreateRedisStores = vi.fn();
const mockCloseRedis = vi.fn();
const mockCreateMemoryStores = vi.fn();

vi.mock("@redsand/claimkit/redis", () => ({
  createRedisClient: (...args: unknown[]) => mockCreateRedisClient(...args),
  connectRedis: (...args: unknown[]) => mockConnectRedis(...args),
  createRedisStores: (...args: unknown[]) => mockCreateRedisStores(...args),
  closeRedis: (...args: unknown[]) => mockCloseRedis(...args),
}));

vi.mock("@redsand/claimkit", () => ({
  ClaimKit: vi.fn(function (this: unknown) {
    return {};
  }),
  createMemoryStores: (...args: unknown[]) => mockCreateMemoryStores(...args),
  MemoryLLMAdapter: vi.fn(function (this: unknown) {
    return {};
  }),
}));

vi.mock("../../../src/config/env", () => ({
  env: {
    CLAIMKIT_ENABLED: "true",
    CLAIMKIT_LLM_PROVIDER: "memory",
    CLAIMKIT_REDIS_URL: "",
    CLAIMKIT_REDIS_PREFIX: "aiworkassistant",
    CLAIMKIT_TOP_K: 10,
    CLAIMKIT_MIN_SCORE: 0.0,
    CLAIMKIT_MAX_EVIDENCE_ITEMS: 20,
    CLAIMKIT_LLM_MODEL: "",
    RAG_EMBEDDING_MODEL: "",
  },
}));

vi.mock("../../../src/agent/embedding-service", () => ({
  embeddingService: {
    isAvailable: vi.fn().mockResolvedValue(true),
    getProviderInfo: () => ({ provider: "test", model: "text-embedding-3-small" }),
    embed: vi.fn().mockResolvedValue({ embedding: new Array(1536).fill(0) }),
    embedBatch: vi.fn(),
  },
}));

import { env } from "../../../src/config/env";

// Must import after mocks are set up
const { ClaimKitAdapter } = await import(
  "../../../src/context-engine/adapters/claimkit-adapter"
);

function makeStores() {
  return {
    sources: { save: vi.fn(), get: vi.fn(), getAll: vi.fn(), delete: vi.fn() },
    claims: { save: vi.fn(), get: vi.fn(), getAll: vi.fn(), delete: vi.fn() },
    evidence: { save: vi.fn(), get: vi.fn(), getByClaim: vi.fn(), getBySource: vi.fn(), delete: vi.fn() },
    entities: { save: vi.fn(), get: vi.fn(), findByName: vi.fn(), delete: vi.fn() },
    vectors: { upsert: vi.fn(), query: vi.fn(), delete: vi.fn(), upsertMany: vi.fn(), deleteMany: vi.fn() },
    graph: { upsertRelation: vi.fn(), getRelationsForClaim: vi.fn() },
    chunks: { save: vi.fn(), saveMany: vi.fn(), get: vi.fn(), getBySource: vi.fn(), delete: vi.fn() },
  };
}

describe("ClaimKitAdapter stores", () => {
  let adapter: InstanceType<typeof ClaimKitAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateMemoryStores.mockReturnValue(makeStores());
    adapter = new ClaimKitAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses memory stores when CLAIMKIT_REDIS_URL is not set", async () => {
    (env as any).CLAIMKIT_REDIS_URL = "";
    const memoryStores = makeStores();
    mockCreateMemoryStores.mockReturnValue(memoryStores);

    const result = await adapter.initialize();

    expect(result).toBe(true);
    expect(mockCreateMemoryStores).toHaveBeenCalled();
    expect(mockCreateRedisClient).not.toHaveBeenCalled();
  });

  it("uses Redis stores when CLAIMKIT_REDIS_URL is set", async () => {
    (env as any).CLAIMKIT_REDIS_URL = "redis://localhost:6379";
    (env as any).CLAIMKIT_REDIS_PREFIX = "testprefix";

    const fakeClient = { ping: vi.fn().mockResolvedValue("PONG") };
    mockCreateRedisClient.mockReturnValue(fakeClient);
    mockConnectRedis.mockResolvedValue(undefined);
    const redisStores = makeStores();
    mockCreateRedisStores.mockReturnValue(redisStores);

    const result = await adapter.initialize();

    expect(result).toBe(true);
    expect(mockCreateRedisClient).toHaveBeenCalledWith({
      url: "redis://localhost:6379",
    });
    expect(mockConnectRedis).toHaveBeenCalledWith(fakeClient);
    expect(mockCreateRedisStores).toHaveBeenCalledWith(
      expect.objectContaining({
        client: fakeClient,
        prefix: "testprefix",
        vectorMode: "bruteForce",
        vectorOptions: { vectorDim: 1536 },
      }),
    );
    expect(mockCreateMemoryStores).not.toHaveBeenCalled();

    // Reset for other tests
    (env as any).CLAIMKIT_REDIS_URL = "";
  });

  it("falls back to memory stores if Redis connection fails", async () => {
    (env as any).CLAIMKIT_REDIS_URL = "redis://localhost:6379";

    const fakeClient = { ping: vi.fn() };
    mockCreateRedisClient.mockReturnValue(fakeClient);
    mockConnectRedis.mockRejectedValue(new Error("Connection refused"));
    mockCreateMemoryStores.mockReturnValue(makeStores());

    const result = await adapter.initialize();

    expect(result).toBe(true);
    expect(mockCreateMemoryStores).toHaveBeenCalled();

    (env as any).CLAIMKIT_REDIS_URL = "";
  });

  it("passes vectorDim from embedding adapter dimensions", async () => {
    (env as any).CLAIMKIT_REDIS_URL = "redis://localhost:6379";

    const fakeClient = { ping: vi.fn().mockResolvedValue("PONG") };
    mockCreateRedisClient.mockReturnValue(fakeClient);
    mockConnectRedis.mockResolvedValue(undefined);
    mockCreateRedisStores.mockReturnValue(makeStores());

    await adapter.initialize();

    expect(mockCreateRedisStores).toHaveBeenCalledWith(
      expect.objectContaining({
        vectorOptions: { vectorDim: 1536 },
      }),
    );

    (env as any).CLAIMKIT_REDIS_URL = "";
  });

  it("does not re-initialize if already initialized", async () => {
    (env as any).CLAIMKIT_REDIS_URL = "";
    mockCreateMemoryStores.mockReturnValue(makeStores());

    await adapter.initialize();
    await adapter.initialize();

    // Should only be called once
    expect(mockCreateMemoryStores).toHaveBeenCalledTimes(1);
  });
});
