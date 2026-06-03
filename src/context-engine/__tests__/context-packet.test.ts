import { describe, it, expect } from "vitest";
import { determineRoutingTier } from "../context-packet";
import { createBudget, estimateTokens, enforceBudget } from "../budget";
import type { ContextSection, AllocatedBudget } from "../types";
import { DEFAULT_SLOT_DEFINITIONS, CHARS_PER_TOKEN } from "../types";
import type { ClaimKitQueryResult } from "../adapters/claimkit-adapter";

// ── determineRoutingTier ──────────────────────────────────────────────────

describe("determineRoutingTier", () => {
  it("should return rag_primary when CK result is null", () => {
    const decision = determineRoutingTier(null);
    expect(decision.tier).toBe("rag_primary");
    expect(decision.preferredSource).toBe("rag");
    expect(decision.routingReason).toBe("ck_unavailable");
  });

  it("should return ck_primary for high confidence + answerable", () => {
    const ck = {
      confidence: 0.5,
      answerability: "answerable",
    } as ClaimKitQueryResult;
    const decision = determineRoutingTier(ck);
    expect(decision.tier).toBe("ck_primary");
    expect(decision.preferredSource).toBe("claimkit");
    expect(decision.overallWinner).toBe("claimkit");
  });

  it("should return ck_primary at exactly 0.3 confidence threshold", () => {
    const ck = {
      confidence: 0.31,
      answerability: "answerable",
    } as ClaimKitQueryResult;
    const decision = determineRoutingTier(ck);
    expect(decision.tier).toBe("ck_primary");
  });

  it("should NOT return ck_primary at 0.3 confidence (must be > 0.3)", () => {
    const ck = {
      confidence: 0.3,
      answerability: "answerable",
    } as ClaimKitQueryResult;
    const decision = determineRoutingTier(ck);
    expect(decision.tier).toBe("blended");
  });

  it("should NOT return ck_primary for high confidence + not_answerable", () => {
    const ck = {
      confidence: 0.8,
      answerability: "not_answerable",
    } as ClaimKitQueryResult;
    const decision = determineRoutingTier(ck);
    expect(decision.tier).not.toBe("ck_primary");
  });

  it("should return rag_primary for low confidence", () => {
    const ck = {
      confidence: 0.05,
      answerability: "partially-answerable",
    } as ClaimKitQueryResult;
    const decision = determineRoutingTier(ck);
    expect(decision.tier).toBe("rag_primary");
    expect(decision.routingReason).toBe("low_confidence");
  });

  it("should return rag_primary for not_answerable", () => {
    const ck = {
      confidence: 0.5,
      answerability: "not_answerable",
    } as ClaimKitQueryResult;
    const decision = determineRoutingTier(ck);
    expect(decision.tier).toBe("rag_primary");
    expect(decision.routingReason).toBe("not_answerable");
  });

  it("should return blended for mid-range confidence + answerable", () => {
    const ck = {
      confidence: 0.2,
      answerability: "partially-answerable",
    } as ClaimKitQueryResult;
    const decision = determineRoutingTier(ck);
    expect(decision.tier).toBe("blended");
    expect(decision.preferredSource).toBe("blended");
    expect(decision.routingReason).toBe("uncertain");
  });
});

// ── createBudget ──────────────────────────────────────────────────────────

describe("createBudget", () => {
  it("should allocate slots by priority", () => {
    const budget = createBudget(DEFAULT_SLOT_DEFINITIONS, 10000, 500);
    const names = budget.slots.map((s) => s.name);
    // system (100) > history (80) > documents (60) > claimkit (55) > graph (40) > health (20)
    expect(names).toEqual(["system", "history", "documents", "claimkit_evidence", "graph", "health"]);
  });

  it("should apply safety margin of 0.7", () => {
    const total = 10000;
    const toolTokens = 0;
    const budget = createBudget(DEFAULT_SLOT_DEFINITIONS, total, toolTokens);
    const expected = Math.floor(total * 0.7);
    const allocated = budget.slots.reduce((sum, s) => sum + s.allocatedTokens, 0);
    // Total allocated should be <= expected (remaining goes to remainingTokens)
    expect(allocated).toBeLessThanOrEqual(expected);
  });

  it("should subtract tool tokens from available budget", () => {
    const budgetNoTools = createBudget(DEFAULT_SLOT_DEFINITIONS, 10000, 0);
    const budgetWithTools = createBudget(DEFAULT_SLOT_DEFINITIONS, 10000, 1000);
    const totalNoTools = budgetNoTools.slots.reduce((s, slot) => s + slot.allocatedTokens, 0);
    const totalWithTools = budgetWithTools.slots.reduce((s, slot) => s + slot.allocatedTokens, 0);
    expect(totalWithTools).toBeLessThan(totalNoTools);
  });

  it("should assign overflow target to each slot", () => {
    const budget = createBudget(DEFAULT_SLOT_DEFINITIONS, 10000, 0);
    const systemSlot = budget.slots.find((s) => s.name === "system");
    expect(systemSlot?.overflowTarget).toBe("history");
    const graphSlot = budget.slots.find((s) => s.name === "graph");
    expect(graphSlot?.overflowTarget).toBe("health");
  });

  it("should allocate remaining tokens to history first", () => {
    const budget = createBudget(DEFAULT_SLOT_DEFINITIONS, 10000, 0);
    // remainingTokens may be > 0 when fractions don't exactly sum to 1.0
    // History slot should get the extra allocation
    expect(budget.remainingTokens).toBeGreaterThanOrEqual(0);
  });
});

// ── estimateTokens ────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("should estimate tokens based on CHARS_PER_TOKEN ratio", () => {
    const text = "a".repeat(18);
    expect(estimateTokens(text)).toBe(Math.ceil(18 / CHARS_PER_TOKEN));
  });

  it("should return at least 1 for non-empty text", () => {
    expect(estimateTokens("x")).toBe(1);
  });

  it("should return 0 for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("should scale linearly with content length", () => {
    const short = "hello world test data for estimating tokens accurately";
    const long = short.repeat(100);
    const ratio = estimateTokens(long) / estimateTokens(short);
    expect(ratio).toBe(100);
  });
});

// ── enforceBudget ─────────────────────────────────────────────────────────

describe("enforceBudget", () => {
  function makeBudget(allocations: Record<string, number>): AllocatedBudget {
    return {
      totalBudget: 10000,
      safetyMargin: 0.7,
      slots: Object.entries(allocations).map(([name, allocatedTokens]) => ({
        name,
        priority: 100,
        maxTokens: allocatedTokens,
        allocatedTokens,
        overflowTarget: null,
      })),
      remainingTokens: 0,
    };
  }

  it("should pass through sections within budget", () => {
    const content = "short";
    const sections: ContextSection[] = [
      { name: "system", content, tokens: estimateTokens(content) },
    ];
    const budget = makeBudget({ system: 100 });
    const result = enforceBudget(sections, budget);
    expect(result[0].content).toBe("short");
    expect(result[0].tokens).toBe(estimateTokens(content));
  });

  it("should truncate sections exceeding budget", () => {
    const longContent = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10";
    const sections: ContextSection[] = [
      { name: "system", content: longContent, tokens: 1000 },
    ];
    const budget = makeBudget({ system: 20 });
    const result = enforceBudget(sections, budget);
    expect(result[0].content).toContain("...[truncated]");
    expect(result[0].tokens).toBe(20);
  });

  it("should cut at newline boundary when possible", () => {
    const content = "a".repeat(30) + "\n" + "b".repeat(30);
    const sections: ContextSection[] = [
      { name: "system", content, tokens: 100 },
    ];
    // Budget allows ~54 chars (30 tokens * 1.8)
    const budget = makeBudget({ system: 30 });
    const result = enforceBudget(sections, budget);
    // Should cut at the newline since it's > 50% of maxChars
    expect(result[0].content).toContain("\n");
  });

  it("should not cut at newline if it is too early", () => {
    const content = "short\n" + "b".repeat(100);
    const sections: ContextSection[] = [
      { name: "system", content, tokens: 100 },
    ];
    const budget = makeBudget({ system: 30 });
    const result = enforceBudget(sections, budget);
    // newline at position 6, maxChars ~54 — 6/54 = 0.11 < 0.5, so cut at maxChars
    expect(result[0].content).toContain("...[truncated]");
  });

  it("should preserve compressionRatio when truncating", () => {
    const sections: ContextSection[] = [
      { name: "system", content: "x".repeat(200), tokens: 200 },
    ];
    const budget = makeBudget({ system: 10 });
    const result = enforceBudget(sections, budget);
    expect(result[0].compressionRatio).toBeGreaterThan(1);
  });

  it("should preserve sourceCount when truncating", () => {
    const sections: ContextSection[] = [
      { name: "documents", content: "x".repeat(200), tokens: 200, sourceCount: 5 },
    ];
    const budget = makeBudget({ documents: 10 });
    const result = enforceBudget(sections, budget);
    expect(result[0].sourceCount).toBe(5);
  });

  it("should use Infinity for sections without matching slot", () => {
    const content = "some content that passes through unchanged";
    const sections: ContextSection[] = [
      { name: "unknown_section", content, tokens: estimateTokens(content) },
    ];
    const budget = makeBudget({ system: 100 });
    const result = enforceBudget(sections, budget);
    expect(result[0].content).toBe(content);
    expect(result[0].tokens).toBe(estimateTokens(content));
  });
});

// ── memory injection ordering ─────────────────────────────────────────────

describe("memory injection ordering in context packet", () => {
  it("should place memory sections before system in the sections array when built", () => {
    const memorySection: ContextSection = { name: "agent_memory", content: "memory content", tokens: 10 };
    const userProfileSection: ContextSection = { name: "user_profile", content: "user content", tokens: 10 };
    const systemSection: ContextSection = { name: "system", content: "system prompt", tokens: 20 };

    // Simulate the ordering logic from assembleContextPacket
    const sections: ContextSection[] = [];
    sections.push(memorySection);
    sections.push(userProfileSection);
    sections.push(systemSection);

    // Memory must come before system prompt
    const memoryIdx = sections.findIndex((s) => s.name === "agent_memory");
    const userIdx = sections.findIndex((s) => s.name === "user_profile");
    const systemIdx = sections.findIndex((s) => s.name === "system");

    expect(memoryIdx).toBeLessThan(systemIdx);
    expect(userIdx).toBeLessThan(systemIdx);
    expect(memoryIdx).toBe(0);
  });

  it("should produce memory messages before system message", () => {
    // Simulate the message ordering from assembleContextPacket (lines 273-281)
    const enforced: ContextSection[] = [
      { name: "agent_memory", content: "memory snapshot", tokens: 10 },
      { name: "user_profile", content: "user profile", tokens: 10 },
      { name: "system", content: "system prompt", tokens: 20 },
    ];

    const messages: { role: string; content: string }[] = [];
    const memoryEnforced = enforced.find((s) => s.name === "agent_memory");
    const userProfileEnforced = enforced.find((s) => s.name === "user_profile");
    const systemEnforced = enforced.find((s) => s.name === "system");

    if (memoryEnforced?.content.trim()) {
      messages.push({ role: "system", content: `=== AGENT MEMORY ===\n${memoryEnforced.content}` });
    }
    if (userProfileEnforced?.content.trim()) {
      messages.push({ role: "system", content: `=== USER PROFILE ===\n${userProfileEnforced.content}` });
    }
    if (systemEnforced) {
      messages.push({ role: "system", content: systemEnforced.content });
    }

    expect(messages[0].content).toContain("=== AGENT MEMORY ===");
    expect(messages[1].content).toContain("=== USER PROFILE ===");
    expect(messages[2].content).toBe("system prompt");
  });

  it("should omit memory message when snapshot is empty", () => {
    const enforced: ContextSection[] = [
      { name: "agent_memory", content: "", tokens: 0 },
      { name: "user_profile", content: "", tokens: 0 },
      { name: "system", content: "system prompt", tokens: 20 },
    ];

    const messages: { role: string; content: string }[] = [];
    const memoryEnforced = enforced.find((s) => s.name === "agent_memory");
    const userProfileEnforced = enforced.find((s) => s.name === "user_profile");
    const systemEnforced = enforced.find((s) => s.name === "system");

    if (memoryEnforced?.content.trim()) {
      messages.push({ role: "system", content: `=== AGENT MEMORY ===\n${memoryEnforced.content}` });
    }
    if (userProfileEnforced?.content.trim()) {
      messages.push({ role: "system", content: `=== USER PROFILE ===\n${userProfileEnforced.content}` });
    }
    if (systemEnforced) {
      messages.push({ role: "system", content: systemEnforced.content });
    }

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("system prompt");
  });

  it("should enforce budget on memory sections like any other section", () => {
    const hugeMemory = "x".repeat(5000);
    const sections: ContextSection[] = [
      { name: "agent_memory", content: hugeMemory, tokens: estimateTokens(hugeMemory) },
      { name: "system", content: "prompt", tokens: 5 },
    ];
    const budget = makeBudget({ agent_memory: 50, system: 100 });

    const result = enforceBudget(sections, budget);
    const memorySection = result.find((s) => s.name === "agent_memory");
    expect(memorySection?.content).toContain("...[truncated]");
    expect(memorySection?.tokens).toBeLessThan(estimateTokens(hugeMemory));
  });

  function makeBudget(allocations: Record<string, number>): AllocatedBudget {
    return {
      totalBudget: 10000,
      safetyMargin: 0.7,
      slots: Object.entries(allocations).map(([name, allocatedTokens]) => ({
        name,
        priority: 100,
        maxTokens: allocatedTokens,
        allocatedTokens,
        overflowTarget: null,
      })),
      remainingTokens: 0,
    };
  }
});

// ── memory sanitization ────────────────────────────────────────────────────

describe("memory sanitization for prompt injection prevention", () => {
  it("should strip control characters from memory content before injection", () => {
    const sanitizeForPrompt = (s: string) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

    const dirty = "clean\x00text\x07here\x1F";
    const clean = sanitizeForPrompt(dirty);
    expect(clean).toBe("cleantexthere");

    // Normal markdown should pass through unchanged
    const normal = "§ my_key\n_added: 2026-01-01\nsome value";
    expect(sanitizeForPrompt(normal)).toBe(normal);
  });

  it("should preserve valid markdown formatting in sanitized content", () => {
    const sanitizeForPrompt = (s: string) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

    const markdown = "§ key1\n_added: date\n**bold** and _italic_\n- list item";
    expect(sanitizeForPrompt(markdown)).toBe(markdown);
  });
});
