import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "stream";
import { ZaiProvider } from "../zai-provider";
import type { ChatRequest, ToolCall } from "../types";

function makeConfig() {
  return {
    apiKey: "test-key",
    baseUrl: "https://api.zai.test",
    model: "glm-4",
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

function mockAxiosPostResolved(provider: ZaiProvider, response: any) {
  return vi.spyOn(provider["client"], "post").mockResolvedValue(response);
}

function mockAxiosPostRejected(provider: ZaiProvider, error: any) {
  return vi.spyOn(provider["client"], "post").mockRejectedValue(error);
}

describe("ZaiProvider", () => {
  let provider: ZaiProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ZaiProvider(makeConfig());
  });

  // ── chat() ────────────────────────────────────────────────────────────

  describe("chat()", () => {
    it("should throw when not configured", async () => {
      const unconfigured = new ZaiProvider({ ...makeConfig(), apiKey: "" });
      await expect(unconfigured.chat(makeRequest())).rejects.toThrow(
        "Z.ai API key not configured",
      );
    });

    it("should return a ChatResponse on success", async () => {
      mockAxiosPostResolved(provider, {
        data: {
          choices: [{ message: { content: "Hi there", tool_calls: undefined } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          model: "glm-4",
        },
      });

      const result = await provider.chat(makeRequest());
      expect(result.content).toBe("Hi there");
      expect(result.done).toBe(true);
      expect(result.model).toBe("glm-4");
      expect(result.usage?.totalTokens).toBe(15);
    });

    it("should return thinking content from reasoning_content", async () => {
      mockAxiosPostResolved(provider, {
        data: {
          choices: [{ message: { content: "answer", reasoning_content: "deep thought" } }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          model: "glm-4",
        },
      });

      const result = await provider.chat(makeRequest());
      expect(result.thinking).toBe("deep thought");
    });

    it("should parse tool calls and restore original names", async () => {
      mockAxiosPostResolved(provider, {
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
          model: "glm-4",
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
      expect(result.toolCalls![0].id).toBe("tc_1");
    });

    it("should retry with aggressive pruning on context overflow 400", async () => {
      const post = vi.spyOn(provider["client"], "post");

      // First call: 400 context overflow
      post.mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 400,
          data: { error: { message: "prompt is too long: 50000" } },
        },
      });

      // Second call (retry): success
      post.mockResolvedValueOnce({
        data: {
          choices: [{ message: { content: "pruned answer" } }],
          usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
          model: "glm-4",
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

      // Both calls return 400 context overflow
      post.mockRejectedValue({
        isAxiosError: true,
        response: {
          status: 400,
          data: { error: { message: "prompt is too long: 50000" } },
        },
      });

      await expect(provider.chat(makeRequest())).rejects.toThrow(
        "context length exceeded",
      );
    });

    it("should throw on auth errors without retrying", async () => {
      mockAxiosPostRejected(provider, {
        isAxiosError: true,
        response: { status: 401, data: {} },
      });

      await expect(provider.chat(makeRequest())).rejects.toThrow(
        "authentication failed",
      );
    });

    it("should retry on 429 rate limit", async () => {
      const post = vi.spyOn(provider["client"], "post");

      const rateLimitedProvider = new ZaiProvider({ ...makeConfig(), maxRetries: 1 });

      post.mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 429, headers: { "retry-after": "0.001" } },
      });

      post.mockResolvedValueOnce({
        data: {
          choices: [{ message: { content: "retry ok" } }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          model: "glm-4",
        },
      });

      vi.spyOn(rateLimitedProvider["client"], "post").mockImplementation(post);

      // Can't easily test the delay, just verify it eventually succeeds
      const result = await rateLimitedProvider.chat(makeRequest());
      expect(result.content).toBe("retry ok");
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

    it("should accumulate tool calls across deltas and emit on finish", async () => {
      const stream = createSSEStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_1","type":"function","function":{"name":"search","arguments":"{\\"qu"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ery\\"}"}}]}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
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
      expect(toolEvent!.toolCalls[0].id).toBe("tc_1");
      expect(toolEvent!.toolCalls[0].function.name).toBe("search");
      expect(toolEvent!.toolCalls[0].function.arguments).toBe('{"query"}');
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
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
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

    it("should retry stream with pruning on context overflow 400", async () => {
      const post = vi.spyOn(provider["client"], "post");

      // First call returns 400 context overflow
      const errorStream = new PassThrough();
      errorStream.end(JSON.stringify({ error: "prompt is too long: 50000" }));
      post.mockResolvedValueOnce({
        status: 400,
        data: errorStream,
      });

      // Retry succeeds
      const successStream = createSSEStream([
        'data: {"choices":[{"delta":{"content":"recovered"}}]}',
        "data: [DONE]",
      ]);
      post.mockResolvedValueOnce({
        status: 200,
        data: successStream,
      });

      const manyMessages: import("../types").ChatMessage[] = [
        { role: "system", content: "sys" },
        ...Array.from({ length: 20 }, (_, i) => ({
          role: "user" as const,
          content: `Message ${i} `.repeat(500),
        })),
        { role: "user", content: "Hello" },
      ];

      const events: string[] = [];
      for await (const event of provider.chatStream(makeRequest({ messages: manyMessages }))) {
        if (typeof event === "string") events.push(event);
      }

      expect(events).toContain("recovered");
      expect(post).toHaveBeenCalledTimes(2);
    });

    it("should throw on auth error in stream", async () => {
      const errorStream = new PassThrough();
      errorStream.end("unauthorized");
      vi.spyOn(provider["client"], "post").mockResolvedValue({
        status: 401,
        data: errorStream,
      });

      const gen = provider.chatStream(makeRequest());
      await expect(gen.next()).rejects.toThrow("authentication failed");
    });
  });

  // ── isConfigured / validateConfig ─────────────────────────────────────

  describe("isConfigured()", () => {
    it("should return true when apiKey is set", () => {
      expect(provider.isConfigured()).toBe(true);
    });

    it("should return false when apiKey is empty", () => {
      const p = new ZaiProvider({ ...makeConfig(), apiKey: "" });
      expect(p.isConfigured()).toBe(false);
    });
  });

  describe("validateConfig()", () => {
    it("should return false when not configured", async () => {
      const p = new ZaiProvider({ ...makeConfig(), apiKey: "" });
      expect(await p.validateConfig()).toBe(false);
    });

    it("should return true on successful /models call", async () => {
      vi.spyOn(provider["client"], "get").mockResolvedValue({ status: 200 });
      expect(await provider.validateConfig()).toBe(true);
    });

    it("should return false on /models failure", async () => {
      vi.spyOn(provider["client"], "get").mockRejectedValue(new Error("fail"));
      expect(await provider.validateConfig()).toBe(false);
    });
  });
});
