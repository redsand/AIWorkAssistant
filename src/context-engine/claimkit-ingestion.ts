import { claimKitAdapter } from "./adapters/claimkit-adapter";
import { knowledgeStore } from "../agent/knowledge-store";
import type { KnowledgeEntry } from "../agent/knowledge-store";
import { codebaseIndexer } from "../agent/codebase-indexer";
import type { IndexedFile } from "../agent/codebase-indexer";
import { knowledgeGraph } from "../agent/knowledge-graph";
import type { KGNode, KGEdge } from "../agent/knowledge-graph";

export interface IngestionStats {
  total: number;
  ingested: number;
  skipped: number;
  errors: number;
  sourceIds: string[];
  durationMs: number;
}

const ingestedIds = new Set<string>();

export async function ingestSingleKnowledgeEntry(entry: KnowledgeEntry): Promise<void> {
  if (!claimKitAdapter.isAvailable()) return;
  if (ingestedIds.has(`knowledge:${entry.id}`)) return;

  try {
    const text = `${entry.title}\n\n${entry.content}`;
    await claimKitAdapter.ingest(text, {
      docId: entry.id,
      title: entry.title,
      source: "knowledge",
      tags: entry.tags ?? [],
    });
    ingestedIds.add(`knowledge:${entry.id}`);
  } catch (err) {
    console.warn(`[ClaimKit Ingestion] Failed to ingest doc ${entry.id}:`, err);
  }
}

export async function ingestSingleCodebaseFile(file: IndexedFile): Promise<void> {
  if (!claimKitAdapter.isAvailable()) return;
  if (ingestedIds.has(`codebase:${file.path}`)) return;

  try {
    const text = `File: ${file.path}\n\n${file.content}`;
    await claimKitAdapter.ingest(text, {
      path: file.path,
      source: "codebase",
      language: file.language,
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
      const text = `File: ${file.path}\n\n${file.content}`;
      const { sourceId } = await claimKitAdapter.ingest(text, {
        path: file.path,
        source: "codebase",
        language: file.language,
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
