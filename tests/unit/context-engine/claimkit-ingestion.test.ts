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

vi.doMock("../../../src/config/env", () => ({
  env: {
    AI_MAX_CONCURRENT: 3,
  },
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
      trustTier: "curated",
      tags: ["tag-a"],
    });
    expect(mockIngest).toHaveBeenNthCalledWith(2, "Doc 2\n\nContent two", {
      docId: "kn-2",
      title: "Doc 2",
      source: "knowledge",
      trustTier: "curated",
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
      trustTier: "curated",
      tags: [],
    });
  });
});

// ── ingestCodebaseStore ───────────────────────────────────────────────

const mockGetIndexedFiles = vi.fn();

const mockCodebaseIndexer = {
  getIndexedFiles: mockGetIndexedFiles,
};

vi.doMock("../../../src/agent/codebase-indexer", () => ({
  codebaseIndexer: mockCodebaseIndexer,
}));

describe("ingestCodebaseStore", () => {
  let ingestCodebaseStore: () => Promise<{
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

    // Re-register the claimKitAdapter mock (vi.resetModules clears it)
    vi.doMock("../../../src/context-engine/adapters/claimkit-adapter", () => ({
      claimKitAdapter: mockClaimKitAdapter,
    }));
    vi.doMock("../../../src/agent/codebase-indexer", () => ({
      codebaseIndexer: mockCodebaseIndexer,
    }));

    const mod = await import("../../../src/context-engine/claimkit-ingestion");
    ingestCodebaseStore = mod.ingestCodebaseStore;
  });

  it("should return early when ClaimKit is not available", async () => {
    mockIsAvailable.mockReturnValue(false);

    const stats = await ingestCodebaseStore();

    expect(stats.total).toBe(0);
    expect(stats.ingested).toBe(0);
    expect(stats.skipped).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.sourceIds).toEqual([]);
    expect(mockGetIndexedFiles).not.toHaveBeenCalled();
  });

  it("should handle empty codebase index", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockGetIndexedFiles.mockReturnValue([]);

    const stats = await ingestCodebaseStore();

    expect(stats.total).toBe(0);
    expect(stats.ingested).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.sourceIds).toEqual([]);
  });

  it("should ingest all files from the codebase indexer", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockGetIndexedFiles.mockReturnValue([
      { path: "src/index.ts", language: "typescript", content: "console.log('hello');" },
      { path: "README.md", language: "markdown", content: "# Project\n\nDescription here." },
    ]);
    mockIngest
      .mockResolvedValueOnce({ sourceId: "src-cb-1" })
      .mockResolvedValueOnce({ sourceId: "src-cb-2" });

    const stats = await ingestCodebaseStore();

    expect(stats.total).toBe(2);
    expect(stats.ingested).toBe(2);
    expect(stats.skipped).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.sourceIds).toEqual(["src-cb-1", "src-cb-2"]);
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);

    expect(mockIngest).toHaveBeenCalledTimes(2);
    expect(mockIngest).toHaveBeenNthCalledWith(
      1,
      "File: src/index.ts\n\nconsole.log('hello');",
      { path: "src/index.ts", title: "src/index.ts", source: "codebase", language: "typescript", trustTier: "curated" },
    );
    expect(mockIngest).toHaveBeenNthCalledWith(
      2,
      "File: README.md\n\n# Project\n\nDescription here.",
      { path: "README.md", title: "README.md", source: "codebase", language: "markdown", trustTier: "curated" },
    );
  });

  it("should continue ingesting after failures and count errors", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockGetIndexedFiles.mockReturnValue([
      { path: "a.ts", language: "typescript", content: "a" },
      { path: "b.ts", language: "typescript", content: "b" },
      { path: "c.ts", language: "typescript", content: "c" },
    ]);
    mockIngest
      .mockResolvedValueOnce({ sourceId: "src-cb-1" })
      .mockRejectedValueOnce(new Error("Ingest failed"))
      .mockResolvedValueOnce({ sourceId: "src-cb-3" });

    const stats = await ingestCodebaseStore();

    expect(stats.total).toBe(3);
    expect(stats.ingested).toBe(2);
    expect(stats.errors).toBe(1);
    expect(stats.sourceIds).toEqual(["src-cb-1", "src-cb-3"]);
  });
});

describe("ingestScoredDocumentsForQuery", () => {
  let ingestScoredDocumentsForQuery: typeof import("../../../src/context-engine/claimkit-ingestion").ingestScoredDocumentsForQuery;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doMock("../../../src/context-engine/adapters/claimkit-adapter", () => ({
      claimKitAdapter: mockClaimKitAdapter,
    }));

    const mod = await import("../../../src/context-engine/claimkit-ingestion");
    ingestScoredDocumentsForQuery = mod.ingestScoredDocumentsForQuery;
  });

  it("should return early when ClaimKit is not available", async () => {
    mockIsAvailable.mockReturnValue(false);

    const stats = await ingestScoredDocumentsForQuery([], "query", 5);

    expect(stats.total).toBe(0);
    expect(stats.ingested).toBe(0);
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it("should ingest top scored documents with query seed metadata", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockIngest.mockResolvedValueOnce({ sourceId: "seed-1" });

    const stats = await ingestScoredDocumentsForQuery([
      {
        id: "code-src:10",
        source: "codebase",
        content: "export async function listVulnerabilities() {}",
        title: "src/integrations/tenable-cloud/tenable-cloud-client.ts",
        score: 12,
        baseScore: 12,
        importanceScore: 0,
        recencyScore: 1,
        trustScore: 0.9,
        claimKitBoost: 0,
        tokens: 25,
        metadata: {
          filePath: "src/integrations/tenable-cloud/tenable-cloud-client.ts",
          startLine: 10,
          endLine: 20,
        },
      },
    ], "tenable report", 5);

    expect(stats.ingested).toBe(1);
    expect(stats.sourceIds).toEqual(["seed-1"]);
    expect(mockIngest).toHaveBeenCalledWith(
      expect.stringContaining("Matched query: tenable report"),
      expect.objectContaining({
        docId: "code-src:10",
        source: "codebase",
        trustTier: "curated",
        querySeed: true,
        score: 12,
      }),
    );
  });
});

// ── ingestGraphStore ───────────────────────────────────────────────────

const mockGetAllNodes = vi.fn();
const mockGetAllEdges = vi.fn();

const mockKnowledgeGraph = {
  getAllNodes: mockGetAllNodes,
  getAllEdges: mockGetAllEdges,
};

vi.doMock("../../../src/agent/knowledge-graph", () => ({
  knowledgeGraph: mockKnowledgeGraph,
}));

describe("ingestGraphStore", () => {
  let ingestGraphStore: () => Promise<{
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

    vi.doMock("../../../src/context-engine/adapters/claimkit-adapter", () => ({
      claimKitAdapter: mockClaimKitAdapter,
    }));
    vi.doMock("../../../src/agent/knowledge-graph", () => ({
      knowledgeGraph: mockKnowledgeGraph,
    }));

    const mod = await import("../../../src/context-engine/claimkit-ingestion");
    ingestGraphStore = mod.ingestGraphStore;
  });

  it("should return early when ClaimKit is not available", async () => {
    mockIsAvailable.mockReturnValue(false);

    const stats = await ingestGraphStore();

    expect(stats.total).toBe(0);
    expect(stats.ingested).toBe(0);
    expect(stats.skipped).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.sourceIds).toEqual([]);
    expect(mockGetAllNodes).not.toHaveBeenCalled();
    expect(mockGetAllEdges).not.toHaveBeenCalled();
  });

  it("should handle empty graph", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockGetAllNodes.mockReturnValue([]);
    mockGetAllEdges.mockReturnValue([]);

    const stats = await ingestGraphStore();

    expect(stats.total).toBe(0);
    expect(stats.ingested).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.sourceIds).toEqual([]);
  });

  it("should ingest all nodes and edges from the knowledge graph", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockGetAllNodes.mockReturnValue([
      {
        id: "kg-component-1",
        type: "component",
        title: "Auth Service",
        content: "Handles user authentication and authorization",
        status: "accepted",
        context: "Core infrastructure component",
        tags: ["auth", "security"],
        metadata: { owner: "Team A", tier: "critical" },
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-15"),
      },
      {
        id: "kg-decision-1",
        type: "decision",
        title: "Use JWT for API auth",
        content: "Decided to use JWT tokens for API authentication",
        status: "accepted",
        context: undefined,
        tags: [],
        metadata: {},
        createdAt: new Date("2026-01-02"),
        updatedAt: new Date("2026-01-02"),
      },
    ]);
    mockGetAllEdges.mockReturnValue([
      {
        id: "edge-1",
        sourceId: "kg-component-1",
        targetId: "kg-decision-1",
        type: "implements",
        description: "Auth Service uses JWT as decided",
        createdAt: new Date("2026-01-03"),
      },
    ]);
    mockIngest
      .mockResolvedValueOnce({ sourceId: "src-g-1" })
      .mockResolvedValueOnce({ sourceId: "src-g-2" })
      .mockResolvedValueOnce({ sourceId: "src-g-3" });

    const stats = await ingestGraphStore();

    expect(stats.total).toBe(3);
    expect(stats.ingested).toBe(3);
    expect(stats.skipped).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.sourceIds).toEqual(["src-g-1", "src-g-2", "src-g-3"]);
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);

    expect(mockIngest).toHaveBeenCalledTimes(3);

    // First call: the "Auth Service" node
    expect(mockIngest).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("Entity: Auth Service (component)"),
      {
        entityId: "kg-component-1",
        entityType: "component",
        source: "graph",
        trustTier: "curated",
      },
    );

    // Second call: the "Use JWT for API auth" node
    expect(mockIngest).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("Entity: Use JWT for API auth (decision)"),
      {
        entityId: "kg-decision-1",
        entityType: "decision",
        source: "graph",
        trustTier: "curated",
      },
    );

    // Third call: the edge
    expect(mockIngest).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("Relationship: kg-component-1 --[implements]--> kg-decision-1"),
      {
        relationshipId: "edge-1",
        relationshipType: "implements",
        source: "graph",
        trustTier: "curated",
      },
    );
  });

  it("should continue ingesting after node failures and count errors", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockGetAllNodes.mockReturnValue([
      { id: "n1", type: "component", title: "Good", content: "c", status: "accepted", tags: [], metadata: {}, createdAt: new Date(), updatedAt: new Date() },
      { id: "n2", type: "component", title: "Bad", content: "c", status: "accepted", tags: [], metadata: {}, createdAt: new Date(), updatedAt: new Date() },
      { id: "n3", type: "component", title: "Good2", content: "c", status: "accepted", tags: [], metadata: {}, createdAt: new Date(), updatedAt: new Date() },
    ]);
    mockGetAllEdges.mockReturnValue([]);
    mockIngest
      .mockResolvedValueOnce({ sourceId: "src-g-1" })
      .mockRejectedValueOnce(new Error("Ingest failed"))
      .mockResolvedValueOnce({ sourceId: "src-g-3" });

    const stats = await ingestGraphStore();

    expect(stats.total).toBe(3);
    expect(stats.ingested).toBe(2);
    expect(stats.errors).toBe(1);
    expect(stats.sourceIds).toEqual(["src-g-1", "src-g-3"]);
  });

  it("should continue ingesting after edge failures and count errors", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockGetAllNodes.mockReturnValue([]);
    mockGetAllEdges.mockReturnValue([
      { id: "e1", sourceId: "a", targetId: "b", type: "depends_on", description: "ok", createdAt: new Date() },
      { id: "e2", sourceId: "c", targetId: "d", type: "blocks", description: "fail", createdAt: new Date() },
    ]);
    mockIngest
      .mockResolvedValueOnce({ sourceId: "src-e-1" })
      .mockRejectedValueOnce(new Error("Edge ingest failed"));

    const stats = await ingestGraphStore();

    expect(stats.total).toBe(2);
    expect(stats.ingested).toBe(1);
    expect(stats.errors).toBe(1);
    expect(stats.sourceIds).toEqual(["src-e-1"]);
  });

  it("should handle nodes without optional fields gracefully", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockGetAllNodes.mockReturnValue([
      {
        id: "minimal-node",
        type: "assumption",
        title: "Minimal Node",
        content: "Just content",
        status: "proposed",
        tags: [],
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    mockGetAllEdges.mockReturnValue([]);
    mockIngest.mockResolvedValueOnce({ sourceId: "src-min" });

    const stats = await ingestGraphStore();

    expect(stats.ingested).toBe(1);
    expect(mockIngest).toHaveBeenCalledTimes(1);
  });
});
