import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Mock claimkit-ingestion to prevent side effects from singleton creation
vi.mock("../../context-engine/claimkit-ingestion", () => ({
  ingestSingleGraphNode: vi.fn().mockResolvedValue(undefined),
  ingestSingleGraphEdge: vi.fn().mockResolvedValue(undefined),
}));

// Mock the providers factory to prevent AI calls
vi.mock("../providers/factory.js", () => ({
  getProvider: vi.fn(),
}));

import { KnowledgeGraph } from "../knowledge-graph";
import { isBroadQuery } from "../knowledge-graph";

let kg: KnowledgeGraph;
let dbPath: string;

function makeNode(overrides: { type?: any; title?: string; content?: string } = {}) {
  return {
    type: overrides.type ?? "component",
    title: overrides.title ?? `Node-${Math.random().toString(36).slice(2, 6)}`,
    content: overrides.content ?? "Test content",
    status: "proposed" as const,
    tags: [],
    metadata: {},
  };
}

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `kg-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  kg = new KnowledgeGraph(dbPath);
});

afterEach(() => {
  kg.close();
  try { fs.unlinkSync(dbPath); } catch {}
});

describe("KnowledgeGraph community detection", () => {
  it("detectCommunities with 3 disconnected clusters returns 3 communities", async () => {
    const clusterA = [
      kg.addNode(makeNode({ title: "A1", type: "component" })),
      kg.addNode(makeNode({ title: "A2", type: "component" })),
      kg.addNode(makeNode({ title: "A3", type: "component" })),
    ];
    kg.addEdge(clusterA[0], clusterA[1], "depends_on");
    kg.addEdge(clusterA[1], clusterA[2], "depends_on");

    const clusterB = [
      kg.addNode(makeNode({ title: "B1", type: "decision" })),
      kg.addNode(makeNode({ title: "B2", type: "decision" })),
      kg.addNode(makeNode({ title: "B3", type: "decision" })),
    ];
    kg.addEdge(clusterB[0], clusterB[1], "related_to");
    kg.addEdge(clusterB[1], clusterB[2], "related_to");

    const clusterC = [
      kg.addNode(makeNode({ title: "C1", type: "risk" })),
      kg.addNode(makeNode({ title: "C2", type: "risk" })),
      kg.addNode(makeNode({ title: "C3", type: "risk" })),
    ];
    kg.addEdge(clusterC[0], clusterC[1], "blocks");
    kg.addEdge(clusterC[1], clusterC[2], "blocks");

    const spy = vi.spyOn(kg as any, "generateCommunitySummary").mockResolvedValue("Test summary");

    const communities = await kg.detectCommunities();

    expect(communities.length).toBe(3);
    expect(communities.every(c => c.summary.length > 0)).toBe(true);
    expect(communities.every(c => c.nodeIds.length >= 3)).toBe(true);
    expect(communities.every(c => c.level === 0)).toBe(true);

    spy.mockRestore();
  });

  it("detectCommunities returns empty for fewer than 3 nodes", async () => {
    kg.addNode(makeNode({ title: "Only1" }));
    kg.addNode(makeNode({ title: "Only2" }));

    const communities = await kg.detectCommunities();
    expect(communities).toEqual([]);
  });

  it("detectCommunities stores results in kg_communities table", async () => {
    const cluster = [
      kg.addNode(makeNode({ title: "X1" })),
      kg.addNode(makeNode({ title: "X2" })),
      kg.addNode(makeNode({ title: "X3" })),
    ];
    kg.addEdge(cluster[0], cluster[1], "related_to");
    kg.addEdge(cluster[1], cluster[2], "related_to");

    const spy = vi.spyOn(kg as any, "generateCommunitySummary").mockResolvedValue("Stored summary");

    await kg.detectCommunities();

    const summaries = kg.retrieveCommunitySummaries("what are the main components?");
    expect(summaries.length).toBe(1);
    expect(summaries[0]).toBe("Stored summary");

    spy.mockRestore();
  });

  it("generateCommunitySummary returns non-empty string", async () => {
    const nodes = [
      { ...makeNode({ title: "Auth Service", type: "component" }), id: "test-1", createdAt: new Date(), updatedAt: new Date() },
      { ...makeNode({ title: "Token Manager", type: "component" }), id: "test-2", createdAt: new Date(), updatedAt: new Date() },
    ];

    const summary = await kg.generateCommunitySummary(nodes as any);
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toContain("2 nodes");
  });

  it("generateCommunitySummary returns fallback for empty nodes", async () => {
    const summary = await kg.generateCommunitySummary([]);
    expect(summary).toBe("Empty community.");
  });

  it("retrieveCommunitySummaries returns empty for non-broad queries", () => {
    const summaries = kg.retrieveCommunitySummaries("what is IR-82's status?");
    expect(summaries).toEqual([]);
  });

  it("retrieveCommunitySummaries returns summaries for broad queries", async () => {
    const cluster = [
      kg.addNode(makeNode({ title: "S1" })),
      kg.addNode(makeNode({ title: "S2" })),
      kg.addNode(makeNode({ title: "S3" })),
    ];
    kg.addEdge(cluster[0], cluster[1], "related_to");
    kg.addEdge(cluster[1], cluster[2], "related_to");

    const spy = vi.spyOn(kg as any, "generateCommunitySummary").mockResolvedValue("Architecture overview");
    await kg.detectCommunities();
    spy.mockRestore();

    const summaries = kg.retrieveCommunitySummaries("describe the architecture");
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    expect(summaries).toContain("Architecture overview");
  });
});

describe("isBroadQuery", () => {
  it("matches 'what are the main components?'", () => {
    expect(isBroadQuery("what are the main components?")).toBe(true);
  });

  it("matches 'overview of the system'", () => {
    expect(isBroadQuery("overview of the system")).toBe(true);
  });

  it("matches 'how does the auth system work'", () => {
    expect(isBroadQuery("how does the auth system work")).toBe(true);
  });

  it("matches 'describe the architecture'", () => {
    expect(isBroadQuery("describe the architecture")).toBe(true);
  });

  it("matches 'what components are involved'", () => {
    expect(isBroadQuery("what components are involved")).toBe(true);
  });

  it("does not match 'what is IR-82's status?'", () => {
    expect(isBroadQuery("what is IR-82's status?")).toBe(false);
  });

  it("does not match 'tell me about ticket PROJ-123'", () => {
    expect(isBroadQuery("tell me about ticket PROJ-123")).toBe(false);
  });

  it("does not match empty string", () => {
    expect(isBroadQuery("")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isBroadQuery("What Are The Main Features?")).toBe(true);
    expect(isBroadQuery("OVERVIEW OF SYSTEM")).toBe(true);
  });
});

describe("KnowledgeGraph multi-level community detection", () => {
  it("creates level-1 communities when detectHigherLevelCommunities receives communities with cross-edges", async () => {
    // Build 3 groups of nodes with internal edges, plus cross-group edges.
    // Then call detectHigherLevelCommunities directly with mock level-0 communities
    // whose node sets are connected by those cross-group edges.
    const g1 = [
      kg.addNode(makeNode({ title: "HA1" })),
      kg.addNode(makeNode({ title: "HA2" })),
      kg.addNode(makeNode({ title: "HA3" })),
    ];
    const g2 = [
      kg.addNode(makeNode({ title: "HB1" })),
      kg.addNode(makeNode({ title: "HB2" })),
      kg.addNode(makeNode({ title: "HB3" })),
    ];
    const g3 = [
      kg.addNode(makeNode({ title: "HC1" })),
      kg.addNode(makeNode({ title: "HC2" })),
      kg.addNode(makeNode({ title: "HC3" })),
    ];

    // Internal edges
    kg.addEdge(g1[0], g1[1], "related_to");
    kg.addEdge(g2[0], g2[1], "related_to");
    kg.addEdge(g3[0], g3[1], "related_to");

    // Cross-group edges — these let super-node adjacency connect the communities
    kg.addEdge(g1[2], g2[0], "related_to");
    kg.addEdge(g2[2], g3[0], "related_to");

    const communities = [
      { id: "c0", nodeIds: g1, summary: "Group 1", level: 0, createdAt: new Date() },
      { id: "c1", nodeIds: g2, summary: "Group 2", level: 0, createdAt: new Date() },
      { id: "c2", nodeIds: g3, summary: "Group 3", level: 0, createdAt: new Date() },
    ];

    const spy = vi.spyOn(kg as any, "generateCommunitySummary").mockResolvedValue("Level-1 summary");
    await (kg as any).detectHigherLevelCommunities(communities, 1, 2);
    spy.mockRestore();

    const db = (kg as any).db;
    const level1Count = (db.prepare(`SELECT COUNT(*) as c FROM kg_communities WHERE level = 1`).get() as any).c;
    expect(level1Count).toBeGreaterThanOrEqual(1);
  });

  it("detectCommunities called twice does not accumulate stale community rows", async () => {
    const cluster = [
      kg.addNode(makeNode({ title: "R1" })),
      kg.addNode(makeNode({ title: "R2" })),
      kg.addNode(makeNode({ title: "R3" })),
    ];
    kg.addEdge(cluster[0], cluster[1], "related_to");
    kg.addEdge(cluster[1], cluster[2], "related_to");

    const spy = vi.spyOn(kg as any, "generateCommunitySummary").mockResolvedValue("Rerun summary");

    await kg.detectCommunities();
    await kg.detectCommunities();

    spy.mockRestore();

    const db = (kg as any).db;
    const count = (db.prepare(`SELECT COUNT(*) as c FROM kg_communities`).get() as any).c;
    expect(count).toBe(1);
  });

  it("retrieveCommunitySummaries returns both level-0 summaries for disconnected clusters", async () => {
    const c1 = [
      kg.addNode(makeNode({ title: "Z1" })),
      kg.addNode(makeNode({ title: "Z2" })),
      kg.addNode(makeNode({ title: "Z3" })),
    ];
    kg.addEdge(c1[0], c1[1], "related_to");
    kg.addEdge(c1[1], c1[2], "related_to");

    const c2 = [
      kg.addNode(makeNode({ title: "Y1" })),
      kg.addNode(makeNode({ title: "Y2" })),
      kg.addNode(makeNode({ title: "Y3" })),
    ];
    kg.addEdge(c2[0], c2[1], "related_to");
    kg.addEdge(c2[1], c2[2], "related_to");

    const spy = vi.spyOn(kg as any, "generateCommunitySummary")
      .mockResolvedValueOnce("First cluster summary")
      .mockResolvedValueOnce("Second cluster summary");

    await kg.detectCommunities();
    spy.mockRestore();

    const summaries = kg.retrieveCommunitySummaries("overview of the system");
    expect(summaries.length).toBe(2);
    // Both summaries present (order depends on created_at within same timestamp)
    expect(summaries).toContain("First cluster summary");
    expect(summaries).toContain("Second cluster summary");
  });

  it("retrieveCommunitySummaries only returns level-0 summaries, not higher-level ones", async () => {
    // Create a graph, detect communities, then manually insert a level-1 row
    const c1 = [
      kg.addNode(makeNode({ title: "X1" })),
      kg.addNode(makeNode({ title: "X2" })),
      kg.addNode(makeNode({ title: "X3" })),
    ];
    kg.addEdge(c1[0], c1[1], "related_to");
    kg.addEdge(c1[1], c1[2], "related_to");

    const spy = vi.spyOn(kg as any, "generateCommunitySummary").mockResolvedValue("Level-0 summary");
    await kg.detectCommunities();
    spy.mockRestore();

    // Manually insert a level-1 community row
    const db = (kg as any).db;
    db.prepare(
      `INSERT INTO kg_communities (id, node_ids, summary, level, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run("comm-manual-L1", JSON.stringify(c1), "Level-1 summary", 1, new Date().toISOString());

    const summaries = kg.retrieveCommunitySummaries("describe the architecture");
    // Should only return level-0 summaries (1 row), not the level-1 row
    expect(summaries.length).toBe(1);
    expect(summaries[0]).toBe("Level-0 summary");
  });
});
