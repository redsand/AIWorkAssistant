import { ClaimKit, createMemoryStores } from "claimkit";
import type { QueryOptions } from "claimkit";
import { MemoryLLMAdapter } from "claimkit";
import { MemoryEmbeddingAdapter } from "claimkit";
import { env } from "../../config/env";

export interface ClaimKitQueryResult {
  answer: string;
  citations: Array<{ claimId: string; sourceId: string; text: string }>;
  confidence: number;
  contradictions: Array<{ claimA: string; claimB: string; reason: string }>;
  missingEvidence: string[];
  answerability: "answerable" | "partially_answerable" | "not_answerable";
  metadata: {
    sourceIds: string[];
    claimCount: number;
    processingTimeMs: number;
    retrievalScore: number;
  };
}

export class ClaimKitAdapter {
  private claimKit: ClaimKit | null = null;
  private initialized = false;
  private initError: string | null = null;

  async initialize(): Promise<boolean> {
    if (this.initialized) return true;
    if (!env.CLAIMKIT_ENABLED) {
      this.initError = "ClaimKit is disabled (CLAIMKIT_ENABLED=false)";
      return false;
    }
    try {
      const llm = new MemoryLLMAdapter();
      const embeddings = new MemoryEmbeddingAdapter();
      const stores = createMemoryStores();
      this.claimKit = new ClaimKit({ llm, embeddings, stores }, {
        retrieval: { topK: env.CLAIMKIT_TOP_K, minScore: env.CLAIMKIT_MIN_SCORE },
        compilation: { maxEvidenceItems: env.CLAIMKIT_MAX_EVIDENCE_ITEMS },
      });
      this.initialized = true;
      return true;
    } catch (err) {
      this.initError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  isAvailable(): boolean { return this.initialized && this.claimKit !== null; }
  getInitError(): string | null { return this.initError; }

  async ingest(text: string, metadata?: Record<string, unknown>): Promise<{ sourceId: string }> {
    if (!this.claimKit) throw new Error("ClaimKit not initialized");
    const result = await this.claimKit.ingest({ text, metadata });
    return { sourceId: result.source.id };
  }

  async query(question: string, options?: QueryOptions): Promise<ClaimKitQueryResult> {
    if (!this.claimKit) throw new Error("ClaimKit not initialized");
    const result = await this.claimKit.query(question, options);
    return {
      answer: result.answer,
      citations: result.citations,
      confidence: result.confidence,
      contradictions: result.contradictions,
      missingEvidence: result.missingEvidence,
      answerability: result.verification?.answerability ?? "answerable",
      metadata: {
        sourceIds: result.metadata.sourceIds,
        claimCount: result.metadata.claimCount,
        processingTimeMs: result.metadata.processingTimeMs,
        retrievalScore: result.metadata.retrievalScore,
      },
    };
  }
}

export const claimKitAdapter = new ClaimKitAdapter();
