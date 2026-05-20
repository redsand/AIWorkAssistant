import type { ComparisonRunResult, ThresholdEvaluation } from "./reportTypes";

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
