/**
 * Tests for provider context overflow handling, token estimation,
 * pruning with tool budgets, and per-model context limits.
 */

import { describe, it, expect } from "vitest";
import {
  AIProvider,
  ChatMessage,
  Tool,
  ProviderConfig,
  ProviderCapabilities,
} from "../../../src/agent/providers/types";

// Concrete subclass for testing the abstract AIProvider methods
class TestProvider extends AIProvider {
  readonly name = "test";
  readonly capabilities: ProviderCapabilities = {
    streaming: false,
    toolChoice: "auto",
    parallelToolCalls: false,
    requiresAuth: false,
    synthesizesToolCallIds: false,
  };

  constructor(config: Partial<ProviderConfig> & { model: string }) {
    super({
      apiKey: "test",
      baseUrl: "http://localhost:9999",
      model: config.model,
      temperature: 0.7,
      topP: 0.95,
      maxRetries: 1,
      timeout: 5000,
      maxContextTokens: config.maxContextTokens,
    });
  }

  async chat() {
    return { content: "test", model: "test", done: true };
  }
  async *chatStream() {
    yield "test";
  }
  isConfigured() {
    return true;
  }
  async validateConfig() {
    return true;
  }
}

// ─── isContextOverflowError ─────────────────────────────────────────────────

describe("isContextOverflowError", () => {
  const provider = new TestProvider({ model: "test-model" });

  it("detects 'prompt is too long' in error body", () => {
    const body = JSON.stringify({
      error: "The prompt is too long: 221782, model maximum context length: 202752",
    });
    expect(provider.isContextOverflowError(body)).toBe(true);
  });

  it("detects 'context length' in error body", () => {
    expect(
      provider.isContextOverflowError(
        '{"error":"context length exceeded"}',
      ),
    ).toBe(true);
  });

  it("detects 'maximum context' in error body", () => {
    expect(
      provider.isContextOverflowError('{"error":"maximum context limit reached"}'),
    ).toBe(true);
  });

  it("detects 'context window' in error body", () => {
    expect(
      provider.isContextOverflowError('{"error":"exceeded context window"}'),
    ).toBe(true);
  });

  it("detects 'token limit' in error body", () => {
    expect(
      provider.isContextOverflowError('{"error":"token limit exceeded"}'),
    ).toBe(true);
  });

  it("detects 'too many tokens' in error body", () => {
    expect(
      provider.isContextOverflowError('{"error":"too many tokens in prompt"}'),
    ).toBe(true);
  });

  it("returns false for non-overflow 400 errors", () => {
    expect(
      provider.isContextOverflowError('{"error":"invalid function call"}'),
    ).toBe(false);
  });

  it("returns false for undefined error body", () => {
    expect(provider.isContextOverflowError(undefined)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(
      provider.isContextOverflowError('{"error":"CONTEXT LENGTH EXCEEDED"}'),
    ).toBe(true);
  });
});

// ─── estimateTokens ────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  const provider = new TestProvider({ model: "test-model" });

  it("estimates tokens for messages without tools", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello, how are you?" },
    ];

    const tokens = provider.estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(100);
  });

  it("estimates higher token count when tools are included", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Create a GitHub issue" },
    ];

    const tools: Tool[] = [
      {
        type: "function",
        function: {
          name: "github.create_issue",
          description: "Create a new issue in a GitHub repository",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string", description: "Issue title" },
              body: { type: "string", description: "Issue body" },
            },
          },
        },
      },
    ];

    const tokensWithoutTools = provider.estimateTokens(messages);
    const tokensWithTools = provider.estimateTokens(messages, tools);

    expect(tokensWithTools).toBeGreaterThan(tokensWithoutTools);
  });

  it("counts per-tool overhead for multiple tools", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "test" },
    ];

    const oneTool: Tool[] = [
      {
        type: "function",
        function: {
          name: "test.tool",
          description: "A test tool",
          parameters: { type: "object", properties: {} },
        },
      },
    ];

    const fiveTools: Tool[] = Array.from({ length: 5 }, (_, i) => ({
      type: "function" as const,
      function: {
        name: `test.tool${i}`,
        description: `Test tool ${i}`,
        parameters: { type: "object", properties: {} },
      },
    }));

    const tokensOne = provider.estimateTokens(messages, oneTool);
    const tokensFive = provider.estimateTokens(messages, fiveTools);

    expect(tokensFive).toBeGreaterThan(tokensOne);
  });

  it("counts tool_calls in messages", () => {
    const messagesWithout: ChatMessage[] = [
      { role: "assistant", content: "I will help you." },
    ];

    const messagesWith: ChatMessage[] = [
      {
        role: "assistant",
        content: "I will help you.",
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: {
              name: "jira.create_issue",
              arguments: '{"title":"Test issue"}',
            },
          },
        ],
      },
    ];

    const tokensWithout = provider.estimateTokens(messagesWithout);
    const tokensWith = provider.estimateTokens(messagesWith);

    expect(tokensWith).toBeGreaterThan(tokensWithout);
  });
});

// ─── pruneToContextWindow ───────────────────────────────────────────────────

describe("pruneToContextWindow", () => {
  it("reserves tool token budget from message allowance", () => {
    const provider = new TestProvider({
      model: "test-model",
      maxContextTokens: 10000,
    });

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: "You are an assistant." + "x".repeat(8000),
      },
      { role: "user", content: "Hello" },
    ];

    const tools: Tool[] = [
      {
        type: "function",
        function: {
          name: "test.tool_with_long_name",
          description: "A tool that does something useful with parameters",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" },
              limit: { type: "number", description: "Max results" },
            },
          },
        },
      },
    ];

    // Without tools, messages fit
    const prunedWithout = provider.pruneToContextWindow(messages);
    // With tools, the tool budget reduces the available message space,
    // so aggressive pruning should happen
    const prunedWith = provider.pruneToContextWindow(messages, tools);

    // Both should return arrays (not crash)
    expect(prunedWithout.length).toBeGreaterThan(0);
    expect(prunedWith.length).toBeGreaterThan(0);

    // With tools, the total should be smaller (more aggressive pruning)
    const tokensWithout = provider.estimateTokens(prunedWithout);
    const tokensWith = provider.estimateTokens(prunedWith);
    expect(tokensWith).toBeLessThanOrEqual(tokensWithout);
  });

  it("warns when tool schemas consume most of the context budget", () => {
    const provider = new TestProvider({
      model: "test-model",
      maxContextTokens: 500,
    });

    const messages: ChatMessage[] = [
      { role: "user", content: "Hello" },
    ];

    // Create large tool set that exceeds most of the context
    const tools: Tool[] = Array.from({ length: 50 }, (_, i) => ({
      type: "function" as const,
      function: {
        name: `tool_${i}`,
        description: `Tool number ${i} that does something very specific and detailed`,
        parameters: {
          type: "object",
          properties: {
            param1: { type: "string", description: "First parameter" },
            param2: { type: "string", description: "Second parameter" },
          },
        },
      },
    }));

    // Should not crash even when tools exceed the budget
    const pruned = provider.pruneToContextWindow(messages, tools);
    expect(pruned.length).toBeGreaterThan(0);
  });

  it("truncates long tool results", () => {
    const provider = new TestProvider({
      model: "test-model",
      maxContextTokens: 5000,
    });

    const longContent = "x".repeat(200000);
    const messages: ChatMessage[] = [
      { role: "system", content: "You are an assistant." },
      { role: "user", content: "Run the tool" },
      { role: "assistant", content: "I ran it." },
      {
        role: "tool",
        content: longContent,
        tool_call_id: "call_1",
      },
      { role: "user", content: "What did it return?" },
    ];

    const pruned = provider.pruneToContextWindow(messages);
    const toolMsg = pruned.find((m) => m.role === "tool");
    if (toolMsg) {
      expect(toolMsg.content.length).toBeLessThan(longContent.length);
      expect(toolMsg.content).toContain("[truncated]");
    }
  });

  it("preserves system and most recent messages when pruning", () => {
    const provider = new TestProvider({
      model: "test-model",
      maxContextTokens: 200,
    });

    // Create messages that are clearly over the 200-token budget
    // (200 tokens * 0.85 safety margin = 170 tokens usable)
    const longContent = "x".repeat(500); // ~143 tokens at 3.5 chars/token
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: longContent },
      { role: "assistant", content: longContent },
      { role: "user", content: longContent },
      { role: "assistant", content: longContent },
      { role: "user", content: "Final question" },
    ];

    const pruned = provider.pruneToContextWindow(messages);

    // Should always keep system message
    expect(pruned[0].role).toBe("system");

    // Should always keep the last user message
    expect(pruned[pruned.length - 1].content).toBe("Final question");

    // Should contain a truncation notice (some messages were removed)
    const hasTruncationNotice = pruned.some(
      (m) => m.content.includes("truncated") || m.content.includes("removed"),
    );
    expect(hasTruncationNotice).toBe(true);
  });
});

// ─── pruneMessages public wrapper ──────────────────────────────────────────

describe("pruneMessages", () => {
  it("delegates to pruneToContextWindow with tools", () => {
    const provider = new TestProvider({
      model: "test-model",
      maxContextTokens: 10000,
    });

    const messages: ChatMessage[] = [
      { role: "user", content: "Hello" },
    ];

    const tools: Tool[] = [
      {
        type: "function",
        function: {
          name: "test.tool",
          description: "Test",
          parameters: { type: "object", properties: {} },
        },
      },
    ];

    const result = provider.pruneMessages(messages, tools);
    expect(result.length).toBeGreaterThan(0);
  });

  it("works without tools", () => {
    const provider = new TestProvider({
      model: "test-model",
      maxContextTokens: 10000,
    });

    const messages: ChatMessage[] = [
      { role: "user", content: "Hello" },
    ];

    const result = provider.pruneMessages(messages);
    expect(result.length).toBe(1);
  });
});