import { claimKitAdapter } from "./adapters/claimkit-adapter";
import { knowledgeStore } from "../agent/knowledge-store";
import type { KnowledgeEntry } from "../agent/knowledge-store";
import { codebaseIndexer } from "../agent/codebase-indexer";
import type { IndexedFile } from "../agent/codebase-indexer";
import { knowledgeGraph } from "../agent/knowledge-graph";
import type { KGNode, KGEdge } from "../agent/knowledge-graph";
import type { ScoredDocument } from "./types";
import { env } from "../config/env";

export interface IngestionStats {
  total: number;
  ingested: number;
  skipped: number;
  errors: number;
  sourceIds: string[];
  durationMs: number;
}

const ingestedIds = new Set<string>();

async function ingestDocument(
  doc: ScoredDocument,
  query: string,
  stats: IngestionStats,
): Promise<void> {
  const key = `scored-doc:${doc.source}:${doc.id}`;
  if (ingestedIds.has(key)) {
    stats.skipped++;
    return;
  }

  try {
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
    ingestedIds.add(key);
  } catch (err) {
    console.warn(`[ClaimKit Ingestion] Failed to ingest scored document ${doc.id}:`, err);
    stats.errors++;
  }
}

async function runWithConcurrencyLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = items.slice();
  const workers: Promise<void>[] = [];
  for (let i = 0; i < limit; i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
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
  if (ingestedIds.has(`knowledge:${entry.id}`)) return;

  try {
    const text = `${entry.title}\n\n${entry.content}`;
    await claimKitAdapter.ingest(text, {
      docId: entry.id,
      title: entry.title,
      source: "knowledge",
      trustTier: "curated",
      tags: entry.tags ?? [],
    });
    ingestedIds.add(`knowledge:${entry.id}`);
  } catch (err) {
    console.warn(`[ClaimKit Ingestion] Failed to ingest doc ${entry.id}:`, err);
  }
}

export async function ingestScoredDocumentsForQuery(
  docs: ScoredDocument[],
  query: string,
  limit: number,
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
  await runWithConcurrencyLimit(selected, concurrency, (doc) => ingestDocument(doc, query, stats));

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
      if (ingestedIds.has(key)) {
        stats.skipped++;
        continue;
      }
      const { sourceId } = await claimKitAdapter.ingest(`File: ${file.path}\n\n${file.content}`, {
        path: file.path,
        title: file.path,
        source: "codebase",
        language: file.language,
        trustTier: "curated",
      });
      stats.sourceIds.push(sourceId);
      stats.ingested++;
      ingestedIds.add(key);
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
  if (ingestedIds.has(`codebase:${file.path}`)) return;

  try {
    await claimKitAdapter.ingest(`File: ${file.path}\n\n${file.content}`, {
      path: file.path,
      title: file.path,
      source: "codebase",
      language: file.language,
      trustTier: "curated",
    });
    ingestedIds.add(`codebase:${file.path}`);
  } catch (err) {
    console.warn(`[ClaimKit Ingestion] Failed to ingest file ${file.path}:`, err);
  }
}


export async function ingestSingleGraphNode(node: KGNode): Promise<void> {
  if (!claimKitAdapter.isAvailable()) return;
  if (ingestedIds.has(`graph-node:${node.id}`)) return;

  try {
    const text = `Entity: ${node.title} (${node.type})\n${node.content}\nContext: ${node.context ?? "N/A"}\nStatus: ${node.status}`;
    await claimKitAdapter.ingest(text, {
      entityId: node.id,
      entityType: node.type,
      source: "graph",
      trustTier: "curated",
    });
    ingestedIds.add(`graph-node:${node.id}`);
  } catch (err) {
    console.warn(`[ClaimKit Ingestion] Failed to ingest node ${node.id}:`, err);
  }
}

export async function ingestSingleGraphEdge(edge: KGEdge): Promise<void> {
  if (!claimKitAdapter.isAvailable()) return;
  if (ingestedIds.has(`graph-edge:${edge.id}`)) return;

  try {
    const text = `Relationship: ${edge.sourceId} --[${edge.type}]--> ${edge.targetId}\n${edge.description ?? ""}`;
    await claimKitAdapter.ingest(text, {
      relationshipId: edge.id,
      relationshipType: edge.type,
      source: "graph",
      trustTier: "curated",
    });
    ingestedIds.add(`graph-edge:${edge.id}`);
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

  const documents: KnowledgeEntry[] = knowledgeStore.getAllEntries();
  stats.total = documents.length;

  for (const doc of documents) {
    try {
      const key = `knowledge:${doc.id}`;
      if (ingestedIds.has(key)) {
        stats.skipped++;
        continue;
      }
      const text = `${doc.title}\n\n${doc.content}`;
      const { sourceId } = await claimKitAdapter.ingest(text, {
        docId: doc.id,
        title: doc.title,
        source: "knowledge",
        trustTier: "curated",
        tags: doc.tags ?? [],
      });
      stats.sourceIds.push(sourceId);
      stats.ingested++;
      ingestedIds.add(key);
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

  for (const node of nodes) {
    try {
      const key = `graph-node:${node.id}`;
      if (ingestedIds.has(key)) {
        stats.skipped++;
        continue;
      }
      const text = `Entity: ${node.title} (${node.type})\n${node.content}\nContext: ${node.context ?? "N/A"}\nStatus: ${node.status}`;
      const { sourceId } = await claimKitAdapter.ingest(text, {
        entityId: node.id,
        entityType: node.type,
        source: "graph",
        trustTier: "curated",
      });
      stats.sourceIds.push(sourceId);
      stats.ingested++;
      ingestedIds.add(key);
    } catch (err) {
      console.warn(`[ClaimKit Ingestion] Failed to ingest node ${node.id}:`, err);
      stats.errors++;
    }
  }

  for (const edge of edges) {
    try {
      const key = `graph-edge:${edge.id}`;
      if (ingestedIds.has(key)) {
        stats.skipped++;
        continue;
      }
      const text = `Relationship: ${edge.sourceId} --[${edge.type}]--> ${edge.targetId}\n${edge.description ?? ""}`;
      const { sourceId } = await claimKitAdapter.ingest(text, {
        relationshipId: edge.id,
        relationshipType: edge.type,
        source: "graph",
        trustTier: "curated",
      });
      stats.sourceIds.push(sourceId);
      stats.ingested++;
      ingestedIds.add(key);
    } catch (err) {
      console.warn(`[ClaimKit Ingestion] Failed to ingest edge ${edge.id}:`, err);
      stats.errors++;
    }
  }

  stats.durationMs = Date.now() - start;
  console.log(`[ClaimKit Ingestion] Graph: ${stats.ingested}/${stats.total} ingested (${stats.errors} errors) in ${stats.durationMs}ms`);
  return stats;
}
