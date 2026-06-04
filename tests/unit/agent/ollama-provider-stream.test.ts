/**
 * Unit tests for OllamaProvider chatStream — tool_calls, thinking, and content.
 * Verifies Ollama behaves identically to OpenCode and Z.ai providers.
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
      isAxiosError: (err: unknown) =>
        err instanceof Error && (err as any).isAxiosError === true,
    },
  };
});

// ── Helpers ────────────────────────────────────────────────────────────────

function makeSSELines(
  events: Array<Record<string, unknown> | "[DONE]">,
): string[] {
  return events.map((ev) => {
    if (ev === "[DONE]") return "data: [DONE]\n";
    return `data: ${JSON.stringify(ev)}\n`;
  });
}

async function* sseGenerator(chunks: string[]): AsyncGenerator<Buffer> {
  for (const c of chunks) {
    await new Promise((r) => setTimeout(r, 0));
    yield Buffer.from(c);
  }
}

// ── Dynamic import after mocks are set up ──────────────────────────────────
import { OllamaProvider } from "../../../src/agent/providers/ollama-provider";
import type { ProviderConfig } from "../../../src/agent/providers/types";

function makeProvider(): OllamaProvider {
  const config: ProviderConfig = {
    apiKey: "",
    baseUrl: "http://localhost:11434",
    model: "llama3",
    temperature: 0.7,
    topP: 0.95,
    maxRetries: 0,
    timeout: 30000,
  };
  return new OllamaProvider(config);
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

type MockPostFn = ReturnType<typeof vi.fn>;

function makePostMock(): MockPostFn {
  const fn = vi.fn();
  const mockClient = { post: fn };
  mockAxiosCreate.mockReturnValue(mockClient);
  return fn;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("OllamaProvider chatStream", () => {
  let postMock: MockPostFn;

  beforeEach(() => {
    vi.clearAllMocks();
    postMock = makePostMock();
  });

  describe("content streaming", () => {
    it("yields string chunks for delta.content", async () => {
      const lines = makeSSELines([
        { choices: [{ delta: { content: "Hello" }, index: 0 }] },
        { choices: [{ delta: { content: " world" }, index: 0 }] },
        {
          choices: [
            { delta: { content: "!" }, index: 0, finish_reason: "stop" },
          ],
        },
        "[DONE]",
      ]);

      postMock.mockResolvedValue({ data: sseGenerator(lines) });

      const provider = makeProvider();
      const { strings, events } = await collectStream(
        provider.chatStream({ messages: [{ role: "user", content: "hi" }] }),
      );

      expect(strings.join("")).toBe("Hello world!");
      expect(events).toHaveLength(0);
    });

    it("handles empty content delta gracefully", async () => {
      const lines = makeSSELines([
        { choices: [{ delta: {}, index: 0 }] },
        {
          choices: [
            {
              delta: { content: "ok" },
              index: 0,
              finish_reason: "stop",
            },
          ],
        },
        "[DONE]",
      ]);

      postMock.mockResolvedValue({ data: sseGenerator(lines) });

      const provider = makeProvider();
      const { strings, events } = await collectStream(
        provider.chatStream({ messages: [{ role: "user", content: "hi" }] }),
      );

      expect(strings.join("")).toBe("ok");
      expect(events).toHaveLength(0);
    });
  });

  describe("thinking tokens", () => {
    it("yields thinking as <<THINKING>>-wrapped strings", async () => {
      const lines = makeSSELines([
        {
          choices: [
            { delta: { thinking: "Let me think" }, index: 0 },
          ],
        },
        {
          choices: [
            { delta: { thinking: " about this" }, index: 0 },
          ],
        },
        {
          choices: [
            {
              delta: { content: "answer" },
              index: 0,
              finish_reason: "stop",
            },
          ],
        },
        "[DONE]",
      ]);

      postMock.mockResolvedValue({ data: sseGenerator(lines) });

      const provider = makeProvider();
      const { strings, events } = await collectStream(
        provider.chatStream({ messages: [{ role: "user", content: "q" }] }),
      );

      const thinkingStrings = strings.filter((s) =>
        s.startsWith("<<THINKING>>"),
      );
      const contentStrings = strings.filter(
        (s) => !s.startsWith("<<THINKING>>"),
      );
      expect(contentStrings.join("")).toBe("answer");
      expect(thinkingStrings).toHaveLength(2);
      expect(thinkingStrings[0]).toBe("<<THINKING>>Let me think<<//THINKING>>");
      expect(thinkingStrings[1]).toBe(
        "<<THINKING>> about this<<//THINKING>>",
      );
      expect(events).toHaveLength(0);
    });

    it("handles reasoning_content field (some Ollama models)", async () => {
      const lines = makeSSELines([
        {
          choices: [
            {
              delta: { reasoning_content: "Deep reasoning" },
              index: 0,
              finish_reason: "stop",
            },
          ],
        },
        "[DONE]",
      ]);

      postMock.mockResolvedValue({ data: sseGenerator(lines) });

      const provider = makeProvider();
      const { strings, events } = await collectStream(
        provider.chatStream({ messages: [{ role: "user", content: "q" }] }),
      );

      const thinkingStrings = strings.filter((s) =>
        s.startsWith("<<THINKING>>"),
      );
      expect(thinkingStrings).toHaveLength(1);
      expect(thinkingStrings[0]).toBe(
        "<<THINKING>>Deep reasoning<<//THINKING>>",
      );
      expect(events).toHaveLength(0);
    });
  });

  describe("tool calls", () => {
    it("accumulates tool call deltas and yields on finish_reason=tool_calls", async () => {
      const lines = makeSSELines([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_abc",
                    type: "function",
                    function: { name: "read_file", arguments: "" },
                  },
                ],
              },
              index: 0,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '{"path"' } },
                ],
              },
              index: 0,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: ':"src/app.ts"}' } },
                ],
              },
              index: 0,
              finish_reason: "tool_calls",
            },
          ],
        },
        "[DONE]",
      ]);

      postMock.mockResolvedValue({ data: sseGenerator(lines) });

      const provider = makeProvider();
      const { strings, events } = await collectStream(
        provider.chatStream({
          messages: [{ role: "user", content: "read file" }],
          tools: [],
        }),
      );

      expect(strings).toHaveLength(0);
      const toolCallEvents = events.filter((e) => e.type === "tool_calls");
      expect(toolCallEvents).toHaveLength(1);
      expect(toolCallEvents[0]).toEqual({
        type: "tool_calls",
        toolCalls: [
          {
            id: "call_abc",
            type: "function",
            function: {
              name: "read_file",
              arguments: '{"path":"src/app.ts"}',
            },
          },
        ],
      });
    });

    it("handles multiple parallel tool calls", async () => {
      const lines = makeSSELines([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: '{"path":"a.ts"}',
                    },
                  },
                  {
                    index: 1,
                    id: "call_2",
                    type: "function",
                    function: {
                      name: "grep",
                      arguments: '{"p":"TODO"}',
                    },
                  },
                ],
              },
              index: 0,
              finish_reason: "tool_calls",
            },
          ],
        },
        "[DONE]",
      ]);

      postMock.mockResolvedValue({ data: sseGenerator(lines) });

      const provider = makeProvider();
      const { events } = await collectStream(
        provider.chatStream({
          messages: [{ role: "user", content: "do stuff" }],
          tools: [],
        }),
      );

      const tcEvents = events.filter((e) => e.type === "tool_calls");
      expect(tcEvents).toHaveLength(1);
      const tcs = tcEvents[0] as Extract<StreamEvent, { type: "tool_calls" }>;
      expect(tcs.toolCalls).toHaveLength(2);
      expect(tcs.toolCalls[0].function.name).toBe("read_file");
      expect(tcs.toolCalls[1].function.name).toBe("grep");
    });

    it("does not yield tool_calls event when finish_reason is not tool_calls", async () => {
      const lines = makeSSELines([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_x",
                    type: "function",
                    function: { name: "f", arguments: "{}" },
                  },
                ],
              },
              index: 0,
              finish_reason: "stop",
            },
          ],
        },
        "[DONE]",
      ]);

      postMock.mockResolvedValue({ data: sseGenerator(lines) });

      const provider = makeProvider();
      const { events } = await collectStream(
        provider.chatStream({
          messages: [{ role: "user", content: "hi" }],
          tools: [],
        }),
      );

      const tcEvents = events.filter((e) => e.type === "tool_calls");
      expect(tcEvents).toHaveLength(0);
    });

    it("handles tool calls without IDs (Ollama synthesizes them)", async () => {
      const lines = makeSSELines([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    type: "function",
                    function: {
                      name: "search",
                      arguments: '{"q":"test"}',
                    },
                  },
                ],
              },
              index: 0,
              finish_reason: "tool_calls",
            },
          ],
        },
        "[DONE]",
      ]);

      postMock.mockResolvedValue({ data: sseGenerator(lines) });

      const provider = makeProvider();
      const { events } = await collectStream(
        provider.chatStream({
          messages: [{ role: "user", content: "search" }],
          tools: [],
        }),
      );

      const tcEvents = events.filter((e) => e.type === "tool_calls");
      expect(tcEvents).toHaveLength(1);
      const tc = tcEvents[0] as Extract<StreamEvent, { type: "tool_calls" }>;
      expect(tc.toolCalls).toHaveLength(1);
      expect(tc.toolCalls[0].function.name).toBe("search");
      expect(tc.toolCalls[0].function.arguments).toBe('{"q":"test"}');
    });
  });

  describe("mixed content, thinking, and tool_calls", () => {
    it("handles all three streamed together like OpenCode", async () => {
      const lines = makeSSELines([
        {
          choices: [
            { delta: { thinking: "Hmm" }, index: 0 },
          ],
        },
        {
          choices: [
            { delta: { content: "Let me check" }, index: 0 },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_mix",
                    type: "function",
                    function: {
                      name: "search",
                      arguments: '{"q":"test"}',
                    },
                  },
                ],
              },
              index: 0,
              finish_reason: "tool_calls",
            },
          ],
        },
        "[DONE]",
      ]);

      postMock.mockResolvedValue({ data: sseGenerator(lines) });

      const provider = makeProvider();
      const { strings, events } = await collectStream(
        provider.chatStream({
          messages: [{ role: "user", content: "q" }],
          tools: [],
        }),
      );

      // thinking as string, content as string, tool_calls as StreamEvent
      const thinkingStrings = strings.filter((s) =>
        s.startsWith("<<THINKING>>"),
      );
      const contentStrings = strings.filter(
        (s) => !s.startsWith("<<THINKING>>"),
      );
      expect(thinkingStrings).toHaveLength(1);
      expect(thinkingStrings[0]).toBe("<<THINKING>>Hmm<<//THINKING>>");
      expect(contentStrings.join("")).toBe("Let me check");
      expect(events.some((e) => e.type === "tool_calls")).toBe(true);
    });
  });

  describe("error handling in stream parsing", () => {
    it("skips unparseable SSE data lines", async () => {
      const lines = [
        "data: {invalid json}\n",
        `data: ${JSON.stringify({ choices: [{ delta: { content: "recovered" }, index: 0, finish_reason: "stop" }] })}\n`,
        "data: [DONE]\n",
      ];

      postMock.mockResolvedValue({ data: sseGenerator(lines) });

      const provider = makeProvider();
      const { strings } = await collectStream(
        provider.chatStream({ messages: [{ role: "user", content: "hi" }] }),
      );

      expect(strings.join("")).toBe("recovered");
    });

    it("skips non-data SSE lines", async () => {
      const lines = [
        "event: ping\n",
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, index: 0, finish_reason: "stop" }] })}\n`,
        "data: [DONE]\n",
      ];

      postMock.mockResolvedValue({ data: sseGenerator(lines) });

      const provider = makeProvider();
      const { strings } = await collectStream(
        provider.chatStream({ messages: [{ role: "user", content: "hi" }] }),
      );

      expect(strings.join("")).toBe("ok");
    });

    it("parses raw JSON-line stream chunks from Ollama-compatible endpoints", async () => {
      const lines = [
        `${JSON.stringify({ choices: [{ delta: { content: "raw" }, index: 0 }] })}\n`,
        `${JSON.stringify({ choices: [{ delta: { content: " json" }, index: 0, finish_reason: "stop" }] })}\n`,
      ];

      postMock.mockResolvedValue({ data: sseGenerator(lines) });

      const provider = makeProvider();
      const { strings } = await collectStream(
        provider.chatStream({ messages: [{ role: "user", content: "hi" }] }),
      );

      expect(strings.join("")).toBe("raw json");
    });

    it("emits final message-shaped tool calls when no tool finish reason is sent", async () => {
      const lines = [
        `${JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    type: "function",
                    function: {
                      name: "search",
                      arguments: { q: "status" },
                    },
                  },
                ],
              },
              index: 0,
              finish_reason: "stop",
            },
          ],
        })}\n`,
      ];

      postMock.mockResolvedValue({ data: sseGenerator(lines) });

      const provider = makeProvider();
      const { events } = await collectStream(
        provider.chatStream({
          messages: [{ role: "user", content: "search" }],
          tools: [],
        }),
      );

      const tcEvents = events.filter((e) => e.type === "tool_calls");
      expect(tcEvents).toHaveLength(1);
      const tc = tcEvents[0] as Extract<StreamEvent, { type: "tool_calls" }>;
      expect(tc.toolCalls[0].id).toMatch(/^call_/);
      expect(tc.toolCalls[0].function.name).toBe("search");
      expect(tc.toolCalls[0].function.arguments).toBe('{"q":"status"}');
    });
  });
});
