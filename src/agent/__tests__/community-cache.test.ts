import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Mock claimkit-ingestion to prevent side effects
vi.mock("../../context-engine/claimkit-ingestion", () => ({
  ingestSingleGraphNode: vi.fn().mockResolvedValue(undefined),
  ingestSingleGraphEdge: vi.fn().mockResolvedValue(undefined),
}));

// Mock the providers factory to prevent AI calls
vi.mock("../providers/factory.js", () => ({
  getProvider: vi.fn(),
}));

import { KnowledgeGraph } from "../knowledge-graph";

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
  dbPath = path.join(os.tmpdir(), `kg-cache-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  kg = new KnowledgeGraph(dbPath);
});

afterEach(() => {
  kg.close();
  try { fs.unlinkSync(dbPath); } catch {}
});

describe("Community stale flag and invalidation", () => {
  it("adds stale column to kg_communities table", () => {
    const db = (kg as any).db;
    const columns = db.prepare(`PRAGMA table_info(kg_communities)`).all() as any[];
    const staleCol = columns.find((c: any) => c.name === "stale");
    expect(staleCol).toBeDefined();
    expect(staleCol.type).toBe("INTEGER");
    expect(staleCol.notnull).toBe(1);
  });

  it("invalidateCommunities marks communities containing affected nodes as stale", async () => {
    // Create a cluster and detect communities
    const cluster = [
      kg.addNode(makeNode({ title: "IA1" })),
      kg.addNode(makeNode({ title: "IA2" })),
      kg.addNode(makeNode({ title: "IA3" })),
    ];
    kg.addEdge(cluster[0], cluster[1], "related_to");
    kg.addEdge(cluster[1], cluster[2], "related_to");

    const spy = vi.spyOn(kg as any, "generateCommunitySummary").mockResolvedValue("Test summary");
    await kg.detectCommunities();
    spy.mockRestore();

    const db = (kg as any).db;
    const before = (db.prepare(`SELECT COUNT(*) as c FROM kg_communities WHERE stale = 1`).get() as any).c;
    expect(before).toBe(0);

    // Invalidate communities containing the first node
    kg.invalidateCommunities([cluster[0]]);

    const after = (db.prepare(`SELECT COUNT(*) as c FROM kg_communities WHERE stale = 1`).get() as any).c;
    expect(after).toBeGreaterThanOrEqual(1);
  });

  it("invalidateCommunities logs the number of invalidated communities and nodes", async () => {
    const cluster = [
      kg.addNode(makeNode({ title: "LogA" })),
      kg.addNode(makeNode({ title: "LogB" })),
      kg.addNode(makeNode({ title: "LogC" })),
    ];
    kg.addEdge(cluster[0], cluster[1], "related_to");
    kg.addEdge(cluster[1], cluster[2], "related_to");

    const spy = vi.spyOn(kg as any, "generateCommunitySummary").mockResolvedValue("Log summary");
    await kg.detectCommunities();
    spy.mockRestore();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    kg.invalidateCommunities([cluster[0], cluster[1]]);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Invalidated \d+ communit/i),
    );
    logSpy.mockRestore();
  });

  it("getStaleCommunities returns only stale communities up to maxPerRun", async () => {
    // Create 3 clusters to get 3 communities
    const c1 = [
      kg.addNode(makeNode({ title: "S1A" })),
      kg.addNode(makeNode({ title: "S1B" })),
      kg.addNode(makeNode({ title: "S1C" })),
    ];
    kg.addEdge(c1[0], c1[1], "related_to");
    kg.addEdge(c1[1], c1[2], "related_to");

    const c2 = [
      kg.addNode(makeNode({ title: "S2A" })),
      kg.addNode(makeNode({ title: "S2B" })),
      kg.addNode(makeNode({ title: "S2C" })),
    ];
    kg.addEdge(c2[0], c2[1], "related_to");
    kg.addEdge(c2[1], c2[2], "related_to");

    const c3 = [
      kg.addNode(makeNode({ title: "S3A" })),
      kg.addNode(makeNode({ title: "S3B" })),
      kg.addNode(makeNode({ title: "S3C" })),
    ];
    kg.addEdge(c3[0], c3[1], "related_to");
    kg.addEdge(c3[1], c3[2], "related_to");

    const spy = vi.spyOn(kg as any, "generateCommunitySummary").mockResolvedValue("Stale test summary");
    await kg.detectCommunities();
    spy.mockRestore();

    // Invalidate all communities
    kg.invalidateCommunities([...c1, ...c2, ...c3]);

    const stale = kg.getStaleCommunities(2);
    expect(stale.length).toBe(2);
    expect(stale.every((c: any) => c.stale === true)).toBe(true);
  });

  it("updateCommunitySummary updates summary and clears stale flag", async () => {
    const cluster = [
      kg.addNode(makeNode({ title: "UA1" })),
      kg.addNode(makeNode({ title: "UA2" })),
      kg.addNode(makeNode({ title: "UA3" })),
    ];
    kg.addEdge(cluster[0], cluster[1], "related_to");
    kg.addEdge(cluster[1], cluster[2], "related_to");

    const spy = vi.spyOn(kg as any, "generateCommunitySummary").mockResolvedValue("Original summary");
    const communities = await kg.detectCommunities();
    spy.mockRestore();

    expect(communities.length).toBeGreaterThanOrEqual(1);
    const communityId = communities[0].id;

    // Invalidate and then update
    kg.invalidateCommunities([cluster[0]]);

    kg.updateCommunitySummary(communityId, "Updated summary");

    const db = (kg as any).db;
    const row = db.prepare(`SELECT summary, stale FROM kg_communities WHERE id = ?`).get(communityId) as any;
    expect(row.summary).toBe("Updated summary");
    expect(row.stale).toBe(0);
  });
});

describe("CommunityCache regeneration", () => {
  it("regenerateStaleCommunities updates stale summaries and clears stale flag", async () => {
    const { CommunityCache } = await import("../community-cache.js");
    const cluster = [
      kg.addNode(makeNode({ title: "RA1" })),
      kg.addNode(makeNode({ title: "RA2" })),
      kg.addNode(makeNode({ title: "RA3" })),
    ];
    kg.addEdge(cluster[0], cluster[1], "related_to");
    kg.addEdge(cluster[1], cluster[2], "related_to");

    const spy = vi.spyOn(kg as any, "generateCommunitySummary")
      .mockResolvedValueOnce("Initial summary")
      .mockResolvedValueOnce("Regenerated summary");
    await kg.detectCommunities();
    spy.mockRestore();

    kg.invalidateCommunities([cluster[0]]);

    const cache = new CommunityCache(kg);
    const regenSpy = vi.spyOn(kg as any, "generateCommunitySummary").mockResolvedValue("Regenerated summary");
    await cache.regenerateStaleCommunities(10);
    regenSpy.mockRestore();

    const db = (kg as any).db;
    const row = db.prepare(`SELECT summary, stale FROM kg_communities WHERE stale = 0`).get() as any;
    expect(row.summary).toBe("Regenerated summary");
  });

  it("regenerateStaleCommunities skips when already in progress", async () => {
    const { CommunityCache } = await import("../community-cache.js");
    const cache = new CommunityCache(kg);

    // Force regenerationInProgress
    (cache as any).regenerationInProgress = true;

    const regenSpy = vi.spyOn(kg as any, "generateCommunitySummary");
    await cache.regenerateStaleCommunities();
    expect(regenSpy).not.toHaveBeenCalled();
    regenSpy.mockRestore();
  });
});

describe("Stale communities served with warning in context", () => {
  it("retrieveCommunitySummaries returns stale summaries with warning info", async () => {
    const cluster = [
      kg.addNode(makeNode({ title: "WA1" })),
      kg.addNode(makeNode({ title: "WA2" })),
      kg.addNode(makeNode({ title: "WA3" })),
    ];
    kg.addEdge(cluster[0], cluster[1], "related_to");
    kg.addEdge(cluster[1], cluster[2], "related_to");

    const spy = vi.spyOn(kg as any, "generateCommunitySummary").mockResolvedValue("Warning test summary");
    await kg.detectCommunities();
    spy.mockRestore();

    kg.invalidateCommunities([cluster[0]]);

    const summaries = kg.retrieveCommunitySummaries("describe the architecture");
    expect(summaries.length).toBeGreaterThanOrEqual(1);

    // At least one summary should contain the stale warning
    const staleSummaries = summaries.filter(s => s.includes("may be outdated"));
    expect(staleSummaries.length).toBeGreaterThanOrEqual(1);
  });

  it("retrieveCommunitySummaries returns clean summaries when not stale", async () => {
    const cluster = [
      kg.addNode(makeNode({ title: "NA1" })),
      kg.addNode(makeNode({ title: "NA2" })),
      kg.addNode(makeNode({ title: "NA3" })),
    ];
    kg.addEdge(cluster[0], cluster[1], "related_to");
    kg.addEdge(cluster[1], cluster[2], "related_to");

    const spy = vi.spyOn(kg as any, "generateCommunitySummary").mockResolvedValue("Clean summary");
    await kg.detectCommunities();
    spy.mockRestore();

    const summaries = kg.retrieveCommunitySummaries("what are the main components?");
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    // None should have the stale warning since we didn't invalidate
    const staleSummaries = summaries.filter(s => s.includes("may be outdated"));
    expect(staleSummaries.length).toBe(0);
  });
});

describe("Automatic invalidation on graph mutations", () => {
  it("addNode invalidates communities containing the new node via edges", async () => {
    const cluster = [
      kg.addNode(makeNode({ title: "M1A" })),
      kg.addNode(makeNode({ title: "M1B" })),
      kg.addNode(makeNode({ title: "M1C" })),
    ];
    kg.addEdge(cluster[0], cluster[1], "related_to");
    kg.addEdge(cluster[1], cluster[2], "related_to");

    const spy = vi.spyOn(kg as any, "generateCommunitySummary").mockResolvedValue("Mutation test");
    await kg.detectCommunities();
    spy.mockRestore();

    // Reset stale flags that were set during community detection setup mutations
    const db = (kg as any).db;
    db.prepare(`UPDATE kg_communities SET stale = 0`).run();

    // Add edge to a new node — this should trigger invalidation on the connected nodes
    const newNode = kg.addNode(makeNode({ title: "M1New" }));
    kg.addEdge(cluster[0], newNode, "related_to");

    const staleCount = (db.prepare(`SELECT COUNT(*) as c FROM kg_communities WHERE stale = 1`).get() as any).c;
    expect(staleCount).toBeGreaterThanOrEqual(1);
  });
});

describe("Community cache metrics", () => {
  it("tracks hit rate via getCommunityMetrics", async () => {
    const cluster = [
      kg.addNode(makeNode({ title: "ME1" })),
      kg.addNode(makeNode({ title: "ME2" })),
      kg.addNode(makeNode({ title: "ME3" })),
    ];
    kg.addEdge(cluster[0], cluster[1], "related_to");
    kg.addEdge(cluster[1], cluster[2], "related_to");

    const spy = vi.spyOn(kg as any, "generateCommunitySummary").mockResolvedValue("Metrics summary");
    await kg.detectCommunities();
    spy.mockRestore();

    const metrics = kg.getCommunityMetrics();
    expect(metrics.totalCommunities).toBeGreaterThanOrEqual(1);
    expect(metrics.staleCommunities).toBe(0);
    expect(typeof metrics.totalCommunities).toBe("number");
    expect(typeof metrics.staleCommunities).toBe("number");
  });
});
