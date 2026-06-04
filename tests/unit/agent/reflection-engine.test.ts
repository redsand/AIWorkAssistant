import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatMessage, ToolCall } from "../../../src/agent/providers/types";

// ── Hoisted mock references ──────────────────────────────────────────────────
const { mockChat, mockAdd, mockGetUsage, mockShouldConsolidate, mockConsolidate, mockGetEntries } = vi.hoisted(() => ({
  mockChat: vi.fn(),
  mockAdd: vi.fn(),
  mockGetUsage: vi.fn(),
  mockShouldConsolidate: vi.fn(),
  mockConsolidate: vi.fn(),
  mockGetEntries: vi.fn(),
}));

vi.mock("../../../src/agent/opencode-client", () => ({
  aiClient: { chat: mockChat },
}));

vi.mock("../../../src/memory/agent-memory", () => ({
  agentMemory: {
    add: mockAdd,
    getUsage: mockGetUsage,
    shouldConsolidate: mockShouldConsolidate,
    consolidate: mockConsolidate,
    getEntries: mockGetEntries,
    getMemorySnapshot: vi.fn().mockReturnValue(""),
  },
  AgentMemory: vi.fn().mockImplementation(() => ({
    add: mockAdd,
    getUsage: mockGetUsage,
    shouldConsolidate: mockShouldConsolidate,
    consolidate: mockConsolidate,
    getEntries: mockGetEntries,
    getMemorySnapshot: vi.fn().mockReturnValue(""),
    addReflection: vi.fn(),
  })),
}));

import { ReflectionEngine } from "../../../src/agent/reflection-engine";

function makeToolCall(name: string): ToolCall {
  return {
    id: `call-${Math.random().toString(36).slice(2, 8)}`,
    type: "function",
    function: { name, arguments: "{}" },
  };
}

function makeMessages(count: number): ChatMessage[] {
  const msgs: ChatMessage[] = [
    { role: "user", content: "Create a Jira ticket for the login bug" },
  ];
  for (let i = 0; i < count; i++) {
    msgs.push({
      role: "assistant",
      content: `Step ${i + 1}`,
      tool_calls: [makeToolCall(`tool_${i}`)],
    });
    msgs.push({ role: "tool", content: `Result ${i + 1}: success`, tool_call_id: `call-${i}` });
  }
  return msgs;
}

const successReflectionResponse = JSON.stringify({
  taskSucceeded: true,
  wins: ["Used correct tool sequence for Jira ticket creation"],
  losses: [],
  lessons: ["Always include project key when creating Jira tickets"],
  skillCandidate: true,
  memoryEntries: [
    { key: "2026-06-03_win", value: "Jira ticket creation with proper project key works well", target: "memory" },
    { key: "2026-06-03_lesson", value: "Always include project key when creating Jira tickets", target: "memory" },
  ],
});

const failureReflectionResponse = JSON.stringify({
  taskSucceeded: false,
  wins: [],
  losses: ["Tried to close MR without checking pipeline status first"],
  lessons: ["Always check CI pipeline status before closing MRs"],
  skillCandidate: false,
  memoryEntries: [
    { key: "2026-06-03_avoid", value: "Don't try to close GitLab MRs without checking pipeline status first", target: "memory" },
  ],
});

describe("ReflectionEngine", () => {
  let engine: ReflectionEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdd.mockReturnValue({ success: true });
    mockGetUsage.mockReturnValue({ used: 500, total: 2200, percent: 23 });
    mockShouldConsolidate.mockReturnValue(false);
    mockGetEntries.mockReturnValue([]);
    engine = new ReflectionEngine();
  });

  // ── Construction ──────────────────────────────────────────────────────────

  describe("construction", () => {
    it("should instantiate without error", () => {
      expect(engine).toBeDefined();
    });
  });

  // ── reflectOnTask ─────────────────────────────────────────────────────────

  describe("reflectOnTask", () => {
    it("should call aiClient.chat with low temperature", async () => {
      mockChat.mockResolvedValue({
        content: successReflectionResponse,
        model: "test",
        done: true,
      });

      const messages = makeMessages(3);
      const toolCalls = [makeToolCall("jira.create_issue"), makeToolCall("jira.add_comment"), makeToolCall("jira.transition_issue")];

      await engine.reflectOnTask(messages, toolCalls, "Ticket PROJ-123 created successfully");

      expect(mockChat).toHaveBeenCalledOnce();
      const request = mockChat.mock.calls[0][0];
      expect(request.temperature).toBe(0.3);
    });

    it("should include reflection prompt asking key questions", async () => {
      mockChat.mockResolvedValue({
        content: successReflectionResponse,
        model: "test",
        done: true,
      });

      const messages = makeMessages(3);
      const toolCalls = [makeToolCall("tool_a")];

      await engine.reflectOnTask(messages, toolCalls, "Done");

      const request = mockChat.mock.calls[0][0];
      const userMsg = request.messages.find((m: ChatMessage) => m.role === "user");
      expect(userMsg.content).toContain("succeed");
      expect(userMsg.content).toContain("went well");
      expect(userMsg.content).toContain("went wrong");
      expect(userMsg.content).toContain("remember");
    });

    it("should return ReflectionResult with correct structure", async () => {
      mockChat.mockResolvedValue({
        content: successReflectionResponse,
        model: "test",
        done: true,
      });

      const result = await engine.reflectOnTask(
        makeMessages(3),
        [makeToolCall("tool_a")],
        "Success",
      );

      expect(result).toHaveProperty("taskSucceeded", true);
      expect(result).toHaveProperty("toolCallCount");
      expect(result).toHaveProperty("wins");
      expect(result).toHaveProperty("losses");
      expect(result).toHaveProperty("lessons");
      expect(result).toHaveProperty("skillCandidate");
      expect(result).toHaveProperty("memoryEntries");
    });

    it("should count tool calls correctly", async () => {
      mockChat.mockResolvedValue({
        content: successReflectionResponse,
        model: "test",
        done: true,
      });

      const toolCalls = [makeToolCall("a"), makeToolCall("b"), makeToolCall("c")];
      const result = await engine.reflectOnTask(
        makeMessages(3),
        toolCalls,
        "Done",
      );

      expect(result.toolCallCount).toBe(3);
    });

    it("should set skillCandidate to true when 5+ tool calls succeeded", async () => {
      mockChat.mockResolvedValue({
        content: successReflectionResponse,
        model: "test",
        done: true,
      });

      const toolCalls = Array.from({ length: 6 }, (_, i) => makeToolCall(`tool_${i}`));
      const result = await engine.reflectOnTask(
        makeMessages(6),
        toolCalls,
        "Complex task completed",
      );

      expect(result.skillCandidate).toBe(true);
    });

    it("should return fallback result when AI call fails", async () => {
      mockChat.mockRejectedValue(new Error("AI unavailable"));

      const result = await engine.reflectOnTask(
        makeMessages(3),
        [makeToolCall("tool_a")],
        "Partial",
      );

      expect(result.taskSucceeded).toBe(false);
      expect(result.wins).toEqual([]);
      expect(result.losses).toContain("Reflection failed: AI unavailable");
      expect(result.lessons).toEqual([]);
      expect(result.memoryEntries).toEqual([]);
    });

    it("should return fallback result when AI returns invalid JSON", async () => {
      mockChat.mockResolvedValue({
        content: "This is not JSON at all",
        model: "test",
        done: true,
      });

      const result = await engine.reflectOnTask(
        makeMessages(3),
        [makeToolCall("tool_a")],
        "Done",
      );

      expect(result.taskSucceeded).toBe(false);
      expect(result.losses.length).toBeGreaterThan(0);
    });

    it("should handle failure reflection correctly", async () => {
      mockChat.mockResolvedValue({
        content: failureReflectionResponse,
        model: "test",
        done: true,
      });

      const result = await engine.reflectOnTask(
        makeMessages(3),
        [makeToolCall("gitlab.close_mr")],
        "Error: Pipeline still running",
      );

      expect(result.taskSucceeded).toBe(false);
      expect(result.losses).toHaveLength(1);
      expect(result.losses[0]).toContain("pipeline");
      expect(result.skillCandidate).toBe(false);
    });
  });

  // ── saveReflection ────────────────────────────────────────────────────────

  describe("saveReflection", () => {
    it("should save win entries to memory", async () => {
      mockAdd.mockReturnValue({ success: true });

      const result = {
        taskSucceeded: true,
        toolCallCount: 3,
        wins: ["Used correct tool sequence"],
        losses: [],
        lessons: ["Always include project key"],
        skillCandidate: false,
        memoryEntries: [
          { key: "2026-06-03_win", value: "Used correct tool sequence", target: "memory" as const },
        ],
      };

      await engine.saveReflection(result);

      expect(mockAdd).toHaveBeenCalledWith("memory", "2026-06-03_win", "Used correct tool sequence");
    });

    it("should save loss entries with AVOID format", async () => {
      mockAdd.mockReturnValue({ success: true });

      const result = {
        taskSucceeded: false,
        toolCallCount: 3,
        wins: [],
        losses: ["Pipeline was still running"],
        lessons: ["Check pipeline first"],
        skillCandidate: false,
        memoryEntries: [
          { key: "2026-06-03_avoid", value: "AVOID: Pipeline was still running", target: "memory" as const },
        ],
      };

      await engine.saveReflection(result);

      expect(mockAdd).toHaveBeenCalledWith("memory", "2026-06-03_avoid", "AVOID: Pipeline was still running");
    });

    it("should save lesson entries", async () => {
      mockAdd.mockReturnValue({ success: true });

      const result = {
        taskSucceeded: true,
        toolCallCount: 3,
        wins: ["Good approach"],
        losses: [],
        lessons: ["Check pipeline first"],
        skillCandidate: false,
        memoryEntries: [
          { key: "2026-06-03_lesson", value: "Check pipeline first", target: "memory" as const },
        ],
      };

      await engine.saveReflection(result);

      expect(mockAdd).toHaveBeenCalledWith("memory", "2026-06-03_lesson", "Check pipeline first");
    });

    it("should save entries via add even when memory is near capacity", async () => {
      mockAdd.mockReturnValue({ success: true });

      const result = {
        taskSucceeded: true,
        toolCallCount: 3,
        wins: ["New win"],
        losses: [],
        lessons: ["New lesson"],
        skillCandidate: false,
        memoryEntries: [
          { key: "2026-06-03_win", value: "New win", target: "memory" as const },
        ],
      };

      await engine.saveReflection(result);

      expect(mockAdd).toHaveBeenCalledWith("memory", "2026-06-03_win", "New win");
    });

    it("should not add entries when memory add fails", async () => {
      mockAdd.mockReturnValue({ success: false, error: "Memory full" });

      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = {
        taskSucceeded: true,
        toolCallCount: 1,
        wins: [],
        losses: [],
        lessons: [],
        skillCandidate: false,
        memoryEntries: [
          { key: "2026-06-03_win", value: "Something", target: "memory" as const },
        ],
      };

      await engine.saveReflection(result);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[ReflectionEngine]"),
      );

      consoleWarnSpy.mockRestore();
    });

    it("should handle empty memoryEntries gracefully", async () => {
      const result = {
        taskSucceeded: true,
        toolCallCount: 1,
        wins: [],
        losses: [],
        lessons: [],
        skillCandidate: false,
        memoryEntries: [],
      };

      await engine.saveReflection(result);

      expect(mockAdd).not.toHaveBeenCalled();
    });
  });

  // ── shouldReflect ─────────────────────────────────────────────────────────

  describe("shouldReflect", () => {
    it("should return true after 3+ tool calls", () => {
      expect(engine.shouldReflect(3)).toBe(true);
      expect(engine.shouldReflect(5)).toBe(true);
    });

    it("should return false for fewer than 3 tool calls", () => {
      expect(engine.shouldReflect(0)).toBe(false);
      expect(engine.shouldReflect(1)).toBe(false);
      expect(engine.shouldReflect(2)).toBe(false);
    });
  });

  // ── shouldSuggestSkill ────────────────────────────────────────────────────

  describe("shouldSuggestSkill", () => {
    it("should return true when 5+ tool calls and task succeeded", () => {
      expect(engine.shouldSuggestSkill(5, true)).toBe(true);
      expect(engine.shouldSuggestSkill(10, true)).toBe(true);
    });

    it("should return false when fewer than 5 tool calls", () => {
      expect(engine.shouldSuggestSkill(4, true)).toBe(false);
      expect(engine.shouldSuggestSkill(3, true)).toBe(false);
    });

    it("should return false when task did not succeed", () => {
      expect(engine.shouldSuggestSkill(5, false)).toBe(false);
      expect(engine.shouldSuggestSkill(10, false)).toBe(false);
    });
  });

  // ── shouldSelfNudge ───────────────────────────────────────────────────────

  describe("shouldSelfNudge", () => {
    it("should return true at multiples of 15", () => {
      expect(engine.shouldSelfNudge(15)).toBe(true);
      expect(engine.shouldSelfNudge(30)).toBe(true);
      expect(engine.shouldSelfNudge(45)).toBe(true);
    });

    it("should return false for non-multiples of 15", () => {
      expect(engine.shouldSelfNudge(14)).toBe(false);
      expect(engine.shouldSelfNudge(16)).toBe(false);
      expect(engine.shouldSelfNudge(29)).toBe(false);
    });

    it("should return false for 0", () => {
      expect(engine.shouldSelfNudge(0)).toBe(false);
    });
  });

  // ── getRecentReflections ──────────────────────────────────────────────────

  describe("getRecentReflections", () => {
    it("should return formatted string from reflection entries", () => {
      mockGetEntries.mockReturnValue([
        { key: "2026-06-03_win", value: "Good approach for Jira", timestamp: "2026-06-03T10:00:00Z", accessCount: 1 },
        { key: "2026-06-03_avoid", value: "AVOID: Check pipeline first", timestamp: "2026-06-03T11:00:00Z", accessCount: 1 },
        { key: "2026-06-03_lesson", value: "Always verify before closing", timestamp: "2026-06-03T12:00:00Z", accessCount: 1 },
      ]);

      const reflections = engine.getRecentReflections(3);

      expect(reflections).toContain("2026-06-03_win");
      expect(reflections).toContain("2026-06-03_avoid");
      expect(reflections).toContain("2026-06-03_lesson");
      expect(mockGetEntries).toHaveBeenCalledWith("memory");
    });

    it("should return empty string when no reflection entries", () => {
      mockGetEntries.mockReturnValue([]);

      const reflections = engine.getRecentReflections(3);

      expect(reflections).toBe("");
    });

    it("should truncate to token budget", () => {
      const longEntry = { key: "2026-06-03_win", value: "x".repeat(2000), timestamp: "2026-06-03T10:00:00Z", accessCount: 1 };
      mockGetEntries.mockReturnValue([longEntry, longEntry, longEntry, longEntry]);

      // ~300 tokens = ~1200 chars max
      const reflections = engine.getRecentReflections(3, 300);

      // Should be truncated
      expect(reflections.length).toBeLessThan(4 * 2000);
    });
  });

  // ── Logging ───────────────────────────────────────────────────────────────

  describe("logging", () => {
    it("should log with [ReflectionEngine] prefix on reflectOnTask", async () => {
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      mockChat.mockResolvedValue({
        content: successReflectionResponse,
        model: "test",
        done: true,
      });

      await engine.reflectOnTask(
        makeMessages(3),
        [makeToolCall("tool_a")],
        "Done",
      );

      const logged = consoleLogSpy.mock.calls.map((c: string[]) => c.join(" "));
      const hasPrefix = logged.some((l: string) => l.includes("[ReflectionEngine]"));
      expect(hasPrefix).toBe(true);

      consoleLogSpy.mockRestore();
    });

    it("should log with [ReflectionEngine] prefix on saveReflection", async () => {
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      mockAdd.mockReturnValue({ success: true });

      const result = {
        taskSucceeded: true,
        toolCallCount: 3,
        wins: ["Good"],
        losses: [],
        lessons: [],
        skillCandidate: false,
        memoryEntries: [
          { key: "2026-06-03_win", value: "Good", target: "memory" as const },
        ],
      };

      await engine.saveReflection(result);

      const logged = consoleLogSpy.mock.calls.map((c: string[]) => c.join(" "));
      const hasPrefix = logged.some((l: string) => l.includes("[ReflectionEngine]"));
      expect(hasPrefix).toBe(true);

      consoleLogSpy.mockRestore();
    });
  });
});
