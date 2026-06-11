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

    it("creates reversed edge for blocked_by: target blocks current entity", async () => {
      // Entity A is blocked_by B → semantic: B blocks A.
      // Edge should be: B → blocks → A (sourceId=B, targetId=A).
      const entityA = mem.upsertEntity({
        type: "jira_issue",
        name: "IR-82",
        summary: "Blocked issue",
        source: "jira",
      });
      mem.upsertEntity({
        type: "jira_issue",
        name: "IR-99",
        summary: "Blocker issue",
        source: "jira",
      });

      // A is blocked_by B.
      mem.setStructuredFact(entityA.id, "blocked_by", "IR-99");

      // Pre-create KG node for B (the blocker) so edge target lookup succeeds.
      const bNodeId = kg.addNode({
        type: "requirement",
        title: "IR-99",
        content: "",
        status: "accepted",
        tags: ["jira_issue", "auto-populated"],
        metadata: { entityName: "IR-99", autoPopulated: true },
      });

      const { autoPopulateFromEntity } = await import("../graph-auto-populator.js");
      autoPopulateFromEntity(entityA);

      const edges = kg.getAllEdges();
      expect(edges).toHaveLength(1);

      const edge = edges[0];
      expect(edge.type).toBe("blocks");

      // Find the created node for A.
      const aNode = kg.queryNodes({ search: "IR-82", limit: 5 }).find(
        (n) => n.metadata?.entityName === "IR-82",
      );
      expect(aNode).toBeDefined();

      // Edge must read "IR-99 blocks IR-82": source=B (IR-99), target=A (IR-82).
      expect(edge.sourceId).toBe(bNodeId);
      expect(edge.targetId).toBe(aNode!.id);

      // Must NOT be the other way around (the original bug).
      expect(edge.sourceId).not.toBe(aNode!.id);
    });

    it("creates reversed edge for blocked_by with surrounding text in value", async () => {
      const entityA = mem.upsertEntity({
        type: "jira_issue",
        name: "IR-10",
        summary: "Blocked ticket",
        source: "jira",
      });
      mem.upsertEntity({
        type: "jira_issue",
        name: "IR-20",
        summary: "Blocker ticket",
        source: "jira",
      });

      // Claim value has surrounding text; entity ID extraction should still work.
      mem.setStructuredFact(entityA.id, "blocked_by", "currently waiting on IR-20");

      const bNodeId = kg.addNode({
        type: "requirement",
        title: "IR-20",
        content: "",
        status: "accepted",
        tags: [],
        metadata: { entityName: "IR-20", autoPopulated: true },
      });

      const { autoPopulateFromEntity } = await import("../graph-auto-populator.js");
      autoPopulateFromEntity(entityA);

      const edges = kg.getAllEdges();
      expect(edges).toHaveLength(1);
      expect(edges[0].type).toBe("blocks");

      const aNode = kg.queryNodes({ search: "IR-10", limit: 5 }).find(
        (n) => n.metadata?.entityName === "IR-10",
      );
      expect(aNode).toBeDefined();

      // B blocks A: sourceId = B, targetId = A.
      expect(edges[0].sourceId).toBe(bNodeId);
      expect(edges[0].targetId).toBe(aNode!.id);
    });

    it("does not create duplicate edges when autoPopulateFromEntity is called twice", async () => {
      const entity = mem.upsertEntity({
        type: "jira_issue",
        name: "IR-82",
        summary: "Issue with relationship",
        source: "jira",
      });
      mem.upsertEntity({
        type: "jira_issue",
        name: "IR-99",
        summary: "Related issue",
        source: "jira",
      });
      mem.setStructuredFact(entity.id, "blocks", "IR-99");

      kg.addNode({
        type: "requirement",
        title: "IR-99",
        content: "",
        status: "accepted",
        tags: ["jira_issue", "auto-populated"],
        metadata: { entityName: "IR-99", autoPopulated: true },
      });

      const { autoPopulateFromEntity } = await import("../graph-auto-populator.js");

      // Call twice — first call creates node + edge, second should be a no-op.
      autoPopulateFromEntity(entity);
      autoPopulateFromEntity(entity);

      const edges = kg.getAllEdges();
      const blocksEdges = edges.filter((e) => e.type === "blocks");
      expect(blocksEdges).toHaveLength(1);
    });

    it("does not create duplicate edges when edge already exists from manual creation", async () => {
      const entity = mem.upsertEntity({
        type: "jira_issue",
        name: "IR-55",
        summary: "Issue with pre-existing edge",
        source: "jira",
      });
      mem.upsertEntity({
        type: "jira_issue",
        name: "IR-60",
        summary: "Target issue",
        source: "jira",
      });
      mem.setStructuredFact(entity.id, "depends_on", "IR-60");

      const targetNodeId = kg.addNode({
        type: "requirement",
        title: "IR-60",
        content: "",
        status: "accepted",
        tags: [],
        metadata: { entityName: "IR-60", autoPopulated: true },
      });

      const { autoPopulateFromEntity } = await import("../graph-auto-populator.js");

      // First call creates the node and edge.
      autoPopulateFromEntity(entity);

      const edgesAfterFirst = kg.getAllEdges();
      expect(edgesAfterFirst.filter((e) => e.type === "depends_on")).toHaveLength(1);

      // Get the created node ID so we can manually add a duplicate edge.
      const nodeForEntity = kg.queryNodes({ search: "IR-55", limit: 5 }).find(
        (n) => n.metadata?.entityName === "IR-55",
      );
      expect(nodeForEntity).toBeDefined();

      // Manually insert the same edge to simulate an externally-created duplicate.
      kg.addEdge(nodeForEntity!.id, targetNodeId, "depends_on", "manual edge");

      const edgesAfterManual = kg.getAllEdges();
      expect(edgesAfterManual.filter((e) => e.type === "depends_on")).toHaveLength(2);

      // Delete the node to force re-creation path (simulate a fresh run).
      kg.deleteNode(nodeForEntity!.id);

      // Re-run auto-populate: creates a new node, but should NOT duplicate the edge
      // that now points to a dangling reference (deleted node). After delete, edges
      // from that node are also cleaned up, so we expect exactly 0 depends_on edges
      // on the new node (the manual edge was cleaned up with the node deletion).
      autoPopulateFromEntity(entity);

      const finalEdges = kg.getAllEdges().filter((e) => e.type === "depends_on");
      expect(finalEdges).toHaveLength(1);
    });

    it("creates edges for both blocks and blocked_by on the same entity without conflict", async () => {
      const entityA = mem.upsertEntity({
        type: "jira_issue",
        name: "IR-1",
        summary: "Multi-relationship issue",
        source: "jira",
      });
      mem.upsertEntity({ type: "jira_issue", name: "IR-2", source: "jira" });
      mem.upsertEntity({ type: "jira_issue", name: "IR-3", source: "jira" });

      // A blocks IR-2 (A→blocks→IR-2) AND A is blocked_by IR-3 (IR-3→blocks→A).
      mem.setStructuredFact(entityA.id, "blocks", "IR-2");
      mem.setStructuredFact(entityA.id, "blocked_by", "IR-3");

      const ir2NodeId = kg.addNode({
        type: "requirement",
        title: "IR-2",
        content: "",
        status: "accepted",
        tags: [],
        metadata: { entityName: "IR-2", autoPopulated: true },
      });
      const ir3NodeId = kg.addNode({
        type: "requirement",
        title: "IR-3",
        content: "",
        status: "accepted",
        tags: [],
        metadata: { entityName: "IR-3", autoPopulated: true },
      });

      const { autoPopulateFromEntity } = await import("../graph-auto-populator.js");
      autoPopulateFromEntity(entityA);

      const edges = kg.getAllEdges();
      expect(edges).toHaveLength(2);

      const aNode = kg.queryNodes({ search: "IR-1", limit: 5 }).find(
        (n) => n.metadata?.entityName === "IR-1",
      );
      expect(aNode).toBeDefined();

      // "blocks IR-2" → A is source, IR-2 is target.
      const blocksEdge = edges.find(
        (e) => e.sourceId === aNode!.id && e.targetId === ir2NodeId,
      );
      expect(blocksEdge).toBeDefined();
      expect(blocksEdge!.type).toBe("blocks");

      // "blocked_by IR-3" → IR-3 is source, A is target (reversed).
      const blockedByEdge = edges.find(
        (e) => e.sourceId === ir3NodeId && e.targetId === aNode!.id,
      );
      expect(blockedByEdge).toBeDefined();
      expect(blockedByEdge!.type).toBe("blocks");
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
