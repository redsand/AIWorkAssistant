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
  GroundInput,
  GroundResult,
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
import { embeddingService } from "../../agent/embedding-service";
import { OllamaProvider } from "../../agent/providers/ollama-provider";
import { getEffectiveContextLimit } from "../../agent/providers/factory";

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
  private lastInitAttempt = 0;
  private static readonly INIT_RETRY_INTERVAL_MS = 60_000;
  private initPromise: Promise<boolean> | null = null;

  async initialize(): Promise<boolean> {
    if (this.initialized) return true;
    if (!env.CLAIMKIT_ENABLED) {
      this.initError = "ClaimKit is disabled (CLAIMKIT_ENABLED=false)";
      return false;
    }
    // Don't retry a failed init more than once per minute.
    if (this.initError && Date.now() - this.lastInitAttempt < ClaimKitAdapter.INIT_RETRY_INTERVAL_MS) {
      return false;
    }
    // If an init is already in flight (e.g. startup + first chat request
    // racing), wait on it instead of running a second concurrent probe.
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInitialize().finally(() => { this.initPromise = null; });
    return this.initPromise;
  }

  private async _doInitialize(): Promise<boolean> {
    if (!env.CLAIMKIT_ENABLED) return false;
    this.lastInitAttempt = Date.now();
    this.initError = null;
    try {
      // Settle the embedding provider BEFORE creating stores so the
      // vector dimension matches what will actually be used at query time.
      const embeddingReady = await embeddingService.isAvailable();
      if (!embeddingReady) {
        this.initError = "Embedding service unavailable — no providers responded";
        return false;
      }
      const probeResult = await embeddingService.embed("probe");
      if (!probeResult) {
        this.initError = "Embedding probe failed after provider settled";
        return false;
      }
      const actualDimensions = probeResult.embedding.length;
      const settledProvider = embeddingService.getProviderInfo();

      let llm: LLMAdapter;
      if (env.CLAIMKIT_LLM_PROVIDER === "memory") {
        llm = new MemoryLLMAdapter();
      } else if (env.CLAIMKIT_LLM_PROVIDER === "ollama") {
        const dedicatedProvider = new OllamaProvider({
          apiKey: env.CLAIMKIT_OLLAMA_API_KEY,
          baseUrl: env.CLAIMKIT_OLLAMA_API_URL,
          model: env.CLAIMKIT_OLLAMA_MODEL,
          temperature: env.OLLAMA_TEMPERATURE,
          topP: 0.9,
          maxRetries: 2,
          timeout: 300000,
          maxContextTokens: getEffectiveContextLimit(
            env.CLAIMKIT_OLLAMA_MODEL,
            env.OLLAMA_MAX_CONTEXT_TOKENS,
          ),
        });
        llm = new AIProviderLLMAdapter(
          dedicatedProvider,
          env.CLAIMKIT_OLLAMA_MODEL,
        );
      } else {
        llm = new AIProviderLLMAdapter(
          undefined,
          env.CLAIMKIT_LLM_MODEL || undefined,
        );
      }
      const embeddings = new ClaimKitEmbeddingAdapter(actualDimensions);

      let stores: Stores;
      const redisUrl = env.CLAIMKIT_REDIS_URL;

      if (redisUrl) {
        try {
          const client = createRedisClient({ url: redisUrl });
          await connectRedis(client);
          this.redisClient = client;
          const basePrefix = env.CLAIMKIT_REDIS_PREFIX || "aiworkassistant";
          const modelSlug = settledProvider.model
            .replace(/[^a-zA-Z0-9_.-]/g, "-")
            .toLowerCase();
          const prefix = `${basePrefix}:${modelSlug}`;
          const dim = embeddings.dimensions;

          // Detect and auto-repair vector dimension mismatch from a previous
          // embedding model. If stored dim differs, flush stale keys so the
          // new model starts with a clean namespace.
          const metaKey = `${prefix}:meta:vector-dim`;
          const rc = client as unknown as {
            get(k: string): Promise<string | null>;
            set(k: string, v: string): Promise<unknown>;
            keys(pattern: string): Promise<string[]>;
            del(keys: string[]): Promise<number>;
          };
          const storedDim = await rc.get(metaKey);
          if (storedDim !== null && parseInt(storedDim, 10) !== dim) {
            console.warn(
              `[ClaimKit] Dimension changed (${storedDim}d → ${dim}d) — flushing stale Redis keys for "${prefix}"...`,
            );
            const staleKeys = await rc.keys(`${prefix}:*`);
            if (staleKeys.length > 0) await rc.del(staleKeys);
            console.log(`[ClaimKit] Flushed ${staleKeys.length} stale key(s)`);
          }
          await rc.set(metaKey, String(dim));

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
            usePlannerLLM: !env.CLAIMKIT_DISABLE_PLANNER_LLM,
          },
          verification: {
            skipLLM: env.CLAIMKIT_DISABLE_VERIFIER_LLM,
          },
          contradiction: {
            useLLM: !env.CLAIMKIT_DISABLE_CONTRADICTION_LLM,
          },
        },
      });
      this.initialized = true;
      console.log(
        `[ClaimKit] Initialized — embeddings: ${settledProvider.provider}/${settledProvider.model} (${actualDimensions}d)`,
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
    const trustTier = metadata?.trustTier as string | undefined;
    const { trustTier: _drop, ...restMeta } = metadata ?? {};
    const input: SourceInput = {
      title,
      content: text,
      ...(trustTier ? { trustTier: trustTier as Parameters<typeof this.claimKit.ingest>[0]["trustTier"] } : {}),
      metadata: restMeta as Record<string, Json>,
    };
    const result = await this.claimKit.ingest(input);
    return { sourceId: result.ingest.source.id };
  }

  async query(question: string, options?: QueryOptions): Promise<ClaimKitQueryResult> {
    if (!this.claimKit) throw new Error("ClaimKit not initialized");
    const t0 = Date.now();
    const result = await this.claimKit.query(question, options);
    const total = Date.now() - t0;
    const ckMs = result.metadata.processingTimeMs;
    console.log(`[ClaimKit:timing] total=${total}ms internal=${ckMs}ms claims=${result.metadata.claimCount} sources=${result.metadata.sourceIds.length}`);
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

  async ground(input: GroundInput): Promise<GroundResult> {
    if (!this.claimKit) throw new Error("ClaimKit not initialized");
    return this.claimKit.ground(input);
  }
}

export const claimKitAdapter = new ClaimKitAdapter();
