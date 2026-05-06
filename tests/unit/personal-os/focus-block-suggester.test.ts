import { describe, it, expect } from "vitest";
import { focusBlockSuggester } from "../../../src/personal-os/focus-block-suggester";
import type { OpenLoop } from "../../../src/personal-os/types";

describe("FocusBlockSuggester", () => {
  it("suggests focus blocks in calendar gaps", () => {
    const events = [
      { startTime: new Date("2025-01-06T09:00:00"), endTime: new Date("2025-01-06T10:00:00"), summary: "Standup" },
      { startTime: new Date("2025-01-06T14:00:00"), endTime: new Date("2025-01-06T15:00:00"), summary: "1:1" },
    ];
    const openLoops: OpenLoop[] = [];
    const blocks = focusBlockSuggester.suggestFocusBlocks(events, openLoops, "2025-01-06", 60);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0].durationMinutes).toBeGreaterThanOrEqual(60);
  });

  it("prioritizes focus blocks based on open loop urgency", () => {
    const events: any[] = [];
    const openLoops: OpenLoop[] = [
      { id: "1", type: "task", title: "Critical item", source: "work_items", urgency: "critical" },
    ];
    const blocks = focusBlockSuggester.suggestFocusBlocks(events, openLoops, "2025-01-06", 60);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0].priority).toBe("high");
  });

  it("respects minimum duration parameter", () => {
    const events = [
      { startTime: new Date("2025-01-06T09:00:00"), endTime: new Date("2025-01-06T09:30:00"), summary: "Short meeting" },
    ];
    const openLoops: OpenLoop[] = [
      { id: "1", type: "task", title: "Critical item", source: "work_items", urgency: "critical" },
    ];
    const blocks = focusBlockSuggester.suggestFocusBlocks(events, openLoops, "2025-01-06", 90);
    // Should have at least one block (9:30-17:00 gap = 450 min)
    expect(blocks.length).toBeGreaterThan(0);
    // Deep work block for critical open loop should be 90+ min
    const deepWork = blocks.find((b) => b.title.includes("Deep work"));
    expect(deepWork).toBeDefined();
    expect(deepWork!.durationMinutes).toBeGreaterThanOrEqual(90);
  });

  it("handles fully booked days", () => {
    // 8 back-to-back meetings from 9:00 to 17:00
    const events = Array.from({ length: 8 }, (_, i) => ({
      startTime: new Date(`2025-01-06T${String(9 + i).padStart(2, "0")}:00:00`),
      endTime: new Date(`2025-01-06T${String(10 + i).padStart(2, "0")}:00:00`),
      summary: `Meeting ${i}`,
    }));
    const blocks = focusBlockSuggester.suggestFocusBlocks(events, [], "2025-01-06", 60);
    expect(blocks).toHaveLength(0);
  });

  it("detects back-to-back energy risks", () => {
    const events = [
      { startTime: new Date("2025-01-06T09:00:00"), endTime: new Date("2025-01-06T10:00:00"), summary: "Meeting A" },
      { startTime: new Date("2025-01-06T10:00:00"), endTime: new Date("2025-01-06T11:00:00"), summary: "Meeting B" },
    ];
    const risks = focusBlockSuggester.detectEnergyRisks(events, []);
    const b2b = risks.find((r) => r.type === "back_to_back");
    expect(b2b).toBeDefined();
  });

  it("detects meeting overload energy risk", () => {
    const events = Array.from({ length: 6 }, (_, i) => ({
      startTime: new Date(`2025-01-06T${String(9 + i).padStart(2, "0")}:00:00`),
      endTime: new Date(`2025-01-06T${String(10 + i).padStart(2, "0")}:00:00`),
      summary: `Meeting ${i}`,
    }));
    const risks = focusBlockSuggester.detectEnergyRisks(events, []);
    const overload = risks.find((r) => r.type === "meeting_overload");
    expect(overload).toBeDefined();
  });
});