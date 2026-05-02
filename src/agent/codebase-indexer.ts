import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { env } from "../config/env";
import { embeddingService, cosineSimilarity } from "./embedding-service";

interface CodeChunk {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  language: string;
  embedding: number[] | null;
  keywords: string[];
}

class CodebaseIndexer {
  private db: Database.Database;
  private indexed = false;
  private indexing = false;

  constructor() {
    const dataDir = path.resolve(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(path.join(dataDir, "codebase_index.db"));
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_chunks (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        language TEXT NOT NULL,
        keywords TEXT DEFAULT '[]',
        embedding BLOB,
        indexed_at TEXT NOT NULL,
        file_hash TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_file ON code_chunks(file_path);
      CREATE INDEX IF NOT EXISTS idx_chunks_lang ON code_chunks(language);
    `);
  }

  async indexCodebase(rootDir?: string): Promise<{
    totalFiles: number;
    totalChunks: number;
    embedded: boolean;
    duration: number;
    errors: string[];
  }> {
    if (this.indexing) {
      return {
        totalFiles: 0,
        totalChunks: 0,
        embedded: false,
        duration: 0,
        errors: ["Indexing already in progress"],
      };
    }

    this.indexing = true;
    const startTime = Date.now();
    const errors: string[] = [];
    const projectRoot = rootDir || process.cwd();
    const maxFileSize = env.RAG_MAX_FILE_SIZE_KB * 1024;
    const chunkSize = env.RAG_CHUNK_SIZE;
    const chunkOverlap = env.RAG_CHUNK_OVERLAP;

    const SKIP_DIRS = new Set([
      "node_modules",
      ".git",
      "dist",
      ".next",
      "coverage",
      ".turbo",
      "__pycache__",
      ".venv",
      "target",
      "build",
      "data",
      "logs",
    ]);

    const SKIP_EXTENSIONS = new Set([
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".ico",
      ".svg",
      ".woff",
      ".woff2",
      ".ttf",
      ".eot",
      ".mp3",
      ".mp4",
      ".zip",
      ".tar",
      ".gz",
      ".db",
      ".sqlite",
    ]);

    const files: string[] = [];

    function walkDir(dir: string) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.name !== ".env.example")
          continue;

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SKIP_EXTENSIONS.has(ext)) continue;

          try {
            const stat = fs.statSync(fullPath);
            if (stat.size > maxFileSize) continue;
            files.push(fullPath);
          } catch {}
        }
      }
    }

    console.log("[CodebaseIndexer] Scanning project files...");
    walkDir(projectRoot);
    console.log(`[CodebaseIndexer] Found ${files.length} files to index`);

    const useEmbeddings = await embeddingService.isAvailable();
    if (useEmbeddings) {
      console.log(
        `[CodebaseIndexer] Embeddings available via ${embeddingService.getProviderInfo().provider}, using vector search`,
      );
    } else {
      console.log(
        "[CodebaseIndexer] Embeddings unavailable, using TF-IDF keyword search",
      );
    }

    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO code_chunks (id, file_path, start_line, end_line, content, language, keywords, embedding, indexed_at, file_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const clearStmt = this.db.prepare(`DELETE FROM code_chunks`);
    clearStmt.run();

    let totalChunks = 0;
    let batchChunks: CodeChunk[] = [];
    const BATCH_SIZE = 20;

    const flushBatch = async () => {
      if (batchChunks.length === 0) return;

      if (useEmbeddings) {
        const texts = batchChunks.map((c) => c.content);
        const embeddings = await embeddingService.embedBatch(texts);
        for (let i = 0; i < batchChunks.length; i++) {
          batchChunks[i].embedding = embeddings[i]?.embedding || null;
        }
      }

      const tx = this.db.transaction((chunks: CodeChunk[]) => {
        for (const chunk of chunks) {
          const keywords = this.extractKeywords(chunk.content);
          const embeddingBlob = chunk.embedding
            ? Buffer.from(new Float32Array(chunk.embedding).buffer)
            : null;

          insertStmt.run(
            chunk.id,
            chunk.filePath,
            chunk.startLine,
            chunk.endLine,
            chunk.content,
            chunk.language,
            JSON.stringify(keywords),
            embeddingBlob,
            new Date().toISOString(),
            null,
          );
        }
      });

      tx(batchChunks);
      totalChunks += batchChunks.length;
      batchChunks = [];
    };

    for (const filePath of files) {
      try {
        const relativePath = path
          .relative(projectRoot, filePath)
          .replace(/\\/g, "/");
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");
        const language = this.detectLanguage(filePath);

        let charPos = 0;

        while (charPos < content.length) {
          const end = Math.min(charPos + chunkSize, content.length);
          const chunkContent = content.substring(charPos, end);

          let startLine = 1;
          let endLine = 1;
          let charsCounted = 0;
          for (let i = 0; i < lines.length; i++) {
            charsCounted += lines[i].length + 1;
            if (charsCounted >= charPos && startLine === 1) {
              startLine = i + 1;
            }
            if (charsCounted >= end) {
              endLine = i + 1;
              break;
            }
          }

          const chunkId = `chunk-${this.hashString(`${relativePath}:${charPos}`)}`;

          batchChunks.push({
            id: chunkId,
            filePath: relativePath,
            startLine,
            endLine,
            content: chunkContent,
            language,
            embedding: null,
            keywords: [],
          });

          if (batchChunks.length >= BATCH_SIZE) {
            await flushBatch();
            const progress = totalChunks;
            if (progress % 100 === 0) {
              console.log(`[CodebaseIndexer] Indexed ${progress} chunks...`);
            }
          }

          charPos += chunkSize - chunkOverlap;
        }
      } catch (error) {
        errors.push(
          `${filePath}: ${error instanceof Error ? error.message : "Unknown"}`,
        );
      }
    }

    await flushBatch();

    this.indexed = true;
    this.indexing = false;
    const duration = Date.now() - startTime;

    console.log(
      `[CodebaseIndexer] Complete: ${files.length} files, ${totalChunks} chunks, ${duration}ms, embeddings=${useEmbeddings}`,
    );

    return {
      totalFiles: files.length,
      totalChunks,
      embedded: useEmbeddings,
      duration,
      errors,
    };
  }

  search(
    query: string,
    options?: { limit?: number; language?: string; filePath?: string },
  ): Array<{
    filePath: string;
    startLine: number;
    endLine: number;
    content: string;
    language: string;
    score: number;
    matchType: "vector" | "keyword" | "exact";
  }> {
    const limit = options?.limit || 10;

    let sql = `SELECT * FROM code_chunks WHERE 1=1`;
    const params: unknown[] = [];

    if (options?.language) {
      sql += ` AND language = ?`;
      params.push(options.language);
    }

    if (options?.filePath) {
      sql += ` AND file_path LIKE ?`;
      params.push(`%${options.filePath}%`);
    }

    sql += ` LIMIT 500`;

    const rows = this.db.prepare(sql).all(...params) as any[];

    const queryKeywords = this.extractKeywords(query);
    const queryLower = query.toLowerCase();

    const scored: Array<{
      row: any;
      score: number;
      matchType: "vector" | "keyword" | "exact";
    }> = [];

    for (const row of rows) {
      let score = 0;
      let matchType: "vector" | "keyword" | "exact" = "keyword";

      if (row.content.toLowerCase().includes(queryLower)) {
        score += 10;
        matchType = "exact";
      }

      const rowKeywords: string[] = JSON.parse(row.keywords || "[]");
      for (const qk of queryKeywords) {
        if (rowKeywords.includes(qk)) {
          score += 3;
        }
        if (row.content.toLowerCase().includes(qk)) {
          score += 1;
        }
      }

      if (row.embedding) {
        try {
          score += 0.1;
        } catch {}
      }

      if (score > 0) {
        scored.push({ row, score, matchType });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map((s) => ({
      filePath: s.row.file_path,
      startLine: s.row.start_line,
      endLine: s.row.end_line,
      content: s.row.content.substring(0, 500),
      language: s.row.language,
      score: s.score,
      matchType: s.matchType,
    }));
  }

  async searchWithEmbeddings(
    query: string,
    options?: { limit?: number; language?: string; filePath?: string },
  ): Promise<
    Array<{
      filePath: string;
      startLine: number;
      endLine: number;
      content: string;
      language: string;
      score: number;
      matchType: "vector" | "keyword" | "exact";
    }>
  > {
    const limit = options?.limit || 10;

    const queryEmbedding = await embeddingService.embed(query);

    let sql = `SELECT * FROM code_chunks WHERE 1=1`;
    const params: unknown[] = [];

    if (options?.language) {
      sql += ` AND language = ?`;
      params.push(options.language);
    }

    if (options?.filePath) {
      sql += ` AND file_path LIKE ?`;
      params.push(`%${options.filePath}%`);
    }

    sql += ` LIMIT 500`;

    const rows = this.db.prepare(sql).all(...params) as any[];

    const queryKeywords = this.extractKeywords(query);
    const queryLower = query.toLowerCase();

    const scored: Array<{
      row: any;
      score: number;
      matchType: "vector" | "keyword" | "exact";
    }> = [];

    for (const row of rows) {
      let score = 0;
      let matchType: "vector" | "keyword" | "exact" = "keyword";

      if (queryEmbedding && row.embedding) {
        try {
          const embeddingBuf = row.embedding as Buffer;
          const float32 = new Float32Array(
            embeddingBuf.buffer,
            embeddingBuf.byteOffset,
            embeddingBuf.byteLength / 4,
          );
          const similarity = cosineSimilarity(
            queryEmbedding.embedding,
            Array.from(float32),
          );
          if (similarity > 0.3) {
            score += similarity * 20;
            matchType = "vector";
          }
        } catch {}
      }

      if (row.content.toLowerCase().includes(queryLower)) {
        score += 10;
        if (matchType !== "vector") matchType = "exact";
      }

      const rowKeywords: string[] = JSON.parse(row.keywords || "[]");
      for (const qk of queryKeywords) {
        if (rowKeywords.includes(qk)) {
          score += 3;
        }
        if (row.content.toLowerCase().includes(qk)) {
          score += 1;
        }
      }

      if (score > 0) {
        scored.push({ row, score, matchType });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map((s) => ({
      filePath: s.row.file_path,
      startLine: s.row.start_line,
      endLine: s.row.end_line,
      content: s.row.content.substring(0, 500),
      language: s.row.language,
      score: s.score,
      matchType: s.matchType,
    }));
  }

  getStats(): {
    totalChunks: number;
    totalFiles: number;
    byLanguage: Record<string, number>;
    embedded: boolean;
    embeddingProvider: string | null;
  } {
    const total = (
      this.db.prepare(`SELECT COUNT(*) as count FROM code_chunks`).get() as any
    ).count;

    const files = (
      this.db
        .prepare(`SELECT COUNT(DISTINCT file_path) as count FROM code_chunks`)
        .get() as any
    ).count;

    const langs = this.db
      .prepare(
        `SELECT language, COUNT(*) as count FROM code_chunks GROUP BY language ORDER BY count DESC`,
      )
      .all() as any[];

    const byLanguage: Record<string, number> = {};
    for (const l of langs) {
      byLanguage[l.language] = l.count;
    }

    const providerInfo = embeddingService.getProviderInfo();

    return {
      totalChunks: total,
      totalFiles: files,
      byLanguage,
      embedded: providerInfo.available === true,
      embeddingProvider: providerInfo.available ? providerInfo.provider : null,
    };
  }

  isIndexed(): boolean {
    return this.indexed;
  }

  isIndexing(): boolean {
    return this.indexing;
  }

  private detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const langMap: Record<string, string> = {
      ".ts": "typescript",
      ".tsx": "typescript",
      ".js": "javascript",
      ".jsx": "javascript",
      ".py": "python",
      ".rs": "rust",
      ".go": "go",
      ".java": "java",
      ".kt": "kotlin",
      ".rb": "ruby",
      ".php": "php",
      ".cs": "csharp",
      ".cpp": "cpp",
      ".c": "c",
      ".h": "c",
      ".hpp": "cpp",
      ".swift": "swift",
      ".sql": "sql",
      ".json": "json",
      ".yaml": "yaml",
      ".yml": "yaml",
      ".toml": "toml",
      ".md": "markdown",
      ".html": "html",
      ".css": "css",
      ".scss": "scss",
      ".sh": "shell",
      ".bash": "shell",
      ".zsh": "shell",
      ".ps1": "powershell",
      ".dockerfile": "dockerfile",
      ".env": "env",
      ".graphql": "graphql",
      ".proto": "protobuf",
    };

    if (filePath.toLowerCase().endsWith("dockerfile")) return "dockerfile";

    return langMap[ext] || "text";
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
      "const",
      "let",
      "var",
      "function",
      "return",
      "import",
      "export",
      "from",
      "class",
      "new",
      "this",
      "async",
      "await",
      "try",
      "catch",
      "throw",
      "if",
      "else",
      "switch",
      "case",
      "for",
      "while",
      "break",
      "continue",
      "true",
      "false",
      "null",
      "undefined",
      "type",
      "interface",
      "extends",
      "implements",
      "public",
      "private",
      "protected",
      "static",
      "void",
    ]);

    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s_.-]/g, "")
      .split(/[\s_.-]+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));

    const freq: Record<string, number> = {};
    for (const w of words) {
      freq[w] = (freq[w] || 0) + 1;
    }

    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([w]) => w);
  }

  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return Math.abs(hash).toString(36);
  }
}

export const codebaseIndexer = new CodebaseIndexer();
