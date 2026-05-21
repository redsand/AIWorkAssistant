import type { ComparisonEvalCategory } from "../types";
import type { ComparisonRunResult, ThresholdEvaluation } from "./reportTypes";

export interface ThresholdCheck {
  name: string;
  value: number;
  threshold: number;
  comparison: "min" | "max";
  passed: boolean;
}

export interface RetrievalReadinessResult {
  productReady: boolean;
  checks: ThresholdCheck[];
}

export const NO_RAG_WIN_CATEGORIES: ComparisonEvalCategory[] = [
  "citation_laundering",
  "direct_fact",
  "staleness",
];

export interface ThresholdConfig {
  minClaimKitWinRate: number;
  minClaimKitConfidence: number;
  minAnswerabilityRate: number;
  maxAvgProcessingTimeMs: number;
}

export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  minClaimKitWinRate: 0.5,
  minClaimKitConfidence: 0.6,
  minAnswerabilityRate: 0.7,
  maxAvgProcessingTimeMs: 5000,
};

export function evaluateThresholds(
  result: ComparisonRunResult,
  thresholds: ThresholdConfig = DEFAULT_THRESHOLDS,
): ThresholdEvaluation {
  const failures: string[] = [];

  const winRate =
    result.totalCases > 0
      ? result.aggregate.wins.claimkit / result.totalCases
      : 0;

  if (winRate < thresholds.minClaimKitWinRate) {
    failures.push(
      `ClaimKit win rate ${(winRate * 100).toFixed(1)}% below threshold ${(thresholds.minClaimKitWinRate * 100).toFixed(1)}%`,
    );
  }

  const { confidence, answerabilityRate, avgTimeMs } =
    result.aggregate.claimkit.mean;

  if (confidence < thresholds.minClaimKitConfidence) {
    failures.push(
      `Mean confidence ${confidence.toFixed(2)} below threshold ${thresholds.minClaimKitConfidence}`,
    );
  }

  if (answerabilityRate < thresholds.minAnswerabilityRate) {
    failures.push(
      `Answerability rate ${(answerabilityRate * 100).toFixed(1)}% below threshold ${(thresholds.minAnswerabilityRate * 100).toFixed(1)}%`,
    );
  }

  if (avgTimeMs > thresholds.maxAvgProcessingTimeMs) {
    failures.push(
      `Mean processing time ${avgTimeMs.toFixed(0)}ms exceeds threshold ${thresholds.maxAvgProcessingTimeMs}ms`,
    );
  }

  return { passed: failures.length === 0, failures };
}

export function countCategoryCases(
  result: ComparisonRunResult,
  category: ComparisonEvalCategory,
): number {
  return result.cases.filter(c => c.category === category).length;
}

export function countRagWins(
  result: ComparisonRunResult,
  category: ComparisonEvalCategory,
): number {
  return result.cases.filter(
    c => c.category === category && c.overallWinner === "rag",
  ).length;
}

export function evaluateRetrievalReadiness(
  result: ComparisonRunResult,
): RetrievalReadinessResult {
  const checks: ThresholdCheck[] = [];

  for (const category of NO_RAG_WIN_CATEGORIES) {
    const caseCount = countCategoryCases(result, category);
    const ragWins = countRagWins(result, category);

    checks.push({
      name: `Retrieval product-ready: ${category} coverage`,
      value: caseCount,
      threshold: 1,
      comparison: "min",
      passed: caseCount >= 1,
    });

    checks.push({
      name: `Retrieval product-ready: ${category} RAG wins`,
      value: ragWins,
      threshold: 0,
      comparison: "max",
      passed: caseCount > 0 && ragWins <= 0,
    });
  }

  return {
    productReady: checks.every(c => c.passed),
    checks,
  };
}
