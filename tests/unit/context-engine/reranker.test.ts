import { describe, it, expect } from "vitest";

import {
  computeImportance,
  computeQueryRelevance,
  blendScores,
  applyDiversityPenalty,
  rerank,
} from "../../../src/context-engine/reranker";
import type { ScoredDocument, RerankOptions } from "../../../src/context-engine/types";
import { DEFAULT_RERANK_OPTIONS } from "../../../src/context-engine/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoc(overrides: Partial<ScoredDocument> = {}): ScoredDocument {
  return {
    id: "doc-1",
    source: "codebase",
    content: "Test content",
    title: "Test Title",
    score: 0.5,
    baseScore: 0.5,
    importanceScore: 0.0,
    recencyScore: 1.0,
    tokens: 10,
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeImportance (reranker version)
// ---------------------------------------------------------------------------

describe("computeImportance (reranker)", () => {
  it("adds 0.2 for content longer than 200 chars", () => {
    const doc = makeDoc({ content: "a".repeat(201) });
    const result = computeImportance(doc);
    expect(result).toBeGreaterThanOrEqual(0.2);
  });

  it("adds 0.15 additional for content longer than 500 chars", () => {
    const doc = makeDoc({ content: "b".repeat(501) });
    const result = computeImportance(doc);
    // 0.2 (>200) + 0.15 (>500) = 0.35
    expect(result).toBeGreaterThanOrEqual(0.35);
  });

  it("adds 0.1 additional for content longer than 1500 chars", () => {
    const doc = makeDoc({ content: "c".repeat(1501) });
    const result = computeImportance(doc);
    // 0.2 + 0.15 + 0.1 = 0.45
    expect(result).toBeCloseTo(0.45, 1);
  });

  it("adds 0.15 for content with code blocks", () => {
    const doc = makeDoc({ content: "Here is code:\n```js\nconsole.log('hi')\n```\nDone." });
    const result = computeImportance(doc);
    expect(result).toBeGreaterThanOrEqual(0.15);
  });

  it("does not add code block bonus without fenced code blocks", () => {
    const doc = makeDoc({ content: "No code here just plain text" });
    const result = computeImportance(doc);
    // Short content, no code blocks, no list items, no special source
    expect(result).toBe(0);
  });

  it("adds 0.1 for content with numbered list items", () => {
    const doc = makeDoc({ content: "Steps:\n1. First step\n2. Second step\nDone." });
    const result = computeImportance(doc);
    expect(result).toBeGreaterThanOrEqual(0.1);
  });

  it("does not add list bonus for text without numbered items", () => {
    const doc = makeDoc({ content: "Some text without numbered items" });
    const result = computeImportance(doc);
    expect(result).toBe(0);
  });

  it("adds 0.1 for graph source", () => {
    const doc = makeDoc({ source: "graph" });
    const result = computeImportance(doc);
    expect(result).toBeGreaterThanOrEqual(0.1);
  });

  it("adds 0.05 for knowledge source", () => {
    const doc = makeDoc({ source: "knowledge" });
    const result = computeImportance(doc);
    expect(result).toBeGreaterThanOrEqual(0.05);
  });

  it("does not add source bonus for codebase source", () => {
    const doc = makeDoc({ source: "codebase" });
    const result = computeImportance(doc);
    expect(result).toBe(0);
  });

  it("caps total importance at 1.0", () => {
    const doc = makeDoc({
      source: "graph",
      content: "a".repeat(1501) + "\n```\ncode\n```\n1. item\n",
    });
    const result = computeImportance(doc);
    expect(result).toBeLessThanOrEqual(1.0);
  });

  it("returns 0 for minimal content with no bonuses", () => {
    const doc = makeDoc({ source: "codebase", content: "hi", title: "ok" });
    expect(computeImportance(doc)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeQueryRelevance
// ---------------------------------------------------------------------------

describe("computeQueryRelevance", () => {
  it("returns 0 when query and doc have no overlapping tokens", () => {
    const doc = makeDoc({ content: "the weather is sunny today", title: "Weather" });
    const result = computeQueryRelevance(doc, "database migration schema");
    expect(result).toBe(0);
  });

  it("returns higher values for content that matches the query", () => {
    const doc = makeDoc({ content: "jira api endpoint bug fix", title: "Bug Fix" });
    const result = computeQueryRelevance(doc, "jira api bug");
    expect(result).toBeGreaterThan(0);
  });

  it("includes title tokens in relevance computation", () => {
    const doc = makeDoc({ content: "unrelated content here", title: "jira api bug" });
    const result = computeQueryRelevance(doc, "jira api bug");
    expect(result).toBeGreaterThan(0);
  });

  it("returns 0 for empty query", () => {
    const doc = makeDoc({ content: "jira api bug fix", title: "Bug Fix" });
    const result = computeQueryRelevance(doc, "");
    expect(result).toBe(0);
  });

  it("returns 1.0 for identical content and query", () => {
    const text = "jira api endpoint bug fix";
    const doc = makeDoc({ content: text, title: "" });
    const result = computeQueryRelevance(doc, text);
    expect(result).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// blendScores
// ---------------------------------------------------------------------------

describe("blendScores", () => {
  const defaultOpts: RerankOptions = DEFAULT_RERANK_OPTIONS;

  it("computes weighted sum of baseScore, importance, and queryRelevance", () => {
    const doc = makeDoc({
      baseScore: 0.8,
      content: "jira api bug fix endpoint error",
      title: "Bug Report",
    });
    const result = blendScores(doc, "jira api bug", defaultOpts);
    const importance = computeImportance(doc);
    const queryRel = computeQueryRelevance(doc, "jira api bug");
    const expected =
      0.8 * defaultOpts.baseScoreWeight +
      importance * defaultOpts.importanceWeight +
      queryRel * defaultOpts.queryRelevanceWeight;
    expect(result).toBeCloseTo(expected, 10);
  });

  it("returns pure baseScore contribution when content is irrelevant to query", () => {
    const doc = makeDoc({ baseScore: 0.9, content: "weather", title: "Forecast" });
    const result = blendScores(doc, "database migration", defaultOpts);
    expect(result).toBeCloseTo(0.9 * defaultOpts.baseScoreWeight, 5);
  });

  it("respects custom weights", () => {
    const doc = makeDoc({ baseScore: 1.0, content: "test content here", title: "Test" });
    const customOpts: RerankOptions = {
      baseScoreWeight: 1.0,
      importanceWeight: 0.0,
      queryRelevanceWeight: 0.0,
      diversityPenalty: 0,
    };
    const result = blendScores(doc, "irrelevant query", customOpts);
    expect(result).toBeCloseTo(1.0, 10);
  });
});

// ---------------------------------------------------------------------------
// applyDiversityPenalty
// ---------------------------------------------------------------------------

describe("applyDiversityPenalty", () => {
  it("returns docs unchanged for single document", () => {
    const docs = [makeDoc({ score: 0.9 })];
    const result = applyDiversityPenalty(docs, 0.1);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.9);
  });

  it("returns empty array for empty input", () => {
    const result = applyDiversityPenalty([], 0.1);
    expect(result).toEqual([]);
  });

  it("penalizes documents similar to earlier ones", () => {
    const docs = [
      makeDoc({ id: "a", content: "jira api bug fix endpoint error", score: 1.0 }),
      makeDoc({ id: "b", content: "jira api bug fix endpoint error", score: 0.9 }),
    ];
    const result = applyDiversityPenalty(docs, 0.5);
    // Second doc should have its score reduced since it's identical to the first
    const secondDoc = result.find((d) => d.id === "b");
    expect(secondDoc!.score).toBeLessThan(0.9);
  });

  it("does not penalize dissimilar documents", () => {
    const docs = [
      makeDoc({ id: "a", content: "weather forecast sunny rainy", score: 1.0 }),
      makeDoc({ id: "b", content: "database migration schema change", score: 0.9 }),
    ];
    const result = applyDiversityPenalty(docs, 0.1);
    // These have very different content, penalty should be minimal
    const secondDoc = result.find((d) => d.id === "b");
    expect(secondDoc!.score).toBeGreaterThan(0.8);
  });

  it("sorts results by score descending after penalty", () => {
    const docs = [
      makeDoc({ id: "a", content: "first document content about api", score: 0.5 }),
      makeDoc({ id: "b", content: "second document about database", score: 0.8 }),
      makeDoc({ id: "c", content: "third document about security", score: 0.6 }),
    ];
    const result = applyDiversityPenalty(docs, 0.05);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].score).toBeLessThanOrEqual(result[i - 1].score);
    }
  });

  it("applies zero penalty when penalty parameter is 0", () => {
    const docs = [
      makeDoc({ id: "a", content: "same content here", score: 1.0 }),
      makeDoc({ id: "b", content: "same content here", score: 0.9 }),
    ];
    const result = applyDiversityPenalty(docs, 0);
    const secondDoc = result.find((d) => d.id === "b");
    expect(secondDoc!.score).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// rerank
// ---------------------------------------------------------------------------

describe("rerank", () => {
  it("returns empty array for empty input", () => {
    const result = rerank([], "query");
    expect(result).toEqual([]);
  });

  it("returns single document unchanged", () => {
    const docs = [makeDoc({ score: 0.5 })];
    const result = rerank(docs, "query");
    expect(result).toHaveLength(1);
  });

  it("sets importanceScore on results", () => {
    const docs = [makeDoc({ content: "a".repeat(201) })];
    const result = rerank(docs, "query");
    expect(result[0].importanceScore).toBeGreaterThan(0);
  });

  it("sorts by blended score before diversity penalty", () => {
    const docs = [
      makeDoc({ id: "low", baseScore: 0.2, content: "low relevance content", title: "Low", score: 0.2 }),
      makeDoc({ id: "high", baseScore: 0.9, content: "jira api bug fix", title: "High", score: 0.9 }),
    ];
    const result = rerank(docs, "jira api bug");
    // The high-relevance doc should come first
    expect(result[0].id).toBe("high");
  });

  it("uses default options when none provided", () => {
    const docs = [makeDoc(), makeDoc()];
    const result = rerank(docs, "query");
    expect(result).toHaveLength(2);
  });

  it("respects custom rerank options", () => {
    const docs = [
      makeDoc({
        id: "base-only",
        baseScore: 1.0,
        content: "unrelated content",
        title: "Base",
        score: 0.5,
      }),
      makeDoc({
        id: "query-match",
        baseScore: 0.0,
        content: "jira api bug endpoint fix",
        title: "Query",
        score: 0.5,
      }),
    ];
    const customOpts: RerankOptions = {
      baseScoreWeight: 0.0,
      importanceWeight: 0.0,
      queryRelevanceWeight: 1.0,
      diversityPenalty: 0,
    };
    const result = rerank(docs, "jira api bug", customOpts);
    expect(result[0].id).toBe("query-match");
  });

  it("applies diversity penalty as part of reranking", () => {
    const docs = [
      makeDoc({ id: "dup-a", content: "jira api bug fix error", baseScore: 0.9, score: 0.9 }),
      makeDoc({ id: "dup-b", content: "jira api bug fix error", baseScore: 0.8, score: 0.8 }),
      makeDoc({ id: "unique", content: "database migration schema change", baseScore: 0.7, score: 0.7 }),
    ];
    const result = rerank(docs, "jira api", {
      ...DEFAULT_RERANK_OPTIONS,
      diversityPenalty: 1.0, // heavy penalty for similarity
    });
    // The duplicate should be heavily penalized
    const dupB = result.find((d) => d.id === "dup-b");
    expect(dupB!.score).toBeLessThan(0.5);
  });

  it("preserves all original document fields", () => {
    const docs = [
      makeDoc({
        id: "doc-1",
        source: "knowledge",
        content: "test content",
        title: "Test Title",
        baseScore: 0.8,
        tokens: 15,
        metadata: { foo: "bar" },
      }),
    ];
    const result = rerank(docs, "test");
    expect(result[0].id).toBe("doc-1");
    expect(result[0].source).toBe("knowledge");
    expect(result[0].title).toBe("Test Title");
    expect(result[0].tokens).toBe(15);
    expect(result[0].metadata).toEqual({ foo: "bar" });
  });
});
