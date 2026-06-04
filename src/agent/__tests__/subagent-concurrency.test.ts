import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockChat,
  mockIsConfigured,
  mockGetEntries,
  mockLoad,
  mockGetSummariesText,
  mockDispatchToolCall,
} = vi.hoisted(() => ({
  mockChat: vi.fn(),
  mockIsConfigured: vi.fn().mockReturnValue(true),
  mockGetEntries: vi.fn().mockReturnValue([]),
  mockLoad: vi.fn().mockReturnValue("# Identity\nTest soul"),
  mockGetSummariesText: vi.fn().mockReturnValue(""),
  mockDispatchToolCall: vi.fn(),
}));

vi.mock("../opencode-client", () => ({
  aiClient: {
    chat: mockChat,
    isConfigured: mockIsConfigured,
  },
}));

vi.mock("../../memory/agent-memory", () => ({
  agentMemory: {
    getEntries: mockGetEntries,
    add: vi.fn().mockReturnValue({ success: true }),
  },
}));

vi.mock("../../memory/soul-manager", () => ({
  soulManager: {
    load: mockLoad,
  },
}));

vi.mock("../../skills/skill-manager", () => ({
  skillManager: {
    getSummariesText: mockGetSummariesText,
  },
}));

vi.mock("../reflection-engine", () => ({
  reflectionEngine: {
    reflectOnTask: vi.fn().mockResolvedValue({
      taskSucceeded: true,
      toolCallCount: 0,
      wins: [],
      losses: [],
      lessons: [],
      skillCandidate: false,
      memoryEntries: [],
    }),
  },
}));

vi.mock("../tool-registry", () => ({
  getAllToolsForMode: vi.fn().mockReturnValue([]),
}));

vi.mock("../tool-dispatcher", () => ({
  dispatchToolCall: mockDispatchToolCall,
}));

import { SubagentSpawner } from "../subagent-spawner";

describe("SubagentSpawner concurrency and cleanup", () => {
  let spawner: SubagentSpawner;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConfigured.mockReturnValue(true);
    mockChat.mockResolvedValue({
      content: "Task completed successfully.",
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      model: "test-model",
      done: true,
    });
    spawner = new SubagentSpawner();
  });

  // ── concurrent spawn isolation ──────────────────────────────────────

  describe("concurrent spawn isolation", () => {
    it("should handle two concurrent spawns independently without corrupting results", async () => {
      let callIndex = 0;
      mockChat.mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return Promise.resolve({
            content: "First result",
            usage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
            model: "test-model",
            done: true,
          });
        }
        return Promise.resolve({
          content: "Second result",
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          model: "test-model",
          done: true,
        });
      });

      const [result1, result2] = await Promise.all([
        spawner.spawn({ prompt: "Task A" }),
        spawner.spawn({ prompt: "Task B" }),
      ]);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect([result1.output, result2.output].sort()).toEqual([
        "First result",
        "Second result",
      ]);
    });

    it("should not let one spawn failure affect another concurrent spawn", async () => {
      let callIndex = 0;
      mockChat.mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return Promise.reject(new Error("Transient failure"));
        }
        return Promise.resolve({
          content: "Success result",
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          model: "test-model",
          done: true,
        });
      });

      const [result1, result2] = await Promise.all([
        spawner.spawn({ prompt: "Failing task" }),
        spawner.spawn({ prompt: "Succeeding task" }),
      ]);

      expect(result1.success).toBe(false);
      expect(result1.error).toContain("Transient failure");

      expect(result2.success).toBe(true);
      expect(result2.output).toBe("Success result");
    });

    it("should handle concurrent tool-call loops independently", async () => {
      let callIndex = 0;
      const toolCallA = {
        id: "tc_a",
        type: "function" as const,
        function: { name: "knowledge.search", arguments: '{"query":"A"}' },
      };
      const toolCallB = {
        id: "tc_b",
        type: "function" as const,
        function: { name: "knowledge.search", arguments: '{"query":"B"}' },
      };

      mockChat.mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return Promise.resolve({
            content: "",
            toolCalls: [toolCallA],
            model: "test-model",
            done: true,
          });
        }
        if (callIndex === 2) {
          return Promise.resolve({
            content: "",
            toolCalls: [toolCallB],
            model: "test-model",
            done: true,
          });
        }
        const suffix = callIndex === 3 ? "A done" : "B done";
        return Promise.resolve({
          content: suffix,
          model: "test-model",
          done: true,
        });
      });

      mockDispatchToolCall.mockResolvedValue({
        success: true,
        data: { results: [] },
      });

      const [result1, result2] = await Promise.all([
        spawner.spawn({ prompt: "Task A" }),
        spawner.spawn({ prompt: "Task B" }),
      ]);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result1.toolCallsUsed + result2.toolCallsUsed).toBe(2);
    });
  });

  // ── resource cleanup on failure ─────────────────────────────────────

  describe("resource cleanup on failure", () => {
    it("should return structured error result when chat throws", async () => {
      mockChat.mockRejectedValue(new Error("model overloaded"));

      const result = await spawner.spawn({ prompt: "do work" });

      expect(result.success).toBe(false);
      expect(result.output).toBe("");
      expect(result.error).toContain("model overloaded");
      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(result.toolCallsUsed).toBe(0);
    });

    it("should return structured error result on timeout", async () => {
      mockChat.mockReturnValue(new Promise(() => { /* never resolves */ }));

      const result = await spawner.spawn({
        prompt: "slow task",
        timeout: 50,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out");
      expect(result.duration).toBeGreaterThanOrEqual(0);
    }, 10000);

    it("should clean up tool call state when dispatch throws mid-loop", async () => {
      const toolCall = {
        id: "tc_1",
        type: "function" as const,
        function: { name: "knowledge.search", arguments: '{"query":"test"}' },
      };

      mockChat.mockResolvedValueOnce({
        content: "",
        toolCalls: [toolCall],
        model: "test-model",
        done: true,
      });

      mockDispatchToolCall.mockRejectedValue(new Error("tool dispatch crashed"));

      const result = await spawner.spawn({ prompt: "use tool" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("tool dispatch crashed");
    });

    it("should not leak state across sequential failed spawns", async () => {
      mockChat.mockRejectedValueOnce(new Error("first fail"));
      const result1 = await spawner.spawn({ prompt: "fail 1" });
      expect(result1.success).toBe(false);

      mockChat.mockResolvedValueOnce({
        content: "recovered",
        usage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
        model: "test-model",
        done: true,
      });
      const result2 = await spawner.spawn({ prompt: "succeed" });
      expect(result2.success).toBe(true);
      expect(result2.output).toBe("recovered");
      expect(result2.toolCallsUsed).toBe(0);
    });
  });

  // ── blocked tools filter ────────────────────────────────────────────

  describe("blocked tools filter", () => {
    it("should prevent agent.spawn and cron.manage from appearing in subagent tool set", async () => {
      const { getAllToolsForMode } = await import("../tool-registry.js");
      (getAllToolsForMode as ReturnType<typeof vi.fn>).mockReturnValue([
        { name: "knowledge.search", type: "function", function: { name: "knowledge.search", description: "Search", parameters: {} } },
        { name: "agent.spawn", type: "function", function: { name: "agent.spawn", description: "Spawn", parameters: {} } },
        { name: "cron.manage", type: "function", function: { name: "cron.manage", description: "Cron", parameters: {} } },
        { name: "file.read", type: "function", function: { name: "file.read", description: "Read", parameters: {} } },
      ]);

      await spawner.spawn({ prompt: "use tools" });

      const call = mockChat.mock.calls[0][0];
      const toolNames = (call.tools || []).map((t: any) => t.function?.name || t.name);
      expect(toolNames).toContain("knowledge.search");
      expect(toolNames).toContain("file.read");
      expect(toolNames).not.toContain("agent.spawn");
      expect(toolNames).not.toContain("cron.manage");
    });
  });
});
