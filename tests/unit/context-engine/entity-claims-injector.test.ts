import { afterEach, describe, expect, it, vi } from "vitest";

const mockEntityMemory = {
  getEntitiesByNormalizedNames: vi.fn(),
  getCurrentClaims: vi.fn(),
  getClaimHistory: vi.fn(),
};

async function loadInjector() {
  vi.resetModules();
  vi.doMock("../../../src/memory/entity-memory", () => ({
    entityMemory: mockEntityMemory,
  }));
  return import("../../../src/context-engine/entity-claims-injector");
}

describe("buildEntityClaimsSection", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns an empty section when the query has no entity IDs", async () => {
    const { buildEntityClaimsSection } = await loadInjector();

    const section = buildEntityClaimsSection("show me today's work");

    expect(section).toEqual({
      entityCount: 0,
      claimCount: 0,
      entitiesWithHistory: 0,
      contradictionCount: 0,
      contradictions: [],
      content: null,
    });
    expect(mockEntityMemory.getEntitiesByNormalizedNames).not.toHaveBeenCalled();
  });

  it("returns an empty section when mentioned entities are not in memory", async () => {
    mockEntityMemory.getEntitiesByNormalizedNames.mockReturnValue([]);
    const { buildEntityClaimsSection } = await loadInjector();

    const section = buildEntityClaimsSection("what blocks IR-82?");

    expect(section.content).toBeNull();
    expect(mockEntityMemory.getEntitiesByNormalizedNames).toHaveBeenCalledWith(["IR-82"]);
  });

  it("returns an empty section when matched entities have no current claims", async () => {
    mockEntityMemory.getEntitiesByNormalizedNames.mockReturnValue([
      { id: "entity-1", name: "IR-82", summary: "", sourceUrl: "" },
    ]);
    mockEntityMemory.getCurrentClaims.mockReturnValue([]);
    const { buildEntityClaimsSection } = await loadInjector();

    const section = buildEntityClaimsSection("status for IR-82");

    expect(section).toMatchObject({
      entityCount: 0,
      claimCount: 0,
      entitiesWithHistory: 0,
      contradictionCount: 0,
      content: null,
    });
  });

  it("renders current claims with source URLs and tool-source citation labels", async () => {
    vi.setSystemTime(new Date("2026-06-11T12:00:00.000Z"));
    mockEntityMemory.getEntitiesByNormalizedNames.mockReturnValue([
      {
        id: "entity-1",
        name: "IR-82",
        summary: "A".repeat(100),
        sourceUrl: "https://jira.example/browse/IR-82",
      },
    ]);
    mockEntityMemory.getCurrentClaims.mockReturnValue([
      {
        attribute: "status",
        value: "Done",
        source: "tool:jira.get_issue",
        updatedAt: "2026-06-11T10:00:00.000Z",
      },
    ]);
    mockEntityMemory.getClaimHistory.mockReturnValue([
      {
        attribute: "status",
        value: "Done",
        source: "tool:jira.get_issue",
        createdAt: "2026-06-11T10:00:00.000Z",
        updatedAt: "2026-06-11T10:00:00.000Z",
      },
    ]);
    const { buildEntityClaimsSection } = await loadInjector();

    const section = buildEntityClaimsSection("what implements IR-82?");

    expect(section.entityCount).toBe(1);
    expect(section.claimCount).toBe(1);
    expect(section.entitiesWithHistory).toBe(0);
    expect(section.content).toContain("## IR-82");
    expect(section.content).toContain("source: https://jira.example/browse/IR-82");
    expect(section.content).toContain("- status: Done");
    expect(section.content).toContain("observed 2h ago via jira.get_issue");
    expect(section.content).toContain("Citation format");
  });

  it("surfaces recent cross-source supersession history as contradictions", async () => {
    vi.setSystemTime(new Date("2026-06-11T12:00:00.000Z"));
    mockEntityMemory.getEntitiesByNormalizedNames.mockReturnValue([
      { id: "entity-1", name: "IR-82", summary: "", sourceUrl: "" },
    ]);
    mockEntityMemory.getCurrentClaims.mockReturnValue([
      {
        attribute: "status",
        value: "Done",
        source: "tool:jira.get_issue",
        updatedAt: "2026-06-11T11:00:00.000Z",
      },
    ]);
    mockEntityMemory.getClaimHistory.mockReturnValue([
      {
        attribute: "status",
        value: "Done",
        source: "tool:jira.get_issue",
        createdAt: "2026-06-11T11:00:00.000Z",
        updatedAt: "2026-06-11T11:00:00.000Z",
      },
      {
        attribute: "status",
        value: "Blocked",
        source: "manual",
        createdAt: "2026-06-11T02:00:00.000Z",
        updatedAt: "2026-06-11T02:00:00.000Z",
      },
    ]);
    const { buildEntityClaimsSection } = await loadInjector();

    const section = buildEntityClaimsSection("what blocks IR-82?");

    expect(section.entitiesWithHistory).toBe(1);
    expect(section.contradictionCount).toBe(1);
    expect(section.contradictions[0]).toContain("IR-82.status");
    expect(section.contradictions[0]).toContain("manual previously said `Blocked`");
    expect(section.content).toContain("prior value: Blocked");
    expect(section.content).toContain("Recent contradictions detected");
  });

  it("limits rendering to the first eight matched entities", async () => {
    mockEntityMemory.getEntitiesByNormalizedNames.mockReturnValue(
      Array.from({ length: 10 }, (_, index) => ({
        id: `entity-${index}`,
        name: `IR-${index + 100}`,
        summary: "",
        sourceUrl: "",
      })),
    );
    mockEntityMemory.getCurrentClaims.mockReturnValue([
      {
        attribute: "status",
        value: "Open",
        source: "manual",
        updatedAt: "bad-date",
      },
    ]);
    mockEntityMemory.getClaimHistory.mockReturnValue([
      {
        attribute: "status",
        value: "Open",
        source: "manual",
        createdAt: "bad-date",
        updatedAt: "bad-date",
      },
    ]);
    const { buildEntityClaimsSection } = await loadInjector();

    const section = buildEntityClaimsSection("compare IR-100 IR-101 IR-102 IR-103 IR-104 IR-105 IR-106 IR-107 IR-108 IR-109");

    expect(section.entityCount).toBe(10);
    expect(section.claimCount).toBe(8);
    expect(section.content).toContain("observed bad-date via manual");
    expect(section.content).toContain("## IR-107");
    expect(section.content).not.toContain("## IR-108");
  });
});
