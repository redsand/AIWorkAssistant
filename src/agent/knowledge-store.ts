import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { ingestSingleKnowledgeEntry } from "../context-engine/claimkit-ingestion";
import { chunkContent } from "../context-engine/chunker";
import { estimateTokens } from "../context-engine/budget";
import { env } from "../config/env";

export interface KnowledgeEntry {
  id: string;
  source: "web_search" | "web_page" | "file_read" | "conversation" | "manual";
  title: string;
  content: string;
  url?: string;
  filePath?: string;
  tags: string[];
  sessionId?: string;
  createdAt: Date;
  accessedAt: Date;
  accessCount: number;
  /** Set on sub-chunks split from an oversized entry; references the parent id. */
  parentId?: string;
}

export interface SearchResult {
  entry: KnowledgeEntry;
  score: number;
  matchType: "tag" | "keyword" | "exact";
}

export class KnowledgeStore {
  private db: Database.Database;

  // dbPath is injectable for tests (e.g. to exercise schema migration against a
  // pre-existing database); production uses the default data/knowledge.db.
  constructor(dbPath?: string) {
    const resolvedPath =
      dbPath ?? path.join(path.resolve(process.cwd(), "data"), "knowledge.db");
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        url TEXT,
        file_path TEXT,
        tags TEXT DEFAULT '[]',
        session_id TEXT,
        keywords TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        accessed_at TEXT NOT NULL,
        access_count INTEGER DEFAULT 0,
        parent_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge(source);
      CREATE INDEX IF NOT EXISTS idx_knowledge_tags ON knowledge(tags);
      CREATE INDEX IF NOT EXISTS idx_knowledge_session ON knowledge(session_id);
    `);

    // Migrate older databases that predate the parent_id column.
    const cols = this.db.prepare(`PRAGMA table_info(knowledge)`).all() as {
      name: string;
    }[];
    if (!cols.some((c) => c.name === "parent_id")) {
      this.db.exec(`ALTER TABLE knowledge ADD COLUMN parent_id TEXT`);
    }
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_knowledge_parent ON knowledge(parent_id)`,
    );
  }

  store(
    entry: Omit<KnowledgeEntry, "id" | "accessedAt" | "accessCount"> & {
      /** Provide a stable id to update (re-store) an existing entry in place. */
      id?: string;
    },
  ): string {
    const id =
      entry.id ?? `kn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const keywords = this.extractKeywords(entry.content);
    const tagsJson = JSON.stringify(entry.tags);
    const keywordsJson = JSON.stringify(keywords);
    const now = new Date().toISOString();

    // Persist the parent row, drop any sub-chunks from a previous version of
    // this entry, and (re)create sub-chunks atomically. Doing this in one
    // transaction guarantees we never leave a parent without its children, nor
    // orphaned children if re-storing produces fewer (or zero) chunks.
    const persist = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO knowledge (id, source, title, content, url, file_path, tags, session_id, keywords, created_at, accessed_at, access_count, parent_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
        )
        .run(
          id,
          entry.source,
          entry.title,
          entry.content,
          entry.url || null,
          entry.filePath || null,
          tagsJson,
          entry.sessionId || null,
          keywordsJson,
          entry.createdAt.toISOString(),
          now,
        );

      // Remove sub-chunks left over from any prior version of this entry so a
      // re-store with smaller content (or content that no longer needs
      // splitting) cannot leave stale children behind.
      this.db
        .prepare(`DELETE FROM knowledge WHERE parent_id = ?`)
        .run(id);

      // Large entries (e.g. a scraped web page) are too coarse for precise
      // retrieval. Split them into heading-aware sub-chunks that reference the
      // parent so the full entry and its parts both remain searchable.
      if (estimateTokens(entry.content) > 2 * env.RAG_CHUNK_SIZE) {
        this.storeSubChunks(id, entry, now);
      }
    });
    persist();

    ingestSingleKnowledgeEntry({
      id,
      source: entry.source,
      title: entry.title,
      content: entry.content,
      url: entry.url,
      filePath: entry.filePath,
      tags: entry.tags,
      sessionId: entry.sessionId,
      createdAt: entry.createdAt,
      accessedAt: new Date(now),
      accessCount: 0,
    }).catch(err => console.warn(`[KnowledgeStore] Incremental ClaimKit ingestion failed for ${id}:`, err));

    return id;
  }

  // Heading-aware splitting of an oversized entry into child rows. Sub-chunks
  // carry parent_id so they can be grouped back to the source entry, and are
  // not re-ingested into ClaimKit (the parent already covers that content).
  // Callers run this inside a transaction that has already cleared any prior
  // sub-chunks for parentId.
  private storeSubChunks(
    parentId: string,
    entry: Omit<KnowledgeEntry, "id" | "accessedAt" | "accessCount">,
    now: string,
  ): void {
    const chunks = chunkContent(entry.content, "markdown", {
      strategy: env.RAG_CHUNK_STRATEGY,
      maxTokens: env.RAG_CHUNK_SIZE,
      minTokens: Math.floor(env.RAG_CHUNK_SIZE * 0.3),
      overlapTokens: env.RAG_CHUNK_OVERLAP,
    });

    if (chunks.length <= 1) return;

    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO knowledge (id, source, title, content, url, file_path, tags, session_id, keywords, created_at, accessed_at, access_count, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    );
    const tagsJson = JSON.stringify(entry.tags);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const body = chunk.contextHeader
        ? `${chunk.contextHeader}\n${chunk.content}`
        : chunk.content;
      insert.run(
        `${parentId}-c${i}`,
        entry.source,
        `${entry.title} (part ${i + 1})`,
        body,
        entry.url || null,
        entry.filePath || null,
        tagsJson,
        entry.sessionId || null,
        JSON.stringify(this.extractKeywords(body)),
        entry.createdAt.toISOString(),
        now,
        parentId,
      );
    }
  }

  search(
    query: string,
    options?: {
      limit?: number;
      source?: KnowledgeEntry["source"];
      sessionId?: string;
      tags?: string[];
    },
  ): SearchResult[] {
    const limit = options?.limit || 5;
    const queryKeywords = this.extractKeywords(query);
    const queryLower = query.toLowerCase();

    let sql = `SELECT * FROM knowledge WHERE 1=1`;
    const params: unknown[] = [];

    if (options?.source) {
      sql += ` AND source = ?`;
      params.push(options.source);
    }

    if (options?.sessionId) {
      sql += ` AND session_id = ?`;
      params.push(options.sessionId);
    }

    if (options?.tags && options.tags.length > 0) {
      for (const tag of options.tags) {
        sql += ` AND tags LIKE ?`;
        params.push(`%"${tag}"%`);
      }
    }

    sql += ` ORDER BY accessed_at DESC`;

    const rows = this.db.prepare(sql).all(...params) as any[];

    const scored: SearchResult[] = [];

    for (const row of rows) {
      let score = 0;
      let matchType: SearchResult["matchType"] = "keyword";

      if (row.content.toLowerCase().includes(queryLower)) {
        score += 10;
        matchType = "exact";
      }

      if (row.title.toLowerCase().includes(queryLower)) {
        score += 8;
        matchType = "exact";
      }

      const rowKeywords: string[] = JSON.parse(row.keywords || "[]");
      for (const qk of queryKeywords) {
        if (rowKeywords.includes(qk)) {
          score += 3;
        }
      }

      const rowTags: string[] = JSON.parse(row.tags || "[]");
      for (const qk of queryKeywords) {
        if (rowTags.some((t) => t.toLowerCase().includes(qk))) {
          score += 2;
          if (matchType !== "exact") matchType = "tag";
        }
      }

      for (const qk of queryKeywords) {
        if (row.content.toLowerCase().includes(qk)) {
          score += 1;
        }
      }

      if (score > 0) {
        scored.push({
          entry: this.rowToEntry(row),
          score,
          matchType,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    // Collapse parent/child duplicates. A split entry is represented twice in
    // the table: the full parent row and its heading-aware sub-chunks (which
    // carry parent_id). Both can match the same query, so without this a single
    // logical document would surface multiple times. Keying by parentId ?? id
    // and keeping the first (highest-scoring) hit per root yields one result per
    // document while preferring the most precise matching unit.
    const seenRoots = new Set<string>();
    const deduped: SearchResult[] = [];
    for (const r of scored) {
      const rootId = r.entry.parentId ?? r.entry.id;
      if (seenRoots.has(rootId)) continue;
      seenRoots.add(rootId);
      deduped.push(r);
    }

    const results = deduped.slice(0, limit);

    for (const r of results) {
      this.db
        .prepare(
          `UPDATE knowledge SET accessed_at = ?, access_count = access_count + 1 WHERE id = ?`,
        )
        .run(new Date().toISOString(), r.entry.id);
    }

    return results;
  }

  getRecent(options?: {
    limit?: number;
    source?: KnowledgeEntry["source"];
    sessionId?: string;
  }): KnowledgeEntry[] {
    const limit = options?.limit || 10;
    let sql = `SELECT * FROM knowledge WHERE 1=1`;
    const params: unknown[] = [];

    if (options?.source) {
      sql += ` AND source = ?`;
      params.push(options.source);
    }

    if (options?.sessionId) {
      sql += ` AND session_id = ?`;
      params.push(options.sessionId);
    }

    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.rowToEntry(r));
  }

  getAllEntries(options?: {
    source?: KnowledgeEntry["source"];
    sessionId?: string;
  }): KnowledgeEntry[] {
    let sql = `SELECT * FROM knowledge WHERE 1=1`;
    const params: unknown[] = [];

    if (options?.source) {
      sql += ` AND source = ?`;
      params.push(options.source);
    }

    if (options?.sessionId) {
      sql += ` AND session_id = ?`;
      params.push(options.sessionId);
    }

    sql += ` ORDER BY created_at DESC`;

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.rowToEntry(r));
  }

  getStats(): {
    totalEntries: number;
    bySource: Record<string, number>;
    oldestEntry: string | null;
    newestEntry: string | null;
  } {
    const total = (
      this.db.prepare(`SELECT COUNT(*) as count FROM knowledge`).get() as any
    ).count;

    const sources = this.db
      .prepare(
        `SELECT source, COUNT(*) as count FROM knowledge GROUP BY source`,
      )
      .all() as any[];

    const bySource: Record<string, number> = {};
    for (const s of sources) {
      bySource[s.source] = s.count;
    }

    const oldest = this.db
      .prepare(`SELECT MIN(created_at) as d FROM knowledge`)
      .get() as any;
    const newest = this.db
      .prepare(`SELECT MAX(created_at) as d FROM knowledge`)
      .get() as any;

    return {
      totalEntries: total,
      bySource,
      oldestEntry: oldest?.d || null,
      newestEntry: newest?.d || null,
    };
  }

  // Releases the underlying SQLite handle. Mainly for tests that open a store
  // on a temp database and need to delete the file afterward.
  close(): void {
    this.db.close();
  }

  deleteEntry(id: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM knowledge WHERE id = ?`)
      .run(id);
    return result.changes > 0;
  }

  clearOlderThan(days: number): number {
    const cutoff = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = this.db
      .prepare(`DELETE FROM knowledge WHERE created_at < ?`)
      .run(cutoff);
    return result.changes;
  }

  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      "the",
      "a",
      "an",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "being",
      "have",
      "has",
      "had",
      "do",
      "does",
      "did",
      "will",
      "would",
      "could",
      "should",
      "may",
      "might",
      "must",
      "shall",
      "can",
      "need",
      "dare",
      "ought",
      "used",
      "to",
      "of",
      "in",
      "for",
      "on",
      "with",
      "at",
      "by",
      "from",
      "as",
      "into",
      "through",
      "during",
      "before",
      "after",
      "above",
      "below",
      "between",
      "out",
      "off",
      "over",
      "under",
      "again",
      "further",
      "then",
      "once",
      "here",
      "there",
      "when",
      "where",
      "why",
      "how",
      "all",
      "each",
      "every",
      "both",
      "few",
      "more",
      "most",
      "other",
      "some",
      "such",
      "no",
      "nor",
      "not",
      "only",
      "own",
      "same",
      "so",
      "than",
      "too",
      "very",
      "just",
      "because",
      "but",
      "and",
      "or",
      "if",
      "while",
      "that",
      "this",
      "these",
      "those",
      "it",
      "its",
      "i",
      "me",
      "my",
      "we",
      "our",
      "you",
      "your",
      "he",
      "him",
      "his",
      "she",
      "her",
      "they",
      "them",
      "their",
      "what",
      "which",
      "who",
      "whom",
    ]);

    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));

    const freq: Record<string, number> = {};
    for (const w of words) {
      freq[w] = (freq[w] || 0) + 1;
    }

    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([w]) => w);
  }

  private rowToEntry(row: any): KnowledgeEntry {
    return {
      id: row.id,
      source: row.source,
      title: row.title,
      content: row.content,
      url: row.url || undefined,
      filePath: row.file_path || undefined,
      tags: JSON.parse(row.tags || "[]"),
      sessionId: row.session_id || undefined,
      createdAt: new Date(row.created_at),
      accessedAt: new Date(row.accessed_at),
      accessCount: row.access_count,
      parentId: row.parent_id || undefined,
    };
  }
}

export const knowledgeStore = new KnowledgeStore();
