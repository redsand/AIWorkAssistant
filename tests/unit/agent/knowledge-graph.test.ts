import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { KnowledgeGraph } from "../../../src/agent/knowledge-graph";

describe("KnowledgeGraph", () => {
  let dbPath: string;
  let kg: KnowledgeGraph;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `kg-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    kg = new KnowledgeGraph(dbPath);
  });

  afterEach(() => {
    try {
      kg.close();
    } catch {}
    try {
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
    } catch {}
  });

  it("enables FTS5 by default", () => {
    expect(kg.isFts5Enabled()).toBe(true);
  });

  it("finds nodes by search using the FTS5 index", () => {
    kg.addNode({
      type: "component",
      title: "Authentication service",
      content: "Handles OAuth2 flows for all integrations.",
      status: "accepted",
      tags: ["auth"],
      metadata: {},
    });
    kg.addNode({
      type: "component",
      title: "Reporting worker",
      content: "Generates nightly PDF reports.",
      status: "proposed",
      tags: ["reports"],
      metadata: {},
    });

    const results = kg.queryNodes({ search: "OAuth2" });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Authentication service");
  });

  it("updates the FTS5 index when a node is updated", () => {
    const id = kg.addNode({
      type: "adr",
      title: "Use PostgreSQL",
      content: "We will use PostgreSQL as the primary store.",
      status: "accepted",
      tags: [],
      metadata: {},
    });

    kg.updateNode(id, { title: "Use SQLite", content: "We will use SQLite as the primary store." });

    const results = kg.queryNodes({ search: "SQLite" });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Use SQLite");

    expect(kg.queryNodes({ search: "PostgreSQL" })).toHaveLength(0);
  });

  it("removes deleted nodes from the FTS5 index", () => {
    const id = kg.addNode({
      type: "risk",
      title: "Data loss",
      content: "Risk of losing cached embeddings on restart.",
      status: "accepted",
      tags: [],
      metadata: {},
    });

    expect(kg.queryNodes({ search: "embeddings" })).toHaveLength(1);
    kg.deleteNode(id);
    expect(kg.queryNodes({ search: "embeddings" })).toHaveLength(0);
  });

  it("combines node and edge export in a single batch query", () => {
    const a = kg.addNode({
      type: "component",
      title: "Service A",
      content: "First service.",
      status: "accepted",
      tags: [],
      metadata: {},
    });
    const b = kg.addNode({
      type: "component",
      title: "Service B",
      content: "Second service.",
      status: "accepted",
      tags: [],
      metadata: {},
    });
    kg.addEdge(a, b, "depends_on", "A needs B");

    const spyGetNode = vi.spyOn(kg as any, "getNode").mockImplementation(() => null);
    const output = kg.exportForContextBatch([a, b]);
    expect(spyGetNode).not.toHaveBeenCalled();
    spyGetNode.mockRestore();

    expect(output).toContain("Service A");
    expect(output).toContain("Service B");
    expect(output).toContain("depends_on");
    expect(output).toContain("A needs B");
  });

  it("limits community summaries", () => {
    // Pre-populate level-0 communities directly through the public API is
    // not supported, so we insert rows manually for this test.
    const db = (kg as any).db as import("better-sqlite3").Database;
    const insert = db.prepare(
      `INSERT INTO kg_communities (id, node_ids, summary, level, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < 5; i++) {
      insert.run(`comm-${i}`, JSON.stringify(["n1", "n2"]), `Summary ${i}`, 0, new Date().toISOString());
    }

    const broad = "what are the main components";
    const all = kg.retrieveCommunitySummaries(broad, 100);
    expect(all.length).toBeGreaterThanOrEqual(5);

    const limited = kg.retrieveCommunitySummaries(broad, 2);
    expect(limited).toHaveLength(2);
  });
});
