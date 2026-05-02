import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

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

  constructor() {
    const dataDir = path.resolve(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(path.join(dataDir, "knowledge_graph.db"));
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
    `);
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

    return id;
  }

  removeEdge(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM kg_edges WHERE id = ?`).run(id);
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
}

export const knowledgeGraph = new KnowledgeGraph();
