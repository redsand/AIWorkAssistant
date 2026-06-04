import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "stream";
import { OllamaProvider } from "../ollama-provider";
import type { ChatRequest, ToolCall } from "../types";

function makeConfig() {
  return {
    apiKey: "",
    baseUrl: "http://localhost:11434",
    model: "llama3",
    temperature: 0.7,
    topP: 1,
    maxRetries: 0,
    timeout: 5000,
  };
}

function makeRequest(overrides?: Partial<ChatRequest>): ChatRequest {
  return {
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ],
    ...overrides,
  };
}

function createSSEStream(events: string[]): PassThrough {
  const stream = new PassThrough();
  for (const event of events) {
    stream.write(event + "\n");
  }
  stream.end();
  return stream;
}

describe("OllamaProvider", () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OllamaProvider(makeConfig());
  });

  // ── chat() ────────────────────────────────────────────────────────────

  describe("chat()", () => {
    it("should return a ChatResponse on success", async () => {
      vi.spyOn(provider["client"], "post").mockResolvedValue({
        data: {
          choices: [{ message: { content: "Hi there" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          model: "llama3",
        },
      });

      const result = await provider.chat(makeRequest());
      expect(result.content).toBe("Hi there");
      expect(result.done).toBe(true);
      expect(result.model).toBe("llama3");
    });

    it("should extract thinking from reasoning_content", async () => {
      vi.spyOn(provider["client"], "post").mockResolvedValue({
        data: {
          choices: [{ message: { content: "answer", reasoning_content: "thinking..." } }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          model: "llama3",
        },
      });

      const result = await provider.chat(makeRequest());
      expect(result.thinking).toBe("thinking...");
    });

    it("should extract thinking from thinking field", async () => {
      vi.spyOn(provider["client"], "post").mockResolvedValue({
        data: {
          choices: [{ message: { content: "answer", thinking: "hmm" } }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          model: "llama3",
        },
      });

      const result = await provider.chat(makeRequest());
      expect(result.thinking).toBe("hmm");
    });

    it("should parse tool calls and restore original names", async () => {
      vi.spyOn(provider["client"], "post").mockResolvedValue({
        data: {
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "tc_1",
                    type: "function",
                    function: { name: "knowledge_search", arguments: '{"q":"x"}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          model: "llama3",
        },
      });

      const request = makeRequest({
        tools: [
          {
            type: "function",
            function: { name: "knowledge.search", description: "Search", parameters: {} },
          },
        ],
      });

      const result = await provider.chat(request);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].function.name).toBe("knowledge.search");
    });

    it("should retry with aggressive pruning on context overflow 400", async () => {
      const post = vi.spyOn(provider["client"], "post");

      post.mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 400,
          data: { error: "prompt is too long: 50000" },
        },
      });

      post.mockResolvedValueOnce({
        data: {
          choices: [{ message: { content: "pruned answer" } }],
          usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
          model: "llama3",
        },
      });

      const manyMessages: import("../types").ChatMessage[] = [
        { role: "system", content: "sys" },
        ...Array.from({ length: 20 }, (_, i) => ({
          role: "user" as const,
          content: `Message ${i} `.repeat(500),
        })),
        { role: "user", content: "Hello" },
      ];

      const result = await provider.chat(makeRequest({ messages: manyMessages }));
      expect(result.content).toBe("pruned answer");
      expect(post).toHaveBeenCalledTimes(2);
    });

    it("should throw immediately on context overflow if already retrying", async () => {
      const post = vi.spyOn(provider["client"], "post");

      post.mockRejectedValue({
        isAxiosError: true,
        response: {
          status: 400,
          data: { error: "prompt is too long: 50000" },
        },
      });

      await expect(provider.chat(makeRequest())).rejects.toThrow(
        "context length exceeded",
      );
    });

    it("should throw on 404 model not found", async () => {
      vi.spyOn(provider["client"], "post").mockRejectedValue({
        isAxiosError: true,
        response: { status: 404, data: {} },
      });

      await expect(provider.chat(makeRequest())).rejects.toThrow("model not found");
    });

    it("should throw descriptive error on 400 with tools (unsupported model)", async () => {
      vi.spyOn(provider["client"], "post").mockRejectedValue({
        isAxiosError: true,
        response: {
          status: 400,
          data: { error: "bad tool format" },
        },
      });

      const request = makeRequest({
        tools: [
          {
            type: "function",
            function: { name: "search", description: "Search", parameters: {} },
          },
        ],
      });

      await expect(provider.chat(request)).rejects.toThrow("may not support function calling");
    });
  });

  // ── chatStream() ──────────────────────────────────────────────────────

  describe("chatStream()", () => {
    it("should yield content deltas from SSE stream", async () => {
      const stream = createSSEStream([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        "data: [DONE]",
      ]);

      vi.spyOn(provider["client"], "post").mockResolvedValue({
        status: 200,
        data: stream,
      });

      const events: string[] = [];
      for await (const event of provider.chatStream(makeRequest())) {
        if (typeof event === "string") events.push(event);
      }

      expect(events).toEqual(["Hel", "lo"]);
    });

    it("should yield thinking content wrapped in markers", async () => {
      const stream = createSSEStream([
        'data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}',
        'data: {"choices":[{"delta":{"content":"answer"}}]}',
        "data: [DONE]",
      ]);

      vi.spyOn(provider["client"], "post").mockResolvedValue({
        status: 200,
        data: stream,
      });

      const events: (string | object)[] = [];
      for await (const event of provider.chatStream(makeRequest())) {
        events.push(event);
      }

      expect(events[0]).toBe("<<THINKING>>hmm<<//THINKING>>");
      expect(events[1]).toBe("answer");
    });

    it("should accumulate tool calls across multiple deltas", async () => {
      const stream = createSSEStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_1","type":"function","function":{"name":"search","arguments":"{\\"qu"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ery\\"}"}}]}}]}',
        'data: {"choices":[{"finish_reason":"tool_calls"}]}',
        "data: [DONE]",
      ]);

      vi.spyOn(provider["client"], "post").mockResolvedValue({
        status: 200,
        data: stream,
      });

      const events: (string | object)[] = [];
      for await (const event of provider.chatStream(makeRequest())) {
        events.push(event);
      }

      const toolEvent = events.find(
        (e) => typeof e === "object" && (e as any).type === "tool_calls",
      ) as { type: "tool_calls"; toolCalls: ToolCall[] } | undefined;

      expect(toolEvent).toBeDefined();
      expect(toolEvent!.toolCalls).toHaveLength(1);
      expect(toolEvent!.toolCalls[0].function.arguments).toBe('{"query"}');
    });

    it("should accumulate tool calls from the lineBuffer flush at end of stream", async () => {
      // Simulate a final tool call arriving in the trailing lineBuffer
      // (no trailing newline, so it stays in lineBuffer until flush)
      const stream = new PassThrough();
      stream.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_flush","type":"function","function":{"name":"flush_tool","arguments":"{}"}}]}}]}\n');
      stream.write('data: {"choices":[{"message":{"tool_calls":[{"index":0,"id":"tc_flush","type":"function","function":{"name":"flush_tool","arguments":"{}"}}]},"finish_reason":"stop"}]}\n');
      stream.write("data: [DONE]\n");
      stream.end();

      vi.spyOn(provider["client"], "post").mockResolvedValue({
        status: 200,
        data: stream,
      });

      const events: (string | object)[] = [];
      for await (const event of provider.chatStream(makeRequest())) {
        events.push(event);
      }

      const toolEvent = events.find(
        (e) => typeof e === "object" && (e as any).type === "tool_calls",
      ) as { type: "tool_calls"; toolCalls: ToolCall[] } | undefined;

      expect(toolEvent).toBeDefined();
      expect(toolEvent!.toolCalls[0].id).toBe("tc_flush");
    });

    it("should handle tool calls arriving as complete message (non-delta)", async () => {
      const stream = createSSEStream([
        'data: {"choices":[{"message":{"tool_calls":[{"id":"tc_msg","type":"function","function":{"name":"my_tool","arguments":"{}"}}]}}]}',
        'data: {"choices":[{"finish_reason":"stop"}]}',
        "data: [DONE]",
      ]);

      vi.spyOn(provider["client"], "post").mockResolvedValue({
        status: 200,
        data: stream,
      });

      const events: (string | object)[] = [];
      for await (const event of provider.chatStream(makeRequest())) {
        events.push(event);
      }

      const toolEvent = events.find(
        (e) => typeof e === "object" && (e as any).type === "tool_calls",
      ) as { type: "tool_calls"; toolCalls: ToolCall[] } | undefined;

      expect(toolEvent).toBeDefined();
      expect(toolEvent!.toolCalls[0].function.name).toBe("my_tool");
    });

    it("should map sanitized tool names back to originals", async () => {
      const request = makeRequest({
        tools: [
          {
            type: "function",
            function: { name: "knowledge.search", description: "Search", parameters: {} },
          },
        ],
      });

      const stream = createSSEStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_1","type":"function","function":{"name":"knowledge_search","arguments":"{}"}}]}}]}',
        'data: {"choices":[{"finish_reason":"tool_calls"}]}',
        "data: [DONE]",
      ]);

      vi.spyOn(provider["client"], "post").mockResolvedValue({
        status: 200,
        data: stream,
      });

      const events: (string | object)[] = [];
      for await (const event of provider.chatStream(request)) {
        events.push(event);
      }

      const toolEvent = events.find(
        (e) => typeof e === "object" && (e as any).type === "tool_calls",
      ) as { type: "tool_calls"; toolCalls: ToolCall[] } | undefined;

      expect(toolEvent!.toolCalls[0].function.name).toBe("knowledge.search");
    });

    it("should handle tool call arguments arriving as non-string (object)", async () => {
      const stream = createSSEStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_1","type":"function","function":{"name":"search","arguments":{"key":"val"}}}]}}]}',
        'data: {"choices":[{"finish_reason":"tool_calls"}]}',
        "data: [DONE]",
      ]);

      vi.spyOn(provider["client"], "post").mockResolvedValue({
        status: 200,
        data: stream,
      });

      const events: (string | object)[] = [];
      for await (const event of provider.chatStream(makeRequest())) {
        events.push(event);
      }

      const toolEvent = events.find(
        (e) => typeof e === "object" && (e as any).type === "tool_calls",
      ) as { type: "tool_calls"; toolCalls: ToolCall[] } | undefined;

      expect(toolEvent).toBeDefined();
      // Non-string arguments should be JSON.stringify'd
      expect(typeof toolEvent!.toolCalls[0].function.arguments).toBe("string");
    });

    it("should throw on stream error", async () => {
      vi.spyOn(provider["client"], "post").mockRejectedValue(new Error("connection lost"));

      const gen = provider.chatStream(makeRequest());
      await expect(gen.next()).rejects.toThrow("stream failed");
    });

    it("should handle multiple tool call indices (parallel calls)", async () => {
      const stream = createSSEStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_a","type":"function","function":{"name":"tool_a","arguments":"{"}},{"index":1,"id":"tc_b","type":"function","function":{"name":"tool_b","arguments":"{"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}},{"index":1,"function":{"arguments":"}"}}]}}]}',
        'data: {"choices":[{"finish_reason":"tool_calls"}]}',
        "data: [DONE]",
      ]);

      vi.spyOn(provider["client"], "post").mockResolvedValue({
        status: 200,
        data: stream,
      });

      const events: (string | object)[] = [];
      for await (const event of provider.chatStream(makeRequest())) {
        events.push(event);
      }

      const toolEvent = events.find(
        (e) => typeof e === "object" && (e as any).type === "tool_calls",
      ) as { type: "tool_calls"; toolCalls: ToolCall[] } | undefined;

      expect(toolEvent).toBeDefined();
      expect(toolEvent!.toolCalls).toHaveLength(2);
      expect(toolEvent!.toolCalls[0].function.name).toBe("tool_a");
      expect(toolEvent!.toolCalls[1].function.name).toBe("tool_b");
    });
  });

  // ── isConfigured / validateConfig ─────────────────────────────────────

  describe("isConfigured()", () => {
    it("should return true when baseUrl is set", () => {
      expect(provider.isConfigured()).toBe(true);
    });

    it("should return false when baseUrl is empty", () => {
      const p = new OllamaProvider({ ...makeConfig(), baseUrl: "" });
      expect(p.isConfigured()).toBe(false);
    });
  });

  describe("validateConfig()", () => {
    it("should return true on successful /api/tags call", async () => {
      vi.spyOn(provider["client"], "get").mockResolvedValue({ status: 200 });
      expect(await provider.validateConfig()).toBe(true);
    });

    it("should return false on connection failure", async () => {
      vi.spyOn(provider["client"], "get").mockRejectedValue(new Error("ECONNREFUSED"));
      expect(await provider.validateConfig()).toBe(false);
    });

    it("should return false on 401 auth failure", async () => {
      vi.spyOn(provider["client"], "get").mockRejectedValue({
        isAxiosError: true,
        response: { status: 401 },
      });
      expect(await provider.validateConfig()).toBe(false);
    });
  });
});
