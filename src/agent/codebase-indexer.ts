import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { env } from "../config/env";
import { embeddingService, cosineSimilarity } from "./embedding-service";
import { chunkContent } from "../context-engine/chunker";

export interface IndexedFile {
  path: string;
  language: string;
  content: string;
}

interface CodeChunk {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  contextHeader: string;
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
      "node_modules", ".git", "dist", ".next", "coverage", ".turbo",
      "__pycache__", ".venv", "venv", "env", "target", "build",
      "data", "logs", "ssl", "backups", "monitoring", "generated-audio",
      "site-packages",
    ]);

    const ALLOW_EXTENSIONS = new Set([
      ".ts", ".tsx", ".js", ".jsx",
      ".py", ".rs", ".go", ".java", ".kt", ".rb", ".php",
      ".cs", ".cpp", ".c", ".h", ".hpp", ".swift",
      ".sql", ".graphql", ".proto",
      ".json", ".yaml", ".yml", ".toml",
      ".md", ".html", ".css", ".scss",
      ".sh", ".bash", ".zsh", ".ps1",
      ".env.example",
    ]);

    const files: string[] = [];

    function walkDir(dir: string) {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!ALLOW_EXTENSIONS.has(ext) && !(ext === "" && entry.name === ".env.example")) continue;
          try {
            if (fs.statSync(fullPath).size <= maxFileSize) files.push(fullPath);
          } catch {}
        }
      }
    }

    console.log("[CodebaseIndexer] Scanning project files...");
    walkDir(projectRoot);
    console.log(`[CodebaseIndexer] Found ${files.length} files to index`);

    const useEmbeddings = await embeddingService.isAvailable();
    console.log(
      useEmbeddings
        ? `[CodebaseIndexer] Embeddings available via ${embeddingService.getProviderInfo().provider}`
        : "[CodebaseIndexer] Embeddings unavailable, using TF-IDF keyword search",
    );

    // Build file-hash map from existing index for incremental skip
    const existingHashes = new Map<string, string>();
    const hashRows = this.db.prepare(`SELECT DISTINCT file_path, file_hash FROM code_chunks WHERE file_hash IS NOT NULL`).all() as { file_path: string; file_hash: string }[];
    for (const row of hashRows) existingHashes.set(row.file_path, row.file_hash);

    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO code_chunks (id, file_path, start_line, end_line, content, language, keywords, embedding, indexed_at, file_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Only clear chunks for files that will actually be re-indexed
    const deleteFileStmt = this.db.prepare(`DELETE FROM code_chunks WHERE file_path = ?`);

    const EMBED_BATCH_SIZE = 100;   // larger batches = fewer API round trips
    const EMBED_CONCURRENCY = 3;    // parallel inflight embedding requests
    const now = new Date().toISOString();

    let totalChunks = 0;
    let skippedFiles = 0;
    let pendingChunks: CodeChunk[] = [];

    const flushWithEmbeddings = async (chunks: CodeChunk[]) => {
      if (chunks.length === 0) return;
      const texts = chunks.map((c) => c.content);
      const embeddings = await embeddingService.embedBatch(texts);
      const tx = this.db.transaction((items: CodeChunk[]) => {
        for (let i = 0; i < items.length; i++) {
          const emb = embeddings[i]?.embedding || null;
          insertStmt.run(
            items[i].id, items[i].filePath, items[i].startLine, items[i].endLine,
            items[i].content, items[i].language, JSON.stringify(items[i].keywords),
            emb ? Buffer.from(new Float32Array(emb).buffer) : null,
            now, this.hashString(items[i].content),
          );
        }
      });
      tx(chunks);
    };

    const flushWithoutEmbeddings = (chunks: CodeChunk[]) => {
      if (chunks.length === 0) return;
      const tx = this.db.transaction((items: CodeChunk[]) => {
        for (const chunk of items) {
          insertStmt.run(
            chunk.id, chunk.filePath, chunk.startLine, chunk.endLine,
            chunk.content, chunk.language, JSON.stringify(chunk.keywords),
            null, now, this.hashString(chunk.content),
          );
        }
      });
      tx(chunks);
    };

    // Drain pendingChunks in parallel batches of EMBED_BATCH_SIZE
    const drainPending = async (force = false) => {
      while (pendingChunks.length >= EMBED_BATCH_SIZE || (force && pendingChunks.length > 0)) {
        const take = Math.min(pendingChunks.length, EMBED_BATCH_SIZE * EMBED_CONCURRENCY);
        const wave = pendingChunks.splice(0, take);

        if (useEmbeddings) {
          // Split into concurrent sub-batches
          const subBatches: CodeChunk[][] = [];
          for (let i = 0; i < wave.length; i += EMBED_BATCH_SIZE) {
            subBatches.push(wave.slice(i, i + EMBED_BATCH_SIZE));
          }
          await Promise.all(subBatches.map(flushWithEmbeddings));
        } else {
          flushWithoutEmbeddings(wave);
        }

        totalChunks += wave.length;
        if (totalChunks % 200 === 0) {
          console.log(`[CodebaseIndexer] Indexed ${totalChunks} chunks...`);
        }
      }
    };

    for (const filePath of files) {
      try {
        const relativePath = path.relative(projectRoot, filePath).replace(/\\/g, "/");
        const content = fs.readFileSync(filePath, "utf-8");
        const fileHash = this.hashString(content);

        // Skip file if hash unchanged
        if (existingHashes.get(relativePath) === fileHash) {
          skippedFiles++;
          const existing = this.db.prepare(`SELECT COUNT(*) as n FROM code_chunks WHERE file_path = ?`).get(relativePath) as { n: number };
          totalChunks += existing.n;
          continue;
        }

        deleteFileStmt.run(relativePath);
        const language = this.detectLanguage(filePath);

        const chunks = chunkContent(content, language, {
          strategy: env.RAG_CHUNK_STRATEGY,
          maxTokens: chunkSize,
          minTokens: Math.floor(chunkSize * 0.3),
          overlapTokens: chunkOverlap,
          filePath: relativePath,
        });

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const storedContent = chunk.contextHeader
            ? `${chunk.contextHeader}\n${chunk.content}`
            : chunk.content;
          pendingChunks.push({
            id: `chunk-${this.hashString(`${relativePath}:${chunk.startLine}:${i}`)}`,
            filePath: relativePath,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            content: storedContent,
            contextHeader: chunk.contextHeader,
            language,
            embedding: null,
            keywords: this.extractKeywords(storedContent),
          });
        }

        await drainPending();
      } catch (error) {
        errors.push(`${filePath}: ${error instanceof Error ? error.message : "Unknown"}`);
      }
    }

    await drainPending(true);

    this.indexed = true;
    this.indexing = false;
    const duration = Date.now() - startTime;

    console.log(
      `[CodebaseIndexer] Complete: ${files.length} files (${skippedFiles} unchanged), ${totalChunks} chunks, ${duration}ms, embeddings=${useEmbeddings}`,
    );

    return { totalFiles: files.length, totalChunks, embedded: useEmbeddings, duration, errors };
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

  getIndexedFiles(): IndexedFile[] {
    const filePaths = this.db
      .prepare(`SELECT DISTINCT file_path, language FROM code_chunks ORDER BY file_path`)
      .all() as { file_path: string; language: string }[];

    const chunkStmt = this.db.prepare(
      `SELECT content FROM code_chunks WHERE file_path = ? ORDER BY start_line`,
    );

    return filePaths.map((row) => {
      const chunks = chunkStmt.all(row.file_path) as { content: string }[];
      const content = chunks.map((c) => c.content).join("\n");
      return {
        path: row.file_path,
        language: row.language,
        content,
      };
    });
  }

  isIndexed(): boolean {
    return this.indexed;
  }

  isIndexing(): boolean {
    return this.indexing;
  }

  addFile(absolutePath: string, projectRoot?: string): IndexedFile | null {
    const root = projectRoot || process.cwd();
    const relativePath = path.relative(root, absolutePath).replace(/\\/g, "/");
    const language = this.detectLanguage(absolutePath);

    let content: string;
    try {
      content = fs.readFileSync(absolutePath, "utf-8");
    } catch {
      return null;
    }

    const chunkSize = env.RAG_CHUNK_SIZE;
    const chunkOverlap = env.RAG_CHUNK_OVERLAP;

    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO code_chunks (id, file_path, start_line, end_line, content, language, keywords, embedding, indexed_at, file_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const existingChunks = this.db.prepare(`DELETE FROM code_chunks WHERE file_path = ?`);
    existingChunks.run(relativePath);

    const chunks = chunkContent(content, language, {
      strategy: env.RAG_CHUNK_STRATEGY,
      maxTokens: chunkSize,
      minTokens: Math.floor(chunkSize * 0.3),
      overlapTokens: chunkOverlap,
      filePath: relativePath,
    });

    const now = new Date().toISOString();
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const storedContent = chunk.contextHeader
        ? `${chunk.contextHeader}\n${chunk.content}`
        : chunk.content;
      const chunkId = `chunk-${this.hashString(`${relativePath}:${chunk.startLine}:${i}`)}`;
      const keywords = this.extractKeywords(storedContent);

      insertStmt.run(
        chunkId,
        relativePath,
        chunk.startLine,
        chunk.endLine,
        storedContent,
        language,
        JSON.stringify(keywords),
        null,
        now,
        null,
      );
    }

    const file: IndexedFile = { path: relativePath, language, content };

    return file;
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
