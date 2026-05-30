import Fastify, { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentProvider: {
    provider: "openai",
    model: "gpt-4o",
    providers: ["opencode", "zai", "ollama", "openai"],
  },
  getModels: vi.fn(),
  setProvider: vi.fn(),
  aiChat: vi.fn(),
  sessionMessages: [] as Array<{ role: string; content: string }>,
}));

vi.mock("../../src/agent/provider-settings", () => ({
  providerSettings: {
    getCurrent: vi.fn(() => mocks.currentProvider),
    getModels: mocks.getModels,
    setProvider: mocks.setProvider,
    isProviderName: vi.fn((value: string) =>
      ["opencode", "zai", "ollama", "openai"].includes(value),
    ),
  },
}));

vi.mock("../../src/agent", () => ({
  getSystemPrompt: vi.fn(() => "system prompt"),
  aiClient: {
    isConfigured: vi.fn(() => true),
    validateConfig: vi.fn(async () => true),
    chat: mocks.aiChat,
    pruneMessages: vi.fn((messages) => messages),
    estimateTokens: vi.fn(() => 0),
    getMaxContextTokens: vi.fn(() => 64000),
  },
}));

vi.mock("../../src/context-engine", () => ({
  shouldUseContextEngine: vi.fn(() => false),
  assembleContext: vi.fn(),
}));

vi.mock("../../src/agent/tool-registry", () => ({
  getTools: vi.fn(() => []),
  getToolsByCategory: vi.fn(() => []),
  getToolCategories: vi.fn(() => []),
}));

vi.mock("../../src/agent/todo-manager", () => ({ todoManager: {} }));
vi.mock("../../src/agent/knowledge-store", () => ({ knowledgeStore: {} }));
vi.mock("../../src/agent/knowledge-graph", () => ({ knowledgeGraph: {} }));
vi.mock("../../src/agent/codebase-indexer", () => ({ codebaseIndexer: {} }));
vi.mock("../../src/agent/tool-dispatcher", () => ({
  dispatchToolCall: vi.fn(),
}));

vi.mock("../../src/config/constants", () => ({
  AGENT_MODES: { PRODUCTIVITY: "productivity", ENGINEERING: "engineering" },
}));

vi.mock("../../src/config/env", () => ({
  env: {
    ADMIN_USER_IDS: "",
    MAX_TOOL_LOOPS: 3,
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

vi.mock("../../src/integrations/github/github-client", () => ({
  githubClient: {
    isConfigured: vi.fn(async () => false),
    validateConfig: vi.fn(),
  },
}));
vi.mock("../../src/integrations/gitlab/gitlab-client", () => ({
  gitlabClient: {
    isConfigured: vi.fn(async () => false),
    validateConfig: vi.fn(),
  },
}));
vi.mock("../../src/integrations/jira/jira-client", () => ({
  jiraClient: {
    isConfigured: vi.fn(async () => false),
    validateConfig: vi.fn(),
  },
}));
vi.mock("../../src/integrations/jitbit/jitbit-client", () => ({
  jitbitClient: {
    isConfigured: vi.fn(async () => false),
    validateConfig: vi.fn(),
  },
}));

vi.mock("../../src/memory/conversation-manager", () => ({
  conversationManager: {
    getSession: vi.fn(() => null),
    startSession: vi.fn(() => "session-e2e"),
    addMessage: vi.fn(
      (_sessionId: string, message: { role: string; content: string }) => {
        mocks.sessionMessages.push(message);
      },
    ),
    getSessionMessages: vi.fn(async () => mocks.sessionMessages),
  },
}));

vi.mock("../../src/agent-runs/database", () => ({
  agentRunDatabase: {
    startRun: vi.fn(() => ({ id: "run-e2e" })),
    addStep: vi.fn(),
    completeRun: vi.fn(),
    failRun: vi.fn(),
    cancelRun: vi.fn(),
    touchRun: vi.fn(),
  },
}));

vi.mock("../../src/agent-runs/sanitizer", () => ({
  sanitizeValue: vi.fn((value) => value),
}));

async function buildTestServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { chatRoutes } = await import("../../src/routes/chat");
  await chatRoutes(app);
  await app.ready();
  return app;
}

describe("E2E: runtime provider and model switching", () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.sessionMessages = [];
    mocks.currentProvider = {
      provider: "openai",
      model: "gpt-4o",
      providers: ["opencode", "zai", "ollama", "openai"],
    };
    mocks.getModels.mockImplementation(async (provider: string) => ({
      provider,
      models: provider === "ollama" ? ["llama3", "mistral"] : ["gpt-4o"],
      fetchedAt: "2026-05-30T00:00:00.000Z",
      expiresAt: "2026-05-31T00:00:00.000Z",
      cached: true,
    }));
    mocks.setProvider.mockImplementation(
      async (provider: string, model?: string) => {
        const selected = model || (provider === "ollama" ? "llama3" : "gpt-4o");
        mocks.currentProvider = {
          provider,
          model: selected,
          providers: ["opencode", "zai", "ollama", "openai"],
        };
        return {
          provider,
          model: selected,
          models: {
            provider,
            models: provider === "ollama" ? ["llama3", "mistral"] : ["gpt-4o"],
            cached: true,
          },
        };
      },
    );
    mocks.aiChat.mockResolvedValue({
      content: "provider switched",
      model: "llama3",
      done: true,
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    });
    server = await buildTestServer();
  });

  it("discovers models, switches provider/model, reports health, and uses the selected model for chat", async () => {
    const initialProviders = await server.inject({
      method: "GET",
      url: "/chat/providers",
    });
    expect(initialProviders.statusCode).toBe(200);
    expect(initialProviders.json()).toMatchObject({
      active: "openai",
      model: "gpt-4o",
    });

    const ollamaModels = await server.inject({
      method: "GET",
      url: "/chat/providers/ollama/models?refresh=true",
    });
    expect(ollamaModels.statusCode).toBe(200);
    expect(ollamaModels.json().models).toEqual(["llama3", "mistral"]);
    expect(mocks.getModels).toHaveBeenCalledWith("ollama", true);

    const switchResponse = await server.inject({
      method: "POST",
      url: "/chat/provider",
      payload: { provider: "ollama", model: "llama3" },
    });
    expect(switchResponse.statusCode).toBe(200);
    expect(switchResponse.json()).toMatchObject({
      provider: "ollama",
      model: "llama3",
    });

    const health = await server.inject({ method: "GET", url: "/chat/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().provider).toMatchObject({
      active: "ollama",
      model: "llama3",
    });

    const chat = await server.inject({
      method: "POST",
      url: "/chat",
      payload: {
        message: "Use the selected runtime model",
        includeTools: false,
        includeMemory: false,
        model: "llama3",
      },
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.json()).toMatchObject({
      content: "provider switched",
      model: "llama3",
    });
    expect(mocks.aiChat).toHaveBeenCalledWith(
      expect.objectContaining({ model: "llama3", tools: undefined }),
    );
  });
});
