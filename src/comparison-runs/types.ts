export type ComparisonSource = "batch" | "live";
export type ComparisonWinner = "rag" | "claimkit" | "tie";
export type ComparisonEvalCategory =
  | "code_retrieval"
  | "entity_linking"
  | "staleness"
  | "citation_laundering"
  | "direct_fact"
  | "planning_synthesis";

// ── Raw DB row shapes ─────────────────────────────────────────────────

export interface ComparisonRunRow {
  id: string;
  source: ComparisonSource;
  description: string | null;
  created_at: string;
}

export type CkStatus = "answered" | "timeout" | "error" | "no_claims" | "disabled";

export interface ComparisonCaseRow {
  id: string;
  run_id: string;
  query: string;
  category: ComparisonEvalCategory;
  overall_winner: ComparisonWinner;
  rag_tokens: number;
  rag_sections: number;
  rag_time_ms: number;
  ck_confidence: number | null;
  ck_answerability: string | null;
  ck_claim_count: number | null;
  ck_time_ms: number | null;
  ck_contradictions: number | null;
  ck_answer: string | null;
  ck_retrieval_score: number | null;
  ck_source_count: number | null;
  ck_missing_evidence: string | null;
  /** JSON array of { claimId, sourceId, text } actually cited by ClaimKit
   *  for this case. Backfilled per turn so the comparison dashboard can
   *  show "which claims/evidence were used" without parsing ck_answer. */
  ck_citations: string | null;
  winner_reason: string | null;
  /** Why ClaimKit did not produce an answer, or "answered" when it did. */
  ck_status: CkStatus | null;
  /** True when the ClaimKit section was included in the model context messages. */
  ck_included_in_context: boolean | null;
  rag_hallucination_rate: number | null;
  rag_grounded: boolean | null;
  ck_section_tokens: number | null;
  /** JSON-encoded ConfidenceTrace (Phase 1 calibration telemetry). */
  confidence_trace: string | null;
  /** ClaimKit-first routing strategy decided for this query (issue #229). */
  routing_strategy: string | null;
  created_at: string;
}

// ── API response types ────────────────────────────────────────────────

export interface ComparisonAggregate {
  wins: { claimkit: number; rag: number; tie: number };
  /** Rows where CK actually ran (status = answered or no_claims). Excludes timeouts/errors/disabled. */
  evaluatedCases: number;
  ckTimeouts: number;
  ckUnevaluated: number;
  claimkit: {
    mean: {
      confidence: number;
      answerabilityRate: number;
      avgClaims: number;
      avgTimeMs: number;
    };
  };
  rag: {
    mean: {
      avgTokens: number;
      avgSections: number;
      avgTimeMs: number;
      hallucinationRate: number;
      groundedRate: number;
    };
  };
}

export interface ComparisonRunWithCases {
  id: string;
  source: ComparisonSource;
  description: string | null;
  created_at: string;
  totalCases: number;
  cases: ComparisonCaseRow[];
  aggregate: ComparisonAggregate;
}

export interface ComparisonRunSummary {
  id: string;
  source: ComparisonSource;
  description: string | null;
  totalCases: number;
  created_at: string;
  wins: { claimkit: number; rag: number; tie: number };
}

export interface ComparisonRunsListResult {
  runs: ComparisonRunSummary[];
  total: number;
}

export interface CategoryBreakdown {
  category: ComparisonEvalCategory;
  total: number;
  claimkitWins: number;
  ragWins: number;
  ties: number;
}

export interface ComparisonDashboardStats {
  source: ComparisonSource | "all";
  totalRuns: number;
  totalCases: number;
  /** Rows where CK actually ran (not timeout/error/disabled). Win rates should use this as denominator. */
  evaluatedCases: number;
  ckTimeouts: number;
  overallWins: { claimkit: number; rag: number; tie: number };
  avgCkConfidence: number;
  avgAnswerabilityRate: number;
  avgCkTimeMs: number;
  avgRagTimeMs: number;
  avgRagHallucinationRate: number;
  avgRagGroundedRate: number;
  /**
   * Number of cases where the truthfulness-first rule flipped the winner to
   * ClaimKit because RAG hallucinated. The headline metric for ClaimKit's
   * complementary value over RAG (Idea 1 + the truthfulness winner rule).
   */
  ckRescues: number;
  /**
   * Number of cases that have a grounding measurement (rag_hallucination_rate
   * IS NOT NULL). Used as the denominator for rescue / hallucination
   * percentages so we don't mix unmeasured rows into the rate.
   */
  groundedMeasurements: number;
  /**
   * Collaboration counters: how often each of the new RAG+ClaimKit
   * collaborative features actually fired in production. These let the
   * dashboard prove the features aren't just plumbed — they're being used.
   */
  collaboration: {
    citationBoostApplied: number;
    gapFillTriggered: number;
    entityClaimsInjected: number;
    contradictionsFlagged: number;
  };
  /**
   * Token-savings story: ClaimKit's structured-claim packet replaces broad
   * RAG context in many queries, driving prompt size — and therefore
   * cost — down. These aggregates show the cumulative win.
   *   - avgRagTokens / avgCkTokens: per-query averages (apples-to-apples).
   *   - totalTokensSaved: sum of (rag - ck) across all cases where CK was
   *     included AND smaller than RAG. Negative deltas (CK was larger) are
   *     excluded so we don't artificially inflate the savings number.
   *   - measuredCases: denominator for the rates (cases that had both
   *     rag_tokens and ck_section_tokens recorded).
   */
  tokenSavings: {
    avgRagTokens: number;
    avgCkTokens: number;
    totalTokensSaved: number;
    avgSavingsPerQuery: number;
    measuredCases: number;
  };
  /**
   * Why ClaimKit reported low confidence. Classifies each ck_confidence ≤ 0.1
   * case by the most likely root cause, derived from existing columns. Lets
   * the dashboard answer "is CK failing because retrieval finds nothing, or
   * because the verifier is too strict?" without new instrumentation.
   */
  lowConfidenceBreakdown: {
    /** ck_claim_count = 0 → retrieval returned nothing. Usually a ingestion gap. */
    noClaimsRetrieved: number;
    /** ck_answerability = 'not_answerable' → claims found but didn't cover the question. */
    notAnswerable: number;
    /** Claims found, answerable, but confidence still low — generator or verifier issue. */
    lowConfidenceSignal: number;
    /** Total low-confidence cases (denominator). */
    total: number;
  };
  byCategory: CategoryBreakdown[];
  recentRuns: ComparisonRunSummary[];
}

/**
 * Structured-claim memory health (Idea 2 outcome). Read from entity-memory,
 * not the comparison DB. Surfaces on the dashboard as the "Structured Memory"
 * panel — a story RAG cannot tell (RAG has no notion of supersession).
 */
export interface EntityClaimStats {
  totalEntities: number;
  /** Total claim rows (current + superseded). */
  totalClaims: number;
  /** Claims currently in force (not superseded). */
  currentClaims: number;
  /** Historical claims that were replaced by a newer observation. */
  supersededClaims: number;
  /** Entities that have had at least one supersession event. */
  entitiesWithHistory: number;
  /** Top sources contributing claims, ordered descending. */
  topSources: Array<{ source: string; count: number }>;
}

export interface ConfidenceTrendPoint {
  date: string;
  avgConfidence: number;
  caseCount: number;
}

export interface TruthfulnessTrendPoint {
  date: string;
  avgHallucinationRate: number;
  avgGroundedRate: number;
  caseCount: number;
}

// ── Input types ───────────────────────────────────────────────────────

export interface SaveCaseInput {
  query: string;
  category: ComparisonEvalCategory;
  overallWinner: ComparisonWinner;
  winnerReason?: string;
  ckStatus?: CkStatus | null;
  ckIncludedInContext?: boolean | null;
  /** Number of docs that received the CK citation boost (Idea 5). */
  citationBoostApplied?: number | null;
  /** Number of new docs added by the gap-fill cascade (Idea 4). */
  gapFillDocsAdded?: number | null;
  /** Number of entity claims injected into the prompt (Idea 2). */
  entityClaimsInjected?: number | null;
  /** Number of cross-source contradictions flagged (Idea 3). */
  contradictionsFlagged?: number | null;
  /**
   * Tokens consumed by the claimkit_evidence section when it was included
   * in the prompt. Compared against rag.contextTokens, this quantifies the
   * cost savings story — structured claims replacing broad RAG context.
   * NULL when CK was disabled or had nothing to contribute.
   */
  ckSectionTokens?: number | null;
  /**
   * Phase 1 calibration telemetry: per-stage confidence trace from
   * ClaimKit's query(). Persisted as JSON in confidence_trace column.
   * Lets the dashboard answer "which stage drove this score?" with
   * stage-level data instead of a final number.
   */
  confidenceTrace?: unknown;
  /**
   * ClaimKit-first routing strategy chosen for this query (issue #229):
   * "rag_first", "claimkit_first_skip_rag", "claimkit_first_parallel", or
   * "claimkit_first_fallback". Lets the dashboard measure how often RAG was
   * skipped and the latency impact of each path.
   */
  routingStrategy?: string | null;
  rag: {
    contextTokens: number;
    sections: number;
    processingTimeMs: number;
    hallucinationRate?: number | null;
    grounded?: boolean | null;
  };
  claimkit: {
    confidence: number;
    answerability: string;
    claimCount: number;
    processingTimeMs: number;
    contradictions: number;
    answer?: string;
    retrievalScore?: number;
    sourceCount?: number;
    missingEvidence?: string;
    /** Cited evidence rows the dashboard renders so operators can see
     *  what ClaimKit actually used per turn. Persisted as ck_citations
     *  (JSON-stringified, capped at 20 rows). */
    citations?: ReadonlyArray<{
      claimId: string;
      sourceId: string;
      text: string;
    }>;
  } | null;
}

export interface SaveComparisonInput {
  source: ComparisonSource;
  description?: string;
  cases: SaveCaseInput[];
}
