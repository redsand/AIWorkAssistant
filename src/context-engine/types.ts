import type { ChatMessage } from "../agent/providers/types";
import type { KGEdgeType } from "../agent/knowledge-graph";

export type ContextMode = "rag" | "engine";

/**
 * Chunking strategy for code/knowledge ingestion.
 * - "structural": split on function/class/heading boundaries (token-aware).
 * - "fixed": legacy character/token sliding window with overlap.
 */
export type ChunkStrategy = "structural" | "fixed";

export interface ChunkOptions {
  strategy: ChunkStrategy;
  /** Upper bound on a chunk's size, measured in estimated tokens. */
  maxTokens: number;
  /** Below this size, structural chunks are merged with adjacent ones. */
  minTokens: number;
  /** Token overlap carried between adjacent fixed-strategy chunks. */
  overlapTokens: number;
  /** Optional source path, used to build the structural context header. */
  filePath?: string;
}

/**
 * A single chunk produced by the chunker. startLine/endLine are 1-based and
 * refer to lines in the original (unmodified) source. contextHeader is a
 * comment line describing the chunk's structural position (file → class →
 * method, or heading breadcrumb) and is empty when no structure was detected.
 */
export interface ContentChunk {
  content: string;
  startLine: number;
  endLine: number;
  contextHeader: string;
}

export interface BudgetSlotDefinition {
  name: string;
  priority: number;
  fraction: number;
  overflowTarget: string | null;
}

export interface BudgetSlot {
  name: string;
  priority: number;
  maxTokens: number;
  allocatedTokens: number;
  overflowTarget: string | null;
}

export interface AllocatedBudget {
  totalBudget: number;
  safetyMargin: number;
  slots: BudgetSlot[];
  remainingTokens: number;
}

export interface ScoredDocument {
  id: string;
  source: "knowledge" | "codebase" | "graph" | "memory" | "claimkit";
  content: string;
  title: string;
  score: number;
  baseScore: number;
  importanceScore: number;
  recencyScore: number;
  /**
   * Trust weight in [0, 1] derived from the doc's source + provenance.
   * Higher = more authoritative. Used by the reranker to prefer
   * curated/observed content over web-scraped chunks.
   * See computeTrustScore() in reranker.ts.
   */
  trustScore: number;
  /**
   * ClaimKit citation boost in [0, 1]. Set when the same query's ClaimKit
   * pass cited this doc (or a doc whose title overlaps with a citation),
   * weighted by ClaimKit's overall confidence. Lets RAG and ClaimKit
   * collaborate: docs ClaimKit found useful get a rerank boost.
   */
  claimKitBoost: number;
  tokens: number;
  metadata: Record<string, unknown>;
}

export interface RelationshipClaim {
  entity: string;
  attribute: "relationship";
  value: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: KGEdgeType;
  trustTier: "curated";
}

export interface ScoredMessage {
  index: number;
  message: ChatMessage;
  importanceScore: number;
  recencyScore: number;
  freshnessScore: number;
  queryRelevance: number;
  effectiveWeight: number;
  tokens: number;
}

export interface ContextSection {
  name: string;
  content: string;
  tokens: number;
  compressionRatio?: number;
  sourceCount?: number;
}

/**
 * Debug view of the semantic-aware Thompson sampling that selected the
 * recent_sessions (issue #246). Surfaced on the context packet so the
 * dashboard / logs can see each surfaced session's Beta utility and the
 * sampled score that won it a slot.
 */
export interface SessionUtilityDiagnostics {
  enabled: boolean;
  /** Number of candidate sessions pulled from FTS before reranking. */
  candidatePool: number;
  /** Epsilon-greedy exploration probability used this round. */
  epsilon: number;
  /** Whether semantic weight came from embeddings or the FTS-score fallback. */
  semanticSource: "embedding" | "fts_fallback";
  selected: Array<{
    sessionId: string;
    alpha: number;
    beta: number;
    sampledUtility: number;
    similarity: number;
    combinedScore: number;
    explored: boolean;
  }>;
}

export interface ClaimKitContextSection {
  name: "claimkit_evidence";
  content: string;
  tokens: number;
  answerability: import("./adapters/claimkit-adapter").AnswerabilityStatus;
  contradictions: Array<{ claimA: string; claimB: string; reason: string }>;
  claimCount: number;
  confidence: number;
}

export type PreferredSource = "claimkit" | "rag" | "blended";
export type RoutingTier = "ck_primary" | "rag_primary" | "blended";

/**
 * ClaimKit-first routing strategy (issue #229), decided by a pre-flight
 * ClaimKit probe before RAG retrieval runs:
 * - "rag_first": legacy order — ClaimKit-first routing disabled, probe
 *   unavailable, or probe threw. RAG retrieval runs as before.
 * - "claimkit_first_skip_rag": probe answered with high confidence; RAG
 *   retrieval is skipped entirely and the probe answer is used directly.
 * - "claimkit_first_parallel": probe was medium confidence; RAG runs in
 *   parallel with a full ClaimKit query so neither adds serial latency.
 * - "claimkit_first_fallback": probe was low confidence / not answerable;
 *   fall back to full RAG + full ClaimKit.
 */
export type RoutingStrategy =
  | "rag_first"
  | "claimkit_first_skip_rag"
  | "claimkit_first_parallel"
  | "claimkit_first_fallback";

/**
 * Telemetry for the ClaimKit-first routing decision. Recorded on every
 * packet so the comparison dashboard can show how often RAG was skipped and
 * the latency delta vs. the old RAG-first path.
 */
export interface ClaimKitFirstMetrics {
  strategy: RoutingStrategy;
  /** Wall-clock latency of the pre-flight ClaimKit probe (0 when not run). */
  probeLatencyMs: number;
  /** True when RAG retrieval was skipped because the probe was high-confidence. */
  ragSkipped: boolean;
  /**
   * Per-request latency delta vs. the old RAG-first path, computed only from
   * this request's own timings (never another request's RAG latency).
   * When RAG ran this is the probe overhead added on top of the RAG-first
   * path. When RAG was skipped it is 0 — no avoided-RAG cost is measurable
   * inline, so the dashboard derives skip savings in aggregate by comparing
   * rag_time_ms across skip vs. non-skip cohorts (keyed on routing_strategy).
   */
  latencyDeltaMs: number;
}

/**
 * Telemetry for the query-rewriting pass (issue #230). Recorded on every packet
 * so the dashboard can show how often rewriting fired, what it extracted, and
 * that it stayed within the < 100ms budget.
 */
export interface QueryRewriteMetrics {
  enabled: boolean;
  latencyMs: number;
  variantCount: number;
  entityRefCount: number;
  abbreviationCount: number;
}

/**
 * Resolution of the cost-aware retrieval cascade (issue #245), recorded in the
 * packet's debug diagnostics. `level` is the escalation level that resolved the
 * query (claimkit | teacher_verify | tool_research | full_rag); `tokensUsed` is
 * the cumulative escalation spend; `outcome` is the terminal reason.
 */
export interface CascadeMetrics {
  level: string;
  tokensUsed: number;
  confidence: number;
  outcome: string;
}

/**
 * A pointer the chat layer uses to back-fill RAG hallucinationRate / grounded
 * onto a live comparison_case row after the agent's response is available.
 *
 * The grounding pass runs asynchronously after the user receives their answer
 * so there is no added latency in the foreground path. ClaimKit's ground()
 * call evaluates the agent's actual response against the same RAG evidence
 * that was sent to the model — populating the truthfulness fields that the
 * eval winner rule depends on but that were hardcoded to null in production.
 */
export interface GroundingHandle {
  /** comparison_cases row to update with hallucination_rate / grounded. */
  caseId: string;
  /** Evidence documents that were sent to the LLM, used by ground(). */
  ragEvidence: Array<{ title: string; content: string }>;
}

export interface ContextPacket {
  sections: ContextSection[];
  messages: ChatMessage[];
  totalTokens: number;
  claimkitSection?: ClaimKitContextSection;
  preferredSource?: PreferredSource;
  routingReason?: string;
  budgetBreakdown: BudgetSlot[];
  /** Set when live shadow grounding should run on the agent's response. */
  groundingHandle?: GroundingHandle;
  /**
   * Cross-source contradictions surfaced during entity-claims injection
   * (Idea 3). Pre-formatted markdown lines suitable for direct display in
   * a UI banner so the user can resolve the conflict before relying on
   * the agent's answer. Empty/undefined when none detected.
   */
  contradictions?: string[];
  diagnostics: {
    mode: ContextMode;
    originalMessageCount: number;
    finalMessageCount: number;
    documentsRetrieved: number;
    documentsCompressed: number;
    compressionRatio: number;
    budgetUtilization: Record<string, number>;
    stageTimings: Record<string, number>;
    claimkitFirstMetrics: ClaimKitFirstMetrics;
    /**
     * Cost-aware retrieval cascade resolution (issue #245). Null when the
     * cascade did not run (disabled, probe high-confidence/unanswerable, or
     * rag_first). Records which escalation level resolved the query, the tokens
     * the escalation spent, the resolving confidence, and the outcome.
     */
    cascade: CascadeMetrics | null;
    /**
     * Semantic-aware Thompson sampling trace for recent_sessions (issue #246).
     * Null when no candidate sessions were available or utility sampling was
     * disabled.
     */
    sessionUtility: SessionUtilityDiagnostics | null;
    queryRewriteMetrics: QueryRewriteMetrics;
    claimkit: {
      enabled: boolean;
      available: boolean;
      used: boolean;
      timedOut: boolean;
      includedInMessages: boolean;
      preferredSource: PreferredSource;
      routingReason: string;
      confidence: number | null;
      answerability: string | null;
      claimCount: number | null;
      sourceCount: number | null;
      retrievalScore: number | null;
    };
    /**
     * Active knowledge acquisition trace (issue #247). Records the claims
     * surfaced from prior cascade resolutions (and their SA-CTS scores), and
     * the id of any new claim persisted from this turn's cascade resolution.
     * Surfaces the claim IDs so a downstream task outcome can update each
     * claim's Beta utility distribution via ClaimsStore.updateClaimUtility().
     */
    claimsAcquisition?: {
      retrievedClaimIds: string[];
      retrievedCount: number;
      injectedInMessages: boolean;
      storedClaimId: string | null;
      storedCascadeLevel: string | null;
      /**
       * Reason the cascade resolution was NOT persisted as a claim. Set when
       * storeClaim was deliberately skipped (e.g. a teacher/tool outcome whose
       * verified resolution text was empty or below the min-confidence floor).
       * Null when no claim was eligible to be stored at all (no cascade
       * resolution, or a non-persisting outcome) or when the claim was stored.
       */
      skippedClaimReason: "empty_resolution" | "below_min_confidence" | null;
    };
    createdAt: Date;
  };
}

export interface AssembleContextParams {
  mode: "productivity" | "engineering";
  query: string;
  sessionMessages: ChatMessage[];
  sessionId: string;
  includeMemory: boolean;
  toolInventory: string;
  providerMaxTokens: number;
  toolTokens: number;
  userId: string;
  onProgress?: (message: string) => void;
}

export interface RerankOptions {
  baseScoreWeight: number;
  importanceWeight: number;
  queryRelevanceWeight: number;
  /**
   * Optional weight applied to recency in reranking. Recency comes from
   * each doc's metadata.createdAt — recent observations beat stale
   * knowledge for queries about evolving state (issue status, MR review).
   * Optional so existing callers/tests stay valid; defaults to 0 in
   * blendScores when omitted.
   */
  recencyWeight?: number;
  /**
   * Optional weight that favors authoritative sources (manual user
   * assertions, file content, codebase chunks) over web-scraped or
   * chat-derived content. See computeTrustScore() in reranker.ts.
   */
  trustWeight?: number;
  /**
   * Optional weight applied to ClaimKit-citation boost. When ClaimKit's
   * claims cite a doc that RAG also retrieved, that doc gets pushed up.
   * This is the join point that turns ClaimKit + RAG from competitors
   * into collaborators (idea 5 from the ClaimKit roadmap).
   */
  claimKitBoostWeight?: number;
  diversityPenalty: number;
}

export const DEFAULT_RERANK_OPTIONS: RerankOptions = {
  baseScoreWeight: 0.35,
  importanceWeight: 0.2,
  queryRelevanceWeight: 0.2,
  recencyWeight: 0.1,
  trustWeight: 0.1,
  claimKitBoostWeight: 0.15,
  diversityPenalty: 0.1,
};

// V1 fractions sum to 1.2 and several sections emitted by context-packet.ts
// are not budgeted (they get Infinity in enforceBudget). V2 adds explicit
// slots for every section and rebalances to exactly 1.0. Enable with
// CONTEXT_PACKET_V2_BUDGET=true after validating on live traffic.
export const DEFAULT_SLOT_DEFINITIONS: BudgetSlotDefinition[] = [
  { name: "system", priority: 100, fraction: 0.3, overflowTarget: "history" },
  { name: "history", priority: 80, fraction: 0.35, overflowTarget: "documents" },
  { name: "documents", priority: 60, fraction: 0.2, overflowTarget: "graph" },
  { name: "graph", priority: 40, fraction: 0.1, overflowTarget: "health" },
  { name: "claimkit_evidence", priority: 55, fraction: 0.15, overflowTarget: "documents" },
  // entity_claims sits above claimkit_evidence in priority because it's
  // exact, structured, query-aligned, and small. When the user is asking
  // about a specific entity, this section should never be the first thing
  // squeezed for budget.
  { name: "entity_claims", priority: 70, fraction: 0.05, overflowTarget: "claimkit_evidence" },
  // prior_claims (issue #247): durable cascade resolutions retrieved before
  // the ClaimKit probe. Sits just above claimkit_evidence in priority (it's
  // already-verified prior knowledge) but below entity_claims (exact facts
  // still win). Without an explicit slot this section falls through to
  // enforceBudget's generic 200-token unknown-section cap instead of its
  // documented ~400-token content budget (see MAX_PRIOR_CLAIMS_TOKENS in
  // context-packet.ts).
  { name: "prior_claims", priority: 58, fraction: 0.07, overflowTarget: "claimkit_evidence" },
  { name: "health", priority: 20, fraction: 0.05, overflowTarget: null },
];

export const V2_SLOT_DEFINITIONS: BudgetSlotDefinition[] = [
  { name: "system", priority: 100, fraction: 0.18, overflowTarget: "history" },
  { name: "history", priority: 80, fraction: 0.23, overflowTarget: "documents" },
  { name: "documents", priority: 60, fraction: 0.13, overflowTarget: "graph" },
  { name: "claimkit_evidence", priority: 55, fraction: 0.12, overflowTarget: "documents" },
  { name: "entity_claims", priority: 70, fraction: 0.08, overflowTarget: "claimkit_evidence" },
  // prior_claims (issue #247): see the matching comment on DEFAULT_SLOT_DEFINITIONS.
  { name: "prior_claims", priority: 58, fraction: 0.05, overflowTarget: "claimkit_evidence" },
  { name: "graph", priority: 40, fraction: 0.07, overflowTarget: "health" },
  { name: "recent_sessions", priority: 35, fraction: 0.04, overflowTarget: "graph" },
  { name: "health", priority: 20, fraction: 0.03, overflowTarget: null },
  { name: "skills", priority: 30, fraction: 0.02, overflowTarget: "documents" },
  { name: "recent_reflections", priority: 25, fraction: 0.02, overflowTarget: "agent_memory" },
  { name: "agent_memory", priority: 45, fraction: 0.01, overflowTarget: "history" },
  { name: "user_profile", priority: 45, fraction: 0.01, overflowTarget: "history" },
  { name: "soul", priority: 110, fraction: 0.01, overflowTarget: "system" },
];

export function getSlotDefinitions(v2 = false): BudgetSlotDefinition[] {
  return v2 ? V2_SLOT_DEFINITIONS : DEFAULT_SLOT_DEFINITIONS;
}

export interface Community {
  id: string;
  nodeIds: string[];
  summary: string;
  level: number;
  stale?: boolean;
  createdAt: Date;
}

export const CHARS_PER_TOKEN = 1.8;
