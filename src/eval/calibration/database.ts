import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";

/**
 * Calibration database — Phase 2 of the ClaimKit confidence-scoring
 * campaign. Stores the curated eval set, the system runs against each
 * case, and the human ratings of those runs.
 *
 * Three tables, separated so each entity has clean lifecycle semantics:
 *   - eval_cases: the curated queries with optional expected answers
 *   - eval_runs: each (case × system) execution, capturing the system's
 *     answer plus its self-reported confidence and confidence_trace
 *   - eval_ratings: human-rated 0–4 Likert score per run with notes
 *
 * The goal is the calibration curve: human rating (y) vs. system-reported
 * confidence (x). If the regression line is far from y = x, the scoring
 * is poorly calibrated. The data is what answers "is ClaimKit's scoring
 * over-penalizing?" — we don't decide that with intuition.
 */

export const EVAL_SEGMENTS = [
  "direct_fact",
  "entity_lookup",
  "supersession",
  "conflict",
  "streaming",
  "other",
] as const;
export type EvalSegment = (typeof EVAL_SEGMENTS)[number];

export type EvalSystem = "rag" | "claimkit";

export interface EvalCase {
  id: string;
  query: string;
  segment: EvalSegment;
  expectedAnswer: string | null;
  notes: string | null;
  createdAt: string;
}

export interface EvalRun {
  id: string;
  caseId: string;
  system: EvalSystem;
  /** What the system produced. Null when the run errored before producing text. */
  answer: string | null;
  /** Self-reported confidence in [0, 1]. Null when not applicable. */
  confidence: number | null;
  /** JSON-encoded ConfidenceTrace from ClaimKit (null for rag). */
  confidenceTrace: string | null;
  /** Grounding result on the RAG answer (null when not measured). */
  hallucinationRate: number | null;
  grounded: boolean | null;
  contextTokens: number | null;
  processingTimeMs: number | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface EvalRating {
  id: string;
  runId: string;
  /** 0 = wrong, 1 = mostly wrong, 2 = partial, 3 = mostly right, 4 = fully right. */
  rating: number;
  /** Sub-flags for finer analysis. */
  correct: boolean;
  complete: boolean;
  grounded: boolean;
  notes: string | null;
  rater: string | null;
  createdAt: string;
}

export class CalibrationDatabase {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const isTest = process.env.NODE_ENV === "test";
    const dataDir = path.resolve(process.cwd(), "data");
    if (!isTest && !fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const file = dbPath ?? (isTest ? ":memory:" : path.join(dataDir, "eval-calibration.db"));
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS eval_cases (
        id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        segment TEXT NOT NULL,
        expected_answer TEXT,
        notes TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_eval_cases_segment ON eval_cases(segment);
      CREATE INDEX IF NOT EXISTS idx_eval_cases_created ON eval_cases(created_at);

      CREATE TABLE IF NOT EXISTS eval_runs (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES eval_cases(id) ON DELETE CASCADE,
        system TEXT NOT NULL CHECK(system IN ('rag', 'claimkit')),
        answer TEXT,
        confidence REAL,
        confidence_trace TEXT,
        hallucination_rate REAL,
        grounded INTEGER,
        context_tokens INTEGER,
        processing_time_ms INTEGER,
        error_message TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_eval_runs_case ON eval_runs(case_id);
      CREATE INDEX IF NOT EXISTS idx_eval_runs_system ON eval_runs(system);
      CREATE INDEX IF NOT EXISTS idx_eval_runs_created ON eval_runs(created_at);

      CREATE TABLE IF NOT EXISTS eval_ratings (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
        rating INTEGER NOT NULL CHECK(rating BETWEEN 0 AND 4),
        correct INTEGER NOT NULL,
        complete INTEGER NOT NULL,
        grounded INTEGER NOT NULL,
        notes TEXT,
        rater TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_eval_ratings_run ON eval_ratings(run_id);
      CREATE INDEX IF NOT EXISTS idx_eval_ratings_created ON eval_ratings(created_at);
    `);
  }

  // ── Cases ───────────────────────────────────────────────────────────

  addCase(input: {
    query: string;
    segment: EvalSegment;
    expectedAnswer?: string | null;
    notes?: string | null;
  }): EvalCase {
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO eval_cases (id, query, segment, expected_answer, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.query,
        input.segment,
        input.expectedAnswer ?? null,
        input.notes ?? null,
        now,
      );
    return {
      id,
      query: input.query,
      segment: input.segment,
      expectedAnswer: input.expectedAnswer ?? null,
      notes: input.notes ?? null,
      createdAt: now,
    };
  }

  getCase(id: string): EvalCase | null {
    const row = this.db
      .prepare(`SELECT * FROM eval_cases WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapCaseRow(row) : null;
  }

  listCases(filter?: { segment?: EvalSegment }): EvalCase[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.segment) {
      where.push("segment = ?");
      params.push(filter.segment);
    }
    const sql = `SELECT * FROM eval_cases ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at ASC`;
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapCaseRow(r));
  }

  deleteCase(id: string): boolean {
    const r = this.db.prepare(`DELETE FROM eval_cases WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  // ── Runs ────────────────────────────────────────────────────────────

  addRun(input: {
    caseId: string;
    system: EvalSystem;
    answer?: string | null;
    confidence?: number | null;
    confidenceTrace?: unknown;
    hallucinationRate?: number | null;
    grounded?: boolean | null;
    contextTokens?: number | null;
    processingTimeMs?: number | null;
    errorMessage?: string | null;
  }): EvalRun {
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO eval_runs
           (id, case_id, system, answer, confidence, confidence_trace,
            hallucination_rate, grounded, context_tokens, processing_time_ms,
            error_message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.caseId,
        input.system,
        input.answer ?? null,
        input.confidence ?? null,
        input.confidenceTrace ? JSON.stringify(input.confidenceTrace) : null,
        input.hallucinationRate ?? null,
        input.grounded != null ? (input.grounded ? 1 : 0) : null,
        input.contextTokens ?? null,
        input.processingTimeMs ?? null,
        input.errorMessage ?? null,
        now,
      );
    return this.getRun(id)!;
  }

  getRun(id: string): EvalRun | null {
    const row = this.db
      .prepare(`SELECT * FROM eval_runs WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRunRow(row) : null;
  }

  /**
   * Returns all runs for a case grouped by system. Used by the rating
   * UI to display RAG and ClaimKit answers side-by-side.
   */
  getRunsForCase(caseId: string): EvalRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM eval_runs WHERE case_id = ? ORDER BY created_at ASC`)
      .all(caseId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRunRow(r));
  }

  /**
   * Cases that don't yet have at least one run for BOTH systems. Drives
   * the "run all unrun cases" batch operation.
   */
  listUnrunCases(): EvalCase[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM eval_cases c
         WHERE NOT EXISTS (
           SELECT 1 FROM eval_runs r
           WHERE r.case_id = c.id AND r.system = 'rag'
         ) OR NOT EXISTS (
           SELECT 1 FROM eval_runs r
           WHERE r.case_id = c.id AND r.system = 'claimkit'
         )
         ORDER BY c.created_at ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapCaseRow(r));
  }

  // ── Ratings ─────────────────────────────────────────────────────────

  addRating(input: {
    runId: string;
    rating: number;
    correct: boolean;
    complete: boolean;
    grounded: boolean;
    notes?: string | null;
    rater?: string | null;
  }): EvalRating {
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO eval_ratings
           (id, run_id, rating, correct, complete, grounded, notes, rater, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.rating,
        input.correct ? 1 : 0,
        input.complete ? 1 : 0,
        input.grounded ? 1 : 0,
        input.notes ?? null,
        input.rater ?? null,
        now,
      );
    return {
      id,
      runId: input.runId,
      rating: input.rating,
      correct: input.correct,
      complete: input.complete,
      grounded: input.grounded,
      notes: input.notes ?? null,
      rater: input.rater ?? null,
      createdAt: now,
    };
  }

  getRatingsForRun(runId: string): EvalRating[] {
    const rows = this.db
      .prepare(`SELECT * FROM eval_ratings WHERE run_id = ? ORDER BY created_at ASC`)
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRatingRow(r));
  }

  /**
   * Pairs of (confidence, human rating / 4) for every rated run that has
   * a confidence value. Used to produce the calibration curve in Phase 3.
   * Phase 2 just collects the data; Phase 3 plots it.
   */
  getCalibrationPairs(
    system?: EvalSystem,
  ): Array<{ system: EvalSystem; confidence: number; rating: number; ratingNormalized: number }> {
    const where: string[] = ["r.confidence IS NOT NULL"];
    const params: unknown[] = [];
    if (system) {
      where.push("r.system = ?");
      params.push(system);
    }
    const rows = this.db
      .prepare(
        `SELECT r.system, r.confidence, rt.rating
         FROM eval_runs r
         JOIN eval_ratings rt ON rt.run_id = r.id
         WHERE ${where.join(" AND ")}
         ORDER BY r.created_at ASC`,
      )
      .all(...params) as Array<{ system: string; confidence: number; rating: number }>;
    return rows.map((r) => ({
      system: r.system as EvalSystem,
      confidence: r.confidence,
      rating: r.rating,
      ratingNormalized: r.rating / 4,
    }));
  }

  // ── Mappers ─────────────────────────────────────────────────────────

  private mapCaseRow(row: Record<string, unknown>): EvalCase {
    return {
      id: row.id as string,
      query: row.query as string,
      segment: row.segment as EvalSegment,
      expectedAnswer: (row.expected_answer as string | null) ?? null,
      notes: (row.notes as string | null) ?? null,
      createdAt: row.created_at as string,
    };
  }

  private mapRunRow(row: Record<string, unknown>): EvalRun {
    return {
      id: row.id as string,
      caseId: row.case_id as string,
      system: row.system as EvalSystem,
      answer: (row.answer as string | null) ?? null,
      confidence: (row.confidence as number | null) ?? null,
      confidenceTrace: (row.confidence_trace as string | null) ?? null,
      hallucinationRate: (row.hallucination_rate as number | null) ?? null,
      grounded:
        row.grounded != null ? Boolean(row.grounded as number) : null,
      contextTokens: (row.context_tokens as number | null) ?? null,
      processingTimeMs: (row.processing_time_ms as number | null) ?? null,
      errorMessage: (row.error_message as string | null) ?? null,
      createdAt: row.created_at as string,
    };
  }

  private mapRatingRow(row: Record<string, unknown>): EvalRating {
    return {
      id: row.id as string,
      runId: row.run_id as string,
      rating: row.rating as number,
      correct: Boolean(row.correct as number),
      complete: Boolean(row.complete as number),
      grounded: Boolean(row.grounded as number),
      notes: (row.notes as string | null) ?? null,
      rater: (row.rater as string | null) ?? null,
      createdAt: row.created_at as string,
    };
  }

  close(): void {
    this.db.close();
  }
}

export const calibrationDatabase = new CalibrationDatabase();
