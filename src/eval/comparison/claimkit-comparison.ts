import { assembleContextPacket } from "../../context-engine/context-packet";
import { claimKitAdapter } from "../../context-engine/adapters/claimkit-adapter";
import type { ComparisonRunResult, ComparisonCase } from "./reportTypes";
import type { ComparisonEvalCategory } from "../types";
import { evaluateThresholds, DEFAULT_THRESHOLDS } from "./thresholds";

export interface ComparisonConfig {
  queries: string[];
  categories: ComparisonEvalCategory[];
  thresholds?: typeof DEFAULT_THRESHOLDS;
}

export async function runClaimKitComparison(
  config: ComparisonConfig,
): Promise<ComparisonRunResult> {
  const ckAvailable = await claimKitAdapter.initialize();
  const cases: ComparisonCase[] = [];

  for (const query of config.queries) {
    // Run existing RAG pipeline
    const ragStart = Date.now();
    const ragPacket = await assembleContextPacket({
      mode: "engineering",
      query,
      sessionMessages: [],
      sessionId: "eval",
      includeMemory: false,
      toolInventory: "",
      providerMaxTokens: 8192,
      toolTokens: 0,
      userId: "eval",
    });
    const ragMs = Date.now() - ragStart;

    // Run ClaimKit pipeline
    let ckResult = null;
    let ckMs = 0;
    if (ckAvailable) {
      const ckStart = Date.now();
      try {
        ckResult = await claimKitAdapter.query(query);
        ckMs = Date.now() - ckStart;
      } catch (err) {
        console.warn(`[ClaimKit Comparison] Query failed: ${query}`, err);
      }
    }

    // Determine winner per category
    const overallWinner = determineOverallWinner(ckResult);

    cases.push({
      query,
      category: categorizeQuery(query, config.categories),
      overallWinner,
      rag: {
        contextTokens: ragPacket.totalTokens,
        sections: ragPacket.sections.length,
        processingTimeMs: ragMs,
      },
      claimkit: ckResult
        ? {
            confidence: ckResult.confidence,
            answerability: ckResult.answerability,
            claimCount: ckResult.metadata.claimCount,
            processingTimeMs: ckMs,
            contradictions: ckResult.contradictions.length,
          }
        : null,
    });
  }

  // Aggregate results
  const totalCases = cases.length;
  const claimKitWins = cases.filter((c) => c.overallWinner === "claimkit").length;
  const ragWins = cases.filter((c) => c.overallWinner === "rag").length;
  const ties = cases.filter((c) => c.overallWinner === "tie").length;

  const result: ComparisonRunResult = {
    totalCases,
    cases,
    aggregate: {
      wins: { claimkit: claimKitWins, rag: ragWins, tie: ties },
      claimkit: {
        mean: aggregateClaimKitStats(cases),
      },
      rag: {
        mean: aggregateRagStats(cases),
      },
    },
  };

  result.thresholdEvaluation = evaluateThresholds(
    result,
    config.thresholds ?? DEFAULT_THRESHOLDS,
  );

  return result;
}

function determineOverallWinner(
  ck: Awaited<ReturnType<typeof claimKitAdapter.query>> | null,
): "rag" | "claimkit" | "tie" {
  if (!ck) return "rag";
  // ClaimKit wins if it has confidence > 0.5 AND answerability is "answerable"
  if (ck.confidence > 0.5 && ck.answerability === "answerable") return "claimkit";
  // RAG wins if ClaimKit has low confidence or can't answer
  if (ck.confidence < 0.3 || ck.answerability === "not_answerable") return "rag";
  return "tie";
}

function categorizeQuery(
  query: string,
  categories: ComparisonEvalCategory[],
): ComparisonEvalCategory {
  const lower = query.toLowerCase();
  const determined = ((): ComparisonEvalCategory => {
    if (lower.includes("code") || lower.includes("file") || lower.includes("function")) return "code_retrieval";
    if (lower.includes("who") || lower.includes("person") || lower.includes("owner")) return "entity_linking";
    if (lower.includes("when") || lower.includes("date") || lower.includes("last")) return "staleness";
    if (lower.includes("cite") || lower.includes("source") || lower.includes("reference")) return "citation_laundering";
    return "direct_fact";
  })();
  return categories.includes(determined) ? determined : (categories[0] ?? determined);
}

function aggregateClaimKitStats(cases: ComparisonCase[]) {
  const withCk = cases.filter((c) => c.claimkit !== null);
  if (withCk.length === 0) return { confidence: 0, answerabilityRate: 0, avgClaims: 0, avgTimeMs: 0 };
  return {
    confidence: withCk.reduce((s, c) => s + (c.claimkit?.confidence ?? 0), 0) / withCk.length,
    answerabilityRate:
      withCk.filter((c) => c.claimkit?.answerability === "answerable").length / withCk.length,
    avgClaims: withCk.reduce((s, c) => s + (c.claimkit?.claimCount ?? 0), 0) / withCk.length,
    avgTimeMs: withCk.reduce((s, c) => s + (c.claimkit?.processingTimeMs ?? 0), 0) / withCk.length,
  };
}

function aggregateRagStats(cases: ComparisonCase[]) {
  if (cases.length === 0) return { avgTokens: 0, avgSections: 0, avgTimeMs: 0 };
  return {
    avgTokens: cases.reduce((s, c) => s + c.rag.contextTokens, 0) / cases.length,
    avgSections: cases.reduce((s, c) => s + c.rag.sections, 0) / cases.length,
    avgTimeMs: cases.reduce((s, c) => s + c.rag.processingTimeMs, 0) / cases.length,
  };
}
