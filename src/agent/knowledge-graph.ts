import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ingestSingleGraphNode, ingestSingleGraphEdge } from "../context-engine/claimkit-ingestion";
import type { Community } from "../context-engine/types";

export type KGNodeType =
  | "decision"
  | "adr"
  | "component"
  | "api_endpoint"
  | "data_model"
  | "requirement"
  | "assumption"
  | "risk"
  | "tradeoff"
  | "pattern"
  | "reasoning";

export type KGEdgeType =
  | "depends_on"
  | "implements"
  | "alternative_to"
  | "supersedes"
  | "related_to"
  | "constrains"
  | "enables"
  | "blocks"
  | "derives_from"
  | "tested_by";

export interface KGNode {
  id: string;
  type: KGNodeType;
  title: string;
  content: string;
  status: "proposed" | "accepted" | "deprecated" | "superseded";
  context?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface KGEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: KGEdgeType;
  description?: string;
  createdAt: Date;
}

class KnowledgeGraph {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const dbFile = dbPath ?? path.join(path.resolve(process.cwd(), "data"), "knowledge_graph.db");
    const dir = path.dirname(dbFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbFile);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kg_nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed',
        context TEXT,
        tags TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kg_edges (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        type TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (source_id) REFERENCES kg_nodes(id),
        FOREIGN KEY (target_id) REFERENCES kg_nodes(id)
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_type ON kg_nodes(type);
      CREATE INDEX IF NOT EXISTS idx_nodes_status ON kg_nodes(status);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON kg_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON kg_edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_edges_type ON kg_edges(type);

      CREATE TABLE IF NOT EXISTS kg_communities (
        id TEXT PRIMARY KEY,
        node_ids TEXT NOT NULL,
        summary TEXT NOT NULL,
        level INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_communities_level ON kg_communities(level);
    `);

    // Migration: add stale column if it doesn't exist
    const columns = this.db.prepare(`PRAGMA table_info(kg_communities)`).all() as any[];
    if (!columns.some((c: any) => c.name === "stale")) {
      this.db.exec(`ALTER TABLE kg_communities ADD COLUMN stale INTEGER NOT NULL DEFAULT 0`);
    }
  }

  addNode(node: Omit<KGNode, "id" | "createdAt" | "updatedAt">): string {
    const id = `kg-${node.type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO kg_nodes (id, type, title, content, status, context, tags, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        node.type,
        node.title,
        node.content,
        node.status,
        node.context || null,
        JSON.stringify(node.tags),
        JSON.stringify(node.metadata),
        now,
        now,
      );

    ingestSingleGraphNode({
      id,
      type: node.type,
      title: node.title,
      content: node.content,
      status: node.status,
      context: node.context,
      tags: node.tags,
      metadata: node.metadata,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    }).catch(err => console.warn(`[KnowledgeGraph] Incremental ClaimKit ingestion failed for node ${id}:`, err));

    this.invalidateCommunities([id]);

    return id;
  }

  getNode(id: string): KGNode | null {
    const row = this.db
      .prepare(`SELECT * FROM kg_nodes WHERE id = ?`)
      .get(id) as any;
    return row ? this.rowToNode(row) : null;
  }

  updateNode(
    id: string,
    updates: Partial<
      Pick<
        KGNode,
        "title" | "content" | "status" | "context" | "tags" | "metadata"
      >
    >,
  ): KGNode | null {
    const existing = this.getNode(id);
    if (!existing) return null;

    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (updates.title !== undefined) {
      setClauses.push("title = ?");
      params.push(updates.title);
    }
    if (updates.content !== undefined) {
      setClauses.push("content = ?");
      params.push(updates.content);
    }
    if (updates.status !== undefined) {
      setClauses.push("status = ?");
      params.push(updates.status);
    }
    if (updates.context !== undefined) {
      setClauses.push("context = ?");
      params.push(updates.context);
    }
    if (updates.tags !== undefined) {
      setClauses.push("tags = ?");
      params.push(JSON.stringify(updates.tags));
    }
    if (updates.metadata !== undefined) {
      setClauses.push("metadata = ?");
      params.push(JSON.stringify(updates.metadata));
    }

    if (setClauses.length === 0) return existing;

    setClauses.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);

    this.db
      .prepare(`UPDATE kg_nodes SET ${setClauses.join(", ")} WHERE id = ?`)
      .run(...params);

    this.invalidateCommunities([id]);

    return this.getNode(id);
  }

  deleteNode(id: string): boolean {
    this.db
      .prepare(`DELETE FROM kg_edges WHERE source_id = ? OR target_id = ?`)
      .run(id, id);
    const result = this.db.prepare(`DELETE FROM kg_nodes WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  addEdge(
    sourceId: string,
    targetId: string,
    type: KGEdgeType,
    description?: string,
  ): string | null {
    const source = this.getNode(sourceId);
    const target = this.getNode(targetId);
    if (!source || !target) return null;

    const id = `edge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    this.db
      .prepare(
        `INSERT INTO kg_edges (id, source_id, target_id, type, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sourceId,
        targetId,
        type,
        description || null,
        new Date().toISOString(),
      );

    ingestSingleGraphEdge({
      id,
      sourceId,
      targetId,
      type,
      description,
      createdAt: new Date(),
    }).catch(err => console.warn(`[KnowledgeGraph] Incremental ClaimKit ingestion failed for edge ${id}:`, err));

    this.invalidateCommunities([sourceId, targetId]);

    return id;
  }

  removeEdge(id: string): boolean {
    const edge = this.db.prepare(`SELECT source_id, target_id FROM kg_edges WHERE id = ?`).get(id) as any;
    const result = this.db.prepare(`DELETE FROM kg_edges WHERE id = ?`).run(id);
    if (result.changes > 0 && edge) {
      this.invalidateCommunities([edge.source_id, edge.target_id]);
    }
    return result.changes > 0;
  }

  getEdgesForNode(
    nodeId: string,
    direction?: "incoming" | "outgoing" | "both",
  ): KGEdge[] {
    const dir = direction || "both";
    let sql: string;
    if (dir === "incoming") {
      sql = `SELECT * FROM kg_edges WHERE target_id = ?`;
    } else if (dir === "outgoing") {
      sql = `SELECT * FROM kg_edges WHERE source_id = ?`;
    } else {
      sql = `SELECT * FROM kg_edges WHERE source_id = ? OR target_id = ?`;
    }

    const rows = this.db
      .prepare(sql)
      .all(...(dir === "both" ? [nodeId, nodeId] : [nodeId])) as any[];

    return rows.map((r) => this.rowToEdge(r));
  }

  getAllNodes(): KGNode[] {
    const rows = this.db.prepare(`SELECT * FROM kg_nodes ORDER BY updated_at DESC`).all() as any[];
    return rows.map((r) => this.rowToNode(r));
  }

  getAllEdges(): KGEdge[] {
    const rows = this.db.prepare(`SELECT * FROM kg_edges ORDER BY created_at DESC`).all() as any[];
    return rows.map((r) => this.rowToEdge(r));
  }

  getNeighbors(
    nodeId: string,
    maxDepth: number = 2,
  ): {
    nodes: KGNode[];
    edges: KGEdge[];
  } {
    const visited = new Set<string>();
    const nodes: KGNode[] = [];
    const edges: KGEdge[] = [];

    const queue: Array<{ id: string; depth: number }> = [
      { id: nodeId, depth: 0 },
    ];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (visited.has(id) || depth > maxDepth) continue;
      visited.add(id);

      const node = this.getNode(id);
      if (!node) continue;
      nodes.push(node);

      if (depth < maxDepth) {
        const nodeEdges = this.getEdgesForNode(id);
        for (const edge of nodeEdges) {
          if (!edges.find((e) => e.id === edge.id)) {
            edges.push(edge);
          }
          const neighborId =
            edge.sourceId === id ? edge.targetId : edge.sourceId;
          if (!visited.has(neighborId)) {
            queue.push({ id: neighborId, depth: depth + 1 });
          }
        }
      }
    }

    return { nodes, edges };
  }

  queryNodes(options: {
    type?: KGNodeType;
    status?: KGNode["status"];
    tags?: string[];
    search?: string;
    limit?: number;
  }): KGNode[] {
    let sql = `SELECT * FROM kg_nodes WHERE 1=1`;
    const params: unknown[] = [];

    if (options.type) {
      sql += ` AND type = ?`;
      params.push(options.type);
    }

    if (options.status) {
      sql += ` AND status = ?`;
      params.push(options.status);
    }

    if (options.tags && options.tags.length > 0) {
      for (const tag of options.tags) {
        sql += ` AND tags LIKE ?`;
        params.push(`%"${tag}"%`);
      }
    }

    if (options.search) {
      sql += ` AND (title LIKE ? OR content LIKE ? OR context LIKE ?)`;
      const pattern = `%${options.search}%`;
      params.push(pattern, pattern, pattern);
    }

    sql += ` ORDER BY updated_at DESC`;

    if (options.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.rowToNode(r));
  }

  getGraphSummary(): {
    totalNodes: number;
    totalEdges: number;
    nodesByType: Record<string, number>;
    nodesByStatus: Record<string, number>;
    edgesByType: Record<string, number>;
  } {
    const nodeCount = (
      this.db.prepare(`SELECT COUNT(*) as c FROM kg_nodes`).get() as any
    ).c;
    const edgeCount = (
      this.db.prepare(`SELECT COUNT(*) as c FROM kg_edges`).get() as any
    ).c;

    const byType = this.db
      .prepare(`SELECT type, COUNT(*) as c FROM kg_nodes GROUP BY type`)
      .all() as any[];
    const byStatus = this.db
      .prepare(`SELECT status, COUNT(*) as c FROM kg_nodes GROUP BY status`)
      .all() as any[];
    const edgesByType = this.db
      .prepare(`SELECT type, COUNT(*) as c FROM kg_edges GROUP BY type`)
      .all() as any[];

    return {
      totalNodes: nodeCount,
      totalEdges: edgeCount,
      nodesByType: Object.fromEntries(byType.map((r) => [r.type, r.c])),
      nodesByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.c])),
      edgesByType: Object.fromEntries(edgesByType.map((r) => [r.type, r.c])),
    };
  }

  exportForContext(nodeIds: string[]): string {
    const parts: string[] = [];

    for (const id of nodeIds) {
      const node = this.getNode(id);
      if (!node) continue;

      parts.push(`## ${node.type.toUpperCase()}: ${node.title}`);
      parts.push(`Status: ${node.status}`);
      if (node.context) parts.push(`Context: ${node.context}`);
      parts.push(node.content);

      const edges = this.getEdgesForNode(id);
      if (edges.length > 0) {
        parts.push("Relationships:");
        for (const e of edges) {
          const other =
            e.sourceId === id
              ? this.getNode(e.targetId)
              : this.getNode(e.sourceId);
          if (other) {
            const dir = e.sourceId === id ? "→" : "←";
            parts.push(
              `  ${dir} [${e.type}] ${other.title} (${other.type})${e.description ? `: ${e.description}` : ""}`,
            );
          }
        }
      }
      parts.push("");
    }

    return parts.join("\n");
  }

  async detectCommunities(maxLevels: number = 2): Promise<Community[]> {
    const nodes = this.getAllNodes();
    const edges = this.getAllEdges();

    if (nodes.length < 3) {
      this.db.prepare(`DELETE FROM kg_communities`).run();
      return [];
    }

    // Clear stale communities before re-detecting
    this.db.prepare(`DELETE FROM kg_communities`).run();

    const adj = this.buildAdjacencyList(nodes, edges);
    const clusters = this.greedyModularityCluster(nodes.map(n => n.id), adj);
    const validClusters = clusters.filter(c => c.length >= 3);

    if (validClusters.length === 0) {
      console.log(
        `[KnowledgeGraph] Community detection: 0 communities from ${nodes.length} nodes, ${edges.length} edges (no clusters with >= 3 nodes)`,
      );
      return [];
    }

    // Generate summaries in parallel
    const summaryPromises = validClusters.map(nodeIds => {
      const communityNodes = nodeIds
        .map(id => this.getNode(id))
        .filter((n): n is KGNode => n !== null);
      return this.generateCommunitySummary(communityNodes);
    });
    const summaries = await Promise.all(summaryPromises);

    const now = new Date().toISOString();
    const insertStmt = this.db.prepare(
      `INSERT INTO kg_communities (id, node_ids, summary, level, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    const result: Community[] = [];

    for (let i = 0; i < validClusters.length; i++) {
      const nodeIds = validClusters[i];
      const summary = summaries[i];
      const id = randomUUID();

      insertStmt.run(id, JSON.stringify(nodeIds), summary, 0, now);

      result.push({ id, nodeIds, summary, level: 0, createdAt: new Date(now) });
    }

    console.log(
      `[KnowledgeGraph] Community detection: ${result.length} level-0 communities from ${nodes.length} nodes, ${edges.length} edges`,
    );

    // Multi-level: recursively detect communities of communities
    if (maxLevels > 1 && result.length >= 3) {
      await this.detectHigherLevelCommunities(result, 1, maxLevels, edges);
    }

    return result;
  }

  private buildAdjacencyList(nodes: KGNode[], edges: KGEdge[]): Map<string, Set<string>> {
    const adj = new Map<string, Set<string>>();
    for (const node of nodes) {
      adj.set(node.id, new Set());
    }
    for (const edge of edges) {
      adj.get(edge.sourceId)?.add(edge.targetId);
      adj.get(edge.targetId)?.add(edge.sourceId);
    }
    return adj;
  }

  /**
   * Greedy modularity clustering: start with each node in its own community,
   * repeatedly merge the pair with the highest positive ΔQ until no merge
   * improves modularity.
   */
  private greedyModularityCluster(
    nodeIds: string[],
    adj: Map<string, Set<string>>,
  ): string[][] {
    // Count total undirected edges
    let m = 0;
    for (const [, neighbors] of adj) {
      m += neighbors.size;
    }
    m = Math.floor(m / 2);

    if (m === 0) return nodeIds.map(id => [id]);

    // Each node starts as its own community
    const nodeToComm = new Map<string, string>();
    const communities = new Map<string, Set<string>>();
    for (const id of nodeIds) {
      nodeToComm.set(id, id);
      communities.set(id, new Set([id]));
    }

    // Precompute degrees
    const degrees = new Map<string, number>();
    for (const id of nodeIds) {
      degrees.set(id, adj.get(id)?.size ?? 0);
    }

    // Greedy merging: repeatedly merge the pair with highest ΔQ > 0
    let improved = true;
    while (improved) {
      improved = false;
      let bestDeltaQ = 0;
      let bestPair: [string, string] | null = null;
      const checkedPairs = new Set<string>();

      for (const [commA, nodesA] of communities) {
        if (nodesA.size === 0) continue;

        const neighborComms = new Set<string>();
        for (const nodeId of nodesA) {
          for (const neighbor of adj.get(nodeId) ?? []) {
            const neighborComm = nodeToComm.get(neighbor);
            if (neighborComm !== undefined && neighborComm !== commA) {
              neighborComms.add(neighborComm);
            }
          }
        }

        for (const commB of neighborComms) {
          const pairKey = commA < commB ? `${commA}|${commB}` : `${commB}|${commA}`;
          if (checkedPairs.has(pairKey)) continue;
          checkedPairs.add(pairKey);

          const nodesB = communities.get(commB);
          if (!nodesB || nodesB.size === 0) continue;

          // Count edges between A and B
          let edgesBetween = 0;
          for (const nodeId of nodesA) {
            for (const neighbor of adj.get(nodeId) ?? []) {
              if (nodesB.has(neighbor)) edgesBetween++;
            }
          }

          // Sum of degrees
          let degA = 0;
          for (const nodeId of nodesA) degA += degrees.get(nodeId) ?? 0;
          let degB = 0;
          for (const nodeId of nodesB) degB += degrees.get(nodeId) ?? 0;

          // ΔQ = (e_AB / m) - (degA * degB) / (2m²)
          const deltaQ = (edgesBetween / m) - (degA * degB) / (2 * m * m);

          if (deltaQ > bestDeltaQ) {
            bestDeltaQ = deltaQ;
            bestPair = [commA, commB];
          }
        }
      }

      if (bestPair && bestDeltaQ > 0) {
        improved = true;
        const [commA, commB] = bestPair;
        const nodesA = communities.get(commA)!;
        const nodesB = communities.get(commB)!;

        for (const nodeId of nodesB) {
          nodesA.add(nodeId);
          nodeToComm.set(nodeId, commA);
        }
        nodesB.clear();
      }
    }

    const result: string[][] = [];
    for (const [, nodeSet] of communities) {
      if (nodeSet.size > 0) result.push([...nodeSet]);
    }
    return result;
  }

  private async detectHigherLevelCommunities(
    lowerCommunities: Community[],
    currentLevel: number,
    maxLevels: number,
    edges: KGEdge[],
  ): Promise<void> {
    if (currentLevel >= maxLevels || lowerCommunities.length < 3) return;

    // Build super-node adjacency from cross-community edges
    const nodeToCommId = new Map<string, string>();
    for (const comm of lowerCommunities) {
      for (const nodeId of comm.nodeIds) {
        nodeToCommId.set(nodeId, comm.id);
      }
    }

    const superAdj = new Map<string, Set<string>>();
    for (const comm of lowerCommunities) {
      superAdj.set(comm.id, new Set());
    }
    for (const edge of edges) {
      const sourceComm = nodeToCommId.get(edge.sourceId);
      const targetComm = nodeToCommId.get(edge.targetId);
      if (sourceComm && targetComm && sourceComm !== targetComm) {
        superAdj.get(sourceComm)?.add(targetComm);
        superAdj.get(targetComm)?.add(sourceComm);
      }
    }

    // Run greedy modularity on super-graph
    const commIds = lowerCommunities.map(c => c.id);
    const superClusters = this.greedyModularityCluster(commIds, superAdj);
    const validSuperClusters = superClusters.filter(c => c.length >= 2);

    if (validSuperClusters.length === 0) return;

    // Build node-id lookup for each community
    const commNodeMap = new Map<string, string[]>();
    for (const comm of lowerCommunities) {
      commNodeMap.set(comm.id, comm.nodeIds);
    }

    // Generate summaries in parallel
    const summaryPromises = validSuperClusters.map(cluster => {
      const allNodeIds = cluster.flatMap(commId => commNodeMap.get(commId) ?? []);
      const communityNodes = allNodeIds
        .map(id => this.getNode(id))
        .filter((n): n is KGNode => n !== null);
      return this.generateCommunitySummary(communityNodes);
    });
    const summaries = await Promise.all(summaryPromises);

    const now = new Date().toISOString();
    const insertStmt = this.db.prepare(
      `INSERT INTO kg_communities (id, node_ids, summary, level, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    const higherCommunities: Community[] = [];

    for (let i = 0; i < validSuperClusters.length; i++) {
      const cluster = validSuperClusters[i];
      const allNodeIds = cluster.flatMap(commId => commNodeMap.get(commId) ?? []);
      const summary = summaries[i];
      const id = randomUUID();

      insertStmt.run(id, JSON.stringify(allNodeIds), summary, currentLevel, now);

      higherCommunities.push({
        id,
        nodeIds: allNodeIds,
        summary,
        level: currentLevel,
        createdAt: new Date(now),
      });
    }

    console.log(
      `[KnowledgeGraph] Level-${currentLevel} community detection: ${higherCommunities.length} communities`,
    );

    // Recurse with ALL higher-level communities at once
    if (currentLevel + 1 < maxLevels && higherCommunities.length >= 3) {
      await this.detectHigherLevelCommunities(
        higherCommunities,
        currentLevel + 1,
        maxLevels,
        edges,
      );
    }
  }

  async generateCommunitySummary(nodes: KGNode[]): Promise<string> {
    if (nodes.length === 0) return "Empty community.";

    const nodeList = nodes
      .map(n => `- [${n.type}] ${n.title}`)
      .join("\n");

    try {
      const { getProvider } = await import("./providers/factory.js");
      const provider = getProvider();
      const response = await provider.chat({
        messages: [
          {
            role: "system",
            content: "Summarize the following group of related knowledge graph nodes in 2-3 sentences. Focus on the theme that connects them.",
          },
          {
            role: "user",
            content: `Nodes:\n${nodeList}`,
          },
        ],
        temperature: 0.3,
        maxTokens: 256,
      });
      const aiSummary = response.content.trim();
      if (aiSummary) return aiSummary;
    } catch (err) {
      console.warn("[KnowledgeGraph] AI community summary failed, using fallback:", err instanceof Error ? err.message : err);
    }

    // Local fallback when AI is unavailable or returns empty
    const types = [...new Set(nodes.map(n => n.type))];
    const titles = nodes.map(n => n.title).slice(0, 5);
    return `Community of ${nodes.length} nodes spanning types: ${types.join(", ")}. Includes: ${titles.join(", ")}.`;
  }

  retrieveCommunitySummaries(query: string): string[] {
    if (!isBroadQuery(query)) return [];

    try {
      const rows = this.db
        .prepare(`SELECT summary, stale FROM kg_communities WHERE level = 0 ORDER BY created_at DESC`)
        .all() as any[];

      return rows.map(r => {
        if (r.stale === 1) {
          return `${r.summary} _(Note: this summary may be outdated — graph changed since last update)_`;
        }
        return r.summary as string;
      });
    } catch {
      return [];
    }
  }

  invalidateCommunities(nodeIds: string[]): void {
    if (nodeIds.length === 0) return;

    const rows = this.db
      .prepare(`SELECT id, node_ids FROM kg_communities WHERE stale = 0`)
      .all() as any[];

    const toInvalidate: string[] = [];
    for (const row of rows) {
      const communityNodeIds: string[] = JSON.parse(row.node_ids);
      if (communityNodeIds.some(id => nodeIds.includes(id))) {
        toInvalidate.push(row.id);
      }
    }

    if (toInvalidate.length === 0) return;

    const placeholders = toInvalidate.map(() => "?").join(",");
    this.db
      .prepare(`UPDATE kg_communities SET stale = 1 WHERE id IN (${placeholders})`)
      .run(...toInvalidate);

    console.log(
      `[KnowledgeGraph] Invalidated ${toInvalidate.length} communities due to changes in ${nodeIds.length} nodes`,
    );
  }

  getStaleCommunities(maxPerRun: number = 10): Community[] {
    const rows = this.db
      .prepare(`SELECT * FROM kg_communities WHERE stale = 1 ORDER BY created_at ASC LIMIT ?`)
      .all(maxPerRun) as any[];

    return rows.map(r => ({
      id: r.id,
      nodeIds: JSON.parse(r.node_ids),
      summary: r.summary,
      level: r.level,
      stale: true,
      createdAt: new Date(r.created_at),
    }));
  }

  updateCommunitySummary(id: string, summary: string): void {
    this.db
      .prepare(`UPDATE kg_communities SET summary = ?, stale = 0 WHERE id = ?`)
      .run(summary, id);
  }

  getCommunityMetrics(): { totalCommunities: number; staleCommunities: number } {
    const total = (this.db.prepare(`SELECT COUNT(*) as c FROM kg_communities`).get() as any).c;
    const stale = (this.db.prepare(`SELECT COUNT(*) as c FROM kg_communities WHERE stale = 1`).get() as any).c;
    return { totalCommunities: total, staleCommunities: stale };
  }

  private rowToNode(row: any): KGNode {
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      content: row.content,
      status: row.status,
      context: row.context || undefined,
      tags: JSON.parse(row.tags || "[]"),
      metadata: JSON.parse(row.metadata || "{}"),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private rowToEdge(row: any): KGEdge {
    return {
      id: row.id,
      sourceId: row.source_id,
      targetId: row.target_id,
      type: row.type,
      description: row.description || undefined,
      createdAt: new Date(row.created_at),
    };
  }

  close(): void {
    this.db.close();
  }
}

export { KnowledgeGraph };
export const knowledgeGraph = new KnowledgeGraph();

const BROAD_QUERY_PATTERNS = [
  /what\s+are\s+the\s+main/i,
  /overview\s+of/i,
  /how\s+does\s+.*\s+work/i,
  /describe\s+the\s+architecture/i,
  /what\s+components/i,
];

export function isBroadQuery(query: string): boolean {
  return BROAD_QUERY_PATTERNS.some(p => p.test(query));
}
