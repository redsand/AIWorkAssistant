import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 15_000 });

const mocks = vi.hoisted(() => ({
  getCurrent: vi.fn(),
  getModels: vi.fn(),
  setProvider: vi.fn(),
  applyPersistedSelection: vi.fn(),
  isProviderName: vi.fn(),
  aiChat: vi.fn(),
  aiRefresh: vi.fn(),
  aiIsConfigured: vi.fn(),
  aiValidateConfig: vi.fn(),
  githubConfigured: vi.fn(),
  githubValid: vi.fn(),
  gitlabConfigured: vi.fn(),
  gitlabValid: vi.fn(),
  jiraConfigured: vi.fn(),
  jiraValid: vi.fn(),
  jitbitConfigured: vi.fn(),
  jitbitValid: vi.fn(),
}));

vi.mock("../../../src/agent/provider-settings", () => ({
  providerSettings: {
    getCurrent: mocks.getCurrent,
    getModels: mocks.getModels,
    setProvider: mocks.setProvider,
    applyPersistedSelection: mocks.applyPersistedSelection,
    isProviderName: mocks.isProviderName,
  },
}));

vi.mock("../../../src/agent", () => ({
  getSystemPrompt: vi.fn(() => "system"),
  aiClient: {
    isConfigured: mocks.aiIsConfigured,
    validateConfig: mocks.aiValidateConfig,
    chat: mocks.aiChat,
    refresh: mocks.aiRefresh,
    pruneMessages: vi.fn((messages) => messages),
    estimateTokens: vi.fn(() => 0),
    getMaxContextTokens: vi.fn(() => 64000),
    getMaxTools: vi.fn(() => 128),
  },
}));

vi.mock("../../../src/context-engine", () => ({
  shouldUseContextEngine: vi.fn(() => false),
  assembleContext: vi.fn(),
}));

vi.mock("../../../src/agent/tool-registry", () => ({
  getTools: vi.fn(() => []),
  getToolsByCategory: vi.fn(() => []),
  getToolCategories: vi.fn(() => []),
}));

vi.mock("../../../src/agent/todo-manager", () => ({
  todoManager: {},
}));

vi.mock("../../../src/agent/knowledge-store", () => ({
  knowledgeStore: {},
}));

vi.mock("../../../src/agent/knowledge-graph", () => ({
  knowledgeGraph: {},
}));

vi.mock("../../../src/agent/codebase-indexer", () => ({
  codebaseIndexer: {},
}));

vi.mock("../../../src/agent/tool-dispatcher", () => ({
  dispatchToolCall: vi.fn(),
}));

vi.mock("../../../src/config/constants", () => ({
  AGENT_MODES: { PRODUCTIVITY: "productivity", ENGINEERING: "engineering" },
}));

vi.mock("../../../src/config/env", () => ({
  env: {
    ADMIN_USER_IDS: "",
    MAX_TOOL_LOOPS: 3,
    AGENT_JOB_TIMEOUT_MS: 300_000,
    AI_PROVIDER: "openai",
    OPENCODE_API_KEY: "opencode-key",
    OPENCODE_API_URL: "https://opencode.test/v1",
    ZAI_API_KEY: "zai-key",
    ZAI_API_URL: "https://zai.test/v4",
    OLLAMA_API_KEY: "",
    OLLAMA_API_URL: "http://ollama.test",
    OPENAI_API_KEY: "openai-key",
    OPENAI_API_URL: "https://openai.test/v1",
  },
}));

vi.mock("../../../src/integrations/github/github-client", () => ({
  githubClient: {
    isConfigured: mocks.githubConfigured,
    validateConfig: mocks.githubValid,
  },
}));

vi.mock("../../../src/integrations/gitlab/gitlab-client", () => ({
  gitlabClient: {
    isConfigured: mocks.gitlabConfigured,
    validateConfig: mocks.gitlabValid,
  },
}));

vi.mock("../../../src/integrations/jira/jira-client", () => ({
  jiraClient: {
    isConfigured: mocks.jiraConfigured,
    validateConfig: mocks.jiraValid,
  },
}));

vi.mock("../../../src/integrations/jitbit/jitbit-client", () => ({
  jitbitClient: {
    isConfigured: mocks.jitbitConfigured,
    validateConfig: mocks.jitbitValid,
  },
}));

vi.mock("../../../src/memory/conversation-manager", () => ({
  conversationManager: {},
}));

vi.mock("../../../src/agent-runs/database", () => ({
  agentRunDatabase: {
    startRun: vi.fn(() => ({ id: "run-1" })),
    addStep: vi.fn(),
    completeRun: vi.fn(),
    failRun: vi.fn(),
    cancelRun: vi.fn(),
    touchRun: vi.fn(),
    updateToolLoopCount: vi.fn(),
  },
}));

vi.mock("../../../src/agent-runs/sanitizer", () => ({
  sanitizeValue: vi.fn((value) => value),
}));

vi.mock("../../../src/memory/tool-cache", () => ({
  toolCallCache: {},
}));

vi.mock("../../../src/agent/providers/zai-rate-limiter", () => ({
  zaiRateLimiter: { stats: { active: 0, queued: 0, cooldownRemainingMs: 0, burstThrottled: false } },
}));

vi.mock("../../../src/agent/provider-preflight", () => ({
  runProviderPreflight: vi.fn(),
}));

vi.mock("../../../src/observability/error-log", () => ({
  errorLog: {},
}));

vi.mock("../../../src/context-engine/adapters/claimkit-adapter", () => ({
  claimKitAdapter: {
    isAvailable: vi.fn(() => true),
    getInitError: vi.fn(() => null),
  },
}));

vi.mock("../../../src/agent/embedding-service", () => ({
  embeddingService: {
    isAvailable: vi.fn(() => Promise.resolve(true)),
  },
}));

vi.mock("../../../src/comparison-runs/database", () => ({
  comparisonRunDatabase: {},
}));

vi.mock("../../../src/memory/entity-memory", () => ({
  entityMemory: {},
}));

vi.mock("../../../src/context-engine/entity-claims-injector", () => ({
  extractEntityIds: vi.fn(() => []),
}));

async function buildApp() {
  const app = Fastify({ logger: false });
  const { chatRoutes, sessionUsageMap } = await import("../../../src/routes/chat");
  // Reset per-session usage so tests are isolated.
  sessionUsageMap.clear();
  await chatRoutes(app);
  await app.ready();
  return app;
}

describe("GET /chat/usage", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getCurrent.mockReturnValue({
      provider: "openai",
      model: "gpt-current",
      providers: ["opencode", "zai", "ollama", "openai"],
    });
    mocks.getModels.mockResolvedValue({
      provider: "openai",
      models: ["gpt-current"],
      fetchedAt: "2026-05-30T00:00:00.000Z",
      expiresAt: "2026-05-31T00:00:00.000Z",
      cached: true,
    });
    mocks.aiIsConfigured.mockReturnValue(true);
    mocks.aiValidateConfig.mockResolvedValue(true);
    mocks.githubConfigured.mockResolvedValue(false);
    mocks.gitlabConfigured.mockResolvedValue(false);
    mocks.jiraConfigured.mockResolvedValue(false);
    mocks.jitbitConfigured.mockResolvedValue(false);
  });

  it("returns 400 when sessionId is missing", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/chat/usage",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "sessionId required" });

    await app.close();
  });

  it("returns zeroed counts for a new session", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/chat/usage?sessionId=new-session",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      messageCount: 0,
    });

    await app.close();
  });

  it("accumulates usage across multiple assistant turns", async () => {
    const app = await buildApp();
    const { sessionUsageMap } = await import("../../../src/routes/chat");

    sessionUsageMap.set("shared-session", {
      promptTokens: 12,
      completionTokens: 5,
      totalTokens: 17,
      messageCount: 1,
    });

    const response1 = await app.inject({
      method: "GET",
      url: "/chat/usage?sessionId=shared-session",
    });
    expect(response1.json()).toEqual({
      promptTokens: 12,
      completionTokens: 5,
      totalTokens: 17,
      messageCount: 1,
    });

    const entry = sessionUsageMap.get("shared-session")!;
    entry.promptTokens += 8;
    entry.completionTokens += 7;
    entry.totalTokens += 15;
    entry.messageCount += 1;

    const response2 = await app.inject({
      method: "GET",
      url: "/chat/usage?sessionId=shared-session",
    });
    expect(response2.json()).toEqual({
      promptTokens: 20,
      completionTokens: 12,
      totalTokens: 32,
      messageCount: 2,
    });

    await app.close();
  });

  it("isolates usage per sessionId", async () => {
    const app = await buildApp();
    const { sessionUsageMap } = await import("../../../src/routes/chat");

    sessionUsageMap.set("session-a", {
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      messageCount: 1,
    });

    const responseA = await app.inject({
      method: "GET",
      url: "/chat/usage?sessionId=session-a",
    });
    const responseB = await app.inject({
      method: "GET",
      url: "/chat/usage?sessionId=session-b",
    });

    expect(responseA.json()).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      messageCount: 1,
    });
    expect(responseB.json()).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      messageCount: 0,
    });

    await app.close();
  });

  it("returns the expected response shape", async () => {
    const app = await buildApp();
    const { sessionUsageMap } = await import("../../../src/routes/chat");

    sessionUsageMap.set("shaped-session", {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      messageCount: 3,
    });

    const response = await app.inject({
      method: "GET",
      url: "/chat/usage?sessionId=shaped-session",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty("promptTokens", 100);
    expect(body).toHaveProperty("completionTokens", 50);
    expect(body).toHaveProperty("totalTokens", 150);
    expect(body).toHaveProperty("messageCount", 3);

    await app.close();
  });

});
