/**
 * Tests for multi-system-message merging across all providers.
 *
 * Context: The context engine builds up to 5 system-role messages per request
 * (base prompt, RAG docs, ClaimKit evidence, graph context, health status).
 * APIs like Z.ai (and many Qwen-family endpoints) reject requests with more
 * than one system message with "messages parameter is illegal".
 *
 * The fix lives in AIProvider.buildRequestBody (base class) so every provider
 * gets it automatically. These tests prove:
 *   1. The merge logic is correct in isolation (base class / TestProvider).
 *   2. Each concrete provider's buildRequestBody actually delivers a single
 *      system message to the underlying HTTP client.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AIProvider,
  ChatMessage,
  ProviderConfig,
  ProviderCapabilities,
  ChatRequest,
} from "../../../src/agent/providers/types";

// ── Hoisted mocks (must precede all provider imports) ─────────────────────
const { mockAxiosCreate } = vi.hoisted(() => ({
  mockAxiosCreate: vi.fn(),
}));

vi.mock("axios", () => {
  const actual = vi.importActual("axios");
  return {
    ...actual,
    default: {
      ...(actual as any).default,
      create: mockAxiosCreate,
      isAxiosError: (err: unknown) =>
        err instanceof Error && (err as any).isAxiosError === true,
    },
  };
});

import { ZaiProvider } from "../../../src/agent/providers/zai-provider";
import { OpenCodeProvider } from "../../../src/agent/providers/opencode-provider";
import { OllamaProvider } from "../../../src/agent/providers/ollama-provider";
import { OpenAIProvider } from "../../../src/agent/providers/openai-provider";

// ── TestProvider: exposes protected buildRequestBody for unit testing ──────
class TestProvider extends AIProvider {
  readonly name = "test";
  readonly capabilities: ProviderCapabilities = {
    streaming: false,
    toolChoice: "auto",
    parallelToolCalls: false,
    requiresAuth: false,
    synthesizesToolCallIds: false,
  };

  constructor(maxContextTokens = 64000) {
    super({
      apiKey: "test-key",
      baseUrl: "http://localhost:9999",
      model: "test-model",
      temperature: 0.7,
      topP: 0.95,
      maxRetries: 0,
      timeout: 5000,
      maxContextTokens,
    });
  }

  buildRequest(request: ChatRequest): Record<string, unknown> {
    return this.buildRequestBody(request);
  }

  async chat() {
    return { content: "", model: "test", done: true };
  }
  async *chatStream() {
    yield "";
  }
  isConfigured() {
    return true;
  }
  async validateConfig() {
    return true;
  }
}

// ── Shared provider configs ────────────────────────────────────────────────
const BASE_CONFIG: ProviderConfig = {
  apiKey: "test-key",
  baseUrl: "http://localhost:1234",
  model: "test-model",
  temperature: 0.7,
  topP: 0.95,
  maxRetries: 0,
  timeout: 30000,
};

// ── Mock HTTP client helper ────────────────────────────────────────────────
function makeMockClient(content = "ok") {
  const apiData = {
    choices: [{ message: { content, tool_calls: undefined }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    model: "test-model",
  };
  const postMock = vi.fn().mockResolvedValue({ data: apiData });
  mockAxiosCreate.mockReturnValue({ post: postMock, get: vi.fn() });
  return postMock;
}

// Extracts the messages array sent to the HTTP client
function sentMessages(postMock: ReturnType<typeof vi.fn>): any[] {
  return postMock.mock.calls[0][1].messages;
}

// ── Simulated context-engine message layout ────────────────────────────────
// Mirrors what assembleContextPacket produces before passing to chat():
//   [system: base], [system: docs], [system: claimkit],
//   [system: graph], [system: health], [user: ...], [assistant: ...], [user: ...]
function makeContextEngineMessages(): ChatMessage[] {
  return [
    { role: "system", content: "You are a helpful assistant." },
    { role: "system", content: "=== RELEVANT CONTEXT ===\nDoc content here." },
    { role: "system", content: "=== VERIFIED EVIDENCE (ClaimKit) ===\nClaims here." },
    { role: "system", content: "=== KNOWLEDGE GRAPH ===\nGraph nodes here." },
    { role: "system", content: "CURRENT SYSTEM HEALTH:\n- AI Provider: zai (OK)" },
    { role: "user", content: "What assets are tagged as datacenter?" },
    { role: "assistant", content: "Let me check the asset inventory." },
    { role: "user", content: "Build the Tenable report." },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. BASE CLASS — merging logic tested directly via TestProvider
// ─────────────────────────────────────────────────────────────────────────────

describe("AIProvider.buildRequestBody — system message merging", () => {
  const provider = new TestProvider();

  it("merges multiple system messages into exactly one", () => {
    const messages = makeContextEngineMessages();
    const body = provider.buildRequest({ messages });
    const sent = body.messages as ChatMessage[];

    const systemMessages = sent.filter((m) => m.role === "system");
    expect(systemMessages).toHaveLength(1);
  });

  it("preserves all system content in the merged message", () => {
    const messages = makeContextEngineMessages();
    const body = provider.buildRequest({ messages });
    const sent = body.messages as ChatMessage[];

    const sysContent = sent[0].content as string;
    expect(sysContent).toContain("You are a helpful assistant.");
    expect(sysContent).toContain("=== RELEVANT CONTEXT ===");
    expect(sysContent).toContain("=== VERIFIED EVIDENCE (ClaimKit) ===");
    expect(sysContent).toContain("=== KNOWLEDGE GRAPH ===");
    expect(sysContent).toContain("CURRENT SYSTEM HEALTH:");
  });

  it("places the merged system message first", () => {
    const messages = makeContextEngineMessages();
    const body = provider.buildRequest({ messages });
    const sent = body.messages as ChatMessage[];

    expect(sent[0].role).toBe("system");
  });

  it("preserves conversation history after the merged system message", () => {
    const messages = makeContextEngineMessages();
    const body = provider.buildRequest({ messages });
    const sent = body.messages as ChatMessage[];

    const nonSystem = sent.filter((m) => m.role !== "system");
    expect(nonSystem[0]).toMatchObject({ role: "user", content: "What assets are tagged as datacenter?" });
    expect(nonSystem[1]).toMatchObject({ role: "assistant", content: "Let me check the asset inventory." });
    expect(nonSystem[2]).toMatchObject({ role: "user", content: "Build the Tenable report." });
  });

  it("uses --- as separator between merged sections", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Part A" },
      { role: "system", content: "Part B" },
      { role: "user", content: "hi" },
    ];
    const body = provider.buildRequest({ messages });
    const sent = body.messages as ChatMessage[];

    expect(sent[0].content).toBe("Part A\n\n---\n\nPart B");
  });

  it("does not modify messages when there is exactly one system message", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Single system prompt." },
      { role: "user", content: "hello" },
    ];
    const body = provider.buildRequest({ messages });
    const sent = body.messages as ChatMessage[];

    // original array returned unchanged — no new objects
    expect(sent).toBe(messages);
  });

  it("does not modify messages when there are no system messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const body = provider.buildRequest({ messages });
    const sent = body.messages as ChatMessage[];

    expect(sent).toBe(messages);
  });

  it("drops empty or whitespace-only system messages during merge", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Real content." },
      { role: "system", content: "   " },
      { role: "system", content: "" },
      { role: "user", content: "go" },
    ];
    const body = provider.buildRequest({ messages });
    const sent = body.messages as ChatMessage[];

    const systemMessages = sent.filter((m) => m.role === "system");
    // Only 1 non-empty system message — no merge needed, returned as-is
    expect(systemMessages).toHaveLength(1);
    expect((systemMessages[0].content as string).trim()).toBe("Real content.");
  });

  it("merges exactly two system messages correctly", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Alpha" },
      { role: "system", content: "Beta" },
    ];
    const body = provider.buildRequest({ messages });
    const sent = body.messages as ChatMessage[];

    expect(sent).toHaveLength(1);
    expect(sent[0].role).toBe("system");
    expect(sent[0].content).toBe("Alpha\n\n---\n\nBeta");
  });

  it("total message count is correct after merge (5 system + 3 conv = 4 total)", () => {
    const messages = makeContextEngineMessages(); // 5 system + 3 user/assistant
    const body = provider.buildRequest({ messages });
    const sent = body.messages as ChatMessage[];

    // 1 merged system + 3 conversation = 4
    expect(sent).toHaveLength(4);
  });

  it("strips internal tool message names before provider submission", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "System" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "gitlab_get_file", arguments: "{}" },
        }],
      },
      {
        role: "tool",
        content: "{\"success\":true}",
        name: "gitlab.get_file",
        tool_call_id: "call_1",
      },
      { role: "user", content: "continue" },
    ];
    const body = provider.buildRequest({ messages });
    const sent = body.messages as ChatMessage[];

    expect(sent.find((m) => m.role === "tool")).not.toHaveProperty("name");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. ZaiProvider — proves single system message reaches the HTTP client
// ─────────────────────────────────────────────────────────────────────────────

describe("ZaiProvider — single system message sent to API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends exactly one system message when context engine provides five", async () => {
    const postMock = makeMockClient();
    const provider = new ZaiProvider(BASE_CONFIG);

    await provider.chat({ messages: makeContextEngineMessages() });

    const msgs = sentMessages(postMock);
    expect(msgs.filter((m: any) => m.role === "system")).toHaveLength(1);
  });

  it("merged system content contains all five original sections", async () => {
    const postMock = makeMockClient();
    const provider = new ZaiProvider(BASE_CONFIG);

    await provider.chat({ messages: makeContextEngineMessages() });

    const sysMsg = sentMessages(postMock).find((m: any) => m.role === "system");
    expect(sysMsg.content).toContain("You are a helpful assistant.");
    expect(sysMsg.content).toContain("=== RELEVANT CONTEXT ===");
    expect(sysMsg.content).toContain("=== VERIFIED EVIDENCE (ClaimKit) ===");
    expect(sysMsg.content).toContain("=== KNOWLEDGE GRAPH ===");
    expect(sysMsg.content).toContain("CURRENT SYSTEM HEALTH:");
  });

  it("still works correctly with a single system message (no-op path)", async () => {
    const postMock = makeMockClient();
    const provider = new ZaiProvider(BASE_CONFIG);

    await provider.chat({
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hi" },
      ],
    });

    const msgs = sentMessages(postMock);
    expect(msgs.filter((m: any) => m.role === "system")).toHaveLength(1);
    expect(msgs[0].content).toBe("You are helpful.");
  });

  it("tool names are sanitized AND system messages are merged", async () => {
    const postMock = makeMockClient();
    const provider = new ZaiProvider(BASE_CONFIG);

    await provider.chat({
      messages: makeContextEngineMessages(),
      tools: [
        {
          type: "function",
          function: {
            name: "tenable.list_assets",
            description: "List assets",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });

    const body = postMock.mock.calls[0][1];
    const msgs: any[] = body.messages;
    expect(msgs.filter((m: any) => m.role === "system")).toHaveLength(1);

    // Tool name should be sanitized (dot → underscore)
    const tool = body.tools[0];
    expect(tool.function.name).toBe("tenable_list_assets");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. OpenCodeProvider — same guarantees
// ─────────────────────────────────────────────────────────────────────────────

describe("OpenCodeProvider — single system message sent to API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends exactly one system message when context engine provides five", async () => {
    const postMock = makeMockClient();
    const provider = new OpenCodeProvider(BASE_CONFIG);

    await provider.chat({ messages: makeContextEngineMessages() });

    const msgs = sentMessages(postMock);
    expect(msgs.filter((m: any) => m.role === "system")).toHaveLength(1);
  });

  it("merged system content contains all five original sections", async () => {
    const postMock = makeMockClient();
    const provider = new OpenCodeProvider(BASE_CONFIG);

    await provider.chat({ messages: makeContextEngineMessages() });

    const sysMsg = sentMessages(postMock).find((m: any) => m.role === "system");
    expect(sysMsg.content).toContain("You are a helpful assistant.");
    expect(sysMsg.content).toContain("=== RELEVANT CONTEXT ===");
    expect(sysMsg.content).toContain("=== VERIFIED EVIDENCE (ClaimKit) ===");
    expect(sysMsg.content).toContain("=== KNOWLEDGE GRAPH ===");
    expect(sysMsg.content).toContain("CURRENT SYSTEM HEALTH:");
  });

  it("tool names are sanitized AND system messages are merged", async () => {
    const postMock = makeMockClient();
    const provider = new OpenCodeProvider(BASE_CONFIG);

    await provider.chat({
      messages: makeContextEngineMessages(),
      tools: [
        {
          type: "function",
          function: {
            name: "tenable.list_assets",
            description: "List assets",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });

    const body = postMock.mock.calls[0][1];
    expect(body.messages.filter((m: any) => m.role === "system")).toHaveLength(1);
    expect(body.tools[0].function.name).toBe("tenable_list_assets");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. OllamaProvider — same guarantees
// ─────────────────────────────────────────────────────────────────────────────

describe("OllamaProvider — single system message sent to API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends exactly one system message when context engine provides five", async () => {
    const postMock = makeMockClient();
    const provider = new OllamaProvider(BASE_CONFIG);

    await provider.chat({ messages: makeContextEngineMessages() });

    const msgs = sentMessages(postMock);
    expect(msgs.filter((m: any) => m.role === "system")).toHaveLength(1);
  });

  it("merged system content contains all five original sections", async () => {
    const postMock = makeMockClient();
    const provider = new OllamaProvider(BASE_CONFIG);

    await provider.chat({ messages: makeContextEngineMessages() });

    const sysMsg = sentMessages(postMock).find((m: any) => m.role === "system");
    expect(sysMsg.content).toContain("You are a helpful assistant.");
    expect(sysMsg.content).toContain("=== RELEVANT CONTEXT ===");
    expect(sysMsg.content).toContain("=== VERIFIED EVIDENCE (ClaimKit) ===");
    expect(sysMsg.content).toContain("=== KNOWLEDGE GRAPH ===");
    expect(sysMsg.content).toContain("CURRENT SYSTEM HEALTH:");
  });

  it("tool names are sanitized AND system messages are merged", async () => {
    const postMock = makeMockClient();
    const provider = new OllamaProvider(BASE_CONFIG);

    await provider.chat({
      messages: makeContextEngineMessages(),
      tools: [
        {
          type: "function",
          function: {
            name: "tenable.list_assets",
            description: "List assets",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });

    const body = postMock.mock.calls[0][1];
    expect(body.messages.filter((m: any) => m.role === "system")).toHaveLength(1);
    expect(body.tools[0].function.name).toBe("tenable_list_assets");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. OpenAIProvider — same guarantees + tool-pair repair still works
// ─────────────────────────────────────────────────────────────────────────────

describe("OpenAIProvider — single system message sent to API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends exactly one system message when context engine provides five", async () => {
    const postMock = makeMockClient();
    const provider = new OpenAIProvider(BASE_CONFIG);

    await provider.chat({ messages: makeContextEngineMessages() });

    const msgs = sentMessages(postMock);
    expect(msgs.filter((m: any) => m.role === "system")).toHaveLength(1);
  });

  it("merged system content contains all five original sections", async () => {
    const postMock = makeMockClient();
    const provider = new OpenAIProvider(BASE_CONFIG);

    await provider.chat({ messages: makeContextEngineMessages() });

    const sysMsg = sentMessages(postMock).find((m: any) => m.role === "system");
    expect(sysMsg.content).toContain("You are a helpful assistant.");
    expect(sysMsg.content).toContain("=== RELEVANT CONTEXT ===");
    expect(sysMsg.content).toContain("=== VERIFIED EVIDENCE (ClaimKit) ===");
    expect(sysMsg.content).toContain("=== KNOWLEDGE GRAPH ===");
    expect(sysMsg.content).toContain("CURRENT SYSTEM HEALTH:");
  });

  it("tool-pair repair still works alongside system-message merge", async () => {
    const postMock = makeMockClient();
    const provider = new OpenAIProvider(BASE_CONFIG);

    // Orphaned tool response (no preceding assistant+tool_calls) should be dropped
    const messagesWithOrphan: ChatMessage[] = [
      { role: "system", content: "System A" },
      { role: "system", content: "System B" },
      { role: "user", content: "do thing" },
      // orphaned tool message — no preceding assistant+tool_calls
      { role: "tool", content: "result", tool_call_id: "call_xyz" } as any,
      { role: "user", content: "follow up" },
    ];

    await provider.chat({ messages: messagesWithOrphan });

    const msgs = sentMessages(postMock);
    expect(msgs.filter((m: any) => m.role === "system")).toHaveLength(1);
    // Orphaned tool message should be dropped by repairToolMessagePairs
    expect(msgs.filter((m: any) => m.role === "tool")).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. First non-system message guard
// ─────────────────────────────────────────────────────────────────────────────

describe("AIProvider — first non-system message must be user", () => {
  const provider = new TestProvider();

  it("inserts a placeholder user message when the chain starts with tool", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "System prompt" },
      { role: "tool", content: "result", tool_call_id: "call_1" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "hello" },
    ];

    const pruned = provider.pruneMessages(messages);
    const firstNonSystem = pruned.find((m) => m.role !== "system");
    expect(firstNonSystem?.role).toBe("user");
    expect(firstNonSystem?.content).toBe("[conversation continues]");
  });

  it("inserts a placeholder user message when the chain starts with assistant", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "System prompt" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "hello" },
    ];

    const pruned = provider.pruneMessages(messages);
    const firstNonSystem = pruned.find((m) => m.role !== "system");
    expect(firstNonSystem?.role).toBe("user");
  });

  it("does not modify a chain that already starts with user", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];

    const pruned = provider.pruneMessages(messages);
    expect(pruned).toBe(messages);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Cross-provider consistency — all four produce identical structure
// ─────────────────────────────────────────────────────────────────────────────

describe("cross-provider consistency", () => {
  beforeEach(() => vi.clearAllMocks());

  it("all four providers produce exactly 1 system message from 5 system inputs", async () => {
    const messages = makeContextEngineMessages();

    for (const [name, Provider] of [
      ["zai", ZaiProvider],
      ["opencode", OpenCodeProvider],
      ["ollama", OllamaProvider],
      ["openai", OpenAIProvider],
    ] as const) {
      const postMock = makeMockClient();
      const provider = new (Provider as any)(BASE_CONFIG);
      await provider.chat({ messages });

      const systemCount = sentMessages(postMock).filter(
        (m: any) => m.role === "system",
      ).length;
      expect(systemCount, `${name} should send exactly 1 system message`).toBe(1);
    }
  });

  it("all four providers preserve the full conversation history after the system message", async () => {
    const messages = makeContextEngineMessages();
    // conversation = user, assistant, user at positions 5,6,7

    for (const [name, Provider] of [
      ["zai", ZaiProvider],
      ["opencode", OpenCodeProvider],
      ["ollama", OllamaProvider],
      ["openai", OpenAIProvider],
    ] as const) {
      const postMock = makeMockClient();
      const provider = new (Provider as any)(BASE_CONFIG);
      await provider.chat({ messages });

      const sent = sentMessages(postMock);
      const nonSystem = sent.filter((m: any) => m.role !== "system");

      expect(nonSystem.length, `${name} should keep 3 conversation messages`).toBeGreaterThanOrEqual(3);
      expect(
        nonSystem.some((m: any) => m.role === "user" && m.content === "Build the Tenable report."),
        `${name} should include final user message`,
      ).toBe(true);
    }
  });
});
