import { comparisonRunDatabase, ComparisonRunDatabase } from "./database";
import type { SaveComparisonInput, ComparisonEvalCategory, CkStatus } from "./types";
import type { ComparisonRunResult } from "../eval/comparison/reportTypes";

export function classifyQuery(query: string): ComparisonEvalCategory {
  const lower = query.toLowerCase();
  if (lower.includes("build") || lower.includes("process") || lower.includes("plan") || lower.includes("workflow") || lower.includes("methodology") || lower.includes("assessment") || lower.includes("calculate") || lower.includes("determine") || lower.includes("create") || lower.includes("design") || lower.includes("feasibility") || lower.includes("evaluate") || lower.includes("measure") || lower.includes("framework") || lower.includes("roadmap") || lower.includes("strategy")) return "planning_synthesis";
  if (lower.includes("code") || lower.includes("file") || lower.includes("function") || lower.includes("class")) return "code_retrieval";
  if (lower.includes("who") || lower.includes("person") || lower.includes("owner") || lower.includes("author")) return "entity_linking";
  if (lower.includes("when") || lower.includes("date") || lower.includes("last") || lower.includes("recent") || lower.includes("latest")) return "staleness";
  if (lower.includes("cite") || lower.includes("source") || lower.includes("reference") || lower.includes("citation")) return "citation_laundering";
  return "direct_fact";
}

/**
 * Convert a batch ComparisonRunResult to the DB save format.
 */
function fromBatchResult(
  result: ComparisonRunResult,
  description?: string,
): SaveComparisonInput {
  return {
    source: "batch",
    description: description,
    cases: result.cases.map((c) => ({
      query: c.query,
      category: c.category,
      overallWinner: c.overallWinner,
      winnerReason: c.winnerReason,
      ckStatus: c.ckStatus,
      ckIncludedInContext: c.ckIncludedInContext,
      rag: {
        contextTokens: c.rag.contextTokens,
        sections: c.rag.sections,
        processingTimeMs: c.rag.processingTimeMs,
        hallucinationRate: c.rag.hallucinationRate,
        grounded: c.rag.grounded,
      },
      claimkit: c.claimkit
        ? {
            confidence: c.claimkit.confidence,
            answerability: c.claimkit.answerability,
            claimCount: c.claimkit.claimCount,
            processingTimeMs: c.claimkit.processingTimeMs,
            contradictions: c.claimkit.contradictions,
          }
        : null,
    })),
  };
}

/**
 * Persist a batch comparison result to the database.
 * Errors are caught and logged — never throws.
 */
export function saveBatchComparison(
  result: ComparisonRunResult,
  description?: string,
  db?: ComparisonRunDatabase,
): void {
  try {
    const input = fromBatchResult(result, description);
    (db ?? comparisonRunDatabase).createRun(input);
  } catch (err) {
    console.error("[ComparisonRuns] Failed to save batch comparison:", err);
  }
}

/**
 * Persist a single live comparison from a production query.
 * Each live query is stored as its own run with one case.
 * Errors are caught and logged — never throws.
 */
export function saveLiveComparison(params: {
  query: string;
  category?: ComparisonEvalCategory;
  ragTokens: number;
  ragSections: number;
  ragTimeMs: number;
  ragHallucinationRate?: number | null;
  ragGrounded?: boolean | null;
  ckConfidence: number | null;
  ckAnswerability: string | null;
  ckClaimCount: number | null;
  ckTimeMs: number | null;
  ckContradictions: number | null;
  ckAnswer?: string | null;
  ckRetrievalScore?: number | null;
  ckSourceCount?: number | null;
  ckMissingEvidence?: string | null;
  overallWinner: "rag" | "claimkit" | "tie";
  winnerReason?: string;
  ckStatus?: CkStatus | null;
  ckIncludedInContext?: boolean | null;
  /** Set per case when CK citation boost applied to one or more docs. */
  citationBoostApplied?: number | null;
  /** Set per case when gap-fill cascade added docs. */
  gapFillDocsAdded?: number | null;
  /** Set per case when entity claims were injected into the prompt. */
  entityClaimsInjected?: number | null;
  /** Set per case when cross-source contradictions were flagged. */
  contradictionsFlagged?: number | null;
  /** Token count of the claimkit_evidence section when included in context. */
  ckSectionTokens?: number | null;
  db?: ComparisonRunDatabase;
}): { caseId: string } | null {
  try {
    if (!params.db && process.env.NODE_ENV === "test") {
      return null;
    }
    const target = params.db ?? comparisonRunDatabase;
    const run = target.createRun({
      source: "live",
      description: params.query.substring(0, 200),
      cases: [
        {
          query: params.query,
          category: params.category ?? "direct_fact",
          overallWinner: params.overallWinner,
          winnerReason: params.winnerReason,
          ckStatus: params.ckStatus,
          ckIncludedInContext: params.ckIncludedInContext,
          citationBoostApplied: params.citationBoostApplied,
          gapFillDocsAdded: params.gapFillDocsAdded,
          entityClaimsInjected: params.entityClaimsInjected,
          contradictionsFlagged: params.contradictionsFlagged,
          ckSectionTokens: params.ckSectionTokens,
          rag: {
            contextTokens: params.ragTokens,
            sections: params.ragSections,
            processingTimeMs: params.ragTimeMs,
            hallucinationRate: params.ragHallucinationRate,
            grounded: params.ragGrounded,
          },
          claimkit:
            params.ckConfidence !== null
              ? {
                  confidence: params.ckConfidence,
                  answerability: params.ckAnswerability ?? "unknown",
                  claimCount: params.ckClaimCount ?? 0,
                  processingTimeMs: params.ckTimeMs ?? 0,
                  contradictions: params.ckContradictions ?? 0,
                  answer: params.ckAnswer ?? undefined,
                  retrievalScore: params.ckRetrievalScore ?? undefined,
                  sourceCount: params.ckSourceCount ?? undefined,
                  missingEvidence: params.ckMissingEvidence ?? undefined,
                }
              : null,
        },
      ],
    });
    // Return the case ID so the caller can back-fill grounding results
    // asynchronously once the agent's response is available.
    const caseId = run.cases[0]?.id;
    return caseId ? { caseId } : null;
  } catch (err) {
    console.error("[ComparisonRuns] Failed to save live comparison:", err);
    return null;
  }
}
