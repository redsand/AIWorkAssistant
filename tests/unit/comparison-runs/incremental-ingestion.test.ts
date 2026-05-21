import { describe, it, expect, beforeEach, vi } from "vitest";

const mockIngest = vi.fn();
const mockIsAvailable = vi.fn();

const mockClaimKitAdapter = {
  ingest: mockIngest,
  isAvailable: mockIsAvailable,
};

vi.doMock("../../../src/context-engine/adapters/claimkit-adapter", () => ({
  claimKitAdapter: mockClaimKitAdapter,
}));

vi.doMock("../../../src/agent/knowledge-store", () => ({
  knowledgeStore: { getAllEntries: vi.fn().mockReturnValue([]) },
}));

vi.doMock("../../../src/agent/codebase-indexer", () => ({
  codebaseIndexer: { getIndexedFiles: vi.fn().mockReturnValue([]) },
}));

vi.doMock("../../../src/agent/knowledge-graph", () => ({
  knowledgeGraph: { getAllNodes: vi.fn().mockReturnValue([]), getAllEdges: vi.fn().mockReturnValue([]) },
}));

async function importIngestion() {
  return import("../../../src/context-engine/claimkit-ingestion");
}

describe("incremental ingestion", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    vi.doMock("../../../src/context-engine/adapters/claimkit-adapter", () => ({
      claimKitAdapter: mockClaimKitAdapter,
    }));
    vi.doMock("../../../src/agent/knowledge-store", () => ({
      knowledgeStore: { getAllEntries: vi.fn().mockReturnValue([]) },
    }));
    vi.doMock("../../../src/agent/codebase-indexer", () => ({
      codebaseIndexer: { getIndexedFiles: vi.fn().mockReturnValue([]) },
    }));
    vi.doMock("../../../src/agent/knowledge-graph", () => ({
      knowledgeGraph: { getAllNodes: vi.fn().mockReturnValue([]), getAllEdges: vi.fn().mockReturnValue([]) },
    }));
  });

  describe("ingestSingleKnowledgeEntry", () => {
    it("should ingest a single knowledge entry", async () => {
      mockIsAvailable.mockReturnValue(true);
      mockIngest.mockResolvedValue({ sourceId: "src-1" });

      const { ingestSingleKnowledgeEntry } = await importIngestion();
      const entry = {
        id: "kn-test",
        source: "manual" as const,
        title: "Test Doc",
        content: "Test content",
        tags: ["test"],
        createdAt: new Date(),
        accessedAt: new Date(),
        accessCount: 0,
      };

      await ingestSingleKnowledgeEntry(entry);

      expect(mockIngest).toHaveBeenCalledWith("Test Doc\n\nTest content", {
        docId: "kn-test",
        title: "Test Doc",
        source: "knowledge",
        tags: ["test"],
      });
    });

    it("should be a no-op when ClaimKit is not available", async () => {
      mockIsAvailable.mockReturnValue(false);

      const { ingestSingleKnowledgeEntry } = await importIngestion();
      await ingestSingleKnowledgeEntry({
        id: "kn-x",
        source: "manual",
        title: "X",
        content: "X",
        tags: [],
        createdAt: new Date(),
        accessedAt: new Date(),
        accessCount: 0,
      });

      expect(mockIngest).not.toHaveBeenCalled();
    });

    it("should skip duplicate entries by ID", async () => {
      mockIsAvailable.mockReturnValue(true);
      mockIngest.mockResolvedValue({ sourceId: "src-1" });

      const { ingestSingleKnowledgeEntry } = await importIngestion();
      const entry = {
        id: "kn-dup",
        source: "manual" as const,
        title: "Dup",
        content: "Dup content",
        tags: [],
        createdAt: new Date(),
        accessedAt: new Date(),
        accessCount: 0,
      };

      await ingestSingleKnowledgeEntry(entry);
      await ingestSingleKnowledgeEntry(entry);

      expect(mockIngest).toHaveBeenCalledTimes(1);
    });

    it("should catch and log errors without throwing", async () => {
      mockIsAvailable.mockReturnValue(true);
      mockIngest.mockRejectedValue(new Error("Ingest failed"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { ingestSingleKnowledgeEntry } = await importIngestion();
      await ingestSingleKnowledgeEntry({
        id: "kn-err",
        source: "manual",
        title: "Err",
        content: "Err content",
        tags: [],
        createdAt: new Date(),
        accessedAt: new Date(),
        accessCount: 0,
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("kn-err"),
        expect.any(Error),
      );
      warnSpy.mockRestore();
    });

    it("should default undefined tags to empty array", async () => {
      mockIsAvailable.mockReturnValue(true);
      mockIngest.mockResolvedValue({ sourceId: "src-t" });

      const { ingestSingleKnowledgeEntry } = await importIngestion();
      await ingestSingleKnowledgeEntry({
        id: "kn-notags",
        source: "manual",
        title: "No Tags",
        content: "Content",
        tags: undefined as any,
        createdAt: new Date(),
        accessedAt: new Date(),
        accessCount: 0,
      });

      expect(mockIngest).toHaveBeenCalledWith(expect.any(String), {
        docId: "kn-notags",
        title: "No Tags",
        source: "knowledge",
        tags: [],
      });
    });
  });

  describe("ingestSingleCodebaseFile", () => {
    it("should ingest a single codebase file", async () => {
      mockIsAvailable.mockReturnValue(true);
      mockIngest.mockResolvedValue({ sourceId: "src-cb" });

      const { ingestSingleCodebaseFile } = await importIngestion();
      await ingestSingleCodebaseFile({
        path: "src/utils.ts",
        language: "typescript",
        content: "export function foo() {}",
      });

      expect(mockIngest).toHaveBeenCalledWith(
        "File: src/utils.ts\n\nexport function foo() {}",
        { path: "src/utils.ts", source: "codebase", language: "typescript" },
      );
    });

    it("should be a no-op when ClaimKit is not available", async () => {
      mockIsAvailable.mockReturnValue(false);

      const { ingestSingleCodebaseFile } = await importIngestion();
      await ingestSingleCodebaseFile({
        path: "src/a.ts",
        language: "typescript",
        content: "a",
      });

      expect(mockIngest).not.toHaveBeenCalled();
    });

    it("should skip duplicate files by path", async () => {
      mockIsAvailable.mockReturnValue(true);
      mockIngest.mockResolvedValue({ sourceId: "src-cb" });

      const { ingestSingleCodebaseFile } = await importIngestion();
      const file = { path: "src/dup.ts", language: "typescript", content: "dup" };

      await ingestSingleCodebaseFile(file);
      await ingestSingleCodebaseFile(file);

      expect(mockIngest).toHaveBeenCalledTimes(1);
    });

    it("should catch and log errors without throwing", async () => {
      mockIsAvailable.mockReturnValue(true);
      mockIngest.mockRejectedValue(new Error("Ingest failed"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { ingestSingleCodebaseFile } = await importIngestion();
      await ingestSingleCodebaseFile({
        path: "src/err.ts",
        language: "typescript",
        content: "err",
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("src/err.ts"),
        expect.any(Error),
      );
      warnSpy.mockRestore();
    });
  });

  describe("ingestSingleGraphNode", () => {
    it("should ingest a single graph node", async () => {
      mockIsAvailable.mockReturnValue(true);
      mockIngest.mockResolvedValue({ sourceId: "src-g" });

      const { ingestSingleGraphNode } = await importIngestion();
      await ingestSingleGraphNode({
        id: "kg-comp-1",
        type: "component",
        title: "Auth Service",
        content: "Handles auth",
        status: "accepted",
        context: "Core infra",
        tags: ["auth"],
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(mockIngest).toHaveBeenCalledWith(
        expect.stringContaining("Entity: Auth Service (component)"),
        { entityId: "kg-comp-1", entityType: "component", source: "graph" },
      );
    });

    it("should be a no-op when ClaimKit is not available", async () => {
      mockIsAvailable.mockReturnValue(false);

      const { ingestSingleGraphNode } = await importIngestion();
      await ingestSingleGraphNode({
        id: "n1",
        type: "component",
        title: "X",
        content: "X",
        status: "proposed",
        tags: [],
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(mockIngest).not.toHaveBeenCalled();
    });

    it("should skip duplicate nodes by ID", async () => {
      mockIsAvailable.mockReturnValue(true);
      mockIngest.mockResolvedValue({ sourceId: "src-g" });

      const { ingestSingleGraphNode } = await importIngestion();
      const node = {
        id: "kg-dup",
        type: "decision" as const,
        title: "Dup",
        content: "Dup",
        status: "proposed" as const,
        tags: [] as string[],
        metadata: {} as Record<string, unknown>,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await ingestSingleGraphNode(node);
      await ingestSingleGraphNode(node);

      expect(mockIngest).toHaveBeenCalledTimes(1);
    });

    it("should catch and log errors without throwing", async () => {
      mockIsAvailable.mockReturnValue(true);
      mockIngest.mockRejectedValue(new Error("Ingest failed"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { ingestSingleGraphNode } = await importIngestion();
      await ingestSingleGraphNode({
        id: "kg-err",
        type: "component",
        title: "Err",
        content: "Err",
        status: "proposed",
        tags: [],
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("kg-err"),
        expect.any(Error),
      );
      warnSpy.mockRestore();
    });
  });

  describe("ingestSingleGraphEdge", () => {
    it("should ingest a single graph edge", async () => {
      mockIsAvailable.mockReturnValue(true);
      mockIngest.mockResolvedValue({ sourceId: "src-e" });

      const { ingestSingleGraphEdge } = await importIngestion();
      await ingestSingleGraphEdge({
        id: "edge-1",
        sourceId: "a",
        targetId: "b",
        type: "depends_on",
        description: "A depends on B",
        createdAt: new Date(),
      });

      expect(mockIngest).toHaveBeenCalledWith(
        expect.stringContaining("Relationship: a --[depends_on]--> b"),
        { relationshipId: "edge-1", relationshipType: "depends_on", source: "graph" },
      );
    });

    it("should be a no-op when ClaimKit is not available", async () => {
      mockIsAvailable.mockReturnValue(false);

      const { ingestSingleGraphEdge } = await importIngestion();
      await ingestSingleGraphEdge({
        id: "e1",
        sourceId: "a",
        targetId: "b",
        type: "depends_on",
        createdAt: new Date(),
      });

      expect(mockIngest).not.toHaveBeenCalled();
    });

    it("should skip duplicate edges by ID", async () => {
      mockIsAvailable.mockReturnValue(true);
      mockIngest.mockResolvedValue({ sourceId: "src-e" });

      const { ingestSingleGraphEdge } = await importIngestion();
      const edge = {
        id: "edge-dup",
        sourceId: "a",
        targetId: "b",
        type: "depends_on" as const,
        createdAt: new Date(),
      };

      await ingestSingleGraphEdge(edge);
      await ingestSingleGraphEdge(edge);

      expect(mockIngest).toHaveBeenCalledTimes(1);
    });

    it("should catch and log errors without throwing", async () => {
      mockIsAvailable.mockReturnValue(true);
      mockIngest.mockRejectedValue(new Error("Ingest failed"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { ingestSingleGraphEdge } = await importIngestion();
      await ingestSingleGraphEdge({
        id: "edge-err",
        sourceId: "a",
        targetId: "b",
        type: "depends_on",
        createdAt: new Date(),
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("edge-err"),
        expect.any(Error),
      );
      warnSpy.mockRestore();
    });
  });

  describe("bulk ingestion populates dedup set", () => {
    it("should skip items already ingested during bulk startup ingestion", async () => {
      mockIsAvailable.mockReturnValue(true);
      mockIngest.mockResolvedValue({ sourceId: "src-bulk" });

      const { ingestSingleKnowledgeEntry, ingestKnowledgeStore } = await importIngestion();

      const mockGetAllEntries = vi.fn().mockReturnValue([
        {
          id: "kn-bulk",
          source: "manual",
          title: "Bulk Doc",
          content: "Bulk content",
          tags: [],
          createdAt: new Date(),
        },
      ]);

      vi.doMock("../../../src/agent/knowledge-store", () => ({
        knowledgeStore: { getAllEntries: mockGetAllEntries },
      }));

      await ingestKnowledgeStore();

      await ingestSingleKnowledgeEntry({
        id: "kn-bulk",
        source: "manual",
        title: "Bulk Doc",
        content: "Bulk content",
        tags: [],
        createdAt: new Date(),
        accessedAt: new Date(),
        accessCount: 0,
      });

      expect(mockIngest).toHaveBeenCalledTimes(1);
    });
  });
});
