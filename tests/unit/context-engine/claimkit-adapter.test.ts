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
const mockGetNode = vi.fn();

const mockKnowledgeGraph = {
  queryNodes: mockQueryNodes,
  getEdgesForNode: mockGetEdgesForNode,
  getNode: mockGetNode,
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
    ground: (input: {
      text: string;
      evidence: Array<{ title: string; content: string }>;
      preExtractedClaims?: Array<{ text?: string; claimText?: string; subject?: string; predicate?: string; object?: string }>;
      skipLLMVerification?: boolean;
    }) => Promise<{
      grounded: boolean;
      hallucinationRate: number;
      supportedAssertionCount: number;
      unsupportedAssertionCount: number;
      unsupportedPhrases: string[];
      sentenceResults: Array<{ text: string; supported: boolean }>;
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

    it("should add graph evidence for a direct relationship query", async () => {
      mockClaimKitInstance.query.mockResolvedValueOnce({
        ...mockAnswerResult,
        citations: [],
        confidence: 0.4,
        metadata: {
          ...mockAnswerResult.metadata,
          sourceIds: ["s1"],
          claimCount: 2,
        },
        confidenceTrace: { source: "claimkit" },
      });
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
      await adapter.initialize();

      const result = await adapter.query("Does the API Gateway depend on the Auth Service?");

      expect(result.citations).toEqual([
        {
          claimId: "knowledge-graph:1",
          sourceId: "knowledge-graph",
          text: "Graph edge: API Gateway -[depends_on]-> Auth Service",
        },
      ]);
      expect(result.confidence).toBe(1);
      expect(result.metadata.sourceIds).toEqual(["s1", "knowledge-graph"]);
      expect(result.metadata.claimCount).toBe(3);
      expect(result.confidenceTrace).toEqual({ source: "claimkit" });
      expect(mockQueryNodes).toHaveBeenNthCalledWith(1, { search: "API Gateway", limit: 5 });
      expect(mockQueryNodes).toHaveBeenNthCalledWith(2, { search: "Auth Service", limit: 5 });
    });

    it("should add graph evidence for inbound relationship queries", async () => {
      mockClaimKitInstance.query.mockResolvedValueOnce({
        ...mockAnswerResult,
        citations: [],
        confidence: 0.2,
        metadata: {
          ...mockAnswerResult.metadata,
          sourceIds: [],
          claimCount: 0,
        },
      });
      mockQueryNodes.mockReturnValueOnce([{ id: "target-1", title: "Auth Service" }]);
      mockGetEdgesForNode.mockReturnValueOnce([
        {
          id: "edge-1",
          sourceId: "source-1",
          targetId: "target-1",
          type: "depends_on",
          createdAt: new Date(),
        },
        {
          id: "edge-2",
          sourceId: "source-2",
          targetId: "target-1",
          type: "blocks",
          createdAt: new Date(),
        },
      ]);
      mockGetNode.mockReturnValueOnce({ id: "source-1", title: "API Gateway" });
      await adapter.initialize();

      const result = await adapter.query("What depends on Auth Service?");

      expect(result.citations).toEqual([
        {
          claimId: "knowledge-graph:1",
          sourceId: "knowledge-graph",
          text: "Graph edge: API Gateway -[depends_on]-> Auth Service",
        },
      ]);
      expect(result.confidence).toBe(1);
      expect(result.metadata.sourceIds).toEqual(["knowledge-graph"]);
      expect(result.metadata.claimCount).toBe(1);
      expect(mockGetEdgesForNode).toHaveBeenCalledWith("target-1", "incoming");
    });

    it("should ignore inbound relationship edges whose source node is missing", async () => {
      mockClaimKitInstance.query.mockResolvedValueOnce({
        ...mockAnswerResult,
        citations: [],
        confidence: 0.6,
        metadata: {
          ...mockAnswerResult.metadata,
          sourceIds: ["s1"],
          claimCount: 4,
        },
      });
      mockQueryNodes.mockReturnValueOnce([{ id: "target-1", title: "Auth Service" }]);
      mockGetEdgesForNode.mockReturnValueOnce([
        {
          id: "edge-1",
          sourceId: "missing-source",
          targetId: "target-1",
          type: "depends_on",
          createdAt: new Date(),
        },
      ]);
      mockGetNode.mockReturnValueOnce(null);
      await adapter.initialize();

      const result = await adapter.query("What depends on Auth Service?");

      expect(result.citations).toEqual([]);
      expect(result.confidence).toBe(0.6);
      expect(result.metadata.sourceIds).toEqual(["s1"]);
      expect(result.metadata.claimCount).toBe(4);
    });

    it("should leave ClaimKit results unchanged for ambiguous relationship questions", async () => {
      mockClaimKitInstance.query.mockResolvedValueOnce({
        ...mockAnswerResult,
        citations: [],
      });
      await adapter.initialize();

      const result = await adapter.query("Can what depends on Auth Service?");

      expect(result.citations).toEqual([]);
      expect(result.confidence).toBe(0.95);
      expect(result.metadata.sourceIds).toEqual(["s1"]);
      expect(mockQueryNodes).not.toHaveBeenCalled();
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

    it("should verify any edge type when no edgeType filter is provided", async () => {
      mockQueryNodes
        .mockReturnValueOnce([{ id: "source-1", title: "API Gateway" }])
        .mockReturnValueOnce([{ id: "target-1", title: "Auth Service" }]);
      mockGetEdgesForNode.mockReturnValueOnce([
        {
          id: "edge-1",
          sourceId: "source-1",
          targetId: "target-1",
          type: "blocks",
          createdAt: new Date(),
        },
      ]);

      const result = await adapter.verifyRelationship("API Gateway", "Auth Service");

      expect(result.verified).toBe(true);
      expect(result.evidence).toBe("Graph edge: API Gateway -[blocks]-> Auth Service");
    });
  });

  describe("ground", () => {
    it("should throw if not initialized", async () => {
      await expect(adapter.ground({ text: "Some claim.", evidence: [] })).rejects.toThrow("ClaimKit not initialized");
    });

    it("should treat empty text as grounded with no assertions", async () => {
      await adapter.initialize();

      const result = await adapter.ground({ text: " \n ", evidence: [] });

      expect(result).toEqual({
        grounded: true,
        hallucinationRate: 0,
        supportedAssertionCount: 0,
        unsupportedAssertionCount: 0,
        unsupportedPhrases: [],
        sentenceResults: [],
      });
    });

    it("should support assertions from evidence and pre-extracted claims", async () => {
      await adapter.initialize();

      const result = await adapter.ground({
        text: "API Gateway depends on Auth Service. Billing Service blocks Deployments. Go.",
        evidence: [
          {
            title: "Architecture",
            content: "The API Gateway depends on the Auth Service. Go.",
          },
        ],
        preExtractedClaims: [
          { claimText: "Billing Service blocks Deployments" },
          { subject: "Unused", predicate: "relates_to", object: "Unused Target" },
        ],
      });

      expect(result.grounded).toBe(true);
      expect(result.hallucinationRate).toBe(0);
      expect(result.supportedAssertionCount).toBe(3);
      expect(result.unsupportedAssertionCount).toBe(0);
      expect(result.sentenceResults).toEqual([
        { text: "API Gateway depends on Auth Service.", supported: true },
        { text: "Billing Service blocks Deployments.", supported: true },
        { text: "Go.", supported: true },
      ]);
    });

    it("should report unsupported assertions and hallucination rate", async () => {
      await adapter.initialize();

      const result = await adapter.ground({
        text: "API Gateway depends on Auth Service. Billing Service owns Deployments.",
        evidence: [
          {
            title: "Architecture",
            content: "API Gateway depends on Auth Service.",
          },
        ],
      });

      expect(result.grounded).toBe(false);
      expect(result.hallucinationRate).toBe(0.5);
      expect(result.supportedAssertionCount).toBe(1);
      expect(result.unsupportedAssertionCount).toBe(1);
      expect(result.unsupportedPhrases).toEqual(["Billing Service owns Deployments."]);
    });
  });
});
