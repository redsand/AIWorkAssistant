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
    it("yields thinking as <<THINKING>>-wrapped string matching Ollama", async () => {
      makePostMock({ content: "answer", thinking: "Let me reason" });

      const provider = makeProvider();
      const { strings, events } = await collectStream(
        provider.chatStream({ messages: [{ role: "user", content: "q" }] }),
      );

      // thinking is now a wrapped string, not StreamEvent
      const thinkingStrings = strings.filter((s) => s.startsWith("<<THINKING>>"));
      const contentStrings = strings.filter((s) => !s.startsWith("<<THINKING>>"));
      expect(contentStrings.join("")).toBe("answer");
      expect(thinkingStrings).toHaveLength(1);
      expect(thinkingStrings[0]).toBe("<<THINKING>>Let me reason<<//THINKING>>");
      expect(events.filter((e) => e.type === "thinking")).toHaveLength(0);
    });

    it("yields thinking as string even when content is empty", async () => {
      makePostMock({ content: "", thinking: "reasoning only" });

      const provider = makeProvider();
      const { strings, events } = await collectStream(
        provider.chatStream({ messages: [{ role: "user", content: "q" }] }),
      );

      const thinkingStrings = strings.filter((s) => s.startsWith("<<THINKING>>"));
      expect(thinkingStrings).toHaveLength(1);
      expect(thinkingStrings[0]).toBe("<<THINKING>>reasoning only<<//THINKING>>");
      expect(events.filter((e) => e.type === "thinking")).toHaveLength(0);
    });

    it("does not yield thinking string when thinking is undefined", async () => {
      makePostMock({ content: "answer" });

      const provider = makeProvider();
      const { strings, events } = await collectStream(
        provider.chatStream({ messages: [{ role: "user", content: "q" }] }),
      );

      const thinkingStrings = strings.filter((s) => s.startsWith("<<THINKING>>"));
      expect(thinkingStrings).toHaveLength(0);
      expect(events.filter((e) => e.type === "thinking")).toHaveLength(0);
    });
  });

  describe("tool calls", () => {
    it("repairs invalid tool history before sending the request", async () => {
      const post = makePostMock({ content: "ok" });
      const provider = makeProvider();

      await provider.chat({
        messages: [
          { role: "user", content: "start" },
          { role: "tool", tool_call_id: "orphan", content: "{}" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_missing",
                type: "function",
                function: { name: "repo.search", arguments: "{\"query\":\"a\"}" },
              },
              {
                id: "call_present",
                type: "function",
                function: { name: "repo.search", arguments: "{\"query\":\"b\"}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_present", content: "{\"matches\":[]}" },
          { role: "user", content: "finish" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "repo.search",
              description: "Search repo",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      });

      const body = post.mock.calls[0][1];
      expect(body.tools[0].function.name).toBe("repo_search");
      expect(body.messages.some((message: any) => message.tool_call_id === "orphan")).toBe(false);
      const assistant = body.messages.find((message: any) => message.role === "assistant");
      expect(assistant.tool_calls).toHaveLength(1);
      expect(assistant.tool_calls[0].id).toBe("call_present");
      expect(assistant.tool_calls[0].function.name).toBe("repo_search");
    });

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
    it("yields thinking as string before content before tool_calls", async () => {
      const toolCalls: ToolCall[] = [
        { id: "call_mix", type: "function", function: { name: "search", arguments: '{"q":"test"}' } },
      ];
      makePostMock({ content: "Let me check", thinking: "Hmm", toolCalls });

      const provider = makeProvider();
      const collected: Array<string | StreamEvent> = [];
      for await (const item of provider.chatStream({ messages: [{ role: "user", content: "q" }], tools: [] })) {
        collected.push(item);
      }

      // thinking is now a <<THINKING>>-wrapped string, first item yielded
      expect(typeof collected[0]).toBe("string");
      expect((collected[0] as string).startsWith("<<THINKING>>")).toBe(true);
      expect(collected[0]).toBe("<<THINKING>>Hmm<<//THINKING>>");

      // tool_calls should be the last item (a StreamEvent)
      const lastItem = collected[collected.length - 1];
      expect(typeof lastItem).toBe("object");
      expect((lastItem as StreamEvent).type).toBe("tool_calls");
    });
  });
});
