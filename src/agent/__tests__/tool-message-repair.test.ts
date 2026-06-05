import { describe, it, expect } from "vitest";
import { sanitizeToolName, repairToolMessagePairs } from "../providers/tool-message-repair";
import type { ChatMessage, AssistantMessage, ToolMessage } from "../providers/tool-message-repair";

describe("sanitizeToolName", () => {
  it("should replace non-alphanumeric/dash/underscore chars with underscore", () => {
    expect(sanitizeToolName("my-tool_v1")).toBe("my-tool_v1");
    expect(sanitizeToolName("my tool")).toBe("my_tool");
    expect(sanitizeToolName("tool.name")).toBe("tool_name");
    expect(sanitizeToolName("tool/name")).toBe("tool_name");
    expect(sanitizeToolName("tool@v2!")).toBe("tool_v2_");
  });

  it("should handle empty string", () => {
    expect(sanitizeToolName("")).toBe("");
  });
});

describe("repairToolMessagePairs", () => {
  // ── Happy path: all pairs intact ────────────────────────────────────

  it("should pass through matched assistant/tool pairs unchanged", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "do something" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc1", function: { name: "read_file" } }],
      } as AssistantMessage,
      { role: "tool", content: "file contents", tool_call_id: "tc1" } as ToolMessage,
      { role: "assistant", content: "Done" },
    ];

    const result = repairToolMessagePairs(messages);
    expect(result).toHaveLength(4);
    expect(result[1]).toHaveProperty("tool_calls");
    expect(result[2]).toHaveProperty("tool_call_id", "tc1");
  });

  it("should handle multiple tool calls in a single assistant message", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", function: { name: "read_file" } },
          { id: "tc2", function: { name: "write_file" } },
        ],
      } as AssistantMessage,
      { role: "tool", content: "file1", tool_call_id: "tc1" } as ToolMessage,
      { role: "tool", content: "file2", tool_call_id: "tc2" } as ToolMessage,
    ];

    const result = repairToolMessagePairs(messages);
    expect(result).toHaveLength(3);
  });

  // ── Orphaned tool calls (no matching tool responses) ────────────────

  it("should strip tool_calls from assistant when no tool responses follow", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "I tried to call a tool",
        tool_calls: [{ id: "tc1", function: { name: "read_file" } }],
      } as AssistantMessage,
      { role: "assistant", content: "Moving on" },
    ];

    const result = repairToolMessagePairs(messages);
    expect(result).toHaveLength(2);
    // First assistant should have tool_calls stripped but content preserved
    expect(result[0]).not.toHaveProperty("tool_calls");
    expect((result[0] as { content: string }).content).toBe("I tried to call a tool");
  });

  it("should keep orphaned assistant even with no content to preserve role alternation", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc1", function: { name: "read_file" } }],
      } as AssistantMessage,
      { role: "assistant", content: "Next message" },
    ];

    const result = repairToolMessagePairs(messages);
    // Assistant kept to avoid breaking role alternation (required by Z.ai/GLM)
    expect(result).toHaveLength(2);
    expect(result[0]).not.toHaveProperty("tool_calls");
    expect((result[0] as { content: string }).content).toBe("");
    expect((result[1] as { content: string }).content).toBe("Next message");
  });

  // ── Orphaned tool responses (no matching tool call) ─────────────────

  it("should drop orphaned tool responses", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "tool", content: "orphaned response", tool_call_id: "tc-missing" } as ToolMessage,
      { role: "assistant", content: "Response" },
    ];

    const result = repairToolMessagePairs(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty("role", "user");
    expect(result[1]).toHaveProperty("role", "assistant");
  });

  // ── Partial matches ─────────────────────────────────────────────────

  it("should keep matched tool calls when only some have responses", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", function: { name: "read_file" } },
          { id: "tc2", function: { name: "write_file" } },
        ],
      } as AssistantMessage,
      { role: "tool", content: "file1", tool_call_id: "tc1" } as ToolMessage,
    ];

    const result = repairToolMessagePairs(messages);
    // Should keep tc1 with its response, drop tc2
    expect(result).toHaveLength(2);
    const assistant = result[0] as AssistantMessage;
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls![0].id).toBe("tc1");
  });

  it("should keep assistant with empty content when no tool calls match responses", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", function: { name: "read_file" } },
        ],
      } as AssistantMessage,
      { role: "tool", content: "orphan", tool_call_id: "tc-different" } as ToolMessage,
      { role: "user", content: "next" },
    ];

    const result = repairToolMessagePairs(messages);
    // Assistant should be kept (with empty content) to preserve role alternation;
    // orphaned tool response is dropped.
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty("role", "assistant");
    expect((result[0] as { content: string }).content).toBe("");
    expect(result[1]).toHaveProperty("role", "user");
  });

  // ── Non-tool messages ───────────────────────────────────────────────

  it("should pass through non-tool messages unchanged", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];

    const result = repairToolMessagePairs(messages);
    expect(result).toEqual(messages);
  });

  it("should handle empty message array", () => {
    expect(repairToolMessagePairs([])).toEqual([]);
  });
});
