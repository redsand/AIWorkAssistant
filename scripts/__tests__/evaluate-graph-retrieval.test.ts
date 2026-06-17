// scripts/__tests__/evaluate-graph-retrieval.test.ts
import { describe, it, expect } from "vitest";
import {
  computeAccuracy,
  extractSearchTerms,
  generateReport,
  retrieveGraphEntities,
  RAG_BASELINE_HALLUCINATION_RATE,
  type GraphEvalResult,
} from "../evaluate-graph-retrieval";

function makeResult(overrides?: Partial<GraphEvalResult>): GraphEvalResult {
  return {
    query: "what depends on IR-82?",
    type: "structural",
    graphRetrieved: true,
    graphAccuracy: 1,
    claimkitVerified: true,
    ragHallucinated: false,
    graphError: false,
    latencyMs: 12,
    ...overrides,
  };
}

describe("computeAccuracy", () => {
  it("returns 1.0 for a perfect match", () => {
    expect(computeAccuracy(["IR-83", "IR-84"], ["IR-83", "IR-84"])).toBe(1);
  });

  it("returns 0.5 for a partial match (Jaccard)", () => {
    // retrieved {IR-83}, truth {IR-83, IR-84} -> 1 / 2 = 0.5
    expect(computeAccuracy(["IR-83"], ["IR-83", "IR-84"])).toBe(0.5);
  });

  it("returns 0 when there is no overlap", () => {
    expect(computeAccuracy(["X"], ["Y", "Z"])).toBe(0);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(computeAccuracy([" Auth-Service "], ["auth-service"])).toBe(1);
  });

  it("returns 1.0 when both sets are empty", () => {
    expect(computeAccuracy([], [])).toBe(1);
  });

  it("ignores extra noise in retrieved when computing the union", () => {
    // retrieved {a,b,c}, truth {a} -> intersection 1, union 3 -> 0.333...
    expect(computeAccuracy(["a", "b", "c"], ["a"])).toBeCloseTo(1 / 3, 5);
  });
});

describe("extractSearchTerms", () => {
  it("keeps identifier-like tokens and drops question words", () => {
    const terms = extractSearchTerms("what depends on IR-82?");
    expect(terms).toContain("IR-82");
    expect(terms).not.toContain("what");
    expect(terms).not.toContain("on");
  });

  it("falls back to the raw query when nothing distinctive remains", () => {
    expect(extractSearchTerms("how do the")).toEqual(["how do the"]);
  });
});

describe("generateReport", () => {
  it("includes all required sections", () => {
    const report = generateReport([makeResult()]);
    expect(report).toContain("# Graph Retrieval Evaluation Report");
    expect(report).toContain("## Summary");
    expect(report).toContain("## Retrieval Comparison");
    expect(report).toContain("## Hallucination Rate");
    expect(report).toContain("## Per-Query Results");
    expect(report).toContain("## Recommendations");
  });

  it("reports the RAG baseline hallucination rate", () => {
    const report = generateReport([makeResult()]);
    expect(report).toContain(`${(RAG_BASELINE_HALLUCINATION_RATE * 100).toFixed(1)}%`);
  });

  it("computes retrieval frequency across queries", () => {
    const report = generateReport([
      makeResult({ graphRetrieved: true }),
      makeResult({ graphRetrieved: false }),
    ]);
    expect(report).toContain("Graph retrieval frequency: 50.0% (1/2)");
  });

  it("handles an empty result set without throwing", () => {
    const report = generateReport([]);
    expect(report).toContain("## Summary");
    expect(report).toContain("No queries were evaluated");
  });

  it("escapes pipe characters in query text", () => {
    const report = generateReport([makeResult({ query: "a | b" })]);
    expect(report).toContain("a \\| b");
  });

  it("escapes pipe characters in the type column", () => {
    const report = generateReport([makeResult({ type: "structural | meta" })]);
    expect(report).toContain("structural \\| meta");
  });

  it("reports the graph query error count", () => {
    const report = generateReport([
      makeResult({ graphError: true, graphRetrieved: false }),
      makeResult({ graphError: false }),
    ]);
    expect(report).toContain("Graph query errors: 1/2");
    expect(report).toMatch(/Graph retrieval threw on 1\/2 query/);
  });

  it("omits the graph-error recommendation when there are no errors", () => {
    const report = generateReport([makeResult({ graphError: false })]);
    expect(report).toContain("Graph query errors: 0/1");
    expect(report).not.toMatch(/Graph retrieval threw/);
  });
});

describe("retrieveGraphEntities", () => {
  it("returns an entities array and a numeric latency without throwing", () => {
    const result = retrieveGraphEntities("what depends on IR-82?");
    expect(Array.isArray(result.entities)).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
