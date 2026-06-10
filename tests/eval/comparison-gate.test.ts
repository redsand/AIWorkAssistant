import { describe, it, expect } from "vitest";
import {
  evaluateRetrievalReadiness,
  countCategoryCases,
  countRagWins,
  NO_RAG_WIN_CATEGORIES,
} from "../../src/eval/comparison/thresholds";
import { computeRetrievalScore } from "../../src/eval/comparison/compareMetrics";
import type { ComparisonRunResult, ComparisonCase } from "../../src/eval/comparison/reportTypes";

function makeCase(
  category: ComparisonCase["category"],
  winner: ComparisonCase["overallWinner"] = "claimkit",
): ComparisonCase {
  return {
    query: `test-${category}`,
    category,
    overallWinner: winner,
    rag: { contextTokens: 100, sections: 1, processingTimeMs: 50 },
    claimkit: {
      confidence: 0.9,
      answerability: "answerable",
      claimCount: 1,
      processingTimeMs: 60,
      contradictions: 0,
    },
  };
}

function makeResult(cases: ComparisonCase[]): ComparisonRunResult {
  const claimkitWins = cases.filter(c => c.overallWinner === "claimkit").length;
  const ragWins = cases.filter(c => c.overallWinner === "rag").length;
  const ties = cases.filter(c => c.overallWinner === "tie").length;
  return {
    totalCases: cases.length,
    cases,
    aggregate: {
      wins: { claimkit: claimkitWins, rag: ragWins, tie: ties },
      claimkit: {
        mean: { confidence: 0.9, answerabilityRate: 0.9, avgClaims: 1, avgTimeMs: 60 },
      },
      rag: { mean: { avgTokens: 100, avgSections: 1, avgTimeMs: 50 } },
    },
  };
}

describe("NO_RAG_WIN_CATEGORIES", () => {
  it("includes the three critical categories", () => {
    expect(NO_RAG_WIN_CATEGORIES).toContain("direct_fact");
    expect(NO_RAG_WIN_CATEGORIES).toContain("citation_laundering");
    expect(NO_RAG_WIN_CATEGORIES).toContain("staleness");
  });
});

describe("countCategoryCases", () => {
  it("counts cases matching a category", () => {
    const result = makeResult([
      makeCase("direct_fact"),
      makeCase("direct_fact"),
      makeCase("staleness"),
    ]);
    expect(countCategoryCases(result, "direct_fact")).toBe(2);
  });

  it("returns 0 when no cases match the category", () => {
    const result = makeResult([makeCase("staleness")]);
    expect(countCategoryCases(result, "direct_fact")).toBe(0);
  });
});

describe("countRagWins", () => {
  it("counts RAG wins in a specific category", () => {
    const result = makeResult([
      makeCase("direct_fact", "rag"),
      makeCase("direct_fact", "claimkit"),
      makeCase("direct_fact", "rag"),
    ]);
    expect(countRagWins(result, "direct_fact")).toBe(2);
  });

  it("returns 0 when no RAG wins in the category", () => {
    const result = makeResult([
      makeCase("direct_fact", "claimkit"),
      makeCase("direct_fact", "tie"),
    ]);
    expect(countRagWins(result, "direct_fact")).toBe(0);
  });
});

describe("evaluateRetrievalReadiness", () => {
  it("fails when direct_fact has zero cases", () => {
    const result = makeResult([
      makeCase("citation_laundering"),
      makeCase("staleness"),
    ]);
    const readiness = evaluateRetrievalReadiness(result);
    expect(readiness.productReady).toBe(false);
    const coverage = readiness.checks.find(
      c => c.name === "Retrieval product-ready: direct_fact coverage",
    );
    expect(coverage).toBeDefined();
    expect(coverage!.passed).toBe(false);
  });

  it("fails when citation_laundering has zero cases", () => {
    const result = makeResult([
      makeCase("direct_fact"),
      makeCase("staleness"),
    ]);
    const readiness = evaluateRetrievalReadiness(result);
    expect(readiness.productReady).toBe(false);
    const coverage = readiness.checks.find(
      c => c.name === "Retrieval product-ready: citation_laundering coverage",
    );
    expect(coverage).toBeDefined();
    expect(coverage!.passed).toBe(false);
  });

  it("fails when staleness has zero cases", () => {
    const result = makeResult([
      makeCase("direct_fact"),
      makeCase("citation_laundering"),
    ]);
    const readiness = evaluateRetrievalReadiness(result);
    expect(readiness.productReady).toBe(false);
    const coverage = readiness.checks.find(
      c => c.name === "Retrieval product-ready: staleness coverage",
    );
    expect(coverage).toBeDefined();
    expect(coverage!.passed).toBe(false);
  });

  it("passes when all four categories have cases and 0 RAG wins", () => {
    const result = makeResult([
      makeCase("direct_fact", "claimkit"),
      makeCase("citation_laundering", "claimkit"),
      makeCase("staleness", "tie"),
      makeCase("planning_synthesis", "claimkit"),
    ]);
    const readiness = evaluateRetrievalReadiness(result);
    expect(readiness.productReady).toBe(true);
  });

  it("fails when a category has cases but RAG wins some", () => {
    const result = makeResult([
      makeCase("direct_fact", "rag"),
      makeCase("citation_laundering", "claimkit"),
      makeCase("staleness", "claimkit"),
    ]);
    const readiness = evaluateRetrievalReadiness(result);
    expect(readiness.productReady).toBe(false);
    const ragWinsCheck = readiness.checks.find(
      c => c.name === "Retrieval product-ready: direct_fact RAG wins",
    );
    expect(ragWinsCheck).toBeDefined();
    expect(ragWinsCheck!.passed).toBe(false);
  });

  it("fails RAG wins check when category has zero cases", () => {
    const result = makeResult([
      makeCase("citation_laundering"),
      makeCase("staleness"),
    ]);
    const readiness = evaluateRetrievalReadiness(result);
    const ragWinsCheck = readiness.checks.find(
      c => c.name === "Retrieval product-ready: direct_fact RAG wins",
    );
    expect(ragWinsCheck).toBeDefined();
    expect(ragWinsCheck!.passed).toBe(false);
  });

  it("produces both coverage and RAG-wins checks per category", () => {
    const result = makeResult([
      makeCase("direct_fact"),
      makeCase("citation_laundering"),
      makeCase("staleness"),
      makeCase("planning_synthesis"),
    ]);
    const readiness = evaluateRetrievalReadiness(result);
    expect(readiness.checks).toHaveLength(8);
    const names = readiness.checks.map(c => c.name);
    for (const cat of NO_RAG_WIN_CATEGORIES) {
      expect(names).toContain(`Retrieval product-ready: ${cat} coverage`);
      expect(names).toContain(`Retrieval product-ready: ${cat} RAG wins`);
    }
  });
});

describe("computeRetrievalScore", () => {
  it("returns 1.0 when all sub-metrics are 1.0", () => {
    expect(
      computeRetrievalScore({
        evidenceRecall: 1.0,
        evidencePrecision: 1.0,
        packetCompactness: 1.0,
        citationAvailability: 1.0,
      }),
    ).toBeCloseTo(1.0, 10);
  });

  it("returns 0.0 when all sub-metrics are 0.0", () => {
    expect(
      computeRetrievalScore({
        evidenceRecall: 0.0,
        evidencePrecision: 0.0,
        packetCompactness: 0.0,
        citationAvailability: 0.0,
      }),
    ).toBe(0.0);
  });

  it("weights evidenceRecall at 0.30", () => {
    expect(
      computeRetrievalScore({
        evidenceRecall: 1.0,
        evidencePrecision: 0.0,
        packetCompactness: 0.0,
        citationAvailability: 0.0,
      }),
    ).toBeCloseTo(0.30, 10);
  });

  it("weights evidencePrecision at 0.35", () => {
    expect(
      computeRetrievalScore({
        evidenceRecall: 0.0,
        evidencePrecision: 1.0,
        packetCompactness: 0.0,
        citationAvailability: 0.0,
      }),
    ).toBeCloseTo(0.35, 10);
  });

  it("weights packetCompactness at 0.20", () => {
    expect(
      computeRetrievalScore({
        evidenceRecall: 0.0,
        evidencePrecision: 0.0,
        packetCompactness: 1.0,
        citationAvailability: 0.0,
      }),
    ).toBeCloseTo(0.20, 10);
  });

  it("weights citationAvailability at 0.15", () => {
    expect(
      computeRetrievalScore({
        evidenceRecall: 0.0,
        evidencePrecision: 0.0,
        packetCompactness: 0.0,
        citationAvailability: 1.0,
      }),
    ).toBeCloseTo(0.15, 10);
  });

  it("produces ~0.79 with mixed realistic values", () => {
    expect(
      computeRetrievalScore({
        evidenceRecall: 0.95,
        evidencePrecision: 0.70,
        packetCompactness: 0.70,
        citationAvailability: 0.80,
      }),
    ).toBeCloseTo(0.79, 2);
  });

  it("clamps values exceeding 1.0 back to 1.0", () => {
    expect(
      computeRetrievalScore({
        evidenceRecall: 2.0,
        evidencePrecision: 2.0,
        packetCompactness: 2.0,
        citationAvailability: 2.0,
      }),
    ).toBe(1.0);
  });
});
