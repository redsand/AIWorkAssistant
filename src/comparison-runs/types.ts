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
  winner_reason: string | null;
  /** Why ClaimKit did not produce an answer, or "answered" when it did. */
  ck_status: CkStatus | null;
  /** True when the ClaimKit section was included in the model context messages. */
  ck_included_in_context: boolean | null;
  rag_hallucination_rate: number | null;
  rag_grounded: boolean | null;
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
  byCategory: CategoryBreakdown[];
  recentRuns: ComparisonRunSummary[];
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
  } | null;
}

export interface SaveComparisonInput {
  source: ComparisonSource;
  description?: string;
  cases: SaveCaseInput[];
}
