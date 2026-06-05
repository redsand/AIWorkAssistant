import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { ComparisonRunDatabase } from "../../../src/comparison-runs/database";
import { saveLiveComparison, saveBatchComparison } from "../../../src/comparison-runs/auto-capture";
import type { ComparisonRunResult } from "../../../src/eval/comparison/reportTypes";

const TEST_DB = path.join(process.cwd(), "data", "test-comparison-diag.db");

function cleanDb() {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  if (fs.existsSync(TEST_DB + "-wal")) fs.unlinkSync(TEST_DB + "-wal");
  if (fs.existsSync(TEST_DB + "-shm")) fs.unlinkSync(TEST_DB + "-shm");
}

describe("ComparisonRunDatabase — diagnostic fields", () => {
  let db: ComparisonRunDatabase;

  beforeEach(() => {
    cleanDb();
    db = new ComparisonRunDatabase(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanDb();
  });

  describe("schema migration", () => {
    it("stores and retrieves all new diagnostic columns", () => {
      const run = db.createRun({
        source: "live",
        description: "test diagnostic fields",
        cases: [
          {
            query: "What is the auth middleware?",
            category: "code_retrieval",
            overallWinner: "rag",
            winnerReason: "low_confidence",
            rag: { contextTokens: 500, sections: 3, processingTimeMs: 45 },
            claimkit: {
              confidence: 0.2,
              answerability: "answerable",
              claimCount: 2,
              processingTimeMs: 120,
              contradictions: 0,
              answer: "The auth middleware validates tokens.",
              retrievalScore: 0.35,
              sourceCount: 1,
              missingEvidence: "session token format, timing safe comparison",
            },
          },
        ],
      });

      const c = run.cases[0];
      expect(c.ck_answer).toBe("The auth middleware validates tokens.");
      expect(c.ck_retrieval_score).toBe(0.35);
      expect(c.ck_source_count).toBe(1);
      expect(c.ck_missing_evidence).toBe("session token format, timing safe comparison");
      expect(c.winner_reason).toBe("low_confidence");
    });

    it("stores nulls for optional diagnostic fields when claimkit is null", () => {
      const run = db.createRun({
        source: "live",
        cases: [
          {
            query: "test",
            category: "direct_fact",
            overallWinner: "rag",
            winnerReason: "ck_unavailable",
            rag: { contextTokens: 100, sections: 1, processingTimeMs: 10 },
            claimkit: null,
          },
        ],
      });

      const c = run.cases[0];
      expect(c.ck_answer).toBeNull();
      expect(c.ck_retrieval_score).toBeNull();
      expect(c.ck_source_count).toBeNull();
      expect(c.ck_missing_evidence).toBeNull();
      expect(c.winner_reason).toBe("ck_unavailable");
    });

    it("filters answer text to 2000 chars max", () => {
      const longAnswer = "A".repeat(5000);
      const run = db.createRun({
        source: "live",
        cases: [
          {
            query: "test",
            category: "direct_fact",
            overallWinner: "rag",
            winnerReason: "not_answerable",
            rag: { contextTokens: 100, sections: 1, processingTimeMs: 10 },
            claimkit: {
              confidence: 0.1,
              answerability: "not_answerable",
              claimCount: 0,
              processingTimeMs: 50,
              contradictions: 0,
              answer: longAnswer,
              retrievalScore: 0.1,
              sourceCount: 0,
              missingEvidence: "everything",
            },
          },
        ],
      });

      const c = run.cases[0];
      expect(c.ck_answer).not.toBeNull();
      expect(c.ck_answer!.length).toBeLessThanOrEqual(2000);
    });
  });

  describe("getRun returns all diagnostic fields", () => {
    it("returns diagnostic fields in single run lookup", () => {
      const saved = db.createRun({
        source: "live",
        description: "diag lookup test",
        cases: [
          {
            query: "test query",
            category: "entity_linking",
            overallWinner: "rag",
            winnerReason: "low_confidence",
            rag: { contextTokens: 300, sections: 2, processingTimeMs: 30 },
            claimkit: {
              confidence: 0.15,
              answerability: "partially_answerable",
              claimCount: 1,
              processingTimeMs: 80,
              contradictions: 1,
              answer: "Possibly related to...",
              retrievalScore: 0.25,
              sourceCount: 2,
              missingEvidence: "entity definitions, relationship data",
            },
          },
        ],
      });

      const run = db.getRun(saved.id);
      expect(run).not.toBeNull();
      const c = run!.cases[0];
      expect(c.ck_answer).toBe("Possibly related to...");
      expect(c.ck_retrieval_score).toBe(0.25);
      expect(c.ck_source_count).toBe(2);
      expect(c.ck_missing_evidence).toBe("entity definitions, relationship data");
      expect(c.winner_reason).toBe("low_confidence");
    });
  });

  describe("source-scoped dashboard stats", () => {
    it("separates live and batch aggregate stats", () => {
      db.createRun({
        source: "live",
        description: "live run",
        cases: [
          {
            query: "live query",
            category: "direct_fact",
            overallWinner: "claimkit",
            winnerReason: "high_confidence",
            rag: { contextTokens: 100, sections: 1, processingTimeMs: 20 },
            claimkit: {
              confidence: 0.9,
              answerability: "answerable",
              claimCount: 3,
              processingTimeMs: 80,
              contradictions: 0,
            },
          },
        ],
      });
      db.createRun({
        source: "batch",
        description: "batch run",
        cases: [
          {
            query: "batch query",
            category: "direct_fact",
            overallWinner: "rag",
            winnerReason: "low_confidence",
            rag: { contextTokens: 100, sections: 1, processingTimeMs: 20 },
            claimkit: {
              confidence: 0.1,
              answerability: "answerable",
              claimCount: 1,
              processingTimeMs: 10,
              contradictions: 0,
            },
          },
        ],
      });

      const liveStats = db.getDashboardStats({ source: "live" });
      const batchStats = db.getDashboardStats({ source: "batch" });
      const allStats = db.getDashboardStats();

      expect(liveStats.source).toBe("live");
      expect(liveStats.totalRuns).toBe(1);
      expect(liveStats.overallWins).toEqual({ claimkit: 1, rag: 0, tie: 0 });
      expect(batchStats.source).toBe("batch");
      expect(batchStats.totalRuns).toBe(1);
      expect(batchStats.overallWins).toEqual({ claimkit: 0, rag: 1, tie: 0 });
      expect(allStats.source).toBe("all");
      expect(allStats.totalRuns).toBe(2);
      expect(allStats.overallWins).toEqual({ claimkit: 1, rag: 1, tie: 0 });
    });
  });
});

describe("saveLiveComparison — diagnostic fields", () => {
  let db: ComparisonRunDatabase;

  beforeEach(() => {
    cleanDb();
    db = new ComparisonRunDatabase(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanDb();
  });

  it("accepts and stores all new diagnostic parameters", () => {
    saveLiveComparison({
      query: "How does auth work?",
      overallWinner: "rag",
      winnerReason: "low_confidence",
      ragTokens: 400,
      ragSections: 2,
      ragTimeMs: 50,
      ckConfidence: 0.25,
      ckAnswerability: "answerable",
      ckClaimCount: 3,
      ckTimeMs: 100,
      ckContradictions: 0,
      ckAnswer: "The auth system works via tokens.",
      ckRetrievalScore: 0.33,
      ckSourceCount: 2,
      ckMissingEvidence: "rate limiting mechanism",
      db,
    });

    const runs = db.listRuns({ limit: 1 });
    expect(runs.runs.length).toBe(1);

    const run = db.getRun(runs.runs[0].id);
    const c = run!.cases[0];
    expect(c.ck_answer).toBe("The auth system works via tokens.");
    expect(c.ck_retrieval_score).toBe(0.33);
    expect(c.ck_source_count).toBe(2);
    expect(c.ck_missing_evidence).toBe("rate limiting mechanism");
    expect(c.winner_reason).toBe("low_confidence");
  });

  it("omits optional diagnostic fields without error", () => {
    saveLiveComparison({
      query: "simple query",
      overallWinner: "claimkit",
      ragTokens: 200,
      ragSections: 1,
      ragTimeMs: 20,
      ckConfidence: 0.85,
      ckAnswerability: "answerable",
      ckClaimCount: 5,
      ckTimeMs: 60,
      ckContradictions: 0,
      db,
    });

    const runs = db.listRuns({ limit: 1 });
    expect(runs.runs.length).toBe(1);

    const run = db.getRun(runs.runs[0].id);
    const c = run!.cases[0];
    expect(c.ck_answer).toBeNull();
    expect(c.ck_retrieval_score).toBeNull();
    expect(c.winner_reason).toBeNull();
    expect(c.overall_winner).toBe("claimkit");
  });

  it("handles ckAnswer null when ckConfidence is not null", () => {
    saveLiveComparison({
      query: "test",
      overallWinner: "tie",
      ragTokens: 100,
      ragSections: 1,
      ragTimeMs: 10,
      ckConfidence: 0.4,
      ckAnswerability: "partially_answerable",
      ckClaimCount: 1,
      ckTimeMs: 30,
      ckContradictions: 0,
      ckAnswer: null,
      ckRetrievalScore: null,
      ckSourceCount: null,
      ckMissingEvidence: null,
      db,
    });

    const runs = db.listRuns({ limit: 1 });
    const run = db.getRun(runs.runs[0].id);
    const c = run!.cases[0];
    expect(c.ck_answer).toBeNull();
    expect(c.ck_retrieval_score).toBeNull();
  });
});

describe("saveBatchComparison — diagnostic fields", () => {
  let db: ComparisonRunDatabase;

  beforeEach(() => {
    cleanDb();
    db = new ComparisonRunDatabase(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanDb();
  });

  function makeBatchResult(overrides: Partial<ComparisonRunResult> = {}): ComparisonRunResult {
    return {
      totalCases: 1,
      cases: [
        {
          query: "test query",
          category: "direct_fact",
          overallWinner: "rag",
          rag: { contextTokens: 200, sections: 1, processingTimeMs: 25 },
          claimkit: {
            confidence: 0.2,
            answerability: "answerable",
            claimCount: 2,
            processingTimeMs: 90,
            contradictions: 0,
          },
        },
      ],
      aggregate: {
        wins: { claimkit: 0, rag: 1, tie: 0 },
        claimkit: { mean: { confidence: 0.2, answerabilityRate: 1, avgClaims: 2, avgTimeMs: 90 } },
        rag: { mean: { avgTokens: 200, avgSections: 1, avgTimeMs: 25 } },
      },
      ...overrides,
    };
  }

  it("persists batch result without error", () => {
    const result = makeBatchResult();
    saveBatchComparison(result, "batch diagnostic test", db);

    const runs = db.listRuns({ limit: 1 });
    expect(runs.runs.length).toBe(1);
    expect(runs.runs[0].totalCases).toBe(1);
  });

  it("handles null claimkit in batch result", () => {
    const result: ComparisonRunResult = {
      totalCases: 1,
      cases: [
        {
          query: "test",
          category: "direct_fact",
          overallWinner: "rag",
          rag: { contextTokens: 100, sections: 1, processingTimeMs: 10 },
          claimkit: null,
        },
      ],
      aggregate: {
        wins: { claimkit: 0, rag: 1, tie: 0 },
        claimkit: { mean: { confidence: 0, answerabilityRate: 0, avgClaims: 0, avgTimeMs: 0 } },
        rag: { mean: { avgTokens: 100, avgSections: 1, avgTimeMs: 10 } },
      },
    };
    saveBatchComparison(result, undefined, db);

    const runs = db.listRuns({ limit: 1 });
    const run = db.getRun(runs.runs[0].id);
    const c = run!.cases[0];
    expect(c.ck_confidence).toBeNull();
  });
});
