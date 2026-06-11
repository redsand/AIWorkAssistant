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

  it("should filter file_read entries when local sources are disabled", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockGetAllEntries.mockReturnValue([
      { id: "kn-file", source: "file_read", title: "Local File", content: "local", tags: [], createdAt: new Date() },
      { id: "kn-manual-filter", source: "manual", title: "Manual", content: "manual", tags: [], createdAt: new Date() },
    ]);
    mockIngest.mockResolvedValueOnce({ sourceId: "src-manual-filter" });

    const stats = await ingestKnowledgeStore();

    expect(stats.total).toBe(1);
    expect(stats.ingested).toBe(1);
    expect(mockIngest).toHaveBeenCalledWith("Manual\n\nmanual", expect.objectContaining({
      docId: "kn-manual-filter",
    }));
  });

  it("should skip knowledge entries already ingested in a previous run", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockGetAllEntries.mockReturnValue([
      { id: "kn-dedup", source: "manual", title: "Dedup", content: "content", tags: [], createdAt: new Date() },
    ]);
    mockIngest.mockResolvedValueOnce({ sourceId: "src-kn-dedup" });

    const first = await ingestKnowledgeStore();
    const second = await ingestKnowledgeStore();

    expect(first.ingested).toBe(1);
    expect(second.skipped).toBe(1);
    expect(mockIngest).toHaveBeenCalledTimes(1);
  });

  it("should include file_read entries when local sources are enabled", async () => {
    vi.resetModules();
    vi.doMock("../../../src/context-engine/adapters/claimkit-adapter", () => ({
      claimKitAdapter: mockClaimKitAdapter,
    }));
    vi.doMock("../../../src/agent/knowledge-store", () => ({
      knowledgeStore: mockKnowledgeStore,
    }));
    vi.doMock("../../../src/config/env", () => ({
      env: {
        AI_MAX_CONCURRENT: 3,
        RAG_INCLUDE_LOCAL_SOURCES: true,
      },
    }));
    const mod = await import("../../../src/context-engine/claimkit-ingestion");
    mockIsAvailable.mockReturnValue(true);
    mockGetAllEntries.mockReturnValue([
      { id: "kn-file-included", source: "file_read", title: "Included File", content: "included", tags: [], createdAt: new Date() },
    ]);
    mockIngest.mockResolvedValueOnce({ sourceId: "src-file-included" });

    const stats = await mod.ingestKnowledgeStore();

    expect(stats.total).toBe(1);
    expect(stats.ingested).toBe(1);
    expect(mockIngest).toHaveBeenCalledWith("Included File\n\nincluded", expect.objectContaining({
      docId: "kn-file-included",
    }));
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

  it("should skip codebase files already ingested in a previous run", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockGetIndexedFiles.mockReturnValue([
      { path: "dedup.ts", language: "typescript", content: "first" },
    ]);
    mockIngest.mockResolvedValueOnce({ sourceId: "src-dedup" });

    const first = await ingestCodebaseStore();
    const second = await ingestCodebaseStore();

    expect(first.ingested).toBe(1);
    expect(second.skipped).toBe(1);
    expect(mockIngest).toHaveBeenCalledTimes(1);
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

  it("deduplicates scored documents and formats non-codebase locations", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockIngest.mockResolvedValueOnce({ sourceId: "seed-knowledge" });

    const doc = {
      id: "knowledge-seed-dedup",
      source: "knowledge" as const,
      content: "Knowledge content",
      title: "Knowledge Title",
      score: 5,
      baseScore: 5,
      importanceScore: 0,
      recencyScore: 0,
      trustScore: 0.9,
      claimKitBoost: 0,
      tokens: 10,
      metadata: {
        tags: ["knowledge"],
      },
    };

    const first = await ingestScoredDocumentsForQuery([doc], "knowledge query", 5);
    const second = await ingestScoredDocumentsForQuery([doc], "knowledge query", 5);

    expect(first.ingested).toBe(1);
    expect(second.skipped).toBe(1);
    expect(mockIngest).toHaveBeenCalledTimes(1);
    expect(mockIngest).toHaveBeenCalledWith(
      expect.stringContaining("Location: Knowledge Title"),
      expect.objectContaining({
        docId: "knowledge-seed-dedup",
        source: "knowledge",
      }),
    );
  });

  it("uses codebase seed metadata fallbacks when location fields are missing", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockIngest.mockResolvedValueOnce({ sourceId: "seed-code-fallback" });

    const stats = await ingestScoredDocumentsForQuery([
      {
        id: "code-fallback",
        source: "codebase",
        content: "fallback content",
        title: "src/fallback.ts",
        score: 3,
        baseScore: 3,
        importanceScore: 0,
        recencyScore: 0,
        trustScore: 0.9,
        claimKitBoost: 0,
        tokens: 10,
        metadata: {},
      },
    ], "fallback query", 5);

    expect(stats.ingested).toBe(1);
    expect(mockIngest).toHaveBeenCalledWith(
      expect.stringContaining("Location: src/fallback.ts:-"),
      expect.objectContaining({
        docId: "code-fallback",
        source: "codebase",
      }),
    );
  });
});

describe("single-item ClaimKit ingestion helpers", () => {
  let mod: typeof import("../../../src/context-engine/claimkit-ingestion");

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doMock("../../../src/context-engine/adapters/claimkit-adapter", () => ({
      claimKitAdapter: mockClaimKitAdapter,
    }));
    vi.doMock("../../../src/agent/knowledge-graph", () => ({
      knowledgeGraph: mockKnowledgeGraph,
    }));
    vi.doMock("../../../src/config/env", () => ({
      env: {
        AI_MAX_CONCURRENT: 3,
        RAG_INCLUDE_LOCAL_SOURCES: false,
      },
    }));
    mod = await import("../../../src/context-engine/claimkit-ingestion");
  });

  it("ingests a single knowledge entry once and skips duplicates", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockIngest.mockResolvedValue({ sourceId: "single-knowledge" });
    const entry = {
      id: "single-knowledge-entry",
      source: "manual" as const,
      title: "Manual Note",
      content: "Manual content",
      tags: ["manual"],
      createdAt: new Date(),
    };

    await mod.ingestSingleKnowledgeEntry(entry);
    await mod.ingestSingleKnowledgeEntry(entry);

    expect(mockIngest).toHaveBeenCalledTimes(1);
    expect(mockIngest).toHaveBeenCalledWith("Manual Note\n\nManual content", {
      docId: "single-knowledge-entry",
      title: "Manual Note",
      source: "knowledge",
      trustTier: "curated",
      tags: ["manual"],
    });
  });

  it("skips file_read single knowledge entries when local sources are disabled", async () => {
    mockIsAvailable.mockReturnValue(true);

    await mod.ingestSingleKnowledgeEntry({
      id: "single-file-read-entry",
      source: "file_read" as const,
      title: "Local File",
      content: "Local content",
      tags: [],
      createdAt: new Date(),
    });

    expect(mockIngest).not.toHaveBeenCalled();
  });

  it("does not ingest single entries when ClaimKit is unavailable", async () => {
    mockIsAvailable.mockReturnValue(false);

    await mod.ingestSingleCodebaseFile({
      path: "src/unavailable.ts",
      language: "typescript",
      content: "export const unavailable = true;",
    });

    expect(mockIngest).not.toHaveBeenCalled();
  });

  it("ingests a single codebase file and swallows ingest failures", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockIngest.mockResolvedValueOnce({ sourceId: "single-code" });

    await mod.ingestSingleCodebaseFile({
      path: "src/single.ts",
      language: "typescript",
      content: "export const single = true;",
    });

    expect(mockIngest).toHaveBeenCalledWith("File: src/single.ts\n\nexport const single = true;", {
      path: "src/single.ts",
      title: "src/single.ts",
      source: "codebase",
      language: "typescript",
      trustTier: "curated",
    });

    mockIngest.mockRejectedValueOnce(new Error("codebase ingest failed"));
    await expect(mod.ingestSingleCodebaseFile({
      path: "src/failing-single.ts",
      language: "typescript",
      content: "throw new Error();",
    })).resolves.toBeUndefined();
  });

  it("ingests a single graph node with default context", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockIngest.mockResolvedValue({ sourceId: "single-node" });

    await mod.ingestSingleGraphNode({
      id: "node-single",
      type: "component",
      title: "Auth Service",
      content: "Handles auth",
      status: "accepted",
      tags: [],
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(mockIngest).toHaveBeenCalledWith(
      "Entity: Auth Service (component)\nHandles auth\nContext: N/A\nStatus: accepted",
      {
        entityId: "node-single",
        entityType: "component",
        source: "graph",
        trustTier: "curated",
      },
    );
  });

  it("ingests a single graph edge with relationship claim metadata", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockIngest.mockResolvedValue({ sourceId: "single-edge" });
    mockGetNode.mockImplementation((id: string) => {
      if (id === "source-node") {
        return { id, type: "component", title: "API Gateway", content: "", status: "accepted", tags: [], metadata: {}, createdAt: new Date(), updatedAt: new Date() };
      }
      if (id === "target-node") {
        return { id, type: "component", title: "Auth Service", content: "", status: "accepted", tags: [], metadata: {}, createdAt: new Date(), updatedAt: new Date() };
      }
      return null;
    });

    await mod.ingestSingleGraphEdge({
      id: "edge-single",
      sourceId: "source-node",
      targetId: "target-node",
      type: "depends_on",
      description: "API Gateway calls Auth Service",
      createdAt: new Date(),
    });

    expect(mockIngest).toHaveBeenCalledWith(
      "Relationship claim: API Gateway relationship [depends_on] -> Auth Service\nAPI Gateway calls Auth Service",
      {
        relationshipId: "edge-single",
        relationshipType: "depends_on",
        relationshipClaim: {
          entity: "API Gateway",
          attribute: "relationship",
          value: "[depends_on] -> Auth Service",
          sourceNodeId: "source-node",
          targetNodeId: "target-node",
          edgeType: "depends_on",
          trustTier: "curated",
        },
        source: "graph",
        trustTier: "curated",
      },
    );
  });
});

// ── ingestGraphStore ───────────────────────────────────────────────────

const mockGetAllNodes = vi.fn();
const mockGetAllEdges = vi.fn();
const mockGetNode = vi.fn();

const mockKnowledgeGraph = {
  getAllNodes: mockGetAllNodes,
  getAllEdges: mockGetAllEdges,
  getNode: mockGetNode,
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
    mockGetNode.mockImplementation((id: string) => {
      if (id === "kg-component-1") {
        return {
          id: "kg-component-1",
          type: "component",
          title: "Auth Service",
          content: "Handles user authentication and authorization",
          status: "accepted",
          tags: [],
          metadata: {},
          createdAt: new Date("2026-01-01"),
          updatedAt: new Date("2026-01-15"),
        };
      }
      if (id === "kg-decision-1") {
        return {
          id: "kg-decision-1",
          type: "decision",
          title: "Use JWT for API auth",
          content: "Decided to use JWT tokens for API authentication",
          status: "accepted",
          tags: [],
          metadata: {},
          createdAt: new Date("2026-01-02"),
          updatedAt: new Date("2026-01-02"),
        };
      }
      return null;
    });
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
      expect.stringContaining("Relationship claim: Auth Service relationship [implements] -> Use JWT for API auth"),
      {
        relationshipId: "edge-1",
        relationshipType: "implements",
        relationshipClaim: {
          entity: "Auth Service",
          attribute: "relationship",
          value: "[implements] -> Use JWT for API auth",
          sourceNodeId: "kg-component-1",
          targetNodeId: "kg-decision-1",
          edgeType: "implements",
          trustTier: "curated",
        },
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

  it("should skip graph nodes and edges already ingested in a previous run", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockGetAllNodes.mockReturnValue([
      {
        id: "node-dedup",
        type: "component",
        title: "Dedup Node",
        content: "Node content",
        status: "accepted",
        tags: [],
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    mockGetAllEdges.mockReturnValue([
      {
        id: "edge-dedup",
        sourceId: "node-dedup",
        targetId: "target-dedup",
        type: "related_to",
        createdAt: new Date(),
      },
    ]);
    mockGetNode.mockReturnValue(null);
    mockIngest
      .mockResolvedValueOnce({ sourceId: "node-src" })
      .mockResolvedValueOnce({ sourceId: "edge-src" });

    const first = await ingestGraphStore();
    const second = await ingestGraphStore();

    expect(first.ingested).toBe(2);
    expect(second.skipped).toBe(2);
    expect(mockIngest).toHaveBeenCalledTimes(2);
  });
});
