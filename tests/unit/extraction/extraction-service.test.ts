import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/work-items/database", () => ({
  workItemDatabase: {
    createWorkItem: vi.fn(),
  },
}));

import { ExtractionService } from "../../../src/extraction/extraction-service";
import { workItemDatabase } from "../../../src/work-items/database";

describe("ExtractionService.extractWorkItems", () => {
  const service = new ExtractionService();

  it("returns structured items from conversation text", async () => {
    const result = await service.extractWorkItems({
      conversationText: "We need to fix the login bug before the release.",
    });

    expect(result.items.length).toBeGreaterThan(0);
    const item = result.items[0];
    expect(item.type).toBe("task");
    expect(item.source).toBe("chat");
    expect(item.priority).toBe("medium");
    expect(item.title.length).toBeGreaterThan(0);
    expect(item.description).toContain("fix the login bug");
    expect(result.confidence).toBe(0.7);
    expect(result.reasoning).toContain("Extracted");
  });

  it("returns low confidence and no items when nothing actionable is found", async () => {
    const result = await service.extractWorkItems({
      conversationText: "Hello there. The weather is nice today.",
    });

    expect(result.items).toHaveLength(0);
    expect(result.confidence).toBe(0.2);
    expect(result.reasoning).toContain("No clear action items");
  });

  it("respects the maxItems limit", async () => {
    const lines = Array.from(
      { length: 20 },
      (_, i) => `We need to do task number ${i}`,
    ).join("\n");

    const result = await service.extractWorkItems({
      conversationText: lines,
      maxItems: 3,
    });

    expect(result.items.length).toBeLessThanOrEqual(3);
  });

  it("deduplicates items by title", async () => {
    const result = await service.extractWorkItems({
      conversationText: "We need to deploy the service\nWe need to deploy the service",
    });

    const titles = result.items.map((i) => i.title.toLowerCase());
    const unique = new Set(titles);
    expect(unique.size).toBe(titles.length);
  });

  it("truncates long titles to 100 characters", async () => {
    const longTail = "x".repeat(200);
    const result = await service.extractWorkItems({
      conversationText: `We need to ${longTail}`,
    });

    expect(result.items[0].title.length).toBeLessThanOrEqual(100);
  });
});

describe("ExtractionService.createExtractedItems", () => {
  beforeEach(() => {
    vi.mocked(workItemDatabase.createWorkItem).mockReset();
  });

  it("creates work items with correct type and source and returns their ids", async () => {
    vi.mocked(workItemDatabase.createWorkItem).mockImplementation(
      (params) =>
        ({
          id: `id-${params.title}`,
          ...params,
        }) as ReturnType<typeof workItemDatabase.createWorkItem>,
    );

    const service = new ExtractionService();
    const ids = await service.createExtractedItems([
      {
        type: "task",
        title: "First",
        description: "desc",
        priority: "high",
        source: "chat",
      },
    ]);

    expect(ids).toEqual(["id-First"]);
    expect(workItemDatabase.createWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "task",
        title: "First",
        priority: "high",
        source: "chat",
        status: "proposed",
      }),
    );
  });
});
