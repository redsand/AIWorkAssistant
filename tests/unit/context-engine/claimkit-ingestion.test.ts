import { describe, it, expect, beforeEach, vi } from "vitest";

const mockIngest = vi.fn();
const mockIsAvailable = vi.fn();
const mockGetAllEntries = vi.fn();

const mockClaimKitAdapter = {
  ingest: mockIngest,
  isAvailable: mockIsAvailable,
};

const mockKnowledgeStore = {
  getAllEntries: mockGetAllEntries,
};

vi.doMock("../../../src/context-engine/adapters/claimkit-adapter", () => ({
  claimKitAdapter: mockClaimKitAdapter,
}));

vi.doMock("../../../src/agent/knowledge-store", () => ({
  knowledgeStore: mockKnowledgeStore,
}));

describe("ingestKnowledgeStore", () => {
  let ingestKnowledgeStore: () => Promise<{
    total: number;
    ingested: number;
    skipped: number;
    errors: number;
    sourceIds: string[];
    durationMs: number;
  }>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import("../../../src/context-engine/claimkit-ingestion");
    ingestKnowledgeStore = mod.ingestKnowledgeStore;
  });

  it("should return early when ClaimKit is not available", async () => {
    mockIsAvailable.mockReturnValue(false);

    const stats = await ingestKnowledgeStore();

    expect(stats.total).toBe(0);
    expect(stats.ingested).toBe(0);
    expect(stats.skipped).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.sourceIds).toEqual([]);
    expect(mockGetAllEntries).not.toHaveBeenCalled();
  });

  it("should handle empty knowledge store", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockGetAllEntries.mockReturnValue([]);

    const stats = await ingestKnowledgeStore();

    expect(stats.total).toBe(0);
    expect(stats.ingested).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.sourceIds).toEqual([]);
  });

  it("should ingest all documents from the knowledge store", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockGetAllEntries.mockReturnValue([
      {
        id: "kn-1",
        source: "manual",
        title: "Doc 1",
        content: "Content one",
        tags: ["tag-a"],
        createdAt: new Date("2026-01-01"),
      },
      {
        id: "kn-2",
        source: "web_page",
        title: "Doc 2",
        content: "Content two",
        tags: [],
        url: "https://example.com",
        createdAt: new Date("2026-01-02"),
      },
    ]);
    mockIngest
      .mockResolvedValueOnce({ sourceId: "src-1" })
      .mockResolvedValueOnce({ sourceId: "src-2" });

    const stats = await ingestKnowledgeStore();

    expect(stats.total).toBe(2);
    expect(stats.ingested).toBe(2);
    expect(stats.skipped).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.sourceIds).toEqual(["src-1", "src-2"]);
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);

    expect(mockIngest).toHaveBeenCalledTimes(2);
    expect(mockIngest).toHaveBeenNthCalledWith(1, "Doc 1\n\nContent one", {
      docId: "kn-1",
      title: "Doc 1",
      source: "knowledge",
      tags: ["tag-a"],
    });
    expect(mockIngest).toHaveBeenNthCalledWith(2, "Doc 2\n\nContent two", {
      docId: "kn-2",
      title: "Doc 2",
      source: "knowledge",
      tags: [],
    });
  });

  it("should continue ingesting after failures and count errors", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockGetAllEntries.mockReturnValue([
      { id: "kn-1", source: "manual", title: "Doc 1", content: "C1", tags: [], createdAt: new Date() },
      { id: "kn-2", source: "manual", title: "Doc 2", content: "C2", tags: [], createdAt: new Date() },
      { id: "kn-3", source: "manual", title: "Doc 3", content: "C3", tags: [], createdAt: new Date() },
    ]);
    mockIngest
      .mockResolvedValueOnce({ sourceId: "src-1" })
      .mockRejectedValueOnce(new Error("Ingest failed"))
      .mockResolvedValueOnce({ sourceId: "src-3" });

    const stats = await ingestKnowledgeStore();

    expect(stats.total).toBe(3);
    expect(stats.ingested).toBe(2);
    expect(stats.errors).toBe(1);
    expect(stats.sourceIds).toEqual(["src-1", "src-3"]);
  });

  it("should default empty tags to an empty array", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockGetAllEntries.mockReturnValue([
      {
        id: "kn-1",
        source: "manual",
        title: "Doc",
        content: "Content",
        createdAt: new Date(),
      },
    ]);
    mockIngest.mockResolvedValueOnce({ sourceId: "src-1" });

    await ingestKnowledgeStore();

    expect(mockIngest).toHaveBeenCalledWith("Doc\n\nContent", {
      docId: "kn-1",
      title: "Doc",
      source: "knowledge",
      tags: [],
    });
  });
});
