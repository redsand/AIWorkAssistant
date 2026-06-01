import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrent: vi.fn(),
  getModels: vi.fn(),
  setProvider: vi.fn(),
  applyPersistedSelection: vi.fn(),
  isProviderName: vi.fn(),
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
    chat: vi.fn(),
    pruneMessages: vi.fn((messages) => messages),
    estimateTokens: vi.fn(() => 0),
    getMaxContextTokens: vi.fn(() => 64000),
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
  },
}));

vi.mock("../../../src/agent-runs/sanitizer", () => ({
  sanitizeValue: vi.fn((value) => value),
}));

async function buildApp() {
  const app = Fastify({ logger: false });
  const { chatRoutes } = await import("../../../src/routes/chat");
  await chatRoutes(app);
  await app.ready();
  return app;
}

describe("chat provider routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrent.mockReturnValue({
      provider: "openai",
      model: "gpt-current",
      providers: ["opencode", "zai", "ollama", "openai"],
    });
    mocks.getModels.mockResolvedValue({
      provider: "openai",
      models: ["gpt-current", "gpt-next"],
      fetchedAt: "2026-05-30T00:00:00.000Z",
      expiresAt: "2026-05-31T00:00:00.000Z",
      cached: true,
    });
    mocks.setProvider.mockResolvedValue({
      provider: "openai",
      model: "gpt-next",
      models: {
        provider: "openai",
        models: ["gpt-current", "gpt-next"],
        cached: true,
      },
    });
    mocks.isProviderName.mockImplementation((value: string) =>
      ["opencode", "zai", "ollama", "openai"].includes(value),
    );
    mocks.aiIsConfigured.mockReturnValue(true);
    mocks.aiValidateConfig.mockResolvedValue(true);
    mocks.githubConfigured.mockResolvedValue(false);
    mocks.gitlabConfigured.mockResolvedValue(false);
    mocks.jiraConfigured.mockResolvedValue(false);
    mocks.jitbitConfigured.mockResolvedValue(false);
  });

  it("returns the active provider, current model, and cached models", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/chat/providers",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      active: "openai",
      model: "gpt-current",
      providers: ["opencode", "zai", "ollama", "openai"],
      models: {
        provider: "openai",
        models: ["gpt-current", "gpt-next"],
        fetchedAt: "2026-05-30T00:00:00.000Z",
        expiresAt: "2026-05-31T00:00:00.000Z",
        cached: true,
      },
    });
    expect(mocks.getModels).toHaveBeenCalledWith("openai");

    await app.close();
  });

  it("loads models for a selected provider and honors refresh=true", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/chat/providers/ollama/models?refresh=true",
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.isProviderName).toHaveBeenCalledWith("ollama");
    expect(mocks.getModels).toHaveBeenCalledWith("ollama", true);

    await app.close();
  });

  it("rejects unsupported provider model discovery requests", async () => {
    mocks.isProviderName.mockReturnValue(false);
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/chat/providers/bad/models",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Unsupported provider 'bad'" });
    expect(mocks.getModels).not.toHaveBeenCalled();

    await app.close();
  });

  it("switches provider and model at runtime", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/chat/provider",
      payload: { provider: "openai", model: "gpt-next" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      provider: "openai",
      model: "gpt-next",
    });
    expect(mocks.setProvider).toHaveBeenCalledWith("openai", "gpt-next");

    await app.close();
  });

  it("returns provider switch errors when a selected model is unavailable", async () => {
    mocks.setProvider.mockRejectedValue(
      new Error("Model 'gpt-missing' is not available for provider 'openai'"),
    );
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/chat/provider",
      payload: { provider: "openai", model: "gpt-missing" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "Model 'gpt-missing' is not available for provider 'openai'",
    });

    await app.close();
  });

  it("returns provider and model metadata in chat health", async () => {
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/chat/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json().provider).toEqual({
      active: "openai",
      model: "gpt-current",
      configured: true,
      valid: true,
      baseUrl: "https://openai.test/v1",
    });

    await app.close();
  });
});
