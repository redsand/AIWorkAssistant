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
import { embeddingService } from "../../agent/embedding-service";
import { OllamaProvider } from "../../agent/providers/ollama-provider";
import { getEffectiveContextLimit } from "../../agent/providers/factory";
import { knowledgeGraph } from "../../agent/knowledge-graph";
import type { KGEdgeType, KGNode } from "../../agent/knowledge-graph";

export type { AnswerabilityStatus };

export interface VerificationResult {
  verified: boolean;
  confidence: number;
  trustTier: "curated" | "observed" | "inferred";
  evidence?: string;
  source?: string;
}

export interface GroundInput {
  text: string;
  evidence: Array<{ title: string; content: string }>;
  preExtractedClaims?: Array<{ text?: string; claimText?: string; subject?: string; predicate?: string; object?: string }>;
  skipLLMVerification?: boolean;
}

export interface GroundResult {
  grounded: boolean;
  hallucinationRate: number;
  supportedAssertionCount: number;
  unsupportedAssertionCount: number;
  unsupportedPhrases: string[];
  sentenceResults: Array<{ text: string; supported: boolean }>;
}

const MIN_SUPPORT_TOKEN_OVERLAP = 0.6;
const MIN_ASSERTION_TOKENS = 3;

function splitAssertions(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function assertionTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function isAssertionSupported(assertion: string, evidenceText: string): boolean {
  const lowered = evidenceText.toLowerCase();
  const tokens = assertionTokens(assertion);
  if (tokens.length < MIN_ASSERTION_TOKENS) {
    return lowered.includes(assertion.toLowerCase());
  }
  const uniqueTokens = [...new Set(tokens)];
  const matched = uniqueTokens.filter((token) => lowered.includes(token)).length;
  return matched / uniqueTokens.length >= MIN_SUPPORT_TOKEN_OVERLAP;
}

// ClaimKit's ConfidenceTrace is an internal telemetry object (claimCount,
// avgClaimConfidence, penalties, stageTimings, etc.). We don't need to mirror
// its evolving shape here; callers persist it as opaque JSON, so treat it as
// unknown to stay compatible with whatever claimkit returns.
export type ConfidenceTrace = unknown;

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
  confidenceTrace?: ConfidenceTrace;
}

/**
 * Build a human-readable digest of "what ClaimKit actually cited" from
 * a retrieve-lite result. The full generator pass would normally write
 * a prose answer with inline citations; without it we synthesize a
 * structured evidence list so the comparison dashboard still has
 * something to show in the ck_answer column.
 *
 * Format:
 *   [retrieve-lite] {answerability}, confidence {N%}, {K} claims, {S} sources
 *   Cited evidence:
 *     • claim_id: "first 220 chars of evidence span..."
 *     • ...
 */
function buildLiteCitationDigest(
  citations: Array<{ claimId: string; sourceId: string; text: string }>,
  result: { confidence: number; answerability: string; metadata: { claimCount: number; sourceIds: readonly string[] } },
): string {
  const conf = `${(result.confidence * 100).toFixed(0)}%`;
  const header = `[retrieve-lite] ${result.answerability}, confidence ${conf}, ${result.metadata.claimCount} claims, ${result.metadata.sourceIds.length} sources.`;
  if (citations.length === 0) {
    return `${header}\nCited evidence: (none — retrieval returned no claims for this query).`;
  }
  const lines = [header, "Cited evidence:"];
  for (const c of citations.slice(0, 10)) {
    const snippet = (c.text || "").replace(/\s+/g, " ").trim().slice(0, 220);
    const tail = c.text && c.text.length > 220 ? "…" : "";
    lines.push(`  • ${c.claimId}: "${snippet}${tail}"`);
  }
  if (citations.length > 10) {
    lines.push(`  • (+${citations.length - 10} more)`);
  }
  return lines.join("\n");
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
      console.log(`[ClaimKit] Probing embedding provider (${env.EMBEDDING_PROVIDER || "auto"} / ${env.EMBEDDING_MODEL || "default"})…`);
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
      console.log(`[ClaimKit] Embedding provider ready: ${settledProvider.provider}/${settledProvider.model} (${actualDimensions}d)`);

      console.log(`[ClaimKit] Creating LLM adapter: ${env.CLAIMKIT_LLM_PROVIDER}`);
      let llm: LLMAdapter;
      if (env.CLAIMKIT_LLM_PROVIDER === "memory") {
        llm = new MemoryLLMAdapter();
      } else if (env.CLAIMKIT_LLM_PROVIDER === "ollama") {
        // Fall back to the user's main OLLAMA_MODEL when no ClaimKit-specific
        // override is set, so users don't have to set two env vars to keep
        // their preferred model. Previously this defaulted to "llama3" and
        // hard-failed for any user not running llama3.
        const ckModel = env.CLAIMKIT_OLLAMA_MODEL || env.OLLAMA_MODEL;
        const dedicatedProvider = new OllamaProvider({
          apiKey: env.CLAIMKIT_OLLAMA_API_KEY,
          baseUrl: env.CLAIMKIT_OLLAMA_API_URL,
          model: ckModel,
          temperature: env.OLLAMA_TEMPERATURE,
          topP: 0.9,
          maxRetries: 2,
          timeout: 300000,
          maxContextTokens: getEffectiveContextLimit(
            ckModel,
            env.OLLAMA_MAX_CONTEXT_TOKENS,
          ),
        });
        llm = new AIProviderLLMAdapter(dedicatedProvider, ckModel);
      } else {
        llm = new AIProviderLLMAdapter(
          undefined,
          env.CLAIMKIT_LLM_MODEL || undefined,
        );
      }
      const embeddings = new ClaimKitEmbeddingAdapter(actualDimensions);

      let stores: Stores;
      console.log(`[ClaimKit] Connecting stores (redis=${Boolean(env.CLAIMKIT_REDIS_URL)})…`);
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
          // new model starts with a clean namespace. The flush runs in the
          // background using SCAN + UNLINK to avoid blocking Redis.
          const metaKey = `${prefix}:meta:vector-dim`;
          const rc = client as unknown as {
            get(k: string): Promise<string | null>;
            set(k: string, v: string): Promise<unknown>;
            scan(cursor: number, options: { MATCH: string; COUNT: number }): Promise<{ cursor: number; keys: string[] }>;
            unlink(keys: string[]): Promise<number>;
          };
          const storedDim = await rc.get(metaKey);
          if (
            env.CLAIMKIT_REPAIR_ON_DIMENSION_MISMATCH &&
            storedDim !== null &&
            parseInt(storedDim, 10) !== dim
          ) {
            console.warn(
              `[ClaimKit] Dimension changed (${storedDim}d → ${dim}d) — flushing stale Redis keys for "${prefix}" in the background...`,
            );
            this.repairStaleKeys(rc, metaKey, prefix, dim).catch((err) => {
              console.error(
                `[ClaimKit] Background Redis repair failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
          } else {
            await rc.set(metaKey, String(dim));
          }

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
      } as ConstructorParameters<typeof ClaimKit>[0]);
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

  private async repairStaleKeys(
    rc: {
      get(k: string): Promise<string | null>;
      set(k: string, v: string): Promise<unknown>;
      scan(cursor: number, options: { MATCH: string; COUNT: number }): Promise<{ cursor: number; keys: string[] }>;
      unlink(keys: string[]): Promise<number>;
    },
    metaKey: string,
    prefix: string,
    dim: number,
  ): Promise<void> {
    let cursor = 0;
    let total = 0;
    const pattern = `${prefix}:*`;
    do {
      const reply = await rc.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = reply.cursor;
      if (reply.keys.length > 0) {
        await rc.unlink(reply.keys);
        total += reply.keys.length;
      }
    } while (cursor !== 0);

    await rc.set(metaKey, String(dim));
    console.log(`[ClaimKit] Flushed ${total} stale key(s) for "${prefix}"`);
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
    const input = this.buildIngestInput(text, metadata);
    const result = await this.claimKit.ingest(input);
    return { sourceId: result.ingest.source.id };
  }

  /**
   * Ingest many documents serially. The SDK's `ingestMany` is just
   * `Promise.all(inputs.map(this.ingest))` — every input fires an
   * extraction LLM call at the same time, all tagged "claimkit". With
   * `CLAIMKIT_QUERY_SEED_LIMIT=3` that's 3 concurrent slots burned per
   * query just for ingestion, starving the foreground planner +
   * contradiction LLMs of bucket capacity for the next chat turn.
   *
   * Serializing per-doc keeps the total LLM count identical while
   * holding only 1 claimkit slot at a time. Wall-clock for ingestion
   * goes up by ~N×, but seeding is fire-and-forget under
   * `CLAIMKIT_AWAIT_SEED=false` so the user doesn't notice — what they
   * DO notice is the foreground turn completing faster because the
   * planner LLM isn't waiting in queue. Trade is unambiguously good
   * for any chat-driven seed flow.
   *
   * Returns sourceIds aligned to the input order; failed inputs surface as
   * { sourceId: null, error } so the caller can drop them from any dedupe
   * write without losing the success set.
   */
  async ingestMany(
    items: Array<{ text: string; metadata?: Record<string, unknown> }>,
    options?: { signal?: AbortSignal },
  ): Promise<Array<{ sourceId: string | null; error?: string }>> {
    if (!this.claimKit) throw new Error("ClaimKit not initialized");
    if (items.length === 0) return [];
    const signal = options?.signal;
    if (signal?.aborted) {
      // Already aborted before we started — short-circuit so the caller
      // doesn't burn slots on work it doesn't want anymore.
      return items.map(() => ({ sourceId: null, error: "Aborted before ingest started" }));
    }
    // Race the serial ingestion against the abort signal. The serial
    // loop processes one doc at a time so abort can take effect cleanly
    // between docs without leaving multiple ingestions running in the
    // background. Any single-doc ingest already in flight when the
    // signal fires keeps running and releases its slot via the normal
    // limiter path (2-min reaper as defense-in-depth).
    const ingestPromise: Promise<Array<{ sourceId: string | null; error?: string }>> = (async () => {
      const out: Array<{ sourceId: string | null; error?: string }> = [];
      for (const item of items) {
        if (signal?.aborted) {
          out.push({ sourceId: null, error: "Aborted mid-ingestion" });
          continue;
        }
        try {
          const r = await this.ingest(item.text, item.metadata);
          out.push({ sourceId: r.sourceId });
        } catch (perDocErr) {
          out.push({
            sourceId: null,
            error: perDocErr instanceof Error ? perDocErr.message : String(perDocErr),
          });
        }
      }
      return out;
    })();

    if (!signal) return ingestPromise;

    return new Promise((resolve) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        console.warn(`[ClaimKit] ingestMany abandoned by caller — ${items.length} in-flight ingestions detached.`);
        resolve(items.map(() => ({ sourceId: null, error: "Aborted by caller" })));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      ingestPromise.then((value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      });
    });
  }

  private buildIngestInput(text: string, metadata?: Record<string, unknown>): SourceInput {
    const title = (metadata?.title as string | undefined)
      ?? (metadata?.path as string | undefined)
      ?? (metadata?.docId as string | undefined)
      ?? (metadata?.entityId as string | undefined)
      ?? "source";
    const trustTier = metadata?.trustTier as string | undefined;
    const { trustTier: _drop, ...restMeta } = metadata ?? {};
    return {
      title,
      content: text,
      ...(trustTier ? { trustTier: trustTier as Parameters<NonNullable<typeof this.claimKit>["ingest"]>[0]["trustTier"] } : {}),
      metadata: restMeta as Record<string, Json>,
    };
  }

  async query(question: string, options?: QueryOptions & { signal?: AbortSignal }): Promise<ClaimKitQueryResult> {
    if (!this.claimKit) throw new Error("ClaimKit not initialized");
    const t0 = Date.now();
    const result = await this.claimKit.query(question, options);
    const graphVerifications = await this.collectRelationshipVerifications(question);
    const verifiedGraph = graphVerifications.filter(
      (verification): verification is VerificationResult & { evidence: string } =>
        verification.verified && typeof verification.evidence === "string",
    );
    const total = Date.now() - t0;
    const ckMs = result.metadata.processingTimeMs;
    console.log(`[ClaimKit:timing] total=${total}ms internal=${ckMs}ms claims=${result.metadata.claimCount} sources=${result.metadata.sourceIds.length}`);
    return {
      answer: result.answer,
      citations: [
        ...result.citations.map((c) => ({
          claimId: c.claimId,
          sourceId: c.sourceId,
          text: c.evidenceText,
        })),
        ...verifiedGraph.map((verification, index) => ({
          claimId: `knowledge-graph:${index + 1}`,
          sourceId: "knowledge-graph",
          text: verification.evidence,
        })),
      ],
      confidence: verifiedGraph.length > 0
        ? this.blendConfidence(result.confidence, verifiedGraph)
        : result.confidence,
      contradictions: result.contradictions.map((c) => ({
        claimA: c.claimText1,
        claimB: c.claimText2,
        reason: c.explanation,
      })),
      missingEvidence: [...result.missingEvidence],
      answerability: result.packet?.answerability?.status ?? "not_answerable",
      metadata: {
        sourceIds: verifiedGraph.length > 0
          ? [...new Set([...result.metadata.sourceIds, "knowledge-graph"])]
          : [...result.metadata.sourceIds],
        claimCount: result.metadata.claimCount + verifiedGraph.length,
        processingTimeMs: result.metadata.processingTimeMs,
        retrievalScore: result.metadata.retrievalScore,
      },
      confidenceTrace: "confidenceTrace" in result ? result.confidenceTrace : undefined,
    };
  }

  /**
   * Retrieval-only query — runs plan + embed + retrieve + compile on
   * ClaimKit but skips the generate + verify LLM calls. Returns the same
   * shape as query() so the chat probe path can drop in without further
   * conversion, but populates `answer` and `citations` from the evidence
   * packet only (no LLM-generated answer text). The chat probe never
   * reads `answer`, so the saved 2 LLM round-trips per call are pure win.
   *
   * Typical cost drops from 3-30s (full query) to 0.5-3s (lite).
   */
  async queryLite(
    question: string,
    options?: QueryOptions & { signal?: AbortSignal },
  ): Promise<ClaimKitQueryResult> {
    if (!this.claimKit) throw new Error("ClaimKit not initialized");
    const t0 = Date.now();
    const result = await this.claimKit.retrieveLite(question, options);
    const graphVerifications = await this.collectRelationshipVerifications(question);
    const verifiedGraph = graphVerifications.filter(
      (verification): verification is VerificationResult & { evidence: string } =>
        verification.verified && typeof verification.evidence === "string",
    );
    const total = Date.now() - t0;
    const ckMs = result.metadata.processingTimeMs;
    console.log(`[ClaimKit:timing] total=${total}ms internal=${ckMs}ms claims=${result.metadata.claimCount} sources=${result.metadata.sourceIds.length} mode=lite`);
    const citations = [
      ...result.packet.claims.flatMap((c) =>
        (c.evidenceSpans ?? []).map((span) => ({
          claimId: String(c.claim.id),
          sourceId: String(c.sourceRef?.id ?? ""),
          text: span.spanText,
        })),
      ),
      ...verifiedGraph.map((verification, index) => ({
        claimId: `knowledge-graph:${index + 1}`,
        sourceId: "knowledge-graph",
        text: verification.evidence,
      })),
    ];
    // Synthesize a digest of what was cited so the dashboard's ck_answer
    // column stays populated even in lite mode. Without this the column
    // would go blank for every chat turn after the lite-probe switch
    // (commit 55885f8) and the operator loses visibility into "what data
    // did ClaimKit actually use?". The full LLM-generated answer text
    // remains absent — only an evidence-list summary stands in.
    const answer = buildLiteCitationDigest(citations, result);
    return {
      answer,
      citations,
      confidence: verifiedGraph.length > 0
        ? this.blendConfidence(result.confidence, verifiedGraph)
        : result.confidence,
      contradictions: result.contradictions.map((c) => ({
        claimA: c.claimText1,
        claimB: c.claimText2,
        reason: c.explanation,
      })),
      missingEvidence: [],
      answerability: result.answerability,
      metadata: {
        sourceIds: verifiedGraph.length > 0
          ? [...new Set([...result.metadata.sourceIds, "knowledge-graph"])]
          : [...result.metadata.sourceIds],
        claimCount: result.metadata.claimCount + verifiedGraph.length,
        processingTimeMs: result.metadata.processingTimeMs,
        retrievalScore: result.metadata.retrievalScore,
      },
    };
  }

  async verifyRelationship(
    source: string,
    target: string,
    edgeType?: string,
  ): Promise<VerificationResult> {
    const sourceNodes = knowledgeGraph.queryNodes({ search: source, limit: 5 });
    const targetNodes = knowledgeGraph.queryNodes({ search: target, limit: 5 });

    for (const sourceNode of sourceNodes) {
      for (const targetNode of targetNodes) {
        const edges = knowledgeGraph.getEdgesForNode(sourceNode.id, "outgoing");
        const match = edges.find(e =>
          e.targetId === targetNode.id &&
          (!edgeType || e.type === edgeType)
        );
        if (match) {
          return {
            verified: true,
            confidence: 0.85,
            trustTier: "curated",
            evidence: `Graph edge: ${sourceNode.title} -[${match.type}]-> ${targetNode.title}`,
            source: "knowledge-graph",
          };
        }
      }
    }
    return { verified: false, confidence: 0, trustTier: "inferred" };
  }

  async ground(input: GroundInput): Promise<GroundResult> {
    if (!this.claimKit) throw new Error("ClaimKit not initialized");
    const assertions = splitAssertions(input.text);
    if (assertions.length === 0) {
      return {
        grounded: true,
        hallucinationRate: 0,
        supportedAssertionCount: 0,
        unsupportedAssertionCount: 0,
        unsupportedPhrases: [],
        sentenceResults: [],
      };
    }

    const evidenceText = [
      ...input.evidence.map((item) => `${item.title}\n${item.content}`),
      ...(input.preExtractedClaims ?? []).map((claim) =>
        claim.text ??
        claim.claimText ??
        [claim.subject, claim.predicate, claim.object].filter(Boolean).join(" "),
      ),
    ].join("\n").toLowerCase();

    const sentenceResults = assertions.map((assertion) => ({
      text: assertion,
      supported: isAssertionSupported(assertion, evidenceText),
    }));
    const unsupportedPhrases = sentenceResults
      .filter((sentence) => !sentence.supported)
      .map((sentence) => sentence.text);
    const unsupportedAssertionCount = unsupportedPhrases.length;
    const supportedAssertionCount = assertions.length - unsupportedAssertionCount;
    return {
      grounded: unsupportedAssertionCount === 0,
      hallucinationRate: unsupportedAssertionCount / assertions.length,
      supportedAssertionCount,
      unsupportedAssertionCount,
      unsupportedPhrases,
      sentenceResults,
    };
  }

  private async collectRelationshipVerifications(question: string): Promise<VerificationResult[]> {
    if (!this.isRelationshipQuery(question)) return [];

    const direct = this.extractDirectRelationship(question);
    if (direct) {
      return [await this.verifyRelationship(direct.source, direct.target, direct.edgeType)];
    }

    const inbound = this.extractInboundRelationship(question);
    if (inbound) {
      return this.verifyInboundRelationships(inbound.target, inbound.edgeType);
    }

    return [];
  }

  private isRelationshipQuery(question: string): boolean {
    return /\b(depends?\s+on|blocks?|relates?\s+to|relationship\s+between)\b/i.test(question);
  }

  private extractDirectRelationship(question: string): { source: string; target: string; edgeType: KGEdgeType } | null {
    const patterns: Array<{ pattern: RegExp; edgeType: KGEdgeType }> = [
      { pattern: /^(?:does|do|did|can|will)?\s*(.+?)\s+depends?\s+on\s+(.+?)[?.!]?$/i, edgeType: "depends_on" },
      { pattern: /^(?:does|do|did|can|will)?\s*(.+?)\s+blocks?\s+(.+?)[?.!]?$/i, edgeType: "blocks" },
      { pattern: /^(?:how\s+does\s+)?(.+?)\s+relates?\s+to\s+(.+?)[?.!]?$/i, edgeType: "related_to" },
      { pattern: /^relationship\s+between\s+(.+?)\s+and\s+(.+?)[?.!]?$/i, edgeType: "related_to" },
    ];

    for (const { pattern, edgeType } of patterns) {
      const match = question.match(pattern);
      if (!match) continue;
      const source = this.cleanRelationshipTerm(match[1]);
      const target = this.cleanRelationshipTerm(match[2]);
      if (!source || !target || this.isQuestionWord(source)) continue;
      return { source, target, edgeType };
    }

    return null;
  }

  private extractInboundRelationship(question: string): { target: string; edgeType: KGEdgeType } | null {
    const patterns: Array<{ pattern: RegExp; edgeType: KGEdgeType }> = [
      { pattern: /^what\s+depends?\s+on\s+(.+?)[?.!]?$/i, edgeType: "depends_on" },
      { pattern: /^what\s+blocks?\s+(.+?)[?.!]?$/i, edgeType: "blocks" },
      { pattern: /^what\s+relates?\s+to\s+(.+?)[?.!]?$/i, edgeType: "related_to" },
    ];

    for (const { pattern, edgeType } of patterns) {
      const match = question.match(pattern);
      if (!match) continue;
      const target = this.cleanRelationshipTerm(match[1]);
      if (!target) continue;
      return { target, edgeType };
    }

    return null;
  }

  private verifyInboundRelationships(target: string, edgeType: KGEdgeType): VerificationResult[] {
    const targetNodes = knowledgeGraph.queryNodes({ search: target, limit: 5 });
    const results: VerificationResult[] = [];

    for (const targetNode of targetNodes) {
      const edges = knowledgeGraph
        .getEdgesForNode(targetNode.id, "incoming")
        .filter((edge) => edge.type === edgeType);

      for (const edge of edges) {
        const sourceNode = knowledgeGraph.getNode(edge.sourceId);
        if (!sourceNode) continue;
        results.push(this.relationshipResult(sourceNode, targetNode, edge.type));
      }
    }

    if (results.length === 0) {
      return [{ verified: false, confidence: 0, trustTier: "inferred" }];
    }

    return results;
  }

  private relationshipResult(sourceNode: KGNode, targetNode: KGNode, edgeType: KGEdgeType): VerificationResult {
    return {
      verified: true,
      confidence: 0.85,
      trustTier: "curated",
      evidence: `Graph edge: ${sourceNode.title} -[${edgeType}]-> ${targetNode.title}`,
      source: "knowledge-graph",
    };
  }

  private blendConfidence(ckConfidence: number, verifications: Array<VerificationResult & { evidence: string }>): number {
    const ckWeight = 0.7;
    const graphWeight = 0.3;
    const avgGraphConfidence = verifications.reduce((sum, v) => sum + v.confidence, 0) / verifications.length;
    return Math.min(1, ckWeight * ckConfidence + graphWeight * avgGraphConfidence);
  }

  private cleanRelationshipTerm(value: string): string {
    return value
      .trim()
      .replace(/^the\s+/i, "")
      .replace(/[?.!]+$/g, "")
      .trim();
  }

  private isQuestionWord(value: string): boolean {
    return ["what", "who", "which", "where", "when", "why", "how"].includes(value.toLowerCase());
  }
}

export const claimKitAdapter = new ClaimKitAdapter();
