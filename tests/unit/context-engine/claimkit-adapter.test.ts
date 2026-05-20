import { describe, it, expect, beforeEach, vi } from "vitest";

const mockClaimKitInstance = {
  ingest: vi.fn(),
  query: vi.fn(),
};

class MockClaimKit {
  constructor(opts: unknown, config: unknown) {
    mockClaimKitConstructor(opts, config);
    return mockClaimKitInstance;
  }
}

class MockMemoryLLMAdapter {}
class MockMemoryEmbeddingAdapter {}

const mockClaimKitConstructor = vi.fn();
const mockCreateMemoryStores = vi.fn(() => ({}));

vi.doMock("claimkit", () => ({
  ClaimKit: MockClaimKit,
  createMemoryStores: mockCreateMemoryStores,
  MemoryLLMAdapter: MockMemoryLLMAdapter,
  MemoryEmbeddingAdapter: MockMemoryEmbeddingAdapter,
}));

vi.doMock("../../../src/config/env", () => ({
  env: {
    CLAIMKIT_ENABLED: true,
    CLAIMKIT_TOP_K: 10,
    CLAIMKIT_MIN_SCORE: 0.0,
    CLAIMKIT_MAX_EVIDENCE_ITEMS: 20,
  },
}));

describe("ClaimKitAdapter", () => {
  let adapter: {
    initialize: () => Promise<boolean>;
    isAvailable: () => boolean;
    getInitError: () => string | null;
    ingest: (text: string, metadata?: Record<string, unknown>) => Promise<{ sourceId: string }>;
    query: (question: string, options?: Record<string, unknown>) => Promise<{
      answer: string;
      citations: Array<{ claimId: string; sourceId: string; text: string }>;
      confidence: number;
      contradictions: Array<{ claimA: string; claimB: string; reason: string }>;
      missingEvidence: string[];
      answerability: string;
      metadata: {
        sourceIds: string[];
        claimCount: number;
        processingTimeMs: number;
        retrievalScore: number;
      };
    }>;
  };
  let claimKitAdapter: { claimKitAdapter: typeof adapter };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.doMock("../../../src/config/env", () => ({
      env: {
        CLAIMKIT_ENABLED: true,
        CLAIMKIT_TOP_K: 10,
        CLAIMKIT_MIN_SCORE: 0.0,
        CLAIMKIT_MAX_EVIDENCE_ITEMS: 20,
      },
    }));
    vi.resetModules();
    claimKitAdapter = await import("../../../src/context-engine/adapters/claimkit-adapter");
    adapter = claimKitAdapter.claimKitAdapter as unknown as typeof adapter;
  });

  describe("initialize", () => {
    it("should return true on successful initialization", async () => {
      const result = await adapter.initialize();
      expect(result).toBe(true);
      expect(mockClaimKitConstructor).toHaveBeenCalledOnce();
    });

    it("should return false when CLAIMKIT_ENABLED is false", async () => {
      vi.doMock("../../../src/config/env", () => ({
        env: {
          CLAIMKIT_ENABLED: false,
          CLAIMKIT_TOP_K: 10,
          CLAIMKIT_MIN_SCORE: 0.0,
          CLAIMKIT_MAX_EVIDENCE_ITEMS: 20,
        },
      }));
      vi.resetModules();
      const mod = await import("../../../src/context-engine/adapters/claimkit-adapter");
      const disabledAdapter = mod.claimKitAdapter as unknown as typeof adapter;

      const result = await disabledAdapter.initialize();
      expect(result).toBe(false);
      expect(disabledAdapter.getInitError()).toBe("ClaimKit is disabled (CLAIMKIT_ENABLED=false)");
    });

    it("should return false and set initError when constructor throws", async () => {
      mockClaimKitConstructor.mockImplementationOnce(() => {
        throw new Error("Connection refused");
      });

      vi.resetModules();
      const mod = await import("../../../src/context-engine/adapters/claimkit-adapter");
      const errorAdapter = mod.claimKitAdapter as unknown as typeof adapter;

      const result = await errorAdapter.initialize();
      expect(result).toBe(false);
      expect(errorAdapter.getInitError()).toBe("Connection refused");
    });

    it("should handle non-Error thrown values", async () => {
      mockClaimKitConstructor.mockImplementationOnce(() => {
        throw "something went wrong";
      });

      vi.resetModules();
      const mod = await import("../../../src/context-engine/adapters/claimkit-adapter");
      const errorAdapter = mod.claimKitAdapter as unknown as typeof adapter;

      const result = await errorAdapter.initialize();
      expect(result).toBe(false);
      expect(errorAdapter.getInitError()).toBe("something went wrong");
    });

    it("should return true on second call without re-initializing", async () => {
      await adapter.initialize();
      const result = await adapter.initialize();
      expect(result).toBe(true);
      expect(mockClaimKitConstructor).toHaveBeenCalledTimes(1);
    });
  });

  describe("isAvailable", () => {
    it("should return false before initialization", () => {
      expect(adapter.isAvailable()).toBe(false);
    });

    it("should return true after successful initialization", async () => {
      await adapter.initialize();
      expect(adapter.isAvailable()).toBe(true);
    });
  });

  describe("getInitError", () => {
    it("should return null before initialization", () => {
      expect(adapter.getInitError()).toBeNull();
    });

    it("should return error message after failed initialization", async () => {
      mockClaimKitConstructor.mockImplementationOnce(() => {
        throw new Error("Connection refused");
      });
      vi.resetModules();
      const mod = await import("../../../src/context-engine/adapters/claimkit-adapter");
      const errorAdapter = mod.claimKitAdapter as unknown as typeof adapter;

      await errorAdapter.initialize();
      expect(errorAdapter.getInitError()).toBe("Connection refused");
    });
  });

  describe("ingest", () => {
    it("should throw if not initialized", async () => {
      await expect(adapter.ingest("some text")).rejects.toThrow("ClaimKit not initialized");
    });

    it("should ingest text and return sourceId", async () => {
      mockClaimKitInstance.ingest.mockResolvedValueOnce({
        source: { id: "src-123" },
      });
      await adapter.initialize();

      const result = await adapter.ingest("some text", { key: "value" });
      expect(result).toEqual({ sourceId: "src-123" });
      expect(mockClaimKitInstance.ingest).toHaveBeenCalledWith({
        text: "some text",
        metadata: { key: "value" },
      });
    });

    it("should ingest text without metadata", async () => {
      mockClaimKitInstance.ingest.mockResolvedValueOnce({
        source: { id: "src-456" },
      });
      await adapter.initialize();

      const result = await adapter.ingest("plain text");
      expect(result).toEqual({ sourceId: "src-456" });
    });
  });

  describe("query", () => {
    const mockAnswerResult = {
      answer: "The answer is 42.",
      citations: [{ claimId: "c1", sourceId: "s1", text: "evidence" }],
      confidence: 0.95,
      contradictions: [{ claimA: "a", claimB: "b", reason: "conflict" }],
      missingEvidence: ["missing piece"],
      verification: { answerability: "answerable" as const },
      metadata: {
        sourceIds: ["s1"],
        claimCount: 5,
        processingTimeMs: 100,
        retrievalScore: 0.9,
      },
    };

    it("should throw if not initialized", async () => {
      await expect(adapter.query("question")).rejects.toThrow("ClaimKit not initialized");
    });

    it("should query and return formatted result", async () => {
      mockClaimKitInstance.query.mockResolvedValueOnce(mockAnswerResult);
      await adapter.initialize();

      const result = await adapter.query("What is the answer?");
      expect(result.answer).toBe("The answer is 42.");
      expect(result.confidence).toBe(0.95);
      expect(result.citations).toHaveLength(1);
      expect(result.contradictions).toHaveLength(1);
      expect(result.missingEvidence).toEqual(["missing piece"]);
      expect(result.answerability).toBe("answerable");
      expect(result.metadata.sourceIds).toEqual(["s1"]);
      expect(result.metadata.claimCount).toBe(5);
      expect(result.metadata.processingTimeMs).toBe(100);
      expect(result.metadata.retrievalScore).toBe(0.9);
      expect(mockClaimKitInstance.query).toHaveBeenCalledWith("What is the answer?", undefined);
    });

    it("should pass query options to claimKit", async () => {
      mockClaimKitInstance.query.mockResolvedValueOnce(mockAnswerResult);
      await adapter.initialize();

      const options = { sourceFilter: { sourceIds: ["s1"] } };
      await adapter.query("question", options);
      expect(mockClaimKitInstance.query).toHaveBeenCalledWith("question", options);
    });

    it("should default answerability to 'answerable' when verification is missing", async () => {
      mockClaimKitInstance.query.mockResolvedValueOnce({
        ...mockAnswerResult,
        verification: undefined,
      });
      await adapter.initialize();

      const result = await adapter.query("question");
      expect(result.answerability).toBe("answerable");
    });
  });
});
