import {
  ClaimKit,
  createMemoryStores,
  MemoryLLMAdapter,
} from "@redsand/claimkit";
import type {
  LLMAdapter,
  QueryOptions,
  Json,
  SourceInput,
  AnswerabilityStatus,
  Stores,
} from "@redsand/claimkit";
import {
  createRedisClient,
  connectRedis,
  createRedisStores,
  closeRedis,
} from "@redsand/claimkit/redis";
import { env } from "../../config/env";
import { ClaimKitEmbeddingAdapter } from "./claimkit-embedding";
import { AIProviderLLMAdapter } from "./claimkit-llm-adapter";

export type { AnswerabilityStatus };

export interface ClaimKitQueryResult {
  answer: string;
  citations: Array<{ claimId: string; sourceId: string; text: string }>;
  confidence: number;
  contradictions: Array<{ claimA: string; claimB: string; reason: string }>;
  missingEvidence: string[];
  answerability: AnswerabilityStatus;
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
  private redisClient: ReturnType<typeof createRedisClient> | null = null;

  async initialize(): Promise<boolean> {
    if (this.initialized) return true;
    if (!env.CLAIMKIT_ENABLED) {
      this.initError = "ClaimKit is disabled (CLAIMKIT_ENABLED=false)";
      return false;
    }
    try {
      const llm: LLMAdapter =
        env.CLAIMKIT_LLM_PROVIDER === "memory"
          ? new MemoryLLMAdapter()
          : new AIProviderLLMAdapter(undefined, env.CLAIMKIT_LLM_MODEL || undefined);
      const embeddings = new ClaimKitEmbeddingAdapter();

      let stores: Stores;
      const redisUrl = env.CLAIMKIT_REDIS_URL;

      if (redisUrl) {
        try {
          const client = createRedisClient({ url: redisUrl });
          await connectRedis(client);
          this.redisClient = client;
          const prefix = env.CLAIMKIT_REDIS_PREFIX || "aiworkassistant";
          const dim = embeddings.dimensions;
          stores = createRedisStores({
            client,
            prefix,
            vectorMode: "bruteForce",
            vectorOptions: { vectorDim: dim },
          });
          console.log(
            `[ClaimKit] Stores: redis (prefix: ${prefix}, dim: ${dim})`,
          );
        } catch (redisErr) {
          console.warn(
            `[ClaimKit] Redis connection failed, falling back to memory stores: ${
              redisErr instanceof Error ? redisErr.message : String(redisErr)
            }`,
          );
          stores = createMemoryStores();
          console.log(`[ClaimKit] Stores: memory`);
        }
      } else {
        stores = createMemoryStores();
        console.log(`[ClaimKit] Stores: memory`);
      }

      this.claimKit = new ClaimKit({
        llm,
        embeddings,
        stores,
        defaults: {
          retrieval: {
            topK: env.CLAIMKIT_TOP_K,
            minScore: env.CLAIMKIT_MIN_SCORE,
            maxEvidenceItems: env.CLAIMKIT_MAX_EVIDENCE_ITEMS,
          },
        },
      });
      this.initialized = true;
      console.log(
        `[ClaimKit] Initialized — embeddings: ${embeddings.model.provider}/${embeddings.model.model} (${embeddings.dimensions}d)`,
      );
      return true;
    } catch (err) {
      this.initError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.redisClient) {
      await closeRedis(this.redisClient);
      this.redisClient = null;
    }
  }

  isAvailable(): boolean { return this.initialized && this.claimKit !== null; }
  getInitError(): string | null { return this.initError; }

  async ingest(text: string, metadata?: Record<string, unknown>): Promise<{ sourceId: string }> {
    if (!this.claimKit) throw new Error("ClaimKit not initialized");
    const title = (metadata?.title as string | undefined)
      ?? (metadata?.path as string | undefined)
      ?? (metadata?.docId as string | undefined)
      ?? (metadata?.entityId as string | undefined)
      ?? "source";
    const input: SourceInput = {
      title,
      content: text,
      metadata: metadata as Record<string, Json>,
    };
    const result = await this.claimKit.ingest(input);
    return { sourceId: result.ingest.source.id };
  }

  async query(question: string, options?: QueryOptions): Promise<ClaimKitQueryResult> {
    if (!this.claimKit) throw new Error("ClaimKit not initialized");
    const result = await this.claimKit.query(question, options);
    return {
      answer: result.answer,
      citations: result.citations.map((c) => ({
        claimId: c.claimId,
        sourceId: c.sourceId,
        text: c.evidenceText,
      })),
      confidence: result.confidence,
      contradictions: result.contradictions.map((c) => ({
        claimA: c.claimText1,
        claimB: c.claimText2,
        reason: c.explanation,
      })),
      missingEvidence: [...result.missingEvidence],
      answerability: result.packet?.answerability?.status ?? "answerable",
      metadata: {
        sourceIds: [...result.metadata.sourceIds],
        claimCount: result.metadata.claimCount,
        processingTimeMs: result.metadata.processingTimeMs,
        retrievalScore: result.metadata.retrievalScore,
      },
    };
  }
}

export const claimKitAdapter = new ClaimKitAdapter();
