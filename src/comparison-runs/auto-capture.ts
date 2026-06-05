import { comparisonRunDatabase, ComparisonRunDatabase } from "./database";
import type { SaveComparisonInput, ComparisonEvalCategory } from "./types";
import type { ComparisonRunResult } from "../eval/comparison/reportTypes";

export function classifyQuery(query: string): ComparisonEvalCategory {
  const lower = query.toLowerCase();
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
  db?: ComparisonRunDatabase;
}): void {
  try {
    if (!params.db && process.env.NODE_ENV === "test") {
      return;
    }
    const target = params.db ?? comparisonRunDatabase;
    target.createRun({
      source: "live",
      description: params.query.substring(0, 200),
      cases: [
        {
          query: params.query,
          category: params.category ?? "direct_fact",
          overallWinner: params.overallWinner,
          winnerReason: params.winnerReason,
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
                  answer: params.ckAnswer ?? undefined,
                  retrievalScore: params.ckRetrievalScore ?? undefined,
                  sourceCount: params.ckSourceCount ?? undefined,
                  missingEvidence: params.ckMissingEvidence ?? undefined,
                }
              : null,
        },
      ],
    });
  } catch (err) {
    console.error("[ComparisonRuns] Failed to save live comparison:", err);
  }
}
