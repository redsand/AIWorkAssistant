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
const mockQueryNodes = vi.fn();
const mockGetEdgesForNode = vi.fn();

const mockKnowledgeGraph = {
  queryNodes: mockQueryNodes,
  getEdgesForNode: mockGetEdgesForNode,
};

vi.doMock("@redsand/claimkit", () => ({
  ClaimKit: MockClaimKit,
  createMemoryStores: mockCreateMemoryStores,
  MemoryLLMAdapter: MockMemoryLLMAdapter,
  MemoryEmbeddingAdapter: MockMemoryEmbeddingAdapter,
}));

vi.doMock("../../../src/agent/providers/factory", () => ({
  getProvider: () => ({ chat: vi.fn(), name: "mock-provider" }),
  resetProvider: vi.fn(),
  getEffectiveContextLimit: (_model: string, defaultLimit: number) => defaultLimit,
}));

vi.doMock("../../../src/agent/embedding-service", () => ({
  embeddingService: {
    isAvailable: vi.fn().mockResolvedValue(true),
    embed: vi.fn().mockResolvedValue({
      embedding: new Array(768).fill(0.1),
      model: "nomic-embed-text",
      provider: "ollama",
    }),
    getProviderInfo: vi.fn().mockReturnValue({
      provider: "ollama",
      model: "nomic-embed-text",
      available: true,
    }),
  },
}));

vi.doMock("../../../src/agent/knowledge-graph", () => ({
  knowledgeGraph: mockKnowledgeGraph,
}));

vi.doMock("../../../src/config/env", () => ({
  env: {
    CLAIMKIT_ENABLED: true,
    CLAIMKIT_LLM_PROVIDER: "memory",
    CLAIMKIT_LLM_MODEL: "",
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
    verifyRelationship: (
      source: string,
      target: string,
      edgeType?: string,
    ) => Promise<{
      verified: boolean;
      confidence: number;
      trustTier: "curated" | "observed" | "inferred";
      evidence?: string;
      source?: string;
    }>;
  };
  let claimKitAdapter: { claimKitAdapter: typeof adapter };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.doMock("../../../src/config/env", () => ({
      env: {
        CLAIMKIT_ENABLED: true,
        CLAIMKIT_LLM_PROVIDER: "memory",
        CLAIMKIT_LLM_MODEL: "",
        CLAIMKIT_TOP_K: 10,
        CLAIMKIT_MIN_SCORE: 0.0,
        CLAIMKIT_MAX_EVIDENCE_ITEMS: 20,
      },
    }));
    vi.resetModules();
    vi.doMock("../../../src/agent/knowledge-graph", () => ({
      knowledgeGraph: mockKnowledgeGraph,
    }));
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
          CLAIMKIT_LLM_PROVIDER: "memory",
          CLAIMKIT_LLM_MODEL: "",
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

    it("should route to MemoryLLMAdapter when CLAIMKIT_LLM_PROVIDER is 'memory'", async () => {
      await adapter.initialize();
      expect(mockClaimKitConstructor).toHaveBeenCalled();
      const ctorArgs = mockClaimKitConstructor.mock.calls[0][0];
      expect(ctorArgs.llm).toBeInstanceOf(MockMemoryLLMAdapter);
    });

    it("should route to AIProviderLLMAdapter when CLAIMKIT_LLM_PROVIDER is not 'memory'", async () => {
      vi.doMock("../../../src/config/env", () => ({
        env: {
          CLAIMKIT_ENABLED: true,
          CLAIMKIT_LLM_PROVIDER: "ollama",
          CLAIMKIT_LLM_MODEL: "llama3",
          CLAIMKIT_TOP_K: 10,
          CLAIMKIT_MIN_SCORE: 0.0,
          CLAIMKIT_MAX_EVIDENCE_ITEMS: 20,
        },
      }));
      vi.resetModules();
      const mod = await import("../../../src/context-engine/adapters/claimkit-adapter");
      const ollamaAdapter = mod.claimKitAdapter as unknown as typeof adapter;

      await ollamaAdapter.initialize();
      expect(mockClaimKitConstructor).toHaveBeenCalled();
      const ctorArgs = mockClaimKitConstructor.mock.calls[0][0];
      expect(ctorArgs.llm).not.toBeInstanceOf(MockMemoryLLMAdapter);
    });

    it("should route to AIProviderLLMAdapter for 'comparison' provider", async () => {
      vi.doMock("../../../src/config/env", () => ({
        env: {
          CLAIMKIT_ENABLED: true,
          CLAIMKIT_LLM_PROVIDER: "comparison",
          CLAIMKIT_LLM_MODEL: "",
          CLAIMKIT_TOP_K: 10,
          CLAIMKIT_MIN_SCORE: 0.0,
          CLAIMKIT_MAX_EVIDENCE_ITEMS: 20,
        },
      }));
      vi.resetModules();
      const mod = await import("../../../src/context-engine/adapters/claimkit-adapter");
      const comparisonAdapter = mod.claimKitAdapter as unknown as typeof adapter;

      await comparisonAdapter.initialize();
      expect(mockClaimKitConstructor).toHaveBeenCalled();
      const ctorArgs = mockClaimKitConstructor.mock.calls[0][0];
      expect(ctorArgs.llm).not.toBeInstanceOf(MockMemoryLLMAdapter);
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
        ingest: { source: { id: "src-123" } },
      });
      await adapter.initialize();

      const result = await adapter.ingest("some text", { key: "value" });
      expect(result).toEqual({ sourceId: "src-123" });
      expect(mockClaimKitInstance.ingest).toHaveBeenCalledWith({
        title: "source",
        content: "some text",
        metadata: { key: "value" },
      });
    });

    it("should ingest text without metadata", async () => {
      mockClaimKitInstance.ingest.mockResolvedValueOnce({
        ingest: { source: { id: "src-456" } },
      });
      await adapter.initialize();

      const result = await adapter.ingest("plain text");
      expect(result).toEqual({ sourceId: "src-456" });
    });
  });

  describe("query", () => {
    const mockAnswerResult = {
      answer: "The answer is 42.",
      citations: [{ claimId: "c1", sourceId: "s1", evidenceText: "evidence" }],
      confidence: 0.95,
      contradictions: [{ claimText1: "a", claimText2: "b", explanation: "conflict" }],
      missingEvidence: ["missing piece"],
      packet: { answerability: { status: "answerable" } },
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

    it("should default answerability to 'answerable' when packet is missing", async () => {
      mockClaimKitInstance.query.mockResolvedValueOnce({
        ...mockAnswerResult,
        packet: undefined,
      });
      await adapter.initialize();

      const result = await adapter.query("question");
      expect(result.answerability).toBe("answerable");
    });
  });

  describe("verifyRelationship", () => {
    it("should return verified true when a graph edge exists", async () => {
      mockQueryNodes
        .mockReturnValueOnce([{ id: "source-1", title: "API Gateway" }])
        .mockReturnValueOnce([{ id: "target-1", title: "Auth Service" }]);
      mockGetEdgesForNode.mockReturnValueOnce([
        {
          id: "edge-1",
          sourceId: "source-1",
          targetId: "target-1",
          type: "depends_on",
          createdAt: new Date(),
        },
      ]);

      const result = await adapter.verifyRelationship("API Gateway", "Auth Service", "depends_on");

      expect(result).toEqual({
        verified: true,
        confidence: 1,
        trustTier: "curated",
        evidence: "Graph edge: API Gateway -[depends_on]-> Auth Service",
        source: "knowledge-graph",
      });
      expect(mockQueryNodes).toHaveBeenNthCalledWith(1, { search: "API Gateway", limit: 5 });
      expect(mockQueryNodes).toHaveBeenNthCalledWith(2, { search: "Auth Service", limit: 5 });
      expect(mockGetEdgesForNode).toHaveBeenCalledWith("source-1", "outgoing");
    });

    it("should return verified false when no graph edge matches", async () => {
      mockQueryNodes
        .mockReturnValueOnce([{ id: "source-1", title: "API Gateway" }])
        .mockReturnValueOnce([{ id: "target-1", title: "Billing Service" }]);
      mockGetEdgesForNode.mockReturnValueOnce([
        {
          id: "edge-1",
          sourceId: "source-1",
          targetId: "other-target",
          type: "depends_on",
          createdAt: new Date(),
        },
      ]);

      const result = await adapter.verifyRelationship("API Gateway", "Billing Service", "depends_on");

      expect(result).toEqual({
        verified: false,
        confidence: 0,
        trustTier: "inferred",
      });
    });
  });
});
