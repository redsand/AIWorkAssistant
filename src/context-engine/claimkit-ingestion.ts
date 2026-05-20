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
      const text = `${doc.title}\n\n${doc.content}`;
      const { sourceId } = await claimKitAdapter.ingest(text, {
        docId: doc.id,
        title: doc.title,
        source: "knowledge",
        tags: doc.tags ?? [],
      });
      stats.sourceIds.push(sourceId);
      stats.ingested++;
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
      const text = `File: ${file.path}\n\n${file.content}`;
      const { sourceId } = await claimKitAdapter.ingest(text, {
        path: file.path,
        source: "codebase",
        language: file.language,
      });
      stats.sourceIds.push(sourceId);
      stats.ingested++;
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
      const text = `Entity: ${node.title} (${node.type})\n${node.content}\nContext: ${node.context ?? "N/A"}\nStatus: ${node.status}`;
      const { sourceId } = await claimKitAdapter.ingest(text, {
        entityId: node.id,
        entityType: node.type,
        source: "graph",
      });
      stats.sourceIds.push(sourceId);
      stats.ingested++;
    } catch (err) {
      console.warn(`[ClaimKit Ingestion] Failed to ingest node ${node.id}:`, err);
      stats.errors++;
    }
  }

  for (const edge of edges) {
    try {
      const text = `Relationship: ${edge.sourceId} --[${edge.type}]--> ${edge.targetId}\n${edge.description ?? ""}`;
      const { sourceId } = await claimKitAdapter.ingest(text, {
        relationshipId: edge.id,
        relationshipType: edge.type,
        source: "graph",
      });
      stats.sourceIds.push(sourceId);
      stats.ingested++;
    } catch (err) {
      console.warn(`[ClaimKit Ingestion] Failed to ingest edge ${edge.id}:`, err);
      stats.errors++;
    }
  }

  stats.durationMs = Date.now() - start;
  console.log(`[ClaimKit Ingestion] Graph: ${stats.ingested}/${stats.total} ingested (${stats.errors} errors) in ${stats.durationMs}ms`);
  return stats;
}
