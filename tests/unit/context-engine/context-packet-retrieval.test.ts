import { beforeEach, describe, expect, it, vi } from "vitest";

const mockClaimKitAdapter = {
  initialize: vi.fn<() => Promise<boolean>>(),
  isAvailable: vi.fn(),
  getInitError: vi.fn(),
  query: vi.fn(),
  // The probe path now uses queryLite (no generate / no verify). Delegate
  // to query so existing test assertions on mockClaimKitAdapter.query keep
  // exercising the same call-site logic.
  queryLite: vi.fn((...args: unknown[]) => mockClaimKitAdapter.query(...(args as Parameters<typeof mockClaimKitAdapter.query>))),
};
const mockKnowledgeSearch = vi.fn();
const mockCodebaseSearch = vi.fn();
const mockGraphQueryNodes = vi.fn();
const mockGraphExportForContext = vi.fn();
const mockGraphRetrieveCommunitySummaries = vi.fn();
const mockAiIsConfigured = vi.fn();
const mockAiValidateConfig = vi.fn();
const mockGithubIsConfigured = vi.fn();
const mockGithubValidateConfig = vi.fn();
const mockGitlabIsConfigured = vi.fn();
const mockGitlabValidateConfig = vi.fn();
const mockJiraIsConfigured = vi.fn();
const mockJiraValidateConfig = vi.fn();
const mockMemorySnapshot = vi.fn();
const mockUserSnapshot = vi.fn();
const mockSoulLoad = vi.fn();
const mockActivePersonality = vi.fn();
const mockSkillSummaries = vi.fn();
const mockRecentReflections = vi.fn();
const mockSearchSessions = vi.fn();
const mockBuildEntityClaimsSection = vi.fn();
const mockSaveLiveComparison = vi.fn();
const mockCascadeRun = vi.fn();
const mockClaimsStoreRetrieve = vi.fn();
const mockClaimsStoreStore = vi.fn();
const mockFormatClaimsSection = vi.fn<(claims: unknown[]) => string | null>();

const mockEnv = {
  AI_PROVIDER: "test",
  AI_MAX_CONCURRENT: 3,
  RAG_INCLUDE_LOCAL_SOURCES: true,
  CLAIMKIT_ENABLED: false,
  CLAIMKIT_QUERY_SEED_LIMIT: 5,
  CLAIMKIT_QUERY_TIMEOUT_MS: 120000,
  CLAIMKIT_INIT_TIMEOUT_MS: 5000,
  CLAIMKIT_AWAIT_SEED: false,
  CLAIMKIT_SEED_TIMEOUT_MS: 500,
  CLAIMKIT_GAP_FILL_THRESHOLD: 0.3,
  CLAIMKIT_GAP_FILL_MAX_QUERIES: 2,
  CLAIMKIT_LIVE_GROUNDING_RATE: 0,
  CLAIMKIT_FIRST_ROUTING: false,
  CLAIMKIT_HIGH_CONFIDENCE_THRESHOLD: 0.8,
  CLAIMKIT_LOW_CONFIDENCE_THRESHOLD: 0.5,
  CLAIMKIT_FIRST_PROBE_TIMEOUT_MS: 500,
  CASCADE_ENABLED: false,
  CASCADE_BUDGET_TOKENS: 5000,
  CASCADE_STOP_CONFIDENCE: 0.8,
  CASCADE_TEACHER_MODEL: "",
  CASCADE_TEACHER_COST_TOKENS: 1000,
  CASCADE_TOOL_COST_TOKENS: 2000,
  KNOWLEDGE_GRAPH_QUERY_ENABLED: true,
  KNOWLEDGE_GRAPH_DOC_LIMIT: 5,
  KNOWLEDGE_GRAPH_COMMUNITY_LIMIT: 10,
  KNOWLEDGE_GRAPH_CACHE_TTL_MS: 30000,
  QUERY_REWRITER_ENABLED: true,
  QUERY_REWRITE_VARIANT_COUNT: 3,
  SESSION_UTILITY_ENABLED: false,
  SESSION_UTILITY_CANDIDATE_POOL: 10,
  SESSION_UTILITY_TOP_K: 3,
  SESSION_UTILITY_EPSILON: 0.2,
  SESSION_UTILITY_SEMANTIC_EMBED: false,
  SESSION_UTILITY_PRIOR_ALPHA: 2,
  SESSION_UTILITY_PRIOR_BETA: 1,
};

function installMocks() {
  vi.doMock("../../../src/context-engine/adapters/claimkit-adapter", () => ({
    claimKitAdapter: mockClaimKitAdapter,
  }));
  vi.doMock("../../../src/context-engine/claimkit-ingestion", () => ({
    ingestScoredDocumentsForQuery: vi.fn().mockResolvedValue({
      total: 0,
      ingested: 0,
      skipped: 0,
      errors: 0,
      sourceIds: [],
      durationMs: 0,
    }),
  }));
  vi.doMock("../../../src/agent/knowledge-store", () => ({
    knowledgeStore: { search: mockKnowledgeSearch },
  }));
  vi.doMock("../../../src/agent/codebase-indexer", () => ({
    codebaseIndexer: { search: mockCodebaseSearch },
  }));
  vi.doMock("../../../src/agent/knowledge-graph", () => ({
    knowledgeGraph: {
      queryNodes: mockGraphQueryNodes,
      exportForContext: mockGraphExportForContext,
      retrieveCommunitySummaries: mockGraphRetrieveCommunitySummaries,
    },
  }));
  vi.doMock("../../../src/agent/opencode-client", () => ({
    aiClient: {
      isConfigured: mockAiIsConfigured,
      validateConfig: mockAiValidateConfig,
    },
  }));
  vi.doMock("../../../src/integrations/github/github-client", () => ({
    githubClient: {
      isConfigured: mockGithubIsConfigured,
      validateConfig: mockGithubValidateConfig,
    },
  }));
  vi.doMock("../../../src/integrations/gitlab/gitlab-client", () => ({
    gitlabClient: {
      isConfigured: mockGitlabIsConfigured,
      validateConfig: mockGitlabValidateConfig,
    },
  }));
  vi.doMock("../../../src/integrations/jira/jira-client", () => ({
    jiraClient: {
      isConfigured: mockJiraIsConfigured,
      validateConfig: mockJiraValidateConfig,
    },
  }));
  vi.doMock("../../../src/config/env", () => ({ env: mockEnv }));
  vi.doMock("../../../src/agent/prompts", () => ({
    getSystemPrompt: vi.fn(() => "System prompt"),
  }));
  vi.doMock("../../../src/agent/provider-settings", () => ({
    providerSettings: { getCurrent: vi.fn(() => ({ provider: "test-provider" })) },
  }));
  vi.doMock("../../../src/memory/agent-memory", () => ({
    agentMemory: {
      getMemorySnapshot: mockMemorySnapshot,
      getUserSnapshot: mockUserSnapshot,
    },
  }));
  vi.doMock("../../../src/memory/soul-manager", () => ({
    soulManager: {
      load: mockSoulLoad,
      getActivePersonality: mockActivePersonality,
    },
  }));
  vi.doMock("../../../src/skills/skill-manager", () => ({
    skillManager: { getSummariesText: mockSkillSummaries },
  }));
  vi.doMock("../../../src/agent/reflection-engine", () => ({
    reflectionEngine: { getRecentReflections: mockRecentReflections },
  }));
  vi.doMock("../../../src/memory/conversation-manager", () => ({
    conversationManager: { searchSessions: mockSearchSessions },
  }));
  vi.doMock("../../../src/context-engine/entity-claims-injector", () => ({
    buildEntityClaimsSection: mockBuildEntityClaimsSection,
  }));
  vi.doMock("../../../src/comparison-runs/auto-capture", () => ({
    saveLiveComparison: mockSaveLiveComparison,
  }));
  vi.doMock("../../../src/context-engine/retrieval-cascade", () => ({
    createDefaultCascade: () => ({ run: mockCascadeRun }),
  }));
  vi.doMock("../../../src/memory/claims-store", () => ({
    claimsStore: {
      retrieveClaims: mockClaimsStoreRetrieve,
      storeClaim: mockClaimsStoreStore,
    },
    formatClaimsSection: mockFormatClaimsSection,
  }));
}

async function loadContextPacket() {
  vi.resetModules();
  installMocks();
  return import("../../../src/context-engine/context-packet");
}

function knowledgeHit(id: string, source: string, title: string, content: string) {
  return {
    entry: {
      id,
      source,
      title,
      content,
      tags: ["tag"],
      createdAt: new Date("2026-01-01"),
    },
    score: 0.8,
    matchType: "content",
  };
}

describe("assembleContextPacket retrieval and context sections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.RAG_INCLUDE_LOCAL_SOURCES = true;
    mockEnv.CLAIMKIT_ENABLED = false;
    mockEnv.CLAIMKIT_FIRST_ROUTING = false;
    mockEnv.CLAIMKIT_AWAIT_SEED = false;
    mockEnv.CLAIMKIT_HIGH_CONFIDENCE_THRESHOLD = 0.8;
    mockEnv.CLAIMKIT_LOW_CONFIDENCE_THRESHOLD = 0.5;
    mockEnv.CLAIMKIT_FIRST_PROBE_TIMEOUT_MS = 500;
    mockEnv.CASCADE_ENABLED = false;
    mockEnv.CASCADE_BUDGET_TOKENS = 5000;
    mockEnv.CASCADE_STOP_CONFIDENCE = 0.8;
    mockCascadeRun.mockReset();
    mockEnv.QUERY_REWRITER_ENABLED = true;
    mockEnv.QUERY_REWRITE_VARIANT_COUNT = 3;
    mockClaimKitAdapter.isAvailable.mockReturnValue(false);
    mockClaimKitAdapter.initialize.mockResolvedValue(false);
    mockClaimKitAdapter.getInitError.mockReturnValue(null);
    mockKnowledgeSearch.mockReturnValue([]);
    mockCodebaseSearch.mockReturnValue([]);
    mockGraphQueryNodes.mockReturnValue([]);
    mockGraphExportForContext.mockReturnValue("");
    mockGraphRetrieveCommunitySummaries.mockReturnValue([]);
    mockAiIsConfigured.mockReturnValue(false);
    mockAiValidateConfig.mockResolvedValue(false);
    mockGithubIsConfigured.mockResolvedValue(false);
    mockGithubValidateConfig.mockResolvedValue(false);
    mockGitlabIsConfigured.mockResolvedValue(false);
    mockGitlabValidateConfig.mockResolvedValue(false);
    mockJiraIsConfigured.mockResolvedValue(false);
    mockJiraValidateConfig.mockResolvedValue(false);
    mockMemorySnapshot.mockReturnValue("");
    mockUserSnapshot.mockReturnValue("");
    mockSoulLoad.mockReturnValue("");
    mockActivePersonality.mockReturnValue("");
    mockSkillSummaries.mockReturnValue("");
    mockRecentReflections.mockReturnValue("");
    mockSearchSessions.mockReturnValue([]);
    mockBuildEntityClaimsSection.mockReturnValue({
      content: "",
      entityCount: 0,
      claimCount: 0,
      contradictionCount: 0,
      contradictions: [],
      entitiesWithHistory: 0,
    });
    mockSaveLiveComparison.mockReturnValue(null);
    mockClaimsStoreRetrieve.mockReset();
    mockClaimsStoreRetrieve.mockReturnValue([]);
    mockClaimsStoreStore.mockReset();
    mockClaimsStoreStore.mockReturnValue(null);
    mockFormatClaimsSection.mockReset();
    // Default: render a simple untrusted-framed section from whatever claims
    // were retrieved so injection tests exercise the real message path.
    mockFormatClaimsSection.mockImplementation((claims: unknown[]) =>
      claims.length === 0
        ? null
        : "=== PRIOR KNOWLEDGE (untrusted reference) ===\n" +
          claims
            .map((c) => `- ${(c as { resolution: string }).resolution}`)
            .join("\n"),
    );
  });

  it("assembles retrieved knowledge, code, graph, memory, sessions, and health context", async () => {
    mockKnowledgeSearch.mockReturnValue([
      knowledgeHit("k1", "manual", "Runbook", "Auth Service runbook content"),
      knowledgeHit("k2", "file_read", "Local File", "Local source content"),
    ]);
    mockCodebaseSearch.mockReturnValue([
      {
        filePath: "src/auth.ts",
        startLine: 10,
        endLine: 20,
        content: "export function authenticate() {}",
        language: "typescript",
        score: 0.7,
        matchType: "symbol",
      },
    ]);
    mockGraphQueryNodes.mockReturnValue([
      {
        id: "node-1",
        type: "component",
        title: "Auth Service",
        content: "Handles authentication",
        status: "accepted",
        tags: ["auth"],
      },
    ]);
    mockGraphExportForContext.mockReturnValue("Auth Service -> API Gateway");
    mockGraphRetrieveCommunitySummaries.mockReturnValue(["Authentication services cluster"]);
    mockAiIsConfigured.mockReturnValue(true);
    mockAiValidateConfig.mockResolvedValue(true);
    mockGithubIsConfigured.mockResolvedValue(true);
    mockGithubValidateConfig.mockResolvedValue(false);
    mockGitlabIsConfigured.mockResolvedValue(false);
    mockJiraIsConfigured.mockResolvedValue(true);
    mockJiraValidateConfig.mockResolvedValue(true);
    mockMemorySnapshot.mockReturnValue("Agent memory");
    mockUserSnapshot.mockReturnValue("User profile");
    mockSoulLoad.mockReturnValue("Soul instructions");
    mockActivePersonality.mockReturnValue("architect");
    mockSkillSummaries.mockReturnValue("Skill summary");
    mockRecentReflections.mockReturnValue("Recent reflection");
    mockSearchSessions.mockReturnValue([
      {
        title: "Prior auth discussion",
        keyTopics: ["auth", "gateway"],
        summary: "We discussed API gateway authentication.",
      },
    ]);

    const { assembleContextPacket } = await loadContextPacket();
    const packet = await assembleContextPacket({
      mode: "engineering",
      query: "auth service",
      sessionMessages: [],
      providerMaxTokens: 8192,
      toolTokens: 1024,
    });

    const docs = packet.sections.find((section) => section.name === "documents")!;
    expect(docs.content).toContain("--- Knowledge from previous sessions ---");
    expect(docs.content).toContain("[Runbook] Auth Service runbook content");
    expect(docs.content).toContain("--- Relevant code ---");
    expect(docs.content).toContain("[src/auth.ts:10] export function authenticate() {}");
    expect(docs.content).toContain("--- Knowledge graph ---");
    expect(docs.content).toContain("[Auth Service] (component) Handles authentication");
    expect(packet.messages.some((message) => message.content?.includes("=== IDENTITY [personality: architect] ==="))).toBe(true);
    expect(packet.messages.some((message) => message.content?.includes("=== AGENT MEMORY ==="))).toBe(true);
    expect(packet.messages.some((message) => message.content?.includes("=== USER PROFILE ==="))).toBe(true);
    expect(packet.messages.some((message) => message.content?.includes("=== RECENT REFLECTIONS ==="))).toBe(true);
    expect(packet.messages.some((message) => message.content?.includes("=== PAST SESSIONS ==="))).toBe(true);
    expect(mockAiIsConfigured).toHaveBeenCalled();
    expect(mockGithubIsConfigured).toHaveBeenCalled();
    expect(mockJiraValidateConfig).toHaveBeenCalled();
    expect(packet.diagnostics.documentsRetrieved).toBe(4);
  });

  it("filters file_read knowledge and skips codebase search when local sources are disabled", async () => {
    mockEnv.RAG_INCLUDE_LOCAL_SOURCES = false;
    mockKnowledgeSearch.mockReturnValue([
      knowledgeHit("k-local", "file_read", "Local File", "Should not appear"),
      knowledgeHit("k-manual", "manual", "Manual Note", "Should appear"),
    ]);
    mockCodebaseSearch.mockReturnValue([
      {
        filePath: "src/hidden.ts",
        startLine: 1,
        endLine: 2,
        content: "hidden",
        language: "typescript",
        score: 1,
        matchType: "content",
      },
    ]);

    const { assembleContextPacket } = await loadContextPacket();
    const packet = await assembleContextPacket({
      mode: "engineering",
      query: "local source policy",
      sessionMessages: [],
      providerMaxTokens: 8192,
      toolTokens: 1024,
    });

    const docs = packet.sections.find((section) => section.name === "documents")!;
    expect(docs.content).toContain("Should appear");
    expect(docs.content).not.toContain("Should not appear");
    expect(docs.content).not.toContain("hidden");
    expect(mockCodebaseSearch).not.toHaveBeenCalled();
    expect(packet.diagnostics.documentsRetrieved).toBe(1);
  });

  function ckResult(
    confidence: number,
    answerability: string,
    claimCount = 3,
  ) {
    return {
      answer: "ClaimKit structured answer.",
      citations: [{ claimId: "c1", sourceId: "s1", text: "evidence text" }],
      confidence,
      contradictions: [],
      missingEvidence: [],
      answerability,
      metadata: {
        sourceIds: ["s1", "s2"],
        claimCount,
        processingTimeMs: 12,
        retrievalScore: 0.9,
      },
    };
  }

  it("skips RAG retrieval when the ClaimKit-first probe is high-confidence", async () => {
    mockEnv.CLAIMKIT_ENABLED = true;
    mockEnv.CLAIMKIT_FIRST_ROUTING = true;
    mockClaimKitAdapter.isAvailable.mockReturnValue(true);
    mockClaimKitAdapter.initialize.mockResolvedValue(true);
    mockClaimKitAdapter.query.mockResolvedValue(ckResult(0.95, "answerable"));
    mockKnowledgeSearch.mockReturnValue([
      knowledgeHit("k1", "manual", "Runbook", "Should not be retrieved"),
    ]);

    const { assembleContextPacket } = await loadContextPacket();
    const packet = await assembleContextPacket({
      mode: "engineering",
      query: "what is the deploy process",
      sessionMessages: [],
      providerMaxTokens: 8192,
      toolTokens: 1024,
    });

    expect(packet.diagnostics.claimkitFirstMetrics.strategy).toBe("claimkit_first_skip_rag");
    expect(packet.diagnostics.claimkitFirstMetrics.ragSkipped).toBe(true);
    expect(packet.diagnostics.documentsRetrieved).toBe(0);
    // RAG stores must never be touched on the skip path.
    expect(mockKnowledgeSearch).not.toHaveBeenCalled();
    expect(mockCodebaseSearch).not.toHaveBeenCalled();
    // The probe answer is reused — ClaimKit is queried exactly once.
    expect(mockClaimKitAdapter.query).toHaveBeenCalledTimes(1);
  });

  it("runs RAG retrieval when the ClaimKit-first probe is medium-confidence (parallel path)", async () => {
    mockEnv.CLAIMKIT_ENABLED = true;
    mockEnv.CLAIMKIT_FIRST_ROUTING = true;
    mockClaimKitAdapter.isAvailable.mockReturnValue(true);
    mockClaimKitAdapter.initialize.mockResolvedValue(true);
    mockClaimKitAdapter.query.mockResolvedValue(ckResult(0.6, "partially-answerable"));
    mockKnowledgeSearch.mockReturnValue([
      knowledgeHit("k1", "manual", "Runbook", "Auth runbook content"),
    ]);

    const { assembleContextPacket } = await loadContextPacket();
    const packet = await assembleContextPacket({
      mode: "engineering",
      query: "auth runbook",
      sessionMessages: [],
      providerMaxTokens: 8192,
      toolTokens: 1024,
    });

    expect(packet.diagnostics.claimkitFirstMetrics.strategy).toBe("claimkit_first_parallel");
    expect(packet.diagnostics.claimkitFirstMetrics.ragSkipped).toBe(false);
    expect(packet.diagnostics.documentsRetrieved).toBeGreaterThan(0);
    expect(mockKnowledgeSearch).toHaveBeenCalled();
  });

  it("falls back to full RAG when the ClaimKit-first probe is low-confidence", async () => {
    mockEnv.CLAIMKIT_ENABLED = true;
    mockEnv.CLAIMKIT_FIRST_ROUTING = true;
    mockEnv.CLAIMKIT_AWAIT_SEED = false;
    mockClaimKitAdapter.isAvailable.mockReturnValue(true);
    mockClaimKitAdapter.initialize.mockResolvedValue(true);
    // Low confidence + answerable → claimkit_first_fallback: RAG must run and
    // the probe result is reused (no redundant second query when seed is not
    // awaited).
    mockClaimKitAdapter.query.mockResolvedValue(ckResult(0.3, "answerable"));
    mockKnowledgeSearch.mockReturnValue([
      knowledgeHit("k1", "manual", "Runbook", "Auth runbook content"),
    ]);

    const { assembleContextPacket } = await loadContextPacket();
    const packet = await assembleContextPacket({
      mode: "engineering",
      query: "auth runbook",
      sessionMessages: [],
      providerMaxTokens: 8192,
      toolTokens: 1024,
    });

    expect(packet.diagnostics.claimkitFirstMetrics.strategy).toBe("claimkit_first_fallback");
    expect(packet.diagnostics.claimkitFirstMetrics.ragSkipped).toBe(false);
    expect(packet.diagnostics.claimkitFirstMetrics.latencyDeltaMs).toBeGreaterThanOrEqual(0);
    expect(packet.diagnostics.documentsRetrieved).toBeGreaterThan(0);
    expect(mockKnowledgeSearch).toHaveBeenCalled();
    // Probe reused: ClaimKit queried exactly once even though RAG also ran.
    expect(mockClaimKitAdapter.query).toHaveBeenCalledTimes(1);
  });

  it("re-queries ClaimKit after seeding when CLAIMKIT_AWAIT_SEED is enabled", async () => {
    mockEnv.CLAIMKIT_ENABLED = true;
    mockEnv.CLAIMKIT_FIRST_ROUTING = true;
    mockEnv.CLAIMKIT_AWAIT_SEED = true;
    mockClaimKitAdapter.isAvailable.mockReturnValue(true);
    mockClaimKitAdapter.initialize.mockResolvedValue(true);
    mockClaimKitAdapter.query.mockResolvedValue(ckResult(0.6, "answerable"));
    mockKnowledgeSearch.mockReturnValue([
      knowledgeHit("k1", "manual", "Runbook", "Auth runbook content"),
    ]);

    const { assembleContextPacket } = await loadContextPacket();
    const packet = await assembleContextPacket({
      mode: "engineering",
      query: "auth runbook",
      sessionMessages: [],
      providerMaxTokens: 8192,
      toolTokens: 1024,
    });

    expect(packet.diagnostics.claimkitFirstMetrics.strategy).toBe("claimkit_first_parallel");
    // Awaited seeding can change the claim store between probe and query, so a
    // fresh full query runs on top of the probe (probe + full = 2 calls).
    expect(mockClaimKitAdapter.query).toHaveBeenCalledTimes(2);

    mockEnv.CLAIMKIT_AWAIT_SEED = false;
  });

  it("falls back to rag_first when the ClaimKit-first probe throws", async () => {
    mockEnv.CLAIMKIT_ENABLED = true;
    mockEnv.CLAIMKIT_FIRST_ROUTING = true;
    mockClaimKitAdapter.isAvailable.mockReturnValue(true);
    mockClaimKitAdapter.initialize.mockResolvedValue(true);
    mockClaimKitAdapter.query.mockRejectedValue(new Error("probe boom"));
    mockKnowledgeSearch.mockReturnValue([
      knowledgeHit("k1", "manual", "Runbook", "Auth runbook content"),
    ]);

    const { assembleContextPacket } = await loadContextPacket();
    const packet = await assembleContextPacket({
      mode: "engineering",
      query: "auth runbook",
      sessionMessages: [],
      providerMaxTokens: 8192,
      toolTokens: 1024,
    });

    expect(packet.diagnostics.claimkitFirstMetrics.strategy).toBe("rag_first");
    expect(packet.diagnostics.claimkitFirstMetrics.ragSkipped).toBe(false);
    expect(packet.diagnostics.documentsRetrieved).toBeGreaterThan(0);
    expect(mockKnowledgeSearch).toHaveBeenCalled();
  });

  // ── query rewriting reaches retrieval adapters (issue #230) ──────────────

  it("passes the rewritten (filler-stripped, abbreviation-expanded) query to retrieval adapters", async () => {
    mockKnowledgeSearch.mockReturnValue([
      knowledgeHit("k1", "manual", "Runbook", "ClaimKit contradiction handling"),
    ]);

    const { assembleContextPacket } = await loadContextPacket();
    await assembleContextPacket({
      mode: "engineering",
      query: "Can you tell me how CK handles errors",
      sessionMessages: [],
      providerMaxTokens: 8192,
      toolTokens: 1024,
    });

    // The adapter must see the dense rewrite ("ClaimKit handles errors"), not
    // the raw conversational query.
    expect(mockKnowledgeSearch).toHaveBeenCalledWith("ClaimKit handles errors", { limit: 10 });
    expect(mockKnowledgeSearch).not.toHaveBeenCalledWith(
      "Can you tell me how CK handles errors",
      expect.anything(),
    );
  });

  it("passes the raw query through to retrieval adapters when QUERY_REWRITER_ENABLED is false", async () => {
    mockEnv.QUERY_REWRITER_ENABLED = false;
    mockKnowledgeSearch.mockReturnValue([
      knowledgeHit("k1", "manual", "Runbook", "content"),
    ]);

    const { assembleContextPacket } = await loadContextPacket();
    await assembleContextPacket({
      mode: "engineering",
      query: "Can you tell me how CK handles errors",
      sessionMessages: [],
      providerMaxTokens: 8192,
      toolTokens: 1024,
    });

    // Identity rewrite: the adapter receives the query exactly as typed, and no
    // variant fan-out occurs (a single primary retrieval).
    expect(mockKnowledgeSearch).toHaveBeenCalledWith(
      "Can you tell me how CK handles errors",
      { limit: 10 },
    );
    expect(mockKnowledgeSearch).not.toHaveBeenCalledWith("ClaimKit handles errors", expect.anything());
    expect(mockKnowledgeSearch).toHaveBeenCalledTimes(1);
  });

  it("fans variant retrievals out up to QUERY_REWRITE_VARIANT_COUNT (not a hard-coded cap)", async () => {
    // "how should ..." stays question-shaped after filler removal, so the
    // rewriter yields three distinct variants. With the cap at 3 the engine must
    // retrieve all three variants plus the primary (4 searches). A hard-coded
    // slice(0, 2) would only fire 3.
    mockEnv.QUERY_REWRITE_VARIANT_COUNT = 3;
    mockKnowledgeSearch.mockReturnValue([
      knowledgeHit("k1", "manual", "Runbook", "content"),
    ]);

    const { assembleContextPacket } = await loadContextPacket();
    await assembleContextPacket({
      mode: "engineering",
      query: "how should the auth login error be handled",
      sessionMessages: [],
      providerMaxTokens: 8192,
      toolTokens: 1024,
    });

    expect(mockKnowledgeSearch).toHaveBeenCalledTimes(4);
  });

  it("respects a lower QUERY_REWRITE_VARIANT_COUNT for variant fan-out", async () => {
    mockEnv.QUERY_REWRITE_VARIANT_COUNT = 1;
    mockKnowledgeSearch.mockReturnValue([
      knowledgeHit("k1", "manual", "Runbook", "content"),
    ]);

    const { assembleContextPacket } = await loadContextPacket();
    await assembleContextPacket({
      mode: "engineering",
      query: "how should the auth login error be handled",
      sessionMessages: [],
      providerMaxTokens: 8192,
      toolTokens: 1024,
    });

    // Primary + exactly one variant.
    expect(mockKnowledgeSearch).toHaveBeenCalledTimes(2);
  });

  // ── cost-aware retrieval cascade (issue #245) ────────────────────────────

  it("does not run the cascade when CASCADE_ENABLED is false", async () => {
    mockEnv.CLAIMKIT_ENABLED = true;
    mockEnv.CLAIMKIT_FIRST_ROUTING = true;
    mockEnv.CASCADE_ENABLED = false;
    mockClaimKitAdapter.isAvailable.mockReturnValue(true);
    mockClaimKitAdapter.initialize.mockResolvedValue(true);
    mockClaimKitAdapter.query.mockResolvedValue(ckResult(0.6, "partially-answerable"));
    mockKnowledgeSearch.mockReturnValue([
      knowledgeHit("k1", "manual", "Runbook", "Auth runbook content"),
    ]);

    const { assembleContextPacket } = await loadContextPacket();
    const packet = await assembleContextPacket({
      mode: "engineering",
      query: "auth runbook",
      sessionMessages: [],
      providerMaxTokens: 8192,
      toolTokens: 1024,
    });

    expect(mockCascadeRun).not.toHaveBeenCalled();
    expect(packet.diagnostics.cascade).toBeNull();
    // Existing medium-confidence behavior is preserved: RAG still runs.
    expect(mockKnowledgeSearch).toHaveBeenCalled();
    expect(packet.diagnostics.documentsRetrieved).toBeGreaterThan(0);
  });

  it("skips full RAG when the cascade resolves a medium-confidence probe via the teacher", async () => {
    mockEnv.CLAIMKIT_ENABLED = true;
    mockEnv.CLAIMKIT_FIRST_ROUTING = true;
    mockEnv.CASCADE_ENABLED = true;
    mockClaimKitAdapter.isAvailable.mockReturnValue(true);
    mockClaimKitAdapter.initialize.mockResolvedValue(true);
    mockClaimKitAdapter.query.mockResolvedValue(ckResult(0.6, "partially-answerable"));
    mockCascadeRun.mockResolvedValue({
      level: "teacher_verify",
      tokensUsed: 950,
      confidence: 0.9,
      outcome: "teacher_confirmed",
    });
    mockKnowledgeSearch.mockReturnValue([
      knowledgeHit("k1", "manual", "Runbook", "Should not be retrieved"),
    ]);

    const { assembleContextPacket } = await loadContextPacket();
    const packet = await assembleContextPacket({
      mode: "engineering",
      query: "auth runbook",
      sessionMessages: [],
      providerMaxTokens: 8192,
      toolTokens: 1024,
    });

    expect(mockCascadeRun).toHaveBeenCalledTimes(1);
    expect(mockCascadeRun).toHaveBeenCalledWith(
      expect.objectContaining({ claimKitAnswer: "ClaimKit structured answer.", confidence: 0.6 }),
    );
    expect(packet.diagnostics.cascade).toEqual({
      level: "teacher_verify",
      tokensUsed: 950,
      confidence: 0.9,
      outcome: "teacher_confirmed",
    });
    expect(packet.diagnostics.claimkitFirstMetrics.ragSkipped).toBe(true);
    expect(packet.diagnostics.documentsRetrieved).toBe(0);
    // The cheap resolution means RAG stores are never touched.
    expect(mockKnowledgeSearch).not.toHaveBeenCalled();
    expect(mockCodebaseSearch).not.toHaveBeenCalled();
  });

  it("falls through to full RAG when the cascade cannot resolve the query cheaply", async () => {
    mockEnv.CLAIMKIT_ENABLED = true;
    mockEnv.CLAIMKIT_FIRST_ROUTING = true;
    mockEnv.CASCADE_ENABLED = true;
    mockClaimKitAdapter.isAvailable.mockReturnValue(true);
    mockClaimKitAdapter.initialize.mockResolvedValue(true);
    mockClaimKitAdapter.query.mockResolvedValue(ckResult(0.6, "partially-answerable"));
    mockCascadeRun.mockResolvedValue({
      level: "full_rag",
      tokensUsed: 2400,
      confidence: 0.3,
      outcome: "fell_back_to_rag",
    });
    mockKnowledgeSearch.mockReturnValue([
      knowledgeHit("k1", "manual", "Runbook", "Auth runbook content"),
    ]);

    const { assembleContextPacket } = await loadContextPacket();
    const packet = await assembleContextPacket({
      mode: "engineering",
      query: "auth runbook",
      sessionMessages: [],
      providerMaxTokens: 8192,
      toolTokens: 1024,
    });

    expect(mockCascadeRun).toHaveBeenCalledTimes(1);
    expect(packet.diagnostics.cascade?.outcome).toBe("fell_back_to_rag");
    expect(packet.diagnostics.claimkitFirstMetrics.ragSkipped).toBe(false);
    expect(mockKnowledgeSearch).toHaveBeenCalled();
    expect(packet.diagnostics.documentsRetrieved).toBeGreaterThan(0);
  });

  it("does not run the cascade for a high-confidence probe (skip-RAG handled at Level 0)", async () => {
    mockEnv.CLAIMKIT_ENABLED = true;
    mockEnv.CLAIMKIT_FIRST_ROUTING = true;
    mockEnv.CASCADE_ENABLED = true;
    mockClaimKitAdapter.isAvailable.mockReturnValue(true);
    mockClaimKitAdapter.initialize.mockResolvedValue(true);
    mockClaimKitAdapter.query.mockResolvedValue(ckResult(0.95, "answerable"));

    const { assembleContextPacket } = await loadContextPacket();
    const packet = await assembleContextPacket({
      mode: "engineering",
      query: "what is the deploy process",
      sessionMessages: [],
      providerMaxTokens: 8192,
      toolTokens: 1024,
    });

    expect(mockCascadeRun).not.toHaveBeenCalled();
    expect(packet.diagnostics.cascade).toBeNull();
    expect(packet.diagnostics.claimkitFirstMetrics.strategy).toBe("claimkit_first_skip_rag");
    expect(packet.diagnostics.documentsRetrieved).toBe(0);
  });

  it("treats a thrown cascade as a fall-through to full RAG", async () => {
    mockEnv.CLAIMKIT_ENABLED = true;
    mockEnv.CLAIMKIT_FIRST_ROUTING = true;
    mockEnv.CASCADE_ENABLED = true;
    mockClaimKitAdapter.isAvailable.mockReturnValue(true);
    mockClaimKitAdapter.initialize.mockResolvedValue(true);
    mockClaimKitAdapter.query.mockResolvedValue(ckResult(0.6, "partially-answerable"));
    mockCascadeRun.mockRejectedValue(new Error("cascade boom"));
    mockKnowledgeSearch.mockReturnValue([
      knowledgeHit("k1", "manual", "Runbook", "Auth runbook content"),
    ]);

    const { assembleContextPacket } = await loadContextPacket();
    const packet = await assembleContextPacket({
      mode: "engineering",
      query: "auth runbook",
      sessionMessages: [],
      providerMaxTokens: 8192,
      toolTokens: 1024,
    });

    expect(mockCascadeRun).toHaveBeenCalledTimes(1);
    expect(packet.diagnostics.cascade).toBeNull();
    expect(packet.diagnostics.claimkitFirstMetrics.ragSkipped).toBe(false);
    expect(mockKnowledgeSearch).toHaveBeenCalled();
    expect(packet.diagnostics.documentsRetrieved).toBeGreaterThan(0);
  });

  // Critical rework (PR #251 findings): the durable claim must store the
  // cascade's VERIFIED resolution text, not the low-confidence ClaimKit probe
  // answer that triggered escalation. The probe answer was, by definition, weak
  // enough to require the cascade; persisting it would recycle a bad answer.
  it("persists a teacher_confirmed claim using the cascade resolution text, not the probe answer", async () => {
    mockEnv.CLAIMKIT_ENABLED = true;
    mockEnv.CLAIMKIT_FIRST_ROUTING = true;
    mockEnv.CASCADE_ENABLED = true;
    mockClaimKitAdapter.isAvailable.mockReturnValue(true);
    mockClaimKitAdapter.initialize.mockResolvedValue(true);
    // The probe answer is "ClaimKit structured answer." — it must NOT be what
    // gets stored. The teacher endorsed this candidate at high confidence.
    mockClaimKitAdapter.query.mockResolvedValue(ckResult(0.6, "partially-answerable"));
    mockCascadeRun.mockResolvedValue({
      level: "teacher_verify",
      tokensUsed: 950,
      confidence: 0.9,
      outcome: "teacher_confirmed",
      resolution: "ClaimKit structured answer.",
    });
    mockClaimsStoreStore.mockReturnValue("teacher-claim-1");

    const { assembleContextPacket } = await loadContextPacket();
    const packet = await assembleContextPacket({
      mode: "engineering",
      query: "auth runbook",
      sessionMessages: [],
      providerMaxTokens: 8192,
      toolTokens: 1024,
    });

    expect(mockClaimsStoreStore).toHaveBeenCalledTimes(1);
    const stored = mockClaimsStoreStore.mock.calls[0][0];
    expect(stored.resolution).toBe("ClaimKit structured answer.");
    expect(stored.cascadeLevel).toBe("teacher_verify");
    expect(stored.confidence).toBe(0.9);
    expect(stored.source).toBe("teacher:default");
    expect(packet.diagnostics.claimsAcquisition?.storedClaimId).toBe("teacher-claim-1");
    expect(packet.diagnostics.claimsAcquisition?.skippedClaimReason).toBeNull();
  });

  it("persists a tool_confirmed claim using the web evidence as the resolution", async () => {
    mockEnv.CLAIMKIT_ENABLED = true;
    mockEnv.CLAIMKIT_FIRST_ROUTING = true;
    mockEnv.CASCADE_ENABLED = true;
    mockClaimKitAdapter.isAvailable.mockReturnValue(true);
    mockClaimKitAdapter.initialize.mockResolvedValue(true);
    mockClaimKitAdapter.query.mockResolvedValue(ckResult(0.4, "answerable"));
    mockCascadeRun.mockResolvedValue({
      level: "tool_research",
      tokensUsed: 1800,
      confidence: 0.88,
      outcome: "tool_confirmed",
      resolution: "Web evidence: the deploy pipeline runs deploy.sh nightly.",
    });
    mockClaimsStoreStore.mockReturnValue("tool-claim-1");

    const { assembleContextPacket } = await loadContextPacket();
    const packet = await assembleContextPacket({
      mode: "engineering",
      query: "deploy process",
      sessionMessages: [],
      providerMaxTokens: 8192,
      toolTokens: 1024,
    });

    expect(mockClaimsStoreStore).toHaveBeenCalledTimes(1);
    const stored = mockClaimsStoreStore.mock.calls[0][0];
    expect(stored.resolution).toBe(
      "Web evidence: the deploy pipeline runs deploy.sh nightly.",
    );
    expect(stored.cascadeLevel).toBe("tool_research");
    expect(stored.source).toBe("web_search");
    expect(packet.diagnostics.claimsAcquisition?.storedClaimId).toBe("tool-claim-1");
  });

  // fell_back_to_rag carries no verified resolution (full RAG owns the answer),
  // so nothing is persisted — no claim attempt at all, skippedClaimReason null.
  it("does not persist a claim for a fell_back_to_rag outcome", async () => {
    mockEnv.CLAIMKIT_ENABLED = true;
    mockEnv.CLAIMKIT_FIRST_ROUTING = true;
    mockEnv.CASCADE_ENABLED = true;
    mockClaimKitAdapter.isAvailable.mockReturnValue(true);
    mockClaimKitAdapter.initialize.mockResolvedValue(true);
    mockClaimKitAdapter.query.mockResolvedValue(ckResult(0.6, "partially-answerable"));
    mockCascadeRun.mockResolvedValue({
      level: "full_rag",
      tokensUsed: 2400,
      confidence: 0.3,
      outcome: "fell_back_to_rag",
      resolution: "",
    });
    mockKnowledgeSearch.mockReturnValue([
      knowledgeHit("k1", "manual", "Runbook", "Auth runbook content"),
    ]);

    const { assembleContextPacket } = await loadContextPacket();
    const packet = await assembleContextPacket({
      mode: "engineering",
      query: "auth runbook",
      sessionMessages: [],
      providerMaxTokens: 8192,
      toolTokens: 1024,
    });

    expect(mockClaimsStoreStore).not.toHaveBeenCalled();
    expect(packet.diagnostics.claimsAcquisition?.storedClaimId).toBeNull();
    expect(packet.diagnostics.claimsAcquisition?.skippedClaimReason).toBeNull();
  });

  it("skips persisting a teacher/tool outcome when the resolution text is empty", async () => {
    mockEnv.CLAIMKIT_ENABLED = true;
    mockEnv.CLAIMKIT_FIRST_ROUTING = true;
    mockEnv.CASCADE_ENABLED = true;
    mockClaimKitAdapter.isAvailable.mockReturnValue(true);
    mockClaimKitAdapter.initialize.mockResolvedValue(true);
    mockClaimKitAdapter.query.mockResolvedValue(ckResult(0.6, "partially-answerable"));
    mockCascadeRun.mockResolvedValue({
      level: "tool_research",
      tokensUsed: 1800,
      confidence: 0.85,
      outcome: "tool_confirmed",
      resolution: "   ",
    });
    mockKnowledgeSearch.mockReturnValue([
      knowledgeHit("k1", "manual", "Runbook", "Auth runbook content"),
    ]);

    const { assembleContextPacket } = await loadContextPacket();
    const packet = await assembleContextPacket({
      mode: "engineering",
      query: "auth runbook",
      sessionMessages: [],
      providerMaxTokens: 8192,
      toolTokens: 1024,
    });

    expect(mockClaimsStoreStore).not.toHaveBeenCalled();
    expect(packet.diagnostics.claimsAcquisition?.skippedClaimReason).toBe(
      "empty_resolution",
    );
  });

  it("skips persisting a teacher/tool outcome when confidence collapses below the floor", async () => {
    mockEnv.CLAIMKIT_ENABLED = true;
    mockEnv.CLAIMKIT_FIRST_ROUTING = true;
    mockEnv.CASCADE_ENABLED = true;
    mockClaimKitAdapter.isAvailable.mockReturnValue(true);
    mockClaimKitAdapter.initialize.mockResolvedValue(true);
    mockClaimKitAdapter.query.mockResolvedValue(ckResult(0.6, "partially-answerable"));
    mockCascadeRun.mockResolvedValue({
      level: "teacher_verify",
      tokensUsed: 950,
      confidence: 0.01,
      outcome: "teacher_confirmed",
      resolution: "some text that would otherwise be stored",
    });
    mockKnowledgeSearch.mockReturnValue([
      knowledgeHit("k1", "manual", "Runbook", "Auth runbook content"),
    ]);

    const { assembleContextPacket } = await loadContextPacket();
    const packet = await assembleContextPacket({
      mode: "engineering",
      query: "auth runbook",
      sessionMessages: [],
      providerMaxTokens: 8192,
      toolTokens: 1024,
    });

    expect(mockClaimsStoreStore).not.toHaveBeenCalled();
    expect(packet.diagnostics.claimsAcquisition?.skippedClaimReason).toBe(
      "below_min_confidence",
    );
  });

  // Integration: a retrieved prior claim is injected as a "PRIOR KNOWLEDGE"
  // system message before the ClaimKit probe, and its id is traced so a
  // downstream outcome can update its Beta utility.
  it("injects retrieved prior claims as a system message and traces their ids", async () => {
    mockEnv.CLAIMKIT_ENABLED = false;
    mockEnv.CLAIMKIT_FIRST_ROUTING = false;
    mockClaimsStoreRetrieve.mockReturnValue([
      {
        id: "prior-1",
        query: "auth runbook",
        resolution: "Set AUTH_MODE=oidc in the gateway config.",
        cascadeLevel: "teacher_verify",
        confidence: 0.9,
        source: "teacher:glm-5.2",
        alpha: 3,
        beta: 1,
        createdAt: new Date(),
        lastRetrievedAt: new Date(),
        sampledUtility: 0.8,
        similarity: 0.85,
        combinedScore: 0.68,
        explored: false,
      },
    ]);

    const { assembleContextPacket } = await loadContextPacket();
    const packet = await assembleContextPacket({
      mode: "engineering",
      query: "auth runbook",
      sessionMessages: [],
      providerMaxTokens: 8192,
      toolTokens: 1024,
    });

    const injected = packet.messages.some(
      (m) => m.role === "system" && m.content?.includes("PRIOR KNOWLEDGE"),
    );
    expect(injected).toBe(true);
    expect(packet.diagnostics.claimsAcquisition?.retrievedClaimIds).toContain("prior-1");
    expect(packet.diagnostics.claimsAcquisition?.injectedInMessages).toBe(true);
  });

  // Finding #4 rework: claimsRetrieveMs must reflect the real retrieveClaims
  // wall-clock cost. Before the fix it was initialized to 0 and never
  // overwritten, so dashboards reported 0ms even when the FTS5 + Thompson
  // sampling path ran.
  it("records a positive claimsRetrieveMs when prior claims are retrieved", async () => {
    mockEnv.CLAIMKIT_ENABLED = false;
    mockEnv.CLAIMKIT_FIRST_ROUTING = false;
    mockClaimsStoreRetrieve.mockImplementationOnce(() => {
      // Simulate a non-trivial DB read so the wall-clock delta is real.
      const start = Date.now();
      while (Date.now() - start < 2) {
        /* spin briefly to guarantee a measurable ms delta */
      }
      return [
        {
          id: "claim-1",
          query: "auth runbook",
          resolution: "Auth Service runbook content",
          cascadeLevel: "teacher_verify",
          confidence: 0.85,
          source: "teacher:glm-5.2",
          alpha: 2,
          beta: 1,
          createdAt: new Date(),
          lastRetrievedAt: new Date(),
          sampledUtility: 0.7,
          similarity: 0.8,
          combinedScore: 0.56,
          explored: false,
        },
      ];
    });

    const { assembleContextPacket } = await loadContextPacket();
    const packet = await assembleContextPacket({
      mode: "engineering",
      query: "auth runbook",
      sessionMessages: [],
      providerMaxTokens: 8192,
      toolTokens: 1024,
    });

    expect(packet.diagnostics.stageTimings.claimsRetrieveMs).toBeGreaterThan(0);
    expect(packet.diagnostics.claimsAcquisition?.retrievedCount).toBe(1);
  });
});
