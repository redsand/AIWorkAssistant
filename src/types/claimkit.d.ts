declare module "claimkit" {
  export interface AnswerResult {
    answer: string;
    citations: Array<{ claimId: string; sourceId: string; text: string }>;
    confidence: number;
    contradictions: Array<{ claimA: string; claimB: string; reason: string }>;
    missingEvidence: string[];
    verification?: { answerability: "answerable" | "partially_answerable" | "not_answerable" };
    metadata: {
      sourceIds: string[];
      claimCount: number;
      processingTimeMs: number;
      retrievalScore: number;
    };
  }

  export interface QueryOptions {
    sourceFilter?: { sourceIds?: string[] };
    maxClaims?: number;
    minConfidence?: number;
  }

  export interface ClaimKitConfig {
    retrieval?: { topK?: number; minScore?: number };
    compilation?: { maxEvidenceItems?: number };
  }

  export interface ClaimKitAdapters {
    llm: unknown;
    embeddings: unknown;
    stores: unknown;
  }

  export class MemoryLLMAdapter {}
  export class MemoryEmbeddingAdapter {}

  export function createMemoryStores(): unknown;

  export class ClaimKit {
    constructor(adapters: ClaimKitAdapters, config?: ClaimKitConfig);
    ingest(input: { text: string; metadata?: Record<string, unknown> }): Promise<{ source: { id: string } }>;
    query(question: string, options?: QueryOptions): Promise<AnswerResult>;
  }
}
