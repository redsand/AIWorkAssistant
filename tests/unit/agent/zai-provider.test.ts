/**
 * Unit tests for ZaiProvider chatStream — tool_calls, thinking, and content.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamEvent } from "../../../src/agent/providers/types";

// ── Hoisted mocks ──────────────────────────────────────────────────────────
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
      isAxiosError: (err: unknown) => err instanceof Error && (err as any).isAxiosError === true,
    },
  };
});

import { ZaiProvider } from "../../../src/agent/providers/zai-provider";
import type { ProviderConfig, ChatResponse, ToolCall } from "../../../src/agent/providers/types";

function makeProvider(): ZaiProvider {
  const config: ProviderConfig = {
    apiKey: "test-key",
    baseUrl: "http://localhost:5678",
    model: "zai-test",
    temperature: 0.7,
    topP: 0.95,
    maxRetries: 0,
    timeout: 30000,
  };
  return new ZaiProvider(config);
}

async function collectStream(
  gen: AsyncGenerator<string | StreamEvent, void, unknown>,
): Promise<{ strings: string[]; events: StreamEvent[] }> {
  const strings: string[] = [];
  const events: StreamEvent[] = [];
  for await (const item of gen) {
    if (typeof item === "string") {
      strings.push(item);
    } else {
      events.push(item);
    }
  }
  return { strings, events };
}

function makePostMock(response: Partial<ChatResponse> = {}) {
  // Return the raw OpenAI-compatible API response that ZaiProvider.chat() parses
  const apiData = {
    choices: [{
      message: {
        content: response.content ?? "",
        reasoning_content: response.thinking ?? null,
        tool_calls: response.toolCalls?.length
          ? response.toolCalls.map((tc) => ({
              id: tc.id,
              type: tc.type,
              function: tc.function,
            }))
          : undefined,
      },
      finish_reason: response.toolCalls?.length ? "tool_calls" : "stop",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    model: response.model ?? "zai-test",
  };
  const fn = vi.fn().mockResolvedValue({ data: apiData });
  const mockClient = { post: fn, get: vi.fn() };
  mockAxiosCreate.mockReturnValue(mockClient);
  return fn;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ZaiProvider chatStream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("content streaming", () => {
    it("yields content in chunks", async () => {
      makePostMock({ content: "Hello world!" });

      const provider = makeProvider();
      const { strings, events } = await collectStream(
        provider.chatStream({ messages: [{ role: "user", content: "hi" }] }),
      );

      expect(strings.join("")).toBe("Hello world!");
      expect(events).toHaveLength(0);
    });

    it("handles empty content gracefully", async () => {
      makePostMock({ content: "" });

      const provider = makeProvider();
      const { strings, events } = await collectStream(
        provider.chatStream({ messages: [{ role: "user", content: "hi" }] }),
      );

      expect(strings).toHaveLength(0);
      expect(events).toHaveLength(0);
    });
  });

  describe("thinking tokens", () => {
    it("yields a thinking StreamEvent when response has thinking", async () => {
      makePostMock({ content: "answer", thinking: "Let me reason" });

      const provider = makeProvider();
      const { strings, events } = await collectStream(
        provider.chatStream({ messages: [{ role: "user", content: "q" }] }),
      );

      expect(strings.join("")).toBe("answer");
      const thinkingEvents = events.filter((e) => e.type === "thinking");
      expect(thinkingEvents).toHaveLength(1);
      expect(thinkingEvents[0]).toEqual({ type: "thinking", content: "Let me reason" });
    });

    it("yields thinking even when content is empty", async () => {
      makePostMock({ content: "", thinking: "reasoning only" });

      const provider = makeProvider();
      const { strings, events } = await collectStream(
        provider.chatStream({ messages: [{ role: "user", content: "q" }] }),
      );

      expect(strings).toHaveLength(0);
      const thinkingEvents = events.filter((e) => e.type === "thinking");
      expect(thinkingEvents).toHaveLength(1);
      expect(thinkingEvents[0]).toEqual({ type: "thinking", content: "reasoning only" });
    });

    it("does not yield thinking event when thinking is undefined", async () => {
      makePostMock({ content: "answer" });

      const provider = makeProvider();
      const { events } = await collectStream(
        provider.chatStream({ messages: [{ role: "user", content: "q" }] }),
      );

      expect(events.filter((e) => e.type === "thinking")).toHaveLength(0);
    });
  });

  describe("tool calls", () => {
    it("yields a tool_calls StreamEvent when response has toolCalls", async () => {
      const toolCalls: ToolCall[] = [
        {
          id: "call_abc",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"src/app.ts"}' },
        },
      ];
      makePostMock({ content: "", toolCalls });

      const provider = makeProvider();
      const { strings, events } = await collectStream(
        provider.chatStream({ messages: [{ role: "user", content: "read" }], tools: [] }),
      );

      expect(strings).toHaveLength(0);
      const tcEvents = events.filter((e) => e.type === "tool_calls");
      expect(tcEvents).toHaveLength(1);
      expect(tcEvents[0]).toEqual({ type: "tool_calls", toolCalls });
    });

    it("yields multiple tool calls in one event", async () => {
      const toolCalls: ToolCall[] = [
        { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
        { id: "call_2", type: "function", function: { name: "grep", arguments: '{"pattern":"TODO"}' } },
      ];
      makePostMock({ content: "", toolCalls });

      const provider = makeProvider();
      const { events } = await collectStream(
        provider.chatStream({ messages: [{ role: "user", content: "do stuff" }], tools: [] }),
      );

      const tcEvents = events.filter((e) => e.type === "tool_calls");
      expect(tcEvents).toHaveLength(1);
      const tc = tcEvents[0] as Extract<StreamEvent, { type: "tool_calls" }>;
      expect(tc.toolCalls).toHaveLength(2);
      expect(tc.toolCalls[0].function.name).toBe("read_file");
      expect(tc.toolCalls[1].function.name).toBe("grep");
    });

    it("does not yield tool_calls event when toolCalls is undefined", async () => {
      makePostMock({ content: "ok" });

      const provider = makeProvider();
      const { events } = await collectStream(
        provider.chatStream({ messages: [{ role: "user", content: "hi" }] }),
      );

      expect(events.filter((e) => e.type === "tool_calls")).toHaveLength(0);
    });

    it("does not yield tool_calls event when toolCalls is empty array", async () => {
      makePostMock({ content: "ok", toolCalls: [] });

      const provider = makeProvider();
      const { events } = await collectStream(
        provider.chatStream({ messages: [{ role: "user", content: "hi" }] }),
      );

      expect(events.filter((e) => e.type === "tool_calls")).toHaveLength(0);
    });
  });

  describe("mixed thinking, content, and tool_calls", () => {
    it("yields thinking before content before tool_calls", async () => {
      const toolCalls: ToolCall[] = [
        { id: "call_mix", type: "function", function: { name: "search", arguments: '{"q":"test"}' } },
      ];
      makePostMock({ content: "Let me check", thinking: "Hmm", toolCalls });

      const provider = makeProvider();
      const collected: Array<string | StreamEvent> = [];
      for await (const item of provider.chatStream({ messages: [{ role: "user", content: "q" }], tools: [] })) {
        collected.push(item);
      }

      const types = collected.map((i) => (typeof i === "string" ? "string" : i.type));
      const thinkingIdx = types.indexOf("thinking");
      const firstStringIdx = types.indexOf("string");
      const tcIdx = types.indexOf("tool_calls");

      expect(thinkingIdx).toBeGreaterThanOrEqual(0);
      expect(firstStringIdx).toBeGreaterThanOrEqual(0);
      expect(tcIdx).toBeGreaterThanOrEqual(0);

      // thinking comes before content, tool_calls comes after content
      expect(thinkingIdx).toBeLessThan(firstStringIdx);
      expect(firstStringIdx).toBeLessThan(tcIdx);
    });
  });
});
