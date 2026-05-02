import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

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
}

export interface SearchResult {
  entry: KnowledgeEntry;
  score: number;
  matchType: "tag" | "keyword" | "exact";
}

class KnowledgeStore {
  private db: Database.Database;

  constructor() {
    const dataDir = path.resolve(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(path.join(dataDir, "knowledge.db"));
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
        access_count INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge(source);
      CREATE INDEX IF NOT EXISTS idx_knowledge_tags ON knowledge(tags);
      CREATE INDEX IF NOT EXISTS idx_knowledge_session ON knowledge(session_id);
    `);
  }

  store(
    entry: Omit<KnowledgeEntry, "id" | "accessedAt" | "accessCount">,
  ): string {
    const id = `kn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const keywords = this.extractKeywords(entry.content);
    const tagsJson = JSON.stringify(entry.tags);
    const keywordsJson = JSON.stringify(keywords);
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT OR REPLACE INTO knowledge (id, source, title, content, url, file_path, tags, session_id, keywords, created_at, accessed_at, access_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
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

    return id;
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

    const results = scored.slice(0, limit);

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
    };
  }
}

export const knowledgeStore = new KnowledgeStore();
