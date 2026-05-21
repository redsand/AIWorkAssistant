import { describe, it, expect } from "vitest";
import {
  overallScore,
  buildGroupedScores,
  WEIGHTS,
  type MetricSet,
} from "../../../../src/eval/comparison/compareMetrics";

function makeMetricSet(
  overrides: Partial<MetricSet> = {},
): MetricSet {
  return {
    retrievalScore: 0.8,
    generationScore: 0.9,
    safetyScore: 0.95,
    efficiencyScore: 0.85,
    promptEchoRate: 0,
    malformedAnswerRate: 0,
    emptyAnswerRate: 0,
    ...overrides,
  };
}

describe("buildGroupedScores", () => {
  it("computes evaluatorValidityScore as average of (1 - each validity rate)", () => {
    const ms = makeMetricSet({
      promptEchoRate: 0.1,
      malformedAnswerRate: 0.2,
      emptyAnswerRate: 0.3,
    });
    const scores = buildGroupedScores(ms);
    // (1-0.1 + 1-0.2 + 1-0.3) / 3 = (0.9 + 0.8 + 0.7) / 3 = 0.8
    expect(scores.evaluatorValidityScore).toBeCloseTo(0.8, 5);
  });

  it("returns 1.0 evaluatorValidityScore when all rates are 0", () => {
    const scores = buildGroupedScores(makeMetricSet());
    expect(scores.evaluatorValidityScore).toBe(1.0);
  });

  it("returns 0 evaluatorValidityScore when all rates are 1", () => {
    const ms = makeMetricSet({
      promptEchoRate: 1,
      malformedAnswerRate: 1,
      emptyAnswerRate: 1,
    });
    const scores = buildGroupedScores(ms);
    expect(scores.evaluatorValidityScore).toBe(0);
  });

  it("passes through individual scores unchanged", () => {
    const ms = makeMetricSet();
    const scores = buildGroupedScores(ms);
    expect(scores.retrievalScore).toBe(0.8);
    expect(scores.generationScore).toBe(0.9);
    expect(scores.safetyScore).toBe(0.95);
    expect(scores.efficiencyScore).toBe(0.85);
  });
});

describe("overallScore", () => {
  it("computes weighted sum with updated weights (sums to 1.0)", () => {
    const ms = makeMetricSet();
    // All validity metrics are 0, so evaluatorValidityScore = 1.0
    // 0.8*0.20 + 0.9*0.30 + 0.95*0.20 + 0.85*0.10 + 1.0*0.20
    // = 0.16 + 0.27 + 0.19 + 0.085 + 0.20 = 0.905
    const score = overallScore(ms);
    expect(score).toBeCloseTo(0.905, 5);
  });

  it("proportionally reduces score when promptEchoRate is non-zero (not hard-kill)", () => {
    const ms = makeMetricSet({ promptEchoRate: 0.1 });
    // evaluatorValidityScore = (0.9 + 1 + 1) / 3 ≈ 0.9667
    // 0.8*0.20 + 0.9*0.30 + 0.95*0.20 + 0.85*0.10 + 0.9667*0.20
    // = 0.16 + 0.27 + 0.19 + 0.085 + 0.19333 = 0.89833
    const score = overallScore(ms);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeCloseTo(0.8983, 3);
  });

  it("does NOT zero the score when all validity metrics are non-zero", () => {
    const ms = makeMetricSet({
      promptEchoRate: 0.5,
      malformedAnswerRate: 0.5,
      emptyAnswerRate: 0.5,
    });
    // evaluatorValidityScore = 0.5
    // 0.8*0.20 + 0.9*0.30 + 0.95*0.20 + 0.85*0.10 + 0.5*0.20
    // = 0.16 + 0.27 + 0.19 + 0.085 + 0.10 = 0.805
    const score = overallScore(ms);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeCloseTo(0.805, 3);
  });

  it("returns non-zero score even with promptEchoRate at 1.0", () => {
    const ms = makeMetricSet({ promptEchoRate: 1.0 });
    // evaluatorValidityScore = (0 + 1 + 1) / 3 = 0.6667
    // 0.8*0.20 + 0.9*0.30 + 0.95*0.20 + 0.85*0.10 + 0.6667*0.20
    // = 0.16 + 0.27 + 0.19 + 0.085 + 0.13333 = 0.83833
    const score = overallScore(ms);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeCloseTo(0.8383, 3);
  });

  it("clamps result to [0, 1]", () => {
    const allMax: MetricSet = {
      retrievalScore: 1,
      generationScore: 1,
      safetyScore: 1,
      efficiencyScore: 1,
      promptEchoRate: 0,
      malformedAnswerRate: 0,
      emptyAnswerRate: 0,
    };
    expect(overallScore(allMax)).toBe(1.0);

    const allMin: MetricSet = {
      retrievalScore: 0,
      generationScore: 0,
      safetyScore: 0,
      efficiencyScore: 0,
      promptEchoRate: 1,
      malformedAnswerRate: 1,
      emptyAnswerRate: 1,
    };
    expect(overallScore(allMin)).toBe(0);
  });

  it("heavily penalizes validity issues through 20% weight", () => {
    const perfect = overallScore(makeMetricSet());
    const withIssues = overallScore(
      makeMetricSet({ malformedAnswerRate: 0.5 }),
    );
    // Score should drop noticeably but not to zero
    expect(withIssues).toBeGreaterThan(0);
    expect(withIssues).toBeLessThan(perfect);
    // Drop should be at least 3 percentage points (validity went from 1.0 to 0.833)
    expect(perfect - withIssues).toBeGreaterThan(0.03);
  });

  it("weights sum to exactly 1.0", () => {
    const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it("throws on NaN inputs before scoring", () => {
    const ms: MetricSet = {
      retrievalScore: NaN,
      generationScore: 0.9,
      safetyScore: 0.7,
      efficiencyScore: 0.6,
      promptEchoRate: 0,
      malformedAnswerRate: 0,
      emptyAnswerRate: 0,
    };
    expect(() => overallScore(ms)).toThrow(
      "Metric field retrievalScore must be finite",
    );
  });

  it("throws on Infinity inputs before scoring", () => {
    const ms = makeMetricSet({ promptEchoRate: Infinity });
    expect(() => overallScore(ms)).toThrow(
      "Metric field promptEchoRate must be finite",
    );
  });

  it("handles negative rate values by clamping evaluatorValidityScore", () => {
    const ms = makeMetricSet({ promptEchoRate: -0.1 });
    const scores = buildGroupedScores(ms);
    // 1 - (-0.1) = 1.1, clamped to 1.0
    expect(scores.evaluatorValidityScore).toBe(1);
  });
});
