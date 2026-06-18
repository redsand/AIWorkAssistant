import path from "path";
import fs from "fs";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { claimKitAdapter } from "./adapters/claimkit-adapter";
import { knowledgeStore } from "../agent/knowledge-store";
import type { KnowledgeEntry } from "../agent/knowledge-store";
import { codebaseIndexer } from "../agent/codebase-indexer";
import type { IndexedFile } from "../agent/codebase-indexer";
import { knowledgeGraph } from "../agent/knowledge-graph";
import type { KGNode, KGEdge } from "../agent/knowledge-graph";
import type { RelationshipClaim, ScoredDocument } from "./types";
import { env } from "../config/env";
import { embeddingService } from "../agent/embedding-service";

export interface IngestionStats {
  total: number;
  ingested: number;
  skipped: number;
  errors: number;
  sourceIds: string[];
  durationMs: number;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").substring(0, 32);
}

// Persistent dedupe for ClaimKit ingestion. Previously this was an in-memory
// Set, which forced a re-ingest of every store entry on every server restart —
// each entry costs one LLM extraction call, so a few hundred entries blocked
// server.listen() for tens of minutes. The key embeds the embedding model
// because switching models invalidates the vector store and requires a re-ingest.
// See [[ollama-multi-process-instability]] for the original startup-hang
// investigation that led here.
export class IngestionDedupeStore {
  private db: Database.Database | null = null;
  private memory: Map<string, { hash: string | null; updatedAt: string | null }> = new Map();

  private getDb(): Database.Database | null {
    if (this.db) return this.db;
    // Under vitest / explicit test runs, stay in-memory so per-test
    // vi.resetModules() actually gives each test a fresh dedupe state.
    if (process.env.VITEST || process.env.NODE_ENV === "test") return null;
    try {
      const dbFile = path.join(path.resolve(process.cwd(), "data"), "claimkit_ingestion.db");
      const dir = path.dirname(dbFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const db = new Database(dbFile);
      db.pragma("journal_mode = WAL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS ingested (
          key TEXT NOT NULL,
          embed_model TEXT NOT NULL,
          content_hash TEXT,
          updated_at TEXT,
          ingested_at TEXT NOT NULL,
          PRIMARY KEY (key, embed_model)
        );
      `);

      // Migrate older DBs created before content_hash/updated_at columns were added.
      // CREATE TABLE IF NOT EXISTS leaves existing tables untouched, so we ALTER them.
      const columns = db
        .prepare("SELECT name FROM pragma_table_info('ingested')")
        .all() as { name: string }[];
      const columnNames = new Set(columns.map((c) => c.name));
      if (!columnNames.has("content_hash")) {
        db.exec(`ALTER TABLE ingested ADD COLUMN content_hash TEXT;`);
      }
      if (!columnNames.has("updated_at")) {
        db.exec(`ALTER TABLE ingested ADD COLUMN updated_at TEXT;`);
      }

      this.db = db;
      return db;
    } catch (err) {
      console.warn("[ClaimKit Ingestion] Dedupe store unavailable, using in-memory fallback:", err);
      return null;
    }
  }

  private currentModel(): string {
    // Must match ClaimKit's vector-store namespace so the dedupe invalidates
    // automatically when the embedding model changes (which flushes the store).
    // embeddingService settles its provider/model during ClaimKit init, before
    // ingestion runs, so this is reliable here.
    try {
      const info = embeddingService.getProviderInfo();
      if (info?.model) return info.model;
    } catch {
      // fall through
    }
    try {
      return env.RAG_EMBEDDING_MODEL || "unknown";
    } catch {
      return "unknown";
    }
  }

  private makeKey(key: string): { key: string; model: string } {
    return { key, model: this.currentModel() };
  }

  /**
   * Check whether this key has already been ingested with the same content hash.
   * If `updatedAt` is provided and is newer than the stored `updated_at`, or if
   * the hash differs, returns true so the caller can re-ingest.
   */
  hasChanged(key: string, hash?: string, updatedAt?: string): boolean {
    const { key: fullKey, model } = this.makeKey(key);
    const cached = this.memory.get(fullKey);
    if (cached !== undefined) {
      return this.isChanged(cached, hash, updatedAt);
    }
    const db = this.getDb();
    if (!db) return true; // no persistence → assume changed
    const row = db
      .prepare("SELECT content_hash, updated_at FROM ingested WHERE key = ? AND embed_model = ?")
      .get(fullKey, model) as { content_hash: string | null; updated_at: string | null } | undefined;
    if (!row) return true;
    const stored = { hash: row.content_hash ?? null, updatedAt: row.updated_at ?? null };
    this.memory.set(fullKey, stored);
    return this.isChanged(stored, hash, updatedAt);
  }

  private isChanged(
    stored: { hash: string | null; updatedAt: string | null },
    hash?: string,
    updatedAt?: string,
  ): boolean {
    if (hash !== undefined && stored.hash !== hash) return true;
    if (updatedAt !== undefined && stored.updatedAt !== null) {
      return new Date(updatedAt) > new Date(stored.updatedAt);
    }
    return false;
  }

  /** Legacy boolean check: present and unchanged. */
  has(key: string): boolean {
    return !this.hasChanged(key);
  }

  /**
   * Record that a key has been ingested. Pass the content hash and upstream
   * updated-at timestamp so future calls to hasChanged() can detect changes.
   */
  add(key: string, hash?: string, updatedAt?: string): void {
    const { key: fullKey, model } = this.makeKey(key);
    this.memory.set(fullKey, { hash: hash ?? "", updatedAt: updatedAt ?? null });
    const db = this.getDb();
    if (!db) return;
    try {
      db.prepare(
        "INSERT OR REPLACE INTO ingested (key, embed_model, content_hash, updated_at, ingested_at) VALUES (?, ?, ?, ?, ?)",
      ).run(fullKey, model, hash ?? null, updatedAt ?? null, new Date().toISOString());
    } catch (err) {
      console.warn("[ClaimKit Ingestion] Failed to persist dedupe key:", err);
    }
  }

  // For tests: clear in-memory state without touching disk.
  resetMemory(): void {
    this.memory.clear();
  }
}

export const ingestedIds = new IngestionDedupeStore();

function buildRelationshipClaim(
  edge: KGEdge,
  sourceNode: KGNode | null,
  targetNode: KGNode | null,
): RelationshipClaim {
  const sourceTitle = sourceNode?.title ?? edge.sourceId;
  const targetTitle = targetNode?.title ?? edge.targetId;
  return {
    entity: sourceTitle,
    attribute: "relationship",
    value: `[${edge.type}] -> ${targetTitle}`,
    sourceNodeId: edge.sourceId,
    targetNodeId: edge.targetId,
    edgeType: edge.type,
    trustTier: "curated",
  };
}

function formatRelationshipClaim(claim: RelationshipClaim, description?: string): string {
  return [
    `Relationship claim: ${claim.entity} ${claim.attribute} ${claim.value}`,
    description ?? "",
  ].join("\n");
}

async function ingestDocument(
  doc: ScoredDocument,
  query: string,
  stats: IngestionStats,
): Promise<void> {
  const key = `scored-doc:${doc.source}:${doc.id}`;
  const sourceDetail = doc.source === "codebase"
    ? `${doc.metadata.filePath ?? doc.title}:${doc.metadata.startLine ?? ""}-${doc.metadata.endLine ?? ""}`
    : doc.title;
  const text = [
    `Source type: ${doc.source}`,
    `Title: ${doc.title}`,
    `Location: ${sourceDetail}`,
    `Matched query: ${query}`,
    "",
    doc.content,
  ].join("\n");
  const hash = hashContent(text);
  if (!ingestedIds.hasChanged(key, hash)) {
    stats.skipped++;
    return;
  }

  try {
    const { sourceId } = await claimKitAdapter.ingest(text, {
      docId: doc.id,
      title: doc.title,
      source: doc.source,
      trustTier: "curated",
      querySeed: true,
      score: doc.score,
      ...doc.metadata,
    });

    stats.sourceIds.push(sourceId);
    stats.ingested++;
    ingestedIds.add(key, hash);
  } catch (err) {
    console.warn(`[ClaimKit Ingestion] Failed to ingest scored document ${doc.id}:`, err);
    stats.errors++;
  }
}

async function runWithConcurrencyLimit<T>(
  items: T[],
  limit: number,
  signal: AbortSignal | undefined,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = items.slice();
  const workers: Promise<void>[] = [];
  for (let i = 0; i < limit; i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          if (signal?.aborted) return;
          const item = queue.shift()!;
          await fn(item);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

export async function ingestSingleKnowledgeEntry(entry: KnowledgeEntry): Promise<void> {
  if (!claimKitAdapter.isAvailable()) return;

  // Safeguard: when RAG_INCLUDE_LOCAL_SOURCES is off, never push
  // file_read content (the agent calling local.read_file in chat) into
  // ClaimKit's claim store. Other knowledge sources (web_search, manual,
  // conversation, etc.) remain ingestable. See env.ts for context.
  if (!env.RAG_INCLUDE_LOCAL_SOURCES && entry.source === "file_read") {
    return;
  }

  try {
    const text = `${entry.title}\n\n${entry.content}`;
    const key = `knowledge:${entry.id}`;
    const hash = hashContent(text);
    if (!ingestedIds.hasChanged(key, hash)) return;
    await claimKitAdapter.ingest(text, {
      docId: entry.id,
      title: entry.title,
      source: "knowledge",
      trustTier: "curated",
      tags: entry.tags ?? [],
    });
    ingestedIds.add(key, hash);
  } catch (err) {
    console.warn(`[ClaimKit Ingestion] Failed to ingest doc ${entry.id}:`, err);
  }
}

export async function ingestScoredDocumentsForQuery(
  docs: ScoredDocument[],
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<IngestionStats> {
  const start = Date.now();
  const stats: IngestionStats = { total: 0, ingested: 0, skipped: 0, errors: 0, sourceIds: [], durationMs: 0 };

  if (!claimKitAdapter.isAvailable() || limit <= 0) {
    return stats;
  }

  const selected = docs
    .filter((doc) => doc.content.trim().length > 0)
    .slice(0, limit);
  stats.total = selected.length;

  const concurrency = Math.max(1, env.AI_MAX_CONCURRENT);
  await runWithConcurrencyLimit(selected, concurrency, signal, (doc) => ingestDocument(doc, query, stats));

  stats.durationMs = Date.now() - start;
  if (stats.ingested > 0 || stats.errors > 0) {
    console.log(`[ClaimKit Ingestion] Query seed: ${stats.ingested}/${stats.total} ingested (${stats.errors} errors) in ${stats.durationMs}ms`);
  }
  return stats;
}

export async function ingestCodebaseStore(): Promise<IngestionStats> {
  const start = Date.now();
  const stats: IngestionStats = { total: 0, ingested: 0, skipped: 0, errors: 0, sourceIds: [], durationMs: 0 };

  if (!claimKitAdapter.isAvailable()) {
    console.warn("[ClaimKit Ingestion] ClaimKit not available, skipping codebase ingestion");
    return stats;
  }

  const files: IndexedFile[] = codebaseIndexer.getIndexedFiles();
  stats.total = files.length;

  for (const file of files) {
    try {
      const key = `codebase:${file.path}`;
      const text = `File: ${file.path}\n\n${file.content}`;
      const hash = hashContent(text);
      if (!ingestedIds.hasChanged(key, hash)) {
        stats.skipped++;
        continue;
      }
      const { sourceId } = await claimKitAdapter.ingest(text, {
        path: file.path,
        title: file.path,
        source: "codebase",
        language: file.language,
        trustTier: "curated",
      });
      stats.sourceIds.push(sourceId);
      stats.ingested++;
      ingestedIds.add(key, hash);
    } catch (err) {
      console.warn(`[ClaimKit Ingestion] Failed to ingest file ${file.path}:`, err);
      stats.errors++;
    }
  }

  stats.durationMs = Date.now() - start;
  console.log(`[ClaimKit Ingestion] Codebase: ${stats.ingested}/${stats.total} ingested (${stats.errors} errors) in ${stats.durationMs}ms`);
  return stats;
}

export async function ingestSingleCodebaseFile(file: IndexedFile): Promise<void> {
  if (!claimKitAdapter.isAvailable()) return;

  try {
    const text = `File: ${file.path}\n\n${file.content}`;
    const key = `codebase:${file.path}`;
    const hash = hashContent(text);
    if (!ingestedIds.hasChanged(key, hash)) return;
    await claimKitAdapter.ingest(text, {
      path: file.path,
      title: file.path,
      source: "codebase",
      language: file.language,
      trustTier: "curated",
    });
    ingestedIds.add(key, hash);
  } catch (err) {
    console.warn(`[ClaimKit Ingestion] Failed to ingest file ${file.path}:`, err);
  }
}


export async function ingestSingleGraphNode(node: KGNode): Promise<void> {
  if (!claimKitAdapter.isAvailable()) return;

  try {
    const text = `Entity: ${node.title} (${node.type})\n${node.content}\nContext: ${node.context ?? "N/A"}\nStatus: ${node.status}`;
    const key = `graph-node:${node.id}`;
    const hash = hashContent(text);
    if (!ingestedIds.hasChanged(key, hash)) return;
    await claimKitAdapter.ingest(text, {
      entityId: node.id,
      entityType: node.type,
      source: "graph",
      trustTier: "curated",
    });
    ingestedIds.add(key, hash);
  } catch (err) {
    console.warn(`[ClaimKit Ingestion] Failed to ingest node ${node.id}:`, err);
  }
}

export async function ingestSingleGraphEdge(edge: KGEdge): Promise<void> {
  if (!claimKitAdapter.isAvailable()) return;

  try {
    const sourceNode = knowledgeGraph.getNode(edge.sourceId);
    const targetNode = knowledgeGraph.getNode(edge.targetId);
    const relationshipClaim = buildRelationshipClaim(edge, sourceNode, targetNode);
    const text = formatRelationshipClaim(relationshipClaim, edge.description);
    const key = `graph-edge:${edge.id}`;
    const hash = hashContent(text);
    if (!ingestedIds.hasChanged(key, hash)) return;
    await claimKitAdapter.ingest(text, {
      relationshipId: edge.id,
      relationshipType: edge.type,
      relationshipClaim,
      source: "graph",
      trustTier: "curated",
    });
    ingestedIds.add(key, hash);
  } catch (err) {
    console.warn(`[ClaimKit Ingestion] Failed to ingest edge ${edge.id}:`, err);
  }
}

export async function ingestKnowledgeStore(): Promise<IngestionStats> {
  const start = Date.now();
  const stats: IngestionStats = { total: 0, ingested: 0, skipped: 0, errors: 0, sourceIds: [], durationMs: 0 };

  if (!claimKitAdapter.isAvailable()) {
    console.warn("[ClaimKit Ingestion] ClaimKit not available, skipping knowledge store ingestion");
    return stats;
  }

  const allDocuments: KnowledgeEntry[] = knowledgeStore.getAllEntries();
  // Same safeguard as ingestSingleKnowledgeEntry: skip file_read entries
  // when local sources are excluded. Keeps Jira / web / conversation /
  // manual entries flowing.
  const documents = env.RAG_INCLUDE_LOCAL_SOURCES
    ? allDocuments
    : allDocuments.filter((d) => d.source !== "file_read");
  stats.total = documents.length;
  console.log(`[ClaimKit Ingestion] Knowledge store: ${documents.length} candidate document(s)`);
  if (documents.length < allDocuments.length) {
    console.log(
      `[ClaimKit Ingestion] Skipping ${allDocuments.length - documents.length} file_read entries (RAG_INCLUDE_LOCAL_SOURCES=false)`,
    );
  }

  let lastProgressAt = start;
  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    const elapsed = Date.now() - start;
    if (elapsed - (Date.now() - lastProgressAt) >= 10_000 || i === documents.length - 1) {
      console.log(`[ClaimKit Ingestion] Knowledge store progress: ${i + 1}/${documents.length} (${stats.ingested} ingested, ${stats.skipped} skipped, ${stats.errors} errors) — ${elapsed}ms elapsed`);
      lastProgressAt = elapsed;
    }
    try {
      const key = `knowledge:${doc.id}`;
      const text = `${doc.title}\n\n${doc.content}`;
      const hash = hashContent(text);
      if (!ingestedIds.hasChanged(key, hash)) {
        stats.skipped++;
        continue;
      }
      const { sourceId } = await claimKitAdapter.ingest(text, {
        docId: doc.id,
        title: doc.title,
        source: "knowledge",
        trustTier: "curated",
        tags: doc.tags ?? [],
      });
      stats.sourceIds.push(sourceId);
      stats.ingested++;
      ingestedIds.add(key, hash);
    } catch (err) {
      console.warn(`[ClaimKit Ingestion] Failed to ingest doc ${doc.id}:`, err);
      stats.errors++;
    }
  }

  stats.durationMs = Date.now() - start;
  console.log(`[ClaimKit Ingestion] Knowledge store: ${stats.ingested}/${stats.total} ingested (${stats.errors} errors) in ${stats.durationMs}ms`);
  return stats;
}


export async function ingestGraphStore(): Promise<IngestionStats> {
  const start = Date.now();
  const stats: IngestionStats = { total: 0, ingested: 0, skipped: 0, errors: 0, sourceIds: [], durationMs: 0 };

  if (!claimKitAdapter.isAvailable()) {
    console.warn("[ClaimKit Ingestion] ClaimKit not available, skipping graph ingestion");
    return stats;
  }

  const nodes: KGNode[] = knowledgeGraph.getAllNodes();
  const edges: KGEdge[] = knowledgeGraph.getAllEdges();
  stats.total = nodes.length + edges.length;
  console.log(`[ClaimKit Ingestion] Graph: ${nodes.length} node(s) + ${edges.length} edge(s)`);

  let lastProgressAt = start;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const elapsed = Date.now() - start;
    if (elapsed - (Date.now() - lastProgressAt) >= 10_000 || i === nodes.length - 1) {
      console.log(`[ClaimKit Ingestion] Graph node progress: ${i + 1}/${nodes.length} (${stats.ingested} ingested, ${stats.skipped} skipped, ${stats.errors} errors) — ${elapsed}ms elapsed`);
      lastProgressAt = elapsed;
    }
    try {
      const key = `graph-node:${node.id}`;
      const text = `Entity: ${node.title} (${node.type})\n${node.content}\nContext: ${node.context ?? "N/A"}\nStatus: ${node.status}`;
      const hash = hashContent(text);
      if (!ingestedIds.hasChanged(key, hash)) {
        stats.skipped++;
        continue;
      }
      const { sourceId } = await claimKitAdapter.ingest(text, {
        entityId: node.id,
        entityType: node.type,
        source: "graph",
        trustTier: "curated",
      });
      stats.sourceIds.push(sourceId);
      stats.ingested++;
      ingestedIds.add(key, hash);
    } catch (err) {
      console.warn(`[ClaimKit Ingestion] Failed to ingest node ${node.id}:`, err);
      stats.errors++;
    }
  }

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const elapsed = Date.now() - start;
    if (elapsed - (Date.now() - lastProgressAt) >= 10_000 || i === edges.length - 1) {
      console.log(`[ClaimKit Ingestion] Graph edge progress: ${i + 1}/${edges.length} (${stats.ingested} ingested, ${stats.skipped} skipped, ${stats.errors} errors) — ${elapsed}ms elapsed`);
      lastProgressAt = elapsed;
    }
    try {
      const key = `graph-edge:${edge.id}`;
      const sourceNode = knowledgeGraph.getNode(edge.sourceId);
      const targetNode = knowledgeGraph.getNode(edge.targetId);
      const relationshipClaim = buildRelationshipClaim(edge, sourceNode, targetNode);
      const text = formatRelationshipClaim(relationshipClaim, edge.description);
      const hash = hashContent(text);
      if (!ingestedIds.hasChanged(key, hash)) {
        stats.skipped++;
        continue;
      }
      const { sourceId } = await claimKitAdapter.ingest(text, {
        relationshipId: edge.id,
        relationshipType: edge.type,
        relationshipClaim,
        source: "graph",
        trustTier: "curated",
      });
      stats.sourceIds.push(sourceId);
      stats.ingested++;
      ingestedIds.add(key, hash);
    } catch (err) {
      console.warn(`[ClaimKit Ingestion] Failed to ingest edge ${edge.id}:`, err);
      stats.errors++;
    }
  }

  stats.durationMs = Date.now() - start;
  console.log(`[ClaimKit Ingestion] Graph: ${stats.ingested}/${stats.total} ingested (${stats.errors} errors) in ${stats.durationMs}ms`);
  return stats;
}
