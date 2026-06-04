import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock references (accessible inside vi.mock factories) ─────────
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

// ── Mock dependencies ────────────────────────────────────────────────────
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
import type { SubagentConfig } from "../subagent-spawner";

describe("SubagentSpawner", () => {
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

  // ── config validation ────────────────────────────────────────────────

  describe("config validation", () => {
    it("should reject missing prompt", async () => {
      const result = await spawner.spawn({ prompt: "" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("prompt is required");
    });

    it("should reject non-string prompt", async () => {
      const result = await spawner.spawn({ prompt: 42 as unknown as string });
      expect(result.success).toBe(false);
      expect(result.error).toContain("prompt is required");
    });

    it("should reject when AI provider not configured", async () => {
      mockIsConfigured.mockReturnValue(false);
      const result = await spawner.spawn({ prompt: "do something" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("AI provider not configured");
    });

    it("should reject spawn from within a subagent session", async () => {
      const result = await spawner.spawn({
        prompt: "do something",
        _isSubagent: true,
      } as SubagentConfig & { _isSubagent: boolean });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Recursive spawning");
    });
  });

  // ── basic spawn ──────────────────────────────────────────────────────

  describe("basic spawn", () => {
    it("should return structured SubagentResult on success", async () => {
      const result = await spawner.spawn({ prompt: "Research X" });

      expect(result.success).toBe(true);
      expect(result.output).toBe("Task completed successfully.");
      expect(result.toolCallsUsed).toBe(0);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it("should call aiClient.chat with system prompt and user prompt", async () => {
      await spawner.spawn({ prompt: "Research X" });

      expect(mockChat).toHaveBeenCalledTimes(1);
      const call = mockChat.mock.calls[0][0];
      expect(call.messages[0].role).toBe("system");
      expect(call.messages[0].content).toContain("subagent");
      expect(call.messages[1].role).toBe("user");
      expect(call.messages[1].content).toBe("Research X");
    });

    it("should handle AI client errors gracefully", async () => {
      mockChat.mockRejectedValue(new Error("model overloaded"));

      const result = await spawner.spawn({ prompt: "do work" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("model overloaded");
    });

    it("should track duration in result", async () => {
      const result = await spawner.spawn({ prompt: "quick task" });
      expect(typeof result.duration).toBe("number");
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  // ── tool call loop ───────────────────────────────────────────────────

  describe("tool call loop", () => {
    it("should dispatch tool calls and continue the loop", async () => {
      const toolCall = {
        id: "tc_1",
        type: "function" as const,
        function: { name: "knowledge.search", arguments: '{"query":"test"}' },
      };

      mockChat
        .mockResolvedValueOnce({
          content: "",
          toolCalls: [toolCall],
          model: "test-model",
          done: true,
        })
        .mockResolvedValueOnce({
          content: "Found 3 results.",
          model: "test-model",
          done: true,
        });

      mockDispatchToolCall.mockResolvedValue({
        success: true,
        data: { results: [] },
      });

      const result = await spawner.spawn({ prompt: "search for X" });

      expect(result.success).toBe(true);
      expect(result.toolCallsUsed).toBe(1);
      expect(result.output).toBe("Found 3 results.");
      expect(mockDispatchToolCall).toHaveBeenCalledWith(
        "knowledge.search",
        { query: "test" },
        "subagent",
        true,
        expect.objectContaining({ isSubagent: true }),
      );
    });

    it("should respect maxToolCalls limit", async () => {
      const toolCall = {
        id: "tc_1",
        type: "function" as const,
        function: { name: "knowledge.search", arguments: '{"query":"test"}' },
      };

      // Return tool calls on every invocation (infinite loop potential)
      mockChat.mockResolvedValue({
        content: "",
        toolCalls: [toolCall],
        model: "test-model",
        done: true,
      });

      mockDispatchToolCall.mockResolvedValue({
        success: true,
        data: {},
      });

      const result = await spawner.spawn({
        prompt: "infinite tool calls",
        maxToolCalls: 3,
      });

      expect(result.success).toBe(true);
      // Should stop after 3 tool calls (0-indexed iterations hit the limit)
      expect(result.toolCallsUsed).toBeLessThanOrEqual(3);
    });

    it("should exclude spawn and cron tools from subagent tool set", async () => {
      const { getAllToolsForMode } = await import("../tool-registry.js");
      (getAllToolsForMode as ReturnType<typeof vi.fn>).mockReturnValue([
        { name: "knowledge.search", type: "function", function: { name: "knowledge.search", description: "Search", parameters: {} } },
        { name: "agent.spawn", type: "function", function: { name: "agent.spawn", description: "Spawn", parameters: {} } },
        { name: "cron.manage", type: "function", function: { name: "cron.manage", description: "Cron", parameters: {} } },
      ]);

      await spawner.spawn({ prompt: "use tools" });

      const call = mockChat.mock.calls[0][0];
      const toolNames = (call.tools || []).map((t: any) => t.function?.name || t.name);
      expect(toolNames).toContain("knowledge.search");
      expect(toolNames).not.toContain("agent.spawn");
      expect(toolNames).not.toContain("cron.manage");
    });

    it("should include tools.discover and tools.fetch_cached in subagent tool set", async () => {
      const { getAllToolsForMode } = await import("../tool-registry.js");
      (getAllToolsForMode as ReturnType<typeof vi.fn>).mockReturnValue([
        { name: "tools.discover", type: "function", function: { name: "tools.discover", description: "Discover", parameters: {} } },
        { name: "tools.fetch_cached", type: "function", function: { name: "tools.fetch_cached", description: "Fetch cached", parameters: {} } },
        { name: "agent.spawn", type: "function", function: { name: "agent.spawn", description: "Spawn", parameters: {} } },
      ]);

      await spawner.spawn({ prompt: "use tools" });

      const call = mockChat.mock.calls[0][0];
      const toolNames = (call.tools || []).map((t: any) => t.function?.name || t.name);
      expect(toolNames).toContain("tools.discover");
      expect(toolNames).toContain("tools.fetch_cached");
      expect(toolNames).not.toContain("agent.spawn");
    });
  });

  // ── memory inheritance ───────────────────────────────────────────────

  describe("memory inheritance", () => {
    it("should inject MEMORY.md entries into system prompt when inheritMemory is true", async () => {
      mockGetEntries.mockReturnValue([
        { key: "preference_theme", value: "dark mode", timestamp: "", accessCount: 1 },
      ]);

      await spawner.spawn({
        prompt: "respect preferences",
        inheritMemory: true,
      });

      const call = mockChat.mock.calls[0][0];
      expect(call.messages[0].content).toContain("dark mode");
    });

    it("should inject SOUL.md into system prompt when inheritMemory is true", async () => {
      await spawner.spawn({
        prompt: "respect preferences",
        inheritMemory: true,
      });

      const call = mockChat.mock.calls[0][0];
      expect(call.messages[0].content).toContain("Test soul");
    });

    it("should skip memory/soul injection when inheritMemory is false", async () => {
      mockGetEntries.mockReturnValue([
        { key: "preference_theme", value: "dark mode", timestamp: "", accessCount: 1 },
      ]);

      await spawner.spawn({
        prompt: "fresh context",
        inheritMemory: false,
      });

      const call = mockChat.mock.calls[0][0];
      expect(call.messages[0].content).not.toContain("dark mode");
    });
  });

  // ── timeout handling ─────────────────────────────────────────────────

  describe("timeout handling", () => {
    it("should timeout if AI call exceeds the configured timeout", async () => {
      // Make chat hang forever
      mockChat.mockReturnValue(new Promise(() => { /* never resolves */ }));

      const result = await spawner.spawn({
        prompt: "slow task",
        timeout: 100, // 100ms
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out");
    }, 10000);
  });

  // ── skills loading ───────────────────────────────────────────────────

  describe("skills loading", () => {
    it("should inject skill summaries into system prompt when skills specified", async () => {
      mockGetSummariesText.mockReturnValue("## Research Skill\nSteps: 1, 2, 3");

      await spawner.spawn({
        prompt: "do research",
        skills: ["research"],
      });

      const call = mockChat.mock.calls[0][0];
      expect(call.messages[0].content).toContain("Research Skill");
    });

    it("should not inject skills when none specified", async () => {
      mockGetSummariesText.mockReturnValue("## Research Skill\nSteps: 1, 2, 3");

      await spawner.spawn({ prompt: "no skills" });

      const call = mockChat.mock.calls[0][0];
      expect(call.messages[0].content).not.toContain("Research Skill");
    });
  });
});
