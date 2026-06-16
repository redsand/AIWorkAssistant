import { beforeEach, describe, expect, it, vi } from "vitest";

const mockClaimKitAdapter = {
  initialize: vi.fn<() => Promise<boolean>>(),
  isAvailable: vi.fn(),
  getInitError: vi.fn(),
  query: vi.fn(),
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
  KNOWLEDGE_GRAPH_QUERY_ENABLED: true,
  KNOWLEDGE_GRAPH_DOC_LIMIT: 5,
  KNOWLEDGE_GRAPH_COMMUNITY_LIMIT: 10,
  KNOWLEDGE_GRAPH_CACHE_TTL_MS: 30000,
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
});
