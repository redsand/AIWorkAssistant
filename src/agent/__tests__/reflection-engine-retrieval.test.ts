import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReflectionEngine } from "../reflection-engine";
import type { MemoryEntry } from "../../memory/agent-memory";

// Mock agentMemory so we control getEntries without touching the filesystem
vi.mock("../../memory/agent-memory", () => {
  let mockEntries: MemoryEntry[] = [];
  return {
    agentMemory: {
      getEntries: vi.fn(() => mockEntries),
    },
    __setMockEntries: (entries: MemoryEntry[]) => { mockEntries = entries; },
  };
});

// Mock aiClient so reflectOnTask doesn't hit a real API
vi.mock("../opencode-client", () => ({
  aiClient: {
    chat: vi.fn(),
  },
}));

import { agentMemory } from "../../memory/agent-memory";

const mockedGetEntries = agentMemory.getEntries as ReturnType<typeof vi.fn>;
const __setMockEntries = (vi.mocked("../../memory/agent-memory") as any).__setMockEntries;

describe("ReflectionEngine — getRecentReflections", () => {
  let engine: ReflectionEngine;

  beforeEach(() => {
    engine = new ReflectionEngine();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-03T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── empty state ─────────────────────────────────────────────────────────

  describe("empty state", () => {
    it("should return empty string when no reflection entries exist", () => {
      mockedGetEntries.mockReturnValue([]);
      expect(engine.getRecentReflections()).toBe("");
    });

    it("should return empty string when only non-reflection entries exist", () => {
      mockedGetEntries.mockReturnValue([
        { key: "pref_stack", value: "TypeScript + React", timestamp: "", accessCount: 1 },
      ]);
      expect(engine.getRecentReflections()).toBe("");
    });
  });

  // ── basic retrieval ─────────────────────────────────────────────────────

  describe("basic retrieval", () => {
    it("should return formatted reflection entries", () => {
      mockedGetEntries.mockReturnValue([
        { key: "2026-06-03_win", value: "Used correct TypeScript types", timestamp: "", accessCount: 1 },
      ]);
      const result = engine.getRecentReflections();
      expect(result).toContain("§ 2026-06-03_win");
      expect(result).toContain("Used correct TypeScript types");
    });

    it("should respect count parameter", () => {
      mockedGetEntries.mockReturnValue([
        { key: "2026-06-01_win", value: "First", timestamp: "", accessCount: 1 },
        { key: "2026-06-02_win", value: "Second", timestamp: "", accessCount: 1 },
        { key: "2026-06-03_win", value: "Third", timestamp: "", accessCount: 1 },
      ]);
      const result = engine.getRecentReflections(2);
      expect(result).toContain("Second");
      expect(result).toContain("Third");
      expect(result).not.toContain("First");
    });

    it("should include win, avoid, and lesson entries", () => {
      mockedGetEntries.mockReturnValue([
        { key: "2026-06-03_win", value: "Good thing", timestamp: "", accessCount: 1 },
        { key: "2026-06-03_avoid", value: "AVOID: Bad thing", timestamp: "", accessCount: 1 },
        { key: "2026-06-03_lesson", value: "Learned something", timestamp: "", accessCount: 1 },
      ]);
      const result = engine.getRecentReflections();
      expect(result).toContain("2026-06-03_win");
      expect(result).toContain("2026-06-03_avoid");
      expect(result).toContain("2026-06-03_lesson");
    });
  });

  // ── consolidated entries ────────────────────────────────────────────────

  describe("consolidated entries", () => {
    it("should include consolidated entries in results", () => {
      mockedGetEntries.mockReturnValue([
        { key: "consolidated_2026-06-01", value: "- Win A\n- Avoid B", timestamp: "", accessCount: 1 },
      ]);
      const result = engine.getRecentReflections();
      expect(result).toContain("consolidated_2026-06-01");
      expect(result).toContain("Win A");
    });

    it("should mix consolidated and individual reflection entries", () => {
      mockedGetEntries.mockReturnValue([
        { key: "consolidated_2026-06-01", value: "- Old lesson", timestamp: "", accessCount: 1 },
        { key: "2026-06-03_win", value: "New win", timestamp: "", accessCount: 1 },
      ]);
      const result = engine.getRecentReflections();
      expect(result).toContain("consolidated_2026-06-01");
      expect(result).toContain("2026-06-03_win");
    });
  });

  // ── truncation / token budget ───────────────────────────────────────────

  describe("truncation and token budget", () => {
    it("should truncate output that exceeds token budget", () => {
      const longValue = "x".repeat(1000);
      mockedGetEntries.mockReturnValue([
        { key: "2026-06-03_win", value: longValue, timestamp: "", accessCount: 1 },
        { key: "2026-06-03_lesson", value: longValue, timestamp: "", accessCount: 1 },
      ]);
      // tokenBudget=50 → maxChars = 50 * 1.8 = 90 chars
      const result = engine.getRecentReflections(3, 50);
      expect(result).toContain("...(truncated)");
    });

    it("should not truncate output within token budget", () => {
      mockedGetEntries.mockReturnValue([
        { key: "2026-06-03_win", value: "Short", timestamp: "", accessCount: 1 },
      ]);
      const result = engine.getRecentReflections(3, 300);
      expect(result).not.toContain("...(truncated)");
    });

    it("should truncate at entry boundary when possible", () => {
      mockedGetEntries.mockReturnValue([
        { key: "2026-06-01_win", value: "a".repeat(200), timestamp: "", accessCount: 1 },
        { key: "2026-06-02_lesson", value: "b".repeat(200), timestamp: "", accessCount: 1 },
        { key: "2026-06-03_win", value: "c".repeat(200), timestamp: "", accessCount: 1 },
      ]);
      // tokenBudget=150 → maxChars = 270 → should cut between entries
      const result = engine.getRecentReflections(3, 150);
      expect(result).toContain("...(truncated)");
      // Should have at least one complete entry
      expect(result).toMatch(/§ 2026-06-\d{2}_(win|lesson)/);
    });

    it("should use default count of 3 when not specified", () => {
      const entries = Array.from({ length: 5 }, (_, i) => ({
        key: `2026-06-0${i + 1}_win`,
        value: `Entry ${i}`,
        timestamp: "",
        accessCount: 1,
      }));
      mockedGetEntries.mockReturnValue(entries);
      const result = engine.getRecentReflections();
      // Default count=3, so should have the last 3
      expect(result).not.toContain("2026-06-01_win");
      expect(result).not.toContain("2026-06-02_win");
      expect(result).toContain("2026-06-03_win");
      expect(result).toContain("2026-06-04_win");
      expect(result).toContain("2026-06-05_win");
    });
  });
});
