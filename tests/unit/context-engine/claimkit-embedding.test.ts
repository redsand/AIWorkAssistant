import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────────

const { mockEmbed, mockEmbedBatch, mockGetProviderInfo, mockEnvValues } = vi.hoisted(() => ({
  mockEmbed: vi.fn(),
  mockEmbedBatch: vi.fn(),
  mockGetProviderInfo: vi.fn(),
  mockEnvValues: {} as Record<string, any>,
}));

vi.mock("../../../src/agent/embedding-service", () => ({
  embeddingService: {
    embed: mockEmbed,
    embedBatch: mockEmbedBatch,
    getProviderInfo: mockGetProviderInfo,
  },
}));

vi.mock("../../../src/config/env", () => ({
  get env() {
    return mockEnvValues;
  },
}));

vi.mock("@redsand/claimkit", () => ({}));

import { ClaimKitEmbeddingAdapter } from "../../../src/context-engine/adapters/claimkit-embedding";

describe("ClaimKitEmbeddingAdapter", () => {
  let adapter: ClaimKitEmbeddingAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnvValues.RAG_EMBEDDING_MODEL = undefined;
    mockGetProviderInfo.mockReturnValue({
      provider: "opencode",
      model: "text-embedding-3-small",
      available: true,
    });
    adapter = new ClaimKitEmbeddingAdapter();
  });

  // ── Constructor & dimensions ──────────────────────────────────────────────────

  describe("constructor / dimensions", () => {
    it("defaults to 1536 dimensions when no model is specified", () => {
      expect(adapter.dimensions).toBe(1536);
    });

    it("uses known dimensions for text-embedding-3-small", () => {
      mockEnvValues.RAG_EMBEDDING_MODEL = "text-embedding-3-small";
      adapter = new ClaimKitEmbeddingAdapter();
      expect(adapter.dimensions).toBe(1536);
    });

    it("uses known dimensions for text-embedding-3-large", () => {
      mockEnvValues.RAG_EMBEDDING_MODEL = "text-embedding-3-large";
      adapter = new ClaimKitEmbeddingAdapter();
      expect(adapter.dimensions).toBe(3072);
    });

    it("uses known dimensions for text-embedding-ada-002", () => {
      mockEnvValues.RAG_EMBEDDING_MODEL = "text-embedding-ada-002";
      adapter = new ClaimKitEmbeddingAdapter();
      expect(adapter.dimensions).toBe(1536);
    });

    it("uses known dimensions for nomic-embed-text", () => {
      mockEnvValues.RAG_EMBEDDING_MODEL = "nomic-embed-text";
      adapter = new ClaimKitEmbeddingAdapter();
      expect(adapter.dimensions).toBe(768);
    });

    it("uses known dimensions for mxbai-embed-large", () => {
      mockEnvValues.RAG_EMBEDDING_MODEL = "mxbai-embed-large";
      adapter = new ClaimKitEmbeddingAdapter();
      expect(adapter.dimensions).toBe(1024);
    });

    it("uses known dimensions for bge-m3", () => {
      mockEnvValues.RAG_EMBEDDING_MODEL = "bge-m3";
      adapter = new ClaimKitEmbeddingAdapter();
      expect(adapter.dimensions).toBe(1024);
    });

    it("uses known dimensions for all-minilm", () => {
      mockEnvValues.RAG_EMBEDDING_MODEL = "all-minilm";
      adapter = new ClaimKitEmbeddingAdapter();
      expect(adapter.dimensions).toBe(384);
    });

    it("matches by substring when model name contains a known key", () => {
      mockEnvValues.RAG_EMBEDDING_MODEL = "custom/nomic-embed-text-v2";
      adapter = new ClaimKitEmbeddingAdapter();
      expect(adapter.dimensions).toBe(768);
    });

    it("defaults to 1536 for an unknown model name", () => {
      mockEnvValues.RAG_EMBEDDING_MODEL = "custom-unknown-model";
      adapter = new ClaimKitEmbeddingAdapter();
      expect(adapter.dimensions).toBe(1536);
    });
  });

  // ── model getter ──────────────────────────────────────────────────────────────

  describe("model", () => {
    it("returns EmbeddingModelMetadata from the embedding service", () => {
      const metadata = adapter.model;
      expect(metadata).toEqual({
        provider: "opencode",
        model: "text-embedding-3-small",
        dimensions: 1536,
        normalized: true,
      });
    });
  });

  // ── embed ─────────────────────────────────────────────────────────────────────

  describe("embed", () => {
    it("returns embedding array from the service", async () => {
      const fakeEmbedding = new Array(1536).fill(0.1);
      mockEmbed.mockResolvedValue({ embedding: fakeEmbedding, model: "text-embedding-3-small", provider: "opencode" });

      const result = await adapter.embed("hello world");

      expect(result).toBe(fakeEmbedding);
      expect(mockEmbed).toHaveBeenCalledWith("hello world");
    });

    it("throws when embedding service returns null", async () => {
      mockEmbed.mockResolvedValue(null);
      mockGetProviderInfo.mockReturnValue({ provider: "unavailable", model: "unknown", available: false });

      await expect(adapter.embed("test")).rejects.toThrow(
        "[ClaimKitEmbedding] Embed failed: provider=unavailable is unavailable",
      );
    });

    it("throws when actual result differs from constructor dimensions", async () => {
      const shortEmbedding = new Array(384).fill(0.5);
      mockEmbed.mockResolvedValue({ embedding: shortEmbedding, model: "all-minilm", provider: "ollama" });

      expect(adapter.dimensions).toBe(1536);
      await expect(adapter.embed("test")).rejects.toThrow("Dimension mismatch");
      expect(adapter.dimensions).toBe(1536);
    });

    it("does not change dimensions across repeated embed calls", async () => {
      const embedding1 = new Array(1536).fill(0.1);
      const embedding2 = new Array(1536).fill(0.2);
      mockEmbed
        .mockResolvedValueOnce({ embedding: embedding1, model: "m1", provider: "p1" })
        .mockResolvedValueOnce({ embedding: embedding2, model: "m2", provider: "p2" });

      await adapter.embed("first");
      expect(adapter.dimensions).toBe(1536);
      await adapter.embed("second");
      expect(adapter.dimensions).toBe(1536);
    });

    it("throws when detected value changes", async () => {
      const emb1 = new Array(1536).fill(0.1);
      const emb2 = new Array(768).fill(0.2);
      mockEmbed
        .mockResolvedValueOnce({ embedding: emb1, model: "m1", provider: "p1" })
        .mockResolvedValueOnce({ embedding: emb2, model: "m2", provider: "p2" });

      await adapter.embed("first");
      expect(adapter.dimensions).toBe(1536);
      await expect(adapter.embed("second")).rejects.toThrow("Dimension mismatch");
      expect(adapter.dimensions).toBe(1536);
    });
  });

  // ── embedBatch ────────────────────────────────────────────────────────────────

  describe("embedBatch", () => {
    it("returns embedding arrays for all texts", async () => {
      const emb1 = new Array(1536).fill(0.1);
      const emb2 = new Array(1536).fill(0.2);
      mockEmbedBatch.mockResolvedValue([
        { embedding: emb1, model: "m1", provider: "p1" },
        { embedding: emb2, model: "m2", provider: "p2" },
      ]);

      const results = await adapter.embedBatch(["text1", "text2"]);

      expect(results).toHaveLength(2);
      expect(results[0]).toBe(emb1);
      expect(results[1]).toBe(emb2);
      expect(mockEmbedBatch).toHaveBeenCalledWith(["text1", "text2"]);
    });

    it("handles a single text input", async () => {
      const emb = new Array(1536).fill(0.3);
      mockEmbedBatch.mockResolvedValue([
        { embedding: emb, model: "m1", provider: "p1" },
      ]);

      const results = await adapter.embedBatch(["solo"]);

      expect(results).toHaveLength(1);
      expect(results[0]).toBe(emb);
    });

    it("throws when a batch result is null at index 0", async () => {
      mockEmbedBatch.mockResolvedValue([null]);
      mockGetProviderInfo.mockReturnValue({ provider: "opencode", model: "m1", available: true });

      await expect(adapter.embedBatch(["bad"])).rejects.toThrow(
        "[ClaimKitEmbedding] Batch embed[0] failed for provider=opencode",
      );
    });

    it("throws when a batch result is null at a later index", async () => {
      const emb = new Array(1536).fill(0.1);
      mockEmbedBatch.mockResolvedValue([
        { embedding: emb, model: "m1", provider: "p1" },
        null,
      ]);
      mockGetProviderInfo.mockReturnValue({ provider: "opencode", model: "m1", available: true });

      await expect(adapter.embedBatch(["ok", "bad"])).rejects.toThrow(
        "[ClaimKitEmbedding] Batch embed[1] failed for provider=opencode",
      );
    });

    it("throws when a batch result differs from constructor dimensions", async () => {
      const emb1 = new Array(768).fill(0.1);
      const emb2 = new Array(768).fill(0.2);
      mockEmbedBatch.mockResolvedValue([
        { embedding: emb1, model: "m1", provider: "p1" },
        { embedding: emb2, model: "m2", provider: "p2" },
      ]);

      await expect(adapter.embedBatch(["a", "b"])).rejects.toThrow("Dimension mismatch");
      expect(adapter.dimensions).toBe(1536);
    });

    it("throws when a batch result has different dimensions", async () => {
      const emb = new Array(3072).fill(0.5);
      mockEmbedBatch.mockResolvedValue([
        { embedding: emb, model: "m1", provider: "p1" },
      ]);

      expect(adapter.dimensions).toBe(1536);
      await expect(adapter.embedBatch(["text"])).rejects.toThrow("Dimension mismatch");
      expect(adapter.dimensions).toBe(1536);
    });
  });
});
