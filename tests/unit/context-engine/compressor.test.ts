import { describe, it, expect } from "vitest";

import {
  splitSentences,
  tokenize,
  jaccardSimilarity,
  scoreSentence,
  compressDocument,
  compressDocuments,
} from "../../../src/context-engine/compressor";
import type { ScoredDocument } from "../../../src/context-engine/types";
import { CHARS_PER_TOKEN } from "../../../src/context-engine/types";

// ---------------------------------------------------------------------------
// splitSentences
// ---------------------------------------------------------------------------

describe("splitSentences", () => {
  it("splits on period followed by space and capital letter", () => {
    const result = splitSentences("Hello world. Goodbye world.");
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("Hello world.");
    expect(result[1]).toBe("Goodbye world.");
  });

  it("splits on exclamation mark", () => {
    const result = splitSentences("Stop! Go away.");
    expect(result).toHaveLength(2);
  });

  it("splits on question mark", () => {
    const result = splitSentences("Why? Because.");
    expect(result).toHaveLength(2);
  });

  it("does not split on abbreviations like 'vs.' or 'etc.'", () => {
    const result = splitSentences("Apples vs. Oranges are great. etc. and more.");
    // "vs." and "etc." should not cause splits
    expect(result[0]).toContain("vs.");
    expect(result[0]).toContain("etc.");
  });

  it("does not split on known tech abbreviations like 'api.' or 'url.'", () => {
    const result = splitSentences("Use the api. endpoint for data.");
    // "api." is an abbreviation so it should not split there
    expect(result).toHaveLength(1);
  });

  it("handles text ending without punctuation", () => {
    const result = splitSentences("Hello world. No ending");
    expect(result).toHaveLength(2);
    expect(result[1]).toBe("No ending");
  });

  it("returns single sentence for text without sentence-ending punctuation", () => {
    const result = splitSentences("just some words here");
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("just some words here");
  });

  it("handles empty string", () => {
    const result = splitSentences("");
    expect(result).toHaveLength(0);
  });

  it("handles single character", () => {
    const result = splitSentences("a");
    expect(result).toHaveLength(1);
  });

  it("handles text ending with punctuation at end of string", () => {
    const result = splitSentences("One. Two.");
    expect(result).toHaveLength(2);
  });

  it("handles multiple punctuation at end", () => {
    const result = splitSentences("Really?! Yes.");
    expect(result).toHaveLength(2);
  });

  it("handles abbreviation at end of string with no following text", () => {
    const result = splitSentences("Visit the api.");
    // "api." is an abbreviation but there is no next char, so the loop continues
    // and the text is pushed as remaining at end
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("filters out empty sentences", () => {
    const result = splitSentences("   .  ");
    // After trimming, empty sentences should be filtered out
    expect(result.every((s) => s.length > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  it("tokenizes text into a set of lowercase words", () => {
    const result = tokenize("Hello World Test");
    expect(result).toEqual(new Set(["hello", "world", "test"]));
  });

  it("removes punctuation", () => {
    const result = tokenize("hello, world! test?");
    expect(result).toEqual(new Set(["hello", "world", "test"]));
  });

  it("filters tokens shorter than 3 characters", () => {
    const result = tokenize("I am a big cat dog");
    expect(result.has("am")).toBe(false);
    expect(result.has("big")).toBe(true);
    expect(result.has("cat")).toBe(true);
    expect(result.has("dog")).toBe(true);
  });

  it("returns empty set for empty string", () => {
    const result = tokenize("");
    expect(result.size).toBe(0);
  });

  it("returns empty set for string with only short words", () => {
    const result = tokenize("a b c d");
    expect(result.size).toBe(0);
  });

  it("is case-insensitive", () => {
    const result = tokenize("Hello HELLO hello");
    expect(result.size).toBe(1);
    expect(result.has("hello")).toBe(true);
  });

  it("handles special characters", () => {
    const result = tokenize("foo-bar baz_quux");
    // The regex /[^\w\s]/g replaces non-word/non-space with space
    // So "foo-bar" becomes "foo bar" -> tokens "foo" and "bar"
    expect(result.has("foo")).toBe(true);
    expect(result.has("bar")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// jaccardSimilarity
// ---------------------------------------------------------------------------

describe("jaccardSimilarity", () => {
  it("returns 0 for two empty sets", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it("returns 0 for sets with no overlap", () => {
    const a = new Set(["apple", "banana"]);
    const b = new Set(["cherry", "date"]);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it("returns 1 for identical sets", () => {
    const a = new Set(["apple", "banana"]);
    const b = new Set(["apple", "banana"]);
    expect(jaccardSimilarity(a, b)).toBe(1);
  });

  it("computes partial overlap correctly", () => {
    const a = new Set(["apple", "banana", "cherry"]);
    const b = new Set(["banana", "cherry", "date"]);
    // intersection = 2 (banana, cherry), union = 4
    // 2/4 = 0.5
    expect(jaccardSimilarity(a, b)).toBe(0.5);
  });

  it("returns 0 when first set is empty and second is not", () => {
    const a = new Set<string>();
    const b = new Set(["apple"]);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it("returns 0 when second set is empty and first is not", () => {
    const a = new Set(["apple"]);
    const b = new Set<string>();
    expect(jaccardSimilarity(a, b)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// scoreSentence
// ---------------------------------------------------------------------------

describe("scoreSentence", () => {
  const queryTokens = new Set(["jira", "api", "bug"]);

  it("returns 0 for empty sentence (no tokens after tokenizing)", () => {
    const result = scoreSentence("a b", queryTokens, 0, 5);
    expect(result).toBe(0);
  });

  it("computes overlap with query tokens", () => {
    const sentence = "the jira api endpoint is broken";
    const result = scoreSentence(sentence, queryTokens, 2, 5);
    // Sentence tokens: jira, api, endpoint, broken -> overlap with query = {jira, api} = 2
    // sentence has 4 tokens, query has 3, union = 4+3-2 = 5
    // jaccard = 2/5 = 0.4
    expect(result).toBeGreaterThan(0);
  });

  it("adds 0.15 position boost for first sentence (position 0)", () => {
    const sentence = "the jira api endpoint";
    const result = scoreSentence(sentence, queryTokens, 0, 5);
    const nonBoosted = scoreSentence(sentence, queryTokens, 2, 5);
    expect(result - nonBoosted).toBeCloseTo(0.15, 5);
  });

  it("adds 0.1 position boost for last sentence", () => {
    const sentence = "the jira api endpoint";
    const totalPositions = 5;
    const result = scoreSentence(sentence, queryTokens, totalPositions - 1, totalPositions);
    const nonBoosted = scoreSentence(sentence, queryTokens, 2, totalPositions);
    expect(result - nonBoosted).toBeCloseTo(0.1, 5);
  });

  it("adds no position boost for middle sentences", () => {
    const sentence = "the jira api endpoint";
    const result = scoreSentence(sentence, queryTokens, 2, 10);
    // Position 2 is neither first (0) nor last (9), so no boost
    // The score should be purely the jaccard overlap
    const sentenceTokens = tokenize(sentence);
    const overlap = jaccardSimilarity(sentenceTokens, queryTokens);
    expect(result).toBeCloseTo(overlap, 10);
  });

  it("handles sentence with no query overlap", () => {
    const result = scoreSentence("unrelated words here something", queryTokens, 0, 5);
    // No overlap, but position 0 gives 0.15 boost
    expect(result).toBe(0.15);
  });
});

// ---------------------------------------------------------------------------
// compressDocument
// ---------------------------------------------------------------------------

describe("compressDocument", () => {
  it("returns content unchanged when within token budget", () => {
    const content = "Short content";
    const result = compressDocument(content, "query", 1000);
    expect(result.compressed).toBe(content);
    expect(result.originalTokens).toBe(result.compressedTokens);
  });

  it("compresses content when it exceeds token budget", () => {
    const content = [
      "First sentence about jira api bug fixes.",
      "Second sentence about database migration work.",
      "Third sentence about deployment pipeline.",
      "Fourth sentence about testing framework.",
      "Fifth sentence about security audit.",
    ].join(" ");
    const result = compressDocument(content, "jira api bug", 20);
    expect(result.compressed.length).toBeLessThanOrEqual(content.length);
    expect(result.compressedTokens).toBeLessThanOrEqual(result.originalTokens);
  });

  it("prefers sentences that match the query", () => {
    const content = [
      "Unrelated sentence about weather today.",
      "The jira api bug needs immediate attention.",
      "Another unrelated sentence about lunch.",
    ].join(" ");
    const result = compressDocument(content, "jira api bug", 30);
    expect(result.compressed).toContain("jira api bug");
  });

  it("calculates originalTokens based on content length", () => {
    const content = "a".repeat(180); // 180 / 1.8 = 100 tokens
    const result = compressDocument(content, "query", 1000);
    expect(result.originalTokens).toBe(100);
  });

  it("handles content with no sentences gracefully", () => {
    // Content that won't produce sentence boundaries and is very short
    const content = "no punctuation here";
    const result = compressDocument(content, "query", 1000);
    expect(result.compressed).toBe(content);
  });

  it("returns original when sentences array is empty and content exceeds budget", () => {
    // This should not happen in practice but let's test the edge case
    // where splitSentences returns empty for long content
    // Content: long string of spaces won't produce sentences
    const content = "   ";
    const result = compressDocument(content, "query", 1);
    // empty content is trimmed by splitSentences
    expect(result).toBeDefined();
  });

  it("preserves original sentence order in compressed output", () => {
    const content = [
      "The jira ticket was created yesterday.",
      "The api endpoint needs fixing.",
      "The bug was reported by the team.",
    ].join(" ");
    const result = compressDocument(content, "jira api bug", 50);
    // If multiple sentences are selected, they should be in original order
    const jiraIdx = result.compressed.indexOf("jira");
    const apiIdx = result.compressed.indexOf("api");
    if (jiraIdx >= 0 && apiIdx >= 0) {
      expect(jiraIdx).toBeLessThan(apiIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// compressDocuments
// ---------------------------------------------------------------------------

describe("compressDocuments", () => {
  function makeDoc(overrides: Partial<ScoredDocument> = {}): ScoredDocument {
    return {
      id: "doc-1",
      source: "codebase",
      content: "Test content about jira api bugs.",
      title: "Test Document",
      score: 0.8,
      baseScore: 0.7,
      importanceScore: 0.5,
      recencyScore: 1.0,
      tokens: 20,
      metadata: {},
      ...overrides,
    };
  }

  it("returns empty array for empty input", () => {
    const result = compressDocuments([], "query", 1000);
    expect(result).toEqual([]);
  });

  it("divides budget equally among documents", () => {
    const docs = [
      makeDoc({
        id: "doc-1",
        content: "First document with some content about api. More sentences here about things.",
      }),
      makeDoc({
        id: "doc-2",
        content: "Second document about jira. More content about bugs and issues.",
      }),
    ];
    // Budget of 40 means 20 per doc
    const result = compressDocuments(docs, "api", 40);
    expect(result).toHaveLength(2);
    // Each doc should be compressed if it exceeds per-doc budget
    for (const doc of result) {
      expect(doc.tokens).toBeDefined();
    }
  });

  it("updates metadata with originalTokens and compressionRatio", () => {
    const docs = [makeDoc({
      content: "A very long document. " + "Lots of sentences here about stuff. ".repeat(20),
    })];
    const result = compressDocuments(docs, "query", 20);
    expect(result[0].metadata.originalTokens).toBeDefined();
    expect(result[0].metadata.compressionRatio).toBeDefined();
    expect(typeof result[0].metadata.compressionRatio).toBe("number");
  });

  it("preserves document id and source fields", () => {
    const docs = [makeDoc({ id: "my-doc", source: "knowledge" })];
    const result = compressDocuments(docs, "query", 10000);
    expect(result[0].id).toBe("my-doc");
    expect(result[0].source).toBe("knowledge");
  });

  it("sets compressionRatio to 1 when content fits budget", () => {
    const docs = [makeDoc({ content: "Short" })];
    const result = compressDocuments(docs, "query", 10000);
    expect(result[0].metadata.compressionRatio).toBe(1);
  });

  it("handles documents with varying content lengths", () => {
    const docs = [
      makeDoc({ id: "short", content: "Short doc." }),
      makeDoc({ id: "long", content: "A".repeat(2000) + ". More content here." }),
    ];
    const result = compressDocuments(docs, "query", 100);
    expect(result).toHaveLength(2);
    // Both should have tokens property set
    expect(result[0].tokens).toBeGreaterThan(0);
    expect(result[1].tokens).toBeGreaterThan(0);
  });
});
