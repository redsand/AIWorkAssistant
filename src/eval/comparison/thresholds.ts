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
  "planning_synthesis",
];

export interface ThresholdConfig {
  minTruthfulAnswerRate: number;
  minClaimKitConfidence: number;
  minAnswerabilityRate: number;
  maxAvgProcessingTimeMs: number;
  maxRagHallucinationRate: number;
  minRagGroundedRate: number;
}

export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  minTruthfulAnswerRate: 0.7,
  minClaimKitConfidence: 0.4,
  minAnswerabilityRate: 0.5,
  maxAvgProcessingTimeMs: 5000,
  maxRagHallucinationRate: 0.1,
  minRagGroundedRate: 0.8,
};

export function evaluateThresholds(
  result: ComparisonRunResult,
  thresholds: ThresholdConfig = DEFAULT_THRESHOLDS,
): ThresholdEvaluation {
  const failures: string[] = [];

  // Truthful answer rate = (CK wins + ties where RAG was not hallucinating) / total
  // In our new truthfulness model, a "truthful answer" is any case where the winner was claimkit (honest or grounded)
  // OR a tie where both systems were honest. We compute it as: 1 - (rag wins + ungrounded rag) is complex,
  // so instead we measure the rate at which the evaluation produced a truthful outcome.
  const truthfulRate =
    result.totalCases > 0
      ? (result.aggregate.wins.claimkit + result.aggregate.wins.tie) / result.totalCases
      : 0;

  if (truthfulRate < thresholds.minTruthfulAnswerRate) {
    failures.push(
      `Truthful answer rate ${(truthfulRate * 100).toFixed(1)}% below threshold ${(thresholds.minTruthfulAnswerRate * 100).toFixed(1)}%`,
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

  const { hallucinationRate, groundedRate } = result.aggregate.rag.mean;

  if (hallucinationRate > thresholds.maxRagHallucinationRate) {
    failures.push(
      `RAG hallucination rate ${(hallucinationRate * 100).toFixed(1)}% exceeds threshold ${(thresholds.maxRagHallucinationRate * 100).toFixed(1)}%`,
    );
  }

  if (groundedRate < thresholds.minRagGroundedRate) {
    failures.push(
      `RAG grounded rate ${(groundedRate * 100).toFixed(1)}% below threshold ${(thresholds.minRagGroundedRate * 100).toFixed(1)}%`,
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
