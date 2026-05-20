import { comparisonRunDatabase } from "./database";
import type { SaveComparisonInput, ComparisonEvalCategory } from "./types";
import type { ComparisonRunResult } from "../eval/comparison/reportTypes";

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
      rag: {
        contextTokens: c.rag.contextTokens,
        sections: c.rag.sections,
        processingTimeMs: c.rag.processingTimeMs,
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
): void {
  try {
    const input = fromBatchResult(result, description);
    comparisonRunDatabase.createRun(input);
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
  ckConfidence: number | null;
  ckAnswerability: string | null;
  ckClaimCount: number | null;
  ckTimeMs: number | null;
  ckContradictions: number | null;
  overallWinner: "rag" | "claimkit" | "tie";
}): void {
  try {
    comparisonRunDatabase.createRun({
      source: "live",
      description: params.query.substring(0, 200),
      cases: [
        {
          query: params.query,
          category: params.category ?? "direct_fact",
          overallWinner: params.overallWinner,
          rag: {
            contextTokens: params.ragTokens,
            sections: params.ragSections,
            processingTimeMs: params.ragTimeMs,
          },
          claimkit:
            params.ckConfidence !== null
              ? {
                  confidence: params.ckConfidence,
                  answerability: params.ckAnswerability ?? "unknown",
                  claimCount: params.ckClaimCount ?? 0,
                  processingTimeMs: params.ckTimeMs ?? 0,
                  contradictions: params.ckContradictions ?? 0,
                }
              : null,
        },
      ],
    });
  } catch (err) {
    console.error("[ComparisonRuns] Failed to save live comparison:", err);
  }
}
