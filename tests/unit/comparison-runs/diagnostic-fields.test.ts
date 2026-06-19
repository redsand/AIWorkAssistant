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

    it("persists and reads back the ClaimKit-first routing_strategy", () => {
      const run = db.createRun({
        source: "live",
        description: "routing strategy persistence",
        cases: [
          {
            query: "what is the deploy process",
            category: "direct_fact",
            overallWinner: "claimkit",
            winnerReason: "high_confidence",
            rag: { contextTokens: 0, sections: 0, processingTimeMs: 4 },
            claimkit: {
              confidence: 0.95,
              answerability: "answerable",
              claimCount: 3,
              processingTimeMs: 40,
              contradictions: 0,
            },
            routingStrategy: "claimkit_first_skip_rag",
          },
        ],
      });

      expect(run.cases[0].routing_strategy).toBe("claimkit_first_skip_rag");

      // Survives a fresh read from disk (not just the in-memory create result).
      const reloaded = db.getRun(run.id);
      expect(reloaded!.cases[0].routing_strategy).toBe("claimkit_first_skip_rag");
    });

    it("stores null routing_strategy when the case omits it", () => {
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

      expect(run.cases[0].routing_strategy).toBeNull();
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
      expect(allStats.avgRagHallucinationRate).toBe(0);
      expect(allStats.avgRagGroundedRate).toBe(0);
    });

    it("computes truthfulness metrics across cases", () => {
      db.createRun({
        source: "live",
        description: "truthfulness run",
        cases: [
          {
            query: "q1",
            category: "direct_fact",
            overallWinner: "rag",
            winnerReason: "rag_grounded",
            rag: { contextTokens: 100, sections: 1, processingTimeMs: 20, hallucinationRate: 0, grounded: true },
            claimkit: {
              confidence: 0.3,
              answerability: "not_answerable",
              claimCount: 0,
              processingTimeMs: 50,
              contradictions: 0,
            },
          },
          {
            query: "q2",
            category: "direct_fact",
            overallWinner: "claimkit",
            winnerReason: "rag_hallucinated",
            rag: { contextTokens: 100, sections: 1, processingTimeMs: 20, hallucinationRate: 0.8, grounded: false },
            claimkit: {
              confidence: 0.6,
              answerability: "answerable",
              claimCount: 3,
              processingTimeMs: 80,
              contradictions: 0,
            },
          },
        ],
      });

      const stats = db.getDashboardStats({ source: "live" });
      expect(stats.avgRagHallucinationRate).toBeCloseTo(0.4, 2);
      expect(stats.avgRagGroundedRate).toBeCloseTo(0.5, 2);
    });
  });

  describe("truthfulness trends over time", () => {
    it("returns empty array when no cases", () => {
      const trends = db.getTruthfulnessOverTime(30);
      expect(trends).toEqual([]);
    });

    it("aggregates hallucination and grounded rates by date", () => {
      const now = new Date().toISOString();
      db.createRun({
        source: "live",
        description: "trend run",
        cases: [
          {
            query: "q1",
            category: "direct_fact",
            overallWinner: "claimkit",
            winnerReason: "rag_hallucinated",
            rag: { contextTokens: 100, sections: 1, processingTimeMs: 20, hallucinationRate: 0.8, grounded: false },
            claimkit: {
              confidence: 0.6,
              answerability: "answerable",
              claimCount: 3,
              processingTimeMs: 80,
              contradictions: 0,
            },
          },
          {
            query: "q2",
            category: "direct_fact",
            overallWinner: "rag",
            winnerReason: "rag_grounded",
            rag: { contextTokens: 100, sections: 1, processingTimeMs: 20, hallucinationRate: 0, grounded: true },
            claimkit: {
              confidence: 0.3,
              answerability: "not_answerable",
              claimCount: 0,
              processingTimeMs: 50,
              contradictions: 0,
            },
          },
        ],
      });

      const trends = db.getTruthfulnessOverTime(30, { source: "live" });
      expect(trends.length).toBe(1);
      expect(trends[0]!.avgHallucinationRate).toBeCloseTo(0.4, 2);
      expect(trends[0]!.avgGroundedRate).toBeCloseTo(0.5, 2);
      expect(trends[0]!.caseCount).toBe(2);
      expect(trends[0]!.date).toBe(new Date().toISOString().slice(0, 10));
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

/**
 * updateCaseGrounding implements the truthfulness-first winner rule —
 * the headline metric that makes the new "Truthfulness" dashboard panel
 * meaningful. These tests pin down its semantics so the panel can't be
 * silently invalidated by a refactor.
 */
describe("updateCaseGrounding — truthfulness-first winner rule (Idea 1)", () => {
  let db: ComparisonRunDatabase;

  beforeEach(() => {
    cleanDb();
    db = new ComparisonRunDatabase(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanDb();
  });

  function seedCase(opts: {
    overallWinner: "rag" | "claimkit" | "tie";
    ckConfidence: number;
  }): string {
    const result = saveLiveComparison({
      query: "test",
      overallWinner: opts.overallWinner,
      winnerReason: "low_confidence",
      ragTokens: 100,
      ragSections: 1,
      ragTimeMs: 10,
      ckConfidence: opts.ckConfidence,
      ckAnswerability: "answerable",
      ckClaimCount: 1,
      ckTimeMs: 20,
      ckContradictions: 0,
      db,
    });
    expect(result).not.toBeNull();
    return result!.caseId;
  }

  it("back-fills hallucination rate and grounded fields", () => {
    const caseId = seedCase({ overallWinner: "rag", ckConfidence: 0.3 });
    db.updateCaseGrounding(caseId, 0.0, true);
    const runs = db.listRuns({ limit: 1 });
    const c = db.getRun(runs.runs[0].id)!.cases[0];
    expect(c.rag_hallucination_rate).toBe(0.0);
    expect(c.rag_grounded).toBe(true);
  });

  it("flips winner to claimkit when RAG hallucinated and CK had non-trivial confidence", () => {
    const caseId = seedCase({ overallWinner: "rag", ckConfidence: 0.6 });
    db.updateCaseGrounding(caseId, 0.4, false);
    const runs = db.listRuns({ limit: 1 });
    const c = db.getRun(runs.runs[0].id)!.cases[0];
    expect(c.overall_winner).toBe("claimkit");
    expect(c.winner_reason).toBe("rag_hallucinated");
    expect(c.rag_hallucination_rate).toBe(0.4);
  });

  it("does NOT flip winner when CK confidence was too low (<= 0.15)", () => {
    const caseId = seedCase({ overallWinner: "rag", ckConfidence: 0.1 });
    db.updateCaseGrounding(caseId, 0.5, false);
    const runs = db.listRuns({ limit: 1 });
    const c = db.getRun(runs.runs[0].id)!.cases[0];
    // Stays RAG — ClaimKit didn't have the answer either.
    expect(c.overall_winner).toBe("rag");
    expect(c.winner_reason).toBe("low_confidence");
  });

  it("does NOT flip winner when RAG was grounded (hallucinationRate = 0)", () => {
    const caseId = seedCase({ overallWinner: "rag", ckConfidence: 0.6 });
    db.updateCaseGrounding(caseId, 0.0, true);
    const runs = db.listRuns({ limit: 1 });
    const c = db.getRun(runs.runs[0].id)!.cases[0];
    expect(c.overall_winner).toBe("rag");
    expect(c.winner_reason).toBe("low_confidence");
  });

  it("does NOT re-flip a case that already won for claimkit", () => {
    const caseId = seedCase({ overallWinner: "claimkit", ckConfidence: 0.8 });
    db.updateCaseGrounding(caseId, 0.5, false);
    const runs = db.listRuns({ limit: 1 });
    const c = db.getRun(runs.runs[0].id)!.cases[0];
    expect(c.overall_winner).toBe("claimkit");
    // winner_reason should NOT be overwritten with rag_hallucinated when
    // the original winner was already claimkit.
    expect(c.winner_reason).toBe("low_confidence");
  });
});
