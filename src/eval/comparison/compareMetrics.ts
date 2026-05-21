/**
 * Weighted scoring for evaluation comparison runs.
 *
 * Weights (must sum to 1.0):
 *   - retrievalScore:       0.20
 *   - generationScore:      0.30
 *   - safetyScore:          0.20
 *   - efficiencyScore:      0.10
 *   - evaluatorValidityScore: 0.20
 */

export interface MetricSet {
  retrievalScore: number;
  generationScore: number;
  safetyScore: number;
  efficiencyScore: number;
  promptEchoRate: number;
  malformedAnswerRate: number;
  emptyAnswerRate: number;
}

export interface GroupedScores {
  retrievalScore: number;
  generationScore: number;
  safetyScore: number;
  efficiencyScore: number;
  evaluatorValidityScore: number;
}

export const WEIGHTS = {
  retrieval: 0.20,
  generation: 0.30,
  safety: 0.20,
  efficiency: 0.10,
  evaluatorValidity: 0.20,
} as const;

const METRIC_FIELDS: (keyof MetricSet)[] = [
  "retrievalScore",
  "generationScore",
  "safetyScore",
  "efficiencyScore",
  "promptEchoRate",
  "malformedAnswerRate",
  "emptyAnswerRate",
];

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function assertFiniteMetricSet(metricSet: MetricSet): void {
  for (const field of METRIC_FIELDS) {
    if (!Number.isFinite(metricSet[field])) {
      throw new Error(`Metric field ${field} must be finite`);
    }
  }
}

/**
 * Compute individual group scores from raw metrics.
 * evaluatorValidityScore is the average of (1 - rate) for each validity metric.
 */
export function buildGroupedScores(metricSet: MetricSet): GroupedScores {
  assertFiniteMetricSet(metricSet);

  const evaluatorValidityScore = average([
    1 - metricSet.promptEchoRate,
    1 - metricSet.malformedAnswerRate,
    1 - metricSet.emptyAnswerRate,
  ]);

  return {
    retrievalScore: clamp01(metricSet.retrievalScore),
    generationScore: clamp01(metricSet.generationScore),
    safetyScore: clamp01(metricSet.safetyScore),
    efficiencyScore: clamp01(metricSet.efficiencyScore),
    evaluatorValidityScore: clamp01(evaluatorValidityScore),
  };
}

/**
 * Compute the overall weighted score from a metric set.
 *
 * Uses a weighted sum with no hard-kill multiplier. Validity issues
 * reduce the score proportionally through the 20% evaluatorValidity weight
 * rather than zeroing the entire score.
 */
export function overallScore(metricSet: MetricSet): number {
  const scores = buildGroupedScores(metricSet);

  const base =
    scores.retrievalScore * WEIGHTS.retrieval +
    scores.generationScore * WEIGHTS.generation +
    scores.safetyScore * WEIGHTS.safety +
    scores.efficiencyScore * WEIGHTS.efficiency +
    scores.evaluatorValidityScore * WEIGHTS.evaluatorValidity;

  return clamp01(base);
}
