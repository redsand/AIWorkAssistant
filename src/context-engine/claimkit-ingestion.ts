import { claimKitAdapter } from "./adapters/claimkit-adapter";
import { knowledgeStore } from "../agent/knowledge-store";
import type { KnowledgeEntry } from "../agent/knowledge-store";

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
