import { describe, it, expect, beforeEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";

const mockClaimKitAdapter = {
  initialize: vi.fn<() => Promise<boolean>>(),
  isAvailable: vi.fn(() => false),
  getInitError: vi.fn(() => null),
  ingest: vi.fn(),
  query: vi.fn(),
};

vi.doMock("../../../src/context-engine/adapters/claimkit-adapter", () => ({
  claimKitAdapter: mockClaimKitAdapter,
}));

vi.doMock("../../../src/agent/knowledge-store", () => ({
  knowledgeStore: {
    search: vi.fn(() => []),
  },
}));

vi.doMock("../../../src/agent/codebase-indexer", () => ({
  codebaseIndexer: {
    search: vi.fn(() => []),
  },
}));

vi.doMock("../../../src/agent/knowledge-graph", () => ({
  knowledgeGraph: {
    queryNodes: vi.fn(() => []),
    exportForContext: vi.fn(() => ""),
    retrieveCommunitySummaries: vi.fn(() => []),
  },
}));

vi.doMock("../../../src/agent/opencode-client", () => ({
  aiClient: {
    isConfigured: vi.fn(() => false),
    validateConfig: vi.fn(() => Promise.resolve(false)),
  },
}));

vi.doMock("../../../src/integrations/github/github-client", () => ({
  githubClient: {
    isConfigured: vi.fn(() => Promise.resolve(false)),
    validateConfig: vi.fn(() => Promise.resolve(false)),
  },
}));

vi.doMock("../../../src/integrations/gitlab/gitlab-client", () => ({
  gitlabClient: {
    isConfigured: vi.fn(() => Promise.resolve(false)),
    validateConfig: vi.fn(() => Promise.resolve(false)),
  },
}));

vi.doMock("../../../src/integrations/jira/jira-client", () => ({
  jiraClient: {
    isConfigured: vi.fn(() => Promise.resolve(false)),
    validateConfig: vi.fn(() => Promise.resolve(false)),
  },
}));

vi.doMock("../../../src/config/env", () => ({
  env: {
    AI_PROVIDER: "test",
    AI_MAX_CONCURRENT: 3,
    CLAIMKIT_ENABLED: true,
    CLAIMKIT_TOP_K: 10,
    CLAIMKIT_MIN_SCORE: 0.0,
    CLAIMKIT_MAX_EVIDENCE_ITEMS: 20,
    CLAIMKIT_QUERY_SEED_LIMIT: 5,
    CLAIMKIT_QUERY_TIMEOUT_MS: 120000,
    CLAIMKIT_INIT_TIMEOUT_MS: 5000,
    CLAIMKIT_AWAIT_SEED: true,
    CLAIMKIT_ROUTE_HIGH_CONFIDENCE: 0.5,
    CLAIMKIT_ROUTE_LOW_CONFIDENCE: 0.3,
    KNOWLEDGE_GRAPH_QUERY_ENABLED: true,
    KNOWLEDGE_GRAPH_DOC_LIMIT: 5,
    KNOWLEDGE_GRAPH_COMMUNITY_LIMIT: 10,
    KNOWLEDGE_GRAPH_CACHE_TTL_MS: 30000,
  },
  resolvePath: (relativePath: string) =>
    path.join(os.tmpdir(), "ai-assist-context-packet-test", relativePath),
}));

vi.doMock("../../../src/agent/prompts", () => ({
  getSystemPrompt: vi.fn(() => "You are a helpful assistant."),
}));

import type { ChatMessage } from "../../../src/agent/providers/types";

const mockQueryResult = {
  answer: "The verified answer from ClaimKit.",
  citations: [
    { claimId: "c1", sourceId: "s1", text: "First piece of evidence" },
    { claimId: "c2", sourceId: "s2", text: "Second piece of evidence" },
  ],
  confidence: 0.85,
  contradictions: [{ claimA: "A is true", claimB: "B is true", reason: "They conflict on X" }],
  missingEvidence: ["evidence for C"],
  answerability: "answerable" as const,
  metadata: {
    sourceIds: ["s1", "s2"],
    claimCount: 4,
    processingTimeMs: 45,
    retrievalScore: 0.92,
  },
};

describe("assembleContextPacket - ClaimKit integration", () => {
  let assembleContextPacket: typeof import("../../../src/context-engine/context-packet").assembleContextPacket;

  const baseParams = {
    mode: "engineering" as const,
    query: "How does authentication work?",
    sessionMessages: [] as ChatMessage[],
    sessionId: "session-1",
    includeMemory: false,
    toolInventory: "[]",
    providerMaxTokens: 8192,
    toolTokens: 1024,
    userId: "user-1",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockClaimKitAdapter.initialize.mockResolvedValue(true);
    mockClaimKitAdapter.query.mockResolvedValue(mockQueryResult);
    mockClaimKitAdapter.isAvailable.mockReturnValue(false);

    vi.resetModules();
    const mod = await import("../../../src/context-engine/context-packet");
    assembleContextPacket = mod.assembleContextPacket;
  });

  it("should call claimKitAdapter.initialize() during assembly when not yet available", async () => {
    mockClaimKitAdapter.isAvailable.mockReturnValue(false);
    await assembleContextPacket(baseParams);
    expect(mockClaimKitAdapter.initialize).toHaveBeenCalledOnce();
  });

  it("should skip claimKitAdapter.initialize() when isAvailable() returns true (fast path)", async () => {
    mockClaimKitAdapter.isAvailable.mockReturnValue(true);
    await assembleContextPacket(baseParams);
    expect(mockClaimKitAdapter.initialize).not.toHaveBeenCalled();
  });

  it("should still call query() when taking the isAvailable fast path", async () => {
    mockClaimKitAdapter.isAvailable.mockReturnValue(true);
    await assembleContextPacket(baseParams);
    expect(mockClaimKitAdapter.query).toHaveBeenCalledWith(
      baseParams.query,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("should call claimKitAdapter.query() when ClaimKit is available", async () => {
    mockClaimKitAdapter.initialize.mockResolvedValue(true);

    await assembleContextPacket(baseParams);

    expect(mockClaimKitAdapter.query).toHaveBeenCalledWith(
      baseParams.query,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("should include claimkit_evidence section in the packet sections", async () => {
    mockClaimKitAdapter.initialize.mockResolvedValue(true);

    const packet = await assembleContextPacket(baseParams);

    const claimKitSection = packet.sections.find((s) => s.name === "claimkit_evidence");
    expect(claimKitSection).toBeDefined();
    // With confidence 0.85 and answerable, this routes to ck_primary
    expect(claimKitSection!.content).toContain("PRIMARY ANSWER (ClaimKit — high confidence)");
    expect(claimKitSection!.content).toContain("Answerability: answerable");
  });

  it("should include claimkit_evidence message in the messages array", async () => {
    mockClaimKitAdapter.initialize.mockResolvedValue(true);

    const packet = await assembleContextPacket(baseParams);

    const claimKitMessage = packet.messages.find(
      (m) => m.role === "system" && m.content?.includes("PRIMARY ANSWER (ClaimKit"),
    );
    expect(claimKitMessage).toBeDefined();
  });

  it("should include confidence and answerability in claimkit section", async () => {
    mockClaimKitAdapter.initialize.mockResolvedValue(true);

    const packet = await assembleContextPacket(baseParams);

    const claimKitSection = packet.sections.find((s) => s.name === "claimkit_evidence");
    expect(claimKitSection!.content).toContain("Confidence: 85.0%");
    expect(claimKitSection!.content).toContain("Claims found: 4");
  });

  it("should include citations in claimkit section content", async () => {
    mockClaimKitAdapter.initialize.mockResolvedValue(true);

    const packet = await assembleContextPacket(baseParams);

    const claimKitSection = packet.sections.find((s) => s.name === "claimkit_evidence");
    expect(claimKitSection!.content).toContain("Citations");
    expect(claimKitSection!.content).toContain("[c1] First piece of evidence");
  });

  it("should include ClaimKit metadata in claimkit section", async () => {
    mockClaimKitAdapter.initialize.mockResolvedValue(true);

    const packet = await assembleContextPacket(baseParams);

    const claimKitSection = packet.sections.find((s) => s.name === "claimkit_evidence");
    expect(claimKitSection).toBeDefined();
    const typedSection = claimKitSection as unknown as {
      answerability: string;
      contradictions: Array<unknown>;
      claimCount: number;
      confidence: number;
    };
    expect(typedSection.answerability).toBe("answerable");
    expect(typedSection.contradictions).toEqual(mockQueryResult.contradictions);
    expect(typedSection.claimCount).toBe(4);
    expect(typedSection.confidence).toBe(0.85);
  });

  it("should expose ClaimKit usage diagnostics", async () => {
    mockClaimKitAdapter.initialize.mockResolvedValue(true);

    const packet = await assembleContextPacket(baseParams);

    expect(packet.diagnostics.claimkit).toMatchObject({
      enabled: true,
      available: true,
      used: true,
      timedOut: false,
      includedInMessages: true,
      preferredSource: "claimkit",
      routingReason: "high_confidence",
      confidence: 0.85,
      answerability: "answerable",
      claimCount: 4,
      sourceCount: 2,
      retrievalScore: 0.92,
    });
  });

  it("should not call claimKitAdapter.query() when ClaimKit is unavailable", async () => {
    mockClaimKitAdapter.initialize.mockResolvedValue(false);

    await assembleContextPacket(baseParams);

    expect(mockClaimKitAdapter.query).not.toHaveBeenCalled();
  });

  it("should expose ClaimKit unavailable diagnostics", async () => {
    mockClaimKitAdapter.initialize.mockResolvedValue(false);

    const packet = await assembleContextPacket(baseParams);

    expect(packet.diagnostics.claimkit).toMatchObject({
      enabled: true,
      available: false,
      used: false,
      timedOut: false,
      includedInMessages: false,
      preferredSource: "rag",
      routingReason: "ck_disabled",
      confidence: null,
      answerability: null,
      claimCount: null,
      sourceCount: null,
      retrievalScore: null,
    });
  });

  it("should not include claimkit section when ClaimKit is unavailable", async () => {
    mockClaimKitAdapter.initialize.mockResolvedValue(false);

    const packet = await assembleContextPacket(baseParams);

    const claimKitSection = packet.sections.find((s) => s.name === "claimkit_evidence");
    expect(claimKitSection).toBeUndefined();

    const claimKitMessage = packet.messages.find(
      (m) => m.content?.includes("VERIFIED EVIDENCE (ClaimKit)"),
    );
    expect(claimKitMessage).toBeUndefined();
  });

  it("should gracefully handle claimKitAdapter.query() throwing an error", async () => {
    mockClaimKitAdapter.initialize.mockResolvedValue(true);
    mockClaimKitAdapter.query.mockRejectedValue(new Error("Query failed"));

    const packet = await assembleContextPacket(baseParams);

    expect(mockClaimKitAdapter.query).toHaveBeenCalled();
    const claimKitSection = packet.sections.find((s) => s.name === "claimkit_evidence");
    expect(claimKitSection).toBeUndefined();
  });

  it("should format partially_answerable result correctly", async () => {
    mockClaimKitAdapter.initialize.mockResolvedValue(true);
    mockClaimKitAdapter.query.mockResolvedValue({
      ...mockQueryResult,
      answerability: "partially_answerable",
      confidence: 0.45,
      metadata: { ...mockQueryResult.metadata, claimCount: 2 },
    });

    const packet = await assembleContextPacket(baseParams);

    const claimKitSection = packet.sections.find((s) => s.name === "claimkit_evidence");
    expect(claimKitSection!.content).toContain("Answerability: partially_answerable");
    expect(claimKitSection!.content).toContain("Confidence: 45.0%");
    expect(claimKitSection!.content).toContain("Claims found: 2");
  });

  it("should handle empty citations gracefully", async () => {
    mockClaimKitAdapter.initialize.mockResolvedValue(true);
    mockClaimKitAdapter.query.mockResolvedValue({
      ...mockQueryResult,
      citations: [],
    });

    const packet = await assembleContextPacket(baseParams);

    const claimKitSection = packet.sections.find((s) => s.name === "claimkit_evidence");
    expect(claimKitSection!.content).not.toContain("Citations");
  });
});
