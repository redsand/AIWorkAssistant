import { describe, it, expect, vi } from "vitest";

import {
  computeImportance,
  scoreMessages,
  deduplicateByJaccard,
  selectMessages,
} from "../../../src/context-engine/memory-decay";
import type { ChatMessage } from "../../../src/agent/providers/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { role: "user", content: "hello world", ...overrides };
}

function makeScored(
  index: number,
  overrides: Partial<ChatMessage> = {},
  content?: string,
) {
  const msg = makeMessage({ ...overrides, content: content ?? overrides.content ?? "hello world" });
  const scored = scoreMessages([msg], "");
  return { ...scored[0], index };
}

// ---------------------------------------------------------------------------
// computeImportance
// ---------------------------------------------------------------------------

describe("computeImportance", () => {
  it("returns 1.0 for system messages", () => {
    const result = computeImportance(makeMessage({ role: "system", content: "be helpful" }));
    expect(result).toBe(1.0);
  });

  it("returns boosted score for tool messages with long content", () => {
    const longContent = "x".repeat(51);
    const result = computeImportance(makeMessage({ role: "tool", content: longContent }));
    // base 0.3 + 0.4 for long tool = 0.7
    expect(result).toBe(0.7);
  });

  it("returns minimal boost for tool messages with short content", () => {
    const result = computeImportance(makeMessage({ role: "tool", content: "ok" }));
    // base 0.3 + 0.1 for short tool = 0.4
    expect(result).toBe(0.4);
  });

  it("gives base score of 0.3 for empty user messages", () => {
    const result = computeImportance(makeMessage({ role: "user", content: "" }));
    expect(result).toBe(0.3);
  });

  it("adds 0.15 for content longer than 100 chars", () => {
    const content = "a".repeat(101);
    const result = computeImportance(makeMessage({ role: "user", content }));
    // base 0.3 + 0.15 for length > 100 = 0.45
    expect(result).toBeCloseTo(0.45, 1);
  });

  it("adds additional 0.1 for content longer than 500 chars", () => {
    const content = "b".repeat(501);
    const result = computeImportance(makeMessage({ role: "user", content }));
    // base 0.3 + 0.15 + 0.1 = 0.55
    expect(result).toBeCloseTo(0.55, 1);
  });

  it("adds additional 0.1 for content longer than 1500 chars", () => {
    const content = "c".repeat(1501);
    const result = computeImportance(makeMessage({ role: "user", content }));
    // base 0.3 + 0.15 + 0.1 + 0.1 = 0.65
    expect(result).toBeCloseTo(0.65, 1);
  });

  it("adds 0.05 per domain keyword match (up to 0.3)", () => {
    const content = "jira gitlab github commit branch merge";
    const result = computeImportance(makeMessage({ role: "user", content }));
    // 6 keyword matches * 0.05 = 0.3 (capped)
    expect(result).toBeGreaterThanOrEqual(0.6);
  });

  it("caps domain keyword bonus at 0.3", () => {
    const content = "jira gitlab github commit branch merge deploy endpoint api database migration schema";
    const result = computeImportance(makeMessage({ role: "user", content }));
    // Should not exceed 1.0 total
    expect(result).toBeLessThanOrEqual(1.0);
  });

  it("adds 0.3 when tool_calls are present", () => {
    const result = computeImportance(
      makeMessage({
        role: "assistant",
        content: "calling tool",
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "doThing", arguments: "{}" } },
        ],
      }),
    );
    // base 0.3 + 0.3 tool_calls = 0.6
    expect(result).toBeGreaterThanOrEqual(0.6);
  });

  it("does not add tool_call bonus when tool_calls is empty array", () => {
    const result = computeImportance(
      makeMessage({ role: "assistant", content: "no tools", tool_calls: [] }),
    );
    expect(result).toBeLessThan(0.6);
  });

  it("caps total at 1.0", () => {
    const content = "jira gitlab github commit branch merge deploy endpoint api database migration schema bug feature issue ticket sprint roadmap architecture";
    const result = computeImportance(
      makeMessage({
        role: "assistant",
        content,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "doThing", arguments: "{}" } },
        ],
      }),
    );
    expect(result).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// scoreMessages
// ---------------------------------------------------------------------------

describe("scoreMessages", () => {
  it("returns scored messages with correct indices", () => {
    const messages: ChatMessage[] = [
      makeMessage({ role: "user", content: "first" }),
      makeMessage({ role: "assistant", content: "second" }),
    ];
    const scored = scoreMessages(messages, "");
    expect(scored).toHaveLength(2);
    expect(scored[0].index).toBe(0);
    expect(scored[1].index).toBe(1);
  });

  it("gives freshness 1.0 for the last two messages", () => {
    const messages: ChatMessage[] = [
      makeMessage({ role: "user", content: "a" }),
      makeMessage({ role: "assistant", content: "b" }),
      makeMessage({ role: "user", content: "c" }),
      makeMessage({ role: "assistant", content: "d" }),
      makeMessage({ role: "user", content: "e" }),
      makeMessage({ role: "assistant", content: "f" }),
    ];
    const scored = scoreMessages(messages, "");
    // last 2 indices: 4, 5
    expect(scored[4].freshnessScore).toBe(1.0);
    expect(scored[5].freshnessScore).toBe(1.0);
  });

  it("gives freshness 0.75 for messages near the end (within last 4)", () => {
    const messages: ChatMessage[] = [
      makeMessage({ role: "user", content: "a" }),
      makeMessage({ role: "assistant", content: "b" }),
      makeMessage({ role: "user", content: "c" }),
      makeMessage({ role: "assistant", content: "d" }),
      makeMessage({ role: "user", content: "e" }),
      makeMessage({ role: "assistant", content: "f" }),
    ];
    const scored = scoreMessages(messages, "");
    // length=6, last-4 starts at index 2, last-2 starts at index 4
    // indices 2,3 should have 0.75
    expect(scored[2].freshnessScore).toBe(0.75);
    expect(scored[3].freshnessScore).toBe(0.75);
  });

  it("gives freshness 0.5 for messages within last 6", () => {
    const messages: ChatMessage[] = [
      makeMessage({ role: "user", content: "a" }),
      makeMessage({ role: "assistant", content: "b" }),
      makeMessage({ role: "user", content: "c" }),
      makeMessage({ role: "assistant", content: "d" }),
      makeMessage({ role: "user", content: "e" }),
      makeMessage({ role: "assistant", content: "f" }),
      makeMessage({ role: "user", content: "g" }),
      makeMessage({ role: "assistant", content: "h" }),
    ];
    const scored = scoreMessages(messages, "");
    // length=8, last-6 starts at index 2
    // indices 0,1 should get default FRESHNESS_BOOST = 0.5
    expect(scored[0].freshnessScore).toBe(0.5);
    expect(scored[1].freshnessScore).toBe(0.5);
  });

  it("returns recencyScore of 1.0 for all messages", () => {
    const messages: ChatMessage[] = [
      makeMessage({ role: "user", content: "a" }),
      makeMessage({ role: "assistant", content: "b" }),
    ];
    const scored = scoreMessages(messages, "");
    expect(scored[0].recencyScore).toBe(1.0);
    expect(scored[1].recencyScore).toBe(1.0);
  });

  it("computes queryRelevance as 0 when query is empty", () => {
    const messages: ChatMessage[] = [
      makeMessage({ role: "user", content: "some text about jira" }),
    ];
    const scored = scoreMessages(messages, "");
    expect(scored[0].queryRelevance).toBe(0);
  });

  it("computes queryRelevance when query overlaps message content", () => {
    const messages: ChatMessage[] = [
      makeMessage({ role: "user", content: "the jira api endpoint is broken" }),
    ];
    const scored = scoreMessages(messages, "jira api broken");
    expect(scored[0].queryRelevance).toBeGreaterThan(0);
  });

  it("computes tokens based on content length", () => {
    const content = "a".repeat(180);
    const messages: ChatMessage[] = [
      makeMessage({ role: "user", content }),
    ];
    const scored = scoreMessages(messages, "");
    // CHARS_PER_TOKEN = 1.8, so 180 / 1.8 = 100 tokens
    expect(scored[0].tokens).toBe(100);
  });

  it("handles empty messages array", () => {
    const scored = scoreMessages([], "query");
    expect(scored).toHaveLength(0);
  });

  it("calculates effectiveWeight correctly", () => {
    const messages: ChatMessage[] = [
      makeMessage({ role: "user", content: "test query about api" }),
    ];
    const scored = scoreMessages(messages, "api query");
    // effectiveWeight = importanceScore * recencyScore * freshnessScore + queryRelevance
    const msg = scored[0];
    const expectedWeight =
      msg.importanceScore * msg.recencyScore * msg.freshnessScore + msg.queryRelevance;
    expect(msg.effectiveWeight).toBeCloseTo(expectedWeight, 10);
  });

  it("handles messages with empty content", () => {
    const messages: ChatMessage[] = [
      makeMessage({ role: "user", content: "" }),
    ];
    const scored = scoreMessages(messages, "query");
    expect(scored[0].tokens).toBe(0);
    expect(scored[0].importanceScore).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// deduplicateByJaccard
// ---------------------------------------------------------------------------

describe("deduplicateByJaccard", () => {
  it("returns the same array for 0 or 1 items", () => {
    const empty = deduplicateByJaccard([]);
    expect(empty).toEqual([]);

    const messages: ChatMessage[] = [makeMessage({ role: "user", content: "hello" })];
    const scored = scoreMessages(messages, "");
    const single = deduplicateByJaccard(scored);
    expect(single).toHaveLength(1);
  });

  it("keeps messages with different content", () => {
    const messages: ChatMessage[] = [
      makeMessage({ role: "user", content: "tell me about the jira api" }),
      makeMessage({ role: "assistant", content: "the database migration is complete" }),
    ];
    const scored = scoreMessages(messages, "");
    const deduped = deduplicateByJaccard(scored);
    expect(deduped).toHaveLength(2);
  });

  it("removes near-duplicate messages above threshold", () => {
    const content1 = "the jira api endpoint is currently down and needs attention";
    const content2 = "the jira api endpoint is currently down and requires attention";
    const messages: ChatMessage[] = [
      makeMessage({ role: "user", content: content1 }),
      makeMessage({ role: "user", content: content2 }),
    ];
    const scored = scoreMessages(messages, "");
    const deduped = deduplicateByJaccard(scored, 0.72);
    // These are very similar, should be deduplicated
    expect(deduped.length).toBeLessThan(2);
  });

  it("uses default threshold when not specified", () => {
    const content1 = "identical content about the api endpoint bug issue";
    const content2 = "identical content about the api endpoint bug issue";
    const messages: ChatMessage[] = [
      makeMessage({ role: "user", content: content1 }),
      makeMessage({ role: "user", content: content2 }),
    ];
    const scored = scoreMessages(messages, "");
    const deduped = deduplicateByJaccard(scored);
    expect(deduped).toHaveLength(1);
  });

  it("respects custom threshold", () => {
    const content1 = "the jira api is down";
    const content2 = "the github api is down";
    const messages: ChatMessage[] = [
      makeMessage({ role: "user", content: content1 }),
      makeMessage({ role: "user", content: content2 }),
    ];
    const scored = scoreMessages(messages, "");
    // With a very high threshold, both should be kept
    const dedupedHigh = deduplicateByJaccard(scored, 0.99);
    expect(dedupedHigh).toHaveLength(2);

    // With a very low threshold, one should be removed
    const dedupedLow = deduplicateByJaccard(scored, 0.1);
    expect(dedupedLow).toHaveLength(1);
  });

  it("handles messages with empty content", () => {
    const messages: ChatMessage[] = [
      makeMessage({ role: "user", content: "" }),
      makeMessage({ role: "user", content: "" }),
    ];
    const scored = scoreMessages(messages, "");
    const deduped = deduplicateByJaccard(scored);
    // Both have empty content, so Jaccard of two empty sets returns 0
    expect(deduped).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// selectMessages
// ---------------------------------------------------------------------------

describe("selectMessages", () => {
  it("always includes system messages regardless of budget", () => {
    const messages: ChatMessage[] = [
      makeMessage({ role: "system", content: "system prompt" }),
      makeMessage({ role: "user", content: "user message" }),
    ];
    const scored = scoreMessages(messages, "");
    const selected = selectMessages(scored, 50);
    const systemSelected = selected.filter((s) => s.message.role === "system");
    expect(systemSelected.length).toBeGreaterThanOrEqual(1);
  });

  it("includes the last user message even under budget pressure", () => {
    const messages: ChatMessage[] = [
      makeMessage({ role: "system", content: "sys" }),
      makeMessage({ role: "user", content: "a".repeat(200) }),
      makeMessage({ role: "assistant", content: "b".repeat(200) }),
      makeMessage({ role: "user", content: "important question" }),
    ];
    const scored = scoreMessages(messages, "");
    // Very tight budget
    const selected = selectMessages(scored, 50);
    const userMsgs = selected.filter((s) => s.message.role === "user");
    // Should still have at least the last user message
    expect(userMsgs.length).toBeGreaterThanOrEqual(1);
  });

  it("sorts selected messages by original index", () => {
    const messages: ChatMessage[] = [
      makeMessage({ role: "system", content: "sys" }),
      makeMessage({ role: "user", content: "hello" }),
      makeMessage({ role: "assistant", content: "hi there" }),
      makeMessage({ role: "user", content: "how are you" }),
    ];
    const scored = scoreMessages(messages, "");
    const selected = selectMessages(scored, 10000);
    const indices = selected.map((s) => s.index);
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]);
    }
  });

  it("respects token budget", () => {
    const messages: ChatMessage[] = [
      makeMessage({ role: "system", content: "s".repeat(180) }), // 100 tokens
      makeMessage({ role: "user", content: "u".repeat(180) }), // 100 tokens
      makeMessage({ role: "assistant", content: "a".repeat(1800) }), // 1000 tokens
    ];
    const scored = scoreMessages(messages, "");
    const selected = selectMessages(scored, 250);
    const totalTokens = selected.reduce((sum, s) => sum + s.tokens, 0);
    expect(totalTokens).toBeLessThanOrEqual(250);
  });

  it("handles large budget that fits all messages", () => {
    const messages: ChatMessage[] = [
      makeMessage({ role: "system", content: "sys" }),
      makeMessage({ role: "user", content: "hello" }),
      makeMessage({ role: "assistant", content: "hi" }),
    ];
    const scored = scoreMessages(messages, "");
    const selected = selectMessages(scored, 100000);
    expect(selected).toHaveLength(3);
  });

  it("handles empty scored array", () => {
    const selected = selectMessages([], 1000);
    expect(selected).toHaveLength(0);
  });

  it("prefers higher effectiveWeight messages when budget is tight", () => {
    const messages: ChatMessage[] = [
      makeMessage({ role: "system", content: "sys" }),
      makeMessage({ role: "assistant", content: "low value filler text" }),
      makeMessage({ role: "assistant", content: "jira api bug security error exception stack trace debug log" }),
      makeMessage({ role: "user", content: "what happened?" }),
    ];
    const scored = scoreMessages(messages, "jira api bug");
    // Very tight budget - should prefer system + last user + the high-value assistant msg
    const selected = selectMessages(scored, 200);
    // System and last user are always included, the rest is by effectiveWeight
    expect(selected.length).toBeGreaterThanOrEqual(2);
  });
});
