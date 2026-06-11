import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EntityMemory } from "../entity-memory";
import { KnowledgeGraph } from "../../agent/knowledge-graph";
import os from "os";
import path from "path";
import fs from "fs";

function tmpDb(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

describe("graph-auto-populator", () => {
  let mem: EntityMemory;
  let kg: KnowledgeGraph;
  let memDbPath: string;
  let kgDbPath: string;

  beforeEach(() => {
    memDbPath = tmpDb("entity-memory-test");
    kgDbPath = tmpDb("knowledge-graph-test");
    mem = new EntityMemory(memDbPath);
    kg = new KnowledgeGraph(kgDbPath);

    // Replace the singletons that graph-auto-populator imports.
    vi.doMock("../entity-memory", () => ({
      EntityMemory,
      entityMemory: mem,
    }));
    vi.doMock("../../agent/knowledge-graph", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../agent/knowledge-graph")>();
      return {
        ...actual,
        knowledgeGraph: kg,
      };
    });
  });

  afterEach(() => {
    mem.close();
    kg.close();
    if (fs.existsSync(memDbPath)) fs.unlinkSync(memDbPath);
    if (fs.existsSync(kgDbPath)) fs.unlinkSync(kgDbPath);
    vi.resetModules();
    vi.doUnmock("../entity-memory");
    vi.doUnmock("../../agent/knowledge-graph");
  });

  describe("autoPopulateFromEntity", () => {
    it("creates a KG node with autoPopulated metadata when no node exists", async () => {
      const entity = mem.upsertEntity({
        type: "jira_issue",
        name: "IR-82",
        summary: "Security: eval() in query_parser.py",
        source: "jira",
        sourceUrl: "https://jira.example.com/browse/IR-82",
      });

      const { autoPopulateFromEntity } = await import("../graph-auto-populator.js");
      autoPopulateFromEntity(entity);

      const nodes = kg.queryNodes({ search: "IR-82", limit: 5 });
      const match = nodes.find(
        (n) => n.title === "IR-82" || n.metadata?.entityName === "IR-82",
      );
      expect(match).toBeDefined();
      expect(match!.metadata.autoPopulated).toBe(true);
      expect(match!.metadata.entityName).toBe("IR-82");
      expect(match!.metadata.entityType).toBe("jira_issue");
      expect(match!.metadata.sourceUrl).toBe("https://jira.example.com/browse/IR-82");
      expect(match!.status).toBe("accepted");
      expect(match!.tags).toContain("jira_issue");
      expect(match!.tags).toContain("auto-populated");
    });

    it("skips creation when a node with matching entityName already exists", async () => {
      const entity = mem.upsertEntity({
        type: "jira_issue",
        name: "IR-82",
        summary: "Some issue",
        source: "jira",
      });

      // Pre-create a node for this entity.
      kg.addNode({
        type: "requirement",
        title: "IR-82",
        content: "pre-existing",
        status: "accepted",
        tags: ["jira_issue"],
        metadata: { entityName: "IR-82", autoPopulated: true },
      });

      const nodesBefore = kg.getAllNodes().length;

      const { autoPopulateFromEntity } = await import("../graph-auto-populator.js");
      autoPopulateFromEntity(entity);

      const nodesAfter = kg.getAllNodes().length;
      expect(nodesAfter).toBe(nodesBefore); // No new node created.
    });

    it("skips creation when a node with matching title already exists", async () => {
      const entity = mem.upsertEntity({
        type: "jira_issue",
        name: "IR-100",
        summary: "Another issue",
        source: "jira",
      });

      // Pre-create a node with matching title but no entityName metadata.
      kg.addNode({
        type: "requirement",
        title: "IR-100",
        content: "manually created",
        status: "accepted",
        tags: [],
        metadata: {},
      });

      const nodesBefore = kg.getAllNodes().length;

      const { autoPopulateFromEntity } = await import("../graph-auto-populator.js");
      autoPopulateFromEntity(entity);

      const nodesAfter = kg.getAllNodes().length;
      expect(nodesAfter).toBe(nodesBefore);
    });

    it("creates an edge when a claim references another entity via 'blocks'", async () => {
      // Create two entities and populate their claims.
      const entity1 = mem.upsertEntity({
        type: "jira_issue",
        name: "IR-82",
        summary: "Blocker issue",
        source: "jira",
      });
      mem.upsertEntity({
        type: "jira_issue",
        name: "IR-99",
        summary: "Blocked issue",
        source: "jira",
      });

      // Add a "blocks" relationship claim on entity1.
      mem.setStructuredFact(entity1.id, "blocks", "IR-99");

      // Pre-populate a KG node for entity2 so the edge target exists.
      kg.addNode({
        type: "requirement",
        title: "IR-99",
        content: "",
        status: "accepted",
        tags: ["jira_issue", "auto-populated"],
        metadata: { entityName: "IR-99", autoPopulated: true },
      });

      const { autoPopulateFromEntity } = await import("../graph-auto-populator.js");
      autoPopulateFromEntity(entity1);

      const edges = kg.getAllEdges();
      const blocksEdge = edges.find(
        (e) => e.type === "blocks",
      );
      expect(blocksEdge).toBeDefined();
      expect(blocksEdge!.description).toContain("blocks");
      expect(blocksEdge!.description).toContain("IR-99");
    });

    it("creates an edge for depends_on relationship claims", async () => {
      const entity = mem.upsertEntity({
        type: "jira_issue",
        name: "IR-50",
        source: "jira",
      });
      mem.upsertEntity({
        type: "jira_issue",
        name: "IR-51",
        source: "jira",
      });
      mem.setStructuredFact(entity.id, "depends_on", "IR-51");

      // Populate target node.
      kg.addNode({
        type: "requirement",
        title: "IR-51",
        content: "",
        status: "accepted",
        tags: [],
        metadata: { entityName: "IR-51", autoPopulated: true },
      });

      const { autoPopulateFromEntity } = await import("../graph-auto-populator.js");
      autoPopulateFromEntity(entity);

      const edges = kg.getAllEdges();
      const depEdge = edges.find((e) => e.type === "depends_on");
      expect(depEdge).toBeDefined();
    });

    it("does not create an edge when target node does not exist", async () => {
      const entity = mem.upsertEntity({
        type: "jira_issue",
        name: "IR-82",
        source: "jira",
      });
      mem.setStructuredFact(entity.id, "blocks", "IR-999");

      const { autoPopulateFromEntity } = await import("../graph-auto-populator.js");
      autoPopulateFromEntity(entity);

      // Node for IR-82 should be created, but no edges since IR-999 doesn't exist.
      const edges = kg.getAllEdges();
      expect(edges).toHaveLength(0);
    });

    it("does not create edges for non-relationship claims", async () => {
      const entity = mem.upsertEntity({
        type: "jira_issue",
        name: "IR-82",
        source: "jira",
      });
      mem.setStructuredFact(entity.id, "status", "In Progress");
      mem.setStructuredFact(entity.id, "assignee", "Tim Shelton");

      const { autoPopulateFromEntity } = await import("../graph-auto-populator.js");
      autoPopulateFromEntity(entity);

      const edges = kg.getAllEdges();
      expect(edges).toHaveLength(0);

      // But the node itself should still be created.
      const nodes = kg.queryNodes({ search: "IR-82", limit: 5 });
      expect(nodes.find((n) => n.metadata?.entityName === "IR-82")).toBeDefined();
    });
  });

  describe("mapEntityType", () => {
    it("maps jira_issue to requirement", async () => {
      const { mapEntityType } = await import("../graph-auto-populator.js");
      expect(mapEntityType("jira_issue", "")).toBe("requirement");
    });

    it("maps github_pr to pattern", async () => {
      const { mapEntityType } = await import("../graph-auto-populator.js");
      expect(mapEntityType("github_pr", "")).toBe("pattern");
    });

    it("maps gitlab_mr to pattern", async () => {
      const { mapEntityType } = await import("../graph-auto-populator.js");
      expect(mapEntityType("gitlab_mr", "")).toBe("pattern");
    });

    it("maps unknown types to reasoning", async () => {
      const { mapEntityType } = await import("../graph-auto-populator.js");
      expect(mapEntityType("person", "")).toBe("reasoning");
    });

    it("maps vulnerability to risk", async () => {
      const { mapEntityType } = await import("../graph-auto-populator.js");
      expect(mapEntityType("vulnerability", "")).toBe("risk");
    });

    it("maps incident to risk", async () => {
      const { mapEntityType } = await import("../graph-auto-populator.js");
      expect(mapEntityType("incident", "")).toBe("risk");
    });
  });

  describe("inferEdgeType", () => {
    it("maps 'blocks' attribute to 'blocks' edge type", async () => {
      const { inferEdgeType } = await import("../graph-auto-populator.js");
      expect(inferEdgeType("blocks")).toBe("blocks");
    });

    it("maps 'depends_on' attribute to 'depends_on' edge type", async () => {
      const { inferEdgeType } = await import("../graph-auto-populator.js");
      expect(inferEdgeType("depends_on")).toBe("depends_on");
    });

    it("maps 'relates_to' attribute to 'related_to' edge type", async () => {
      const { inferEdgeType } = await import("../graph-auto-populator.js");
      expect(inferEdgeType("relates_to")).toBe("related_to");
    });

    it("maps unknown attributes to 'related_to' as default", async () => {
      const { inferEdgeType } = await import("../graph-auto-populator.js");
      expect(inferEdgeType("something_else")).toBe("related_to");
    });
  });

  describe("extractRelatedEntity", () => {
    it("extracts a Jira-style entity ID from claim value", async () => {
      const { extractRelatedEntity } = await import("../graph-auto-populator.js");
      expect(extractRelatedEntity("IR-82")).toBe("IR-82");
    });

    it("extracts entity ID from text with surrounding words", async () => {
      const { extractRelatedEntity } = await import("../graph-auto-populator.js");
      expect(extractRelatedEntity("blocked by IR-82 currently")).toBe("IR-82");
    });

    it("extracts GitHub-style entity reference", async () => {
      const { extractRelatedEntity } = await import("../graph-auto-populator.js");
      expect(extractRelatedEntity("acme/widgets#42")).toBe("acme/widgets#42");
    });

    it("returns null for plain text without entity references", async () => {
      const { extractRelatedEntity } = await import("../graph-auto-populator.js");
      expect(extractRelatedEntity("In Progress")).toBeNull();
    });

    it("returns null for empty string", async () => {
      const { extractRelatedEntity } = await import("../graph-auto-populator.js");
      expect(extractRelatedEntity("")).toBeNull();
    });
  });
});
