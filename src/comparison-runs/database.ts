import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import type {
  ComparisonRunRow,
  ComparisonCaseRow,
  ComparisonRunWithCases,
  ComparisonRunSummary,
  ComparisonRunsListResult,
  ComparisonDashboardStats,
  ComparisonAggregate,
  ConfidenceTrendPoint,
  TruthfulnessTrendPoint,
  CategoryBreakdown,
  SaveComparisonInput,
  ComparisonSource,
  CkStatus,
} from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const DEFAULT_DB_PATH = path.join(DATA_DIR, "comparison-runs.db");

class ComparisonRunDatabase {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const dbFile = dbPath ?? DEFAULT_DB_PATH;
    const dir = path.dirname(dbFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbFile);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS comparison_runs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK(source IN ('batch', 'live')),
        description TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS comparison_cases (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        query TEXT NOT NULL,
        category TEXT NOT NULL
          CHECK(category IN ('code_retrieval','entity_linking','staleness','citation_laundering','direct_fact')),
        overall_winner TEXT NOT NULL CHECK(overall_winner IN ('rag','claimkit','tie')),
        rag_tokens INTEGER NOT NULL,
        rag_sections INTEGER NOT NULL,
        rag_time_ms INTEGER NOT NULL,
        ck_confidence REAL,
        ck_answerability TEXT,
        ck_claim_count INTEGER,
        ck_time_ms INTEGER,
        ck_contradictions INTEGER,
        ck_answer TEXT,
        ck_retrieval_score REAL,
        ck_source_count INTEGER,
        ck_missing_evidence TEXT,
        winner_reason TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES comparison_runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_comparison_cases_run_id ON comparison_cases(run_id);
      CREATE INDEX IF NOT EXISTS idx_comparison_cases_winner ON comparison_cases(overall_winner);
      CREATE INDEX IF NOT EXISTS idx_comparison_cases_category ON comparison_cases(category);
      CREATE INDEX IF NOT EXISTS idx_comparison_cases_created ON comparison_cases(created_at);
      CREATE INDEX IF NOT EXISTS idx_comparison_runs_created ON comparison_runs(created_at);
      CREATE INDEX IF NOT EXISTS idx_comparison_runs_source ON comparison_runs(source);
    `);

    this.runMigrations();
  }

  private runMigrations() {
    const migrations: Array<{ col: string; def: string }> = [
      { col: "ck_answer", def: "TEXT" },
      { col: "ck_retrieval_score", def: "REAL" },
      { col: "ck_source_count", def: "INTEGER" },
      { col: "ck_missing_evidence", def: "TEXT" },
      { col: "winner_reason", def: "TEXT" },
      { col: "ck_status", def: "TEXT" },
      { col: "ck_included_in_context", def: "INTEGER" },
      { col: "rag_hallucination_rate", def: "REAL" },
      { col: "rag_grounded", def: "INTEGER" },
      // Collaboration columns — set when the RAG+ClaimKit collaborative
      // features (Ideas 4, 5, 2) actually fire during context assembly.
      // Lets the dashboard prove the new features are being used.
      { col: "citation_boost_applied", def: "INTEGER" },
      { col: "gap_fill_docs_added", def: "INTEGER" },
      { col: "entity_claims_injected", def: "INTEGER" },
      { col: "contradictions_flagged", def: "INTEGER" },
      // Token-savings story: ck_section_tokens captures the tokens used by
      // the claimkit_evidence section. Compared against rag_tokens, this
      // quantifies the cost savings when ClaimKit replaces broad RAG context
      // with a structured-claim packet. NULL when CK was disabled or had
      // no evidence to contribute.
      { col: "ck_section_tokens", def: "INTEGER" },
    ];
    for (const { col, def } of migrations) {
      try {
        this.db.exec(`ALTER TABLE comparison_cases ADD COLUMN ${col} ${def}`);
      } catch {
        // Column already exists — skip
      }
    }

    // Migrate category CHECK constraint to include planning_synthesis
    const checkInfo = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='comparison_cases'",
    ).get() as { sql: string } | undefined;
    if (checkInfo && !checkInfo.sql.includes("planning_synthesis")) {
      this.db.exec(`
        ALTER TABLE comparison_cases RENAME TO comparison_cases_old;
        CREATE TABLE comparison_cases (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          query TEXT NOT NULL,
          category TEXT NOT NULL
            CHECK(category IN ('code_retrieval','entity_linking','staleness','citation_laundering','direct_fact','planning_synthesis')),
          overall_winner TEXT NOT NULL CHECK(overall_winner IN ('rag','claimkit','tie')),
          rag_tokens INTEGER NOT NULL,
          rag_sections INTEGER NOT NULL,
          rag_time_ms INTEGER NOT NULL,
          ck_confidence REAL,
          ck_answerability TEXT,
          ck_claim_count INTEGER,
          ck_time_ms INTEGER,
          ck_contradictions INTEGER,
          ck_answer TEXT,
          ck_retrieval_score REAL,
          ck_source_count INTEGER,
          ck_missing_evidence TEXT,
          winner_reason TEXT,
          ck_status TEXT,
          ck_included_in_context INTEGER,
          rag_hallucination_rate REAL,
          rag_grounded INTEGER,
          citation_boost_applied INTEGER,
          gap_fill_docs_added INTEGER,
          entity_claims_injected INTEGER,
          contradictions_flagged INTEGER,
          ck_section_tokens INTEGER,
          created_at TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES comparison_runs(id) ON DELETE CASCADE
        );
        INSERT INTO comparison_cases
          SELECT id, run_id, query, category, overall_winner,
                 rag_tokens, rag_sections, rag_time_ms,
                 ck_confidence, ck_answerability, ck_claim_count, ck_time_ms, ck_contradictions,
                 ck_answer, ck_retrieval_score, ck_source_count, ck_missing_evidence, winner_reason,
                 ck_status, ck_included_in_context,
                 rag_hallucination_rate, rag_grounded,
                 NULL, NULL, NULL, NULL,
                 NULL,
                 created_at
          FROM comparison_cases_old;
        DROP TABLE comparison_cases_old;
        CREATE INDEX idx_comparison_cases_run_id ON comparison_cases(run_id);
        CREATE INDEX idx_comparison_cases_winner ON comparison_cases(overall_winner);
        CREATE INDEX idx_comparison_cases_category ON comparison_cases(category);
        CREATE INDEX idx_comparison_cases_created ON comparison_cases(created_at);
      `);
    }
  }

  // ── Create ──────────────────────────────────────────────────────────

  createRun(input: SaveComparisonInput): ComparisonRunWithCases {
    const runId = uuidv4();
    const now = new Date().toISOString();
    const insertRun = this.db.prepare(
      "INSERT INTO comparison_runs (id, source, description, created_at) VALUES (?, ?, ?, ?)",
    );
    const insertCase = this.db.prepare(
      `INSERT INTO comparison_cases
         (id, run_id, query, category, overall_winner,
          rag_tokens, rag_sections, rag_time_ms,
          ck_confidence, ck_answerability, ck_claim_count, ck_time_ms, ck_contradictions,
          ck_answer, ck_retrieval_score, ck_source_count, ck_missing_evidence, winner_reason,
          ck_status, ck_included_in_context,
          rag_hallucination_rate, rag_grounded,
          citation_boost_applied, gap_fill_docs_added,
          entity_claims_injected, contradictions_flagged,
          ck_section_tokens,
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const txn = this.db.transaction(() => {
      insertRun.run(runId, input.source, input.description ?? null, now);
      for (const c of input.cases) {
        insertCase.run(
          uuidv4(),
          runId,
          c.query,
          c.category,
          c.overallWinner,
          c.rag.contextTokens,
          c.rag.sections,
          c.rag.processingTimeMs,
          c.claimkit?.confidence ?? null,
          c.claimkit?.answerability ?? null,
          c.claimkit?.claimCount ?? null,
          c.claimkit?.processingTimeMs ?? null,
          c.claimkit?.contradictions ?? null,
          c.claimkit?.answer?.substring(0, 2000) ?? null,
          c.claimkit?.retrievalScore ?? null,
          c.claimkit?.sourceCount ?? null,
          c.claimkit?.missingEvidence ?? null,
          c.winnerReason ?? null,
          c.ckStatus ?? null,
          c.ckIncludedInContext != null ? (c.ckIncludedInContext ? 1 : 0) : null,
          c.rag.hallucinationRate ?? null,
          c.rag.grounded != null ? (c.rag.grounded ? 1 : 0) : null,
          c.citationBoostApplied ?? null,
          c.gapFillDocsAdded ?? null,
          c.entityClaimsInjected ?? null,
          c.contradictionsFlagged ?? null,
          c.ckSectionTokens ?? null,
          now,
        );
      }
    });

    txn();
    return this.getRun(runId)!;
  }

  /**
   * Update grounding fields on a previously-inserted comparison_case row.
   * Used by the live shadow grounding pass to back-fill rag_hallucination_rate /
   * rag_grounded after the agent's response has been generated and ground()
   * has run asynchronously.
   *
   * Also recomputes overall_winner against the truthfulness-first rule: if RAG
   * hallucinated (hallucinationRate > 0) and ClaimKit was available with
   * non-trivial confidence, ClaimKit wins. Otherwise the original routing
   * decision stands.
   */
  updateCaseGrounding(
    caseId: string,
    hallucinationRate: number,
    grounded: boolean,
  ): void {
    this.db
      .prepare(
        `UPDATE comparison_cases
         SET rag_hallucination_rate = ?, rag_grounded = ?
         WHERE id = ?`,
      )
      .run(hallucinationRate, grounded ? 1 : 0, caseId);

    // Apply truthfulness-first winner rule on the back-fill, mirroring
    // determineOverallWinner() in claimkit-comparison.ts: RAG hallucination
    // hands the win to ClaimKit when CK had non-trivial confidence.
    if (hallucinationRate > 0) {
      const row = this.db
        .prepare(
          `SELECT ck_confidence, overall_winner FROM comparison_cases WHERE id = ?`,
        )
        .get(caseId) as
        | { ck_confidence: number | null; overall_winner: string }
        | undefined;
      if (
        row &&
        row.ck_confidence !== null &&
        row.ck_confidence > 0.15 &&
        row.overall_winner !== "claimkit"
      ) {
        this.db
          .prepare(
            `UPDATE comparison_cases
             SET overall_winner = 'claimkit', winner_reason = 'rag_hallucinated'
             WHERE id = ?`,
          )
          .run(caseId);
      }
    }
  }

  // ── Read ────────────────────────────────────────────────────────────

  getRun(id: string): ComparisonRunWithCases | null {
    const runRow = this.db
      .prepare("SELECT * FROM comparison_runs WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!runRow) return null;

    const cases = this.db
      .prepare("SELECT * FROM comparison_cases WHERE run_id = ? ORDER BY created_at")
      .all(id) as Record<string, unknown>[];

    const caseRows = cases.map((c) => this.mapCaseRow(c));
    const aggregate = this.computeAggregate(id);

    return {
      ...this.mapRunRow(runRow),
      totalCases: caseRows.length,
      cases: caseRows,
      aggregate,
    };
  }

  getRunSummary(id: string): ComparisonRunSummary | null {
    const runRow = this.db
      .prepare("SELECT * FROM comparison_runs WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!runRow) return null;

    const winRow = this.db
      .prepare(
        `SELECT
           COUNT(*) as total_cases,
           SUM(CASE WHEN overall_winner = 'claimkit' THEN 1 ELSE 0 END) as ck_wins,
           SUM(CASE WHEN overall_winner = 'rag' THEN 1 ELSE 0 END) as rag_wins,
           SUM(CASE WHEN overall_winner = 'tie' THEN 1 ELSE 0 END) as ties
         FROM comparison_cases WHERE run_id = ?`,
      )
      .get(id) as { total_cases: number; ck_wins: number; rag_wins: number; ties: number };

    return {
      id: runRow.id as string,
      source: runRow.source as ComparisonRunSummary["source"],
      description: runRow.description as string | null,
      totalCases: winRow.total_cases,
      created_at: runRow.created_at as string,
      wins: {
        claimkit: winRow.ck_wins,
        rag: winRow.rag_wins,
        tie: winRow.ties,
      },
    };
  }

  listRuns(options?: {
    source?: string;
    limit?: number;
    offset?: number;
  }): ComparisonRunsListResult {
    const limit = options?.limit ?? 25;
    const offset = options?.offset ?? 0;

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (options?.source) {
      conditions.push("source = ?");
      params.push(options.source);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as total FROM comparison_runs ${whereClause}`)
      .get(...params) as { total: number };

    const rows = this.db
      .prepare(
        `SELECT * FROM comparison_runs ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Record<string, unknown>[];

    const runs = rows.map((r) => this.getRunSummary(r.id as string)).filter(Boolean) as ComparisonRunSummary[];

    return { runs, total: countRow.total };
  }

  // ── Aggregation ─────────────────────────────────────────────────────

  private computeAggregate(runId: string): ComparisonAggregate {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) as total_cases,
           SUM(CASE WHEN ck_status = 'answered' OR ck_status = 'no_claims' THEN 1 ELSE 0 END) as evaluated_cases,
           SUM(CASE WHEN ck_status = 'timeout' THEN 1 ELSE 0 END) as ck_timeouts,
           SUM(CASE WHEN ck_status IS NOT NULL AND ck_status NOT IN ('answered','no_claims') THEN 1 ELSE 0 END) as ck_unevaluated,
           SUM(CASE WHEN overall_winner = 'claimkit' THEN 1 ELSE 0 END) as ck_wins,
           SUM(CASE WHEN overall_winner = 'rag' THEN 1 ELSE 0 END) as rag_wins,
           SUM(CASE WHEN overall_winner = 'tie' THEN 1 ELSE 0 END) as ties,
           AVG(ck_confidence) as avg_confidence,
           AVG(CASE WHEN ck_answerability = 'answerable' THEN 1.0 ELSE 0.0 END) as answerability_rate,
           AVG(ck_claim_count) as avg_claims,
           AVG(ck_time_ms) as avg_ck_time,
           AVG(rag_tokens) as avg_rag_tokens,
           AVG(rag_sections) as avg_rag_sections,
           AVG(rag_time_ms) as avg_rag_time,
           AVG(CASE WHEN rag_hallucination_rate IS NOT NULL THEN rag_hallucination_rate END) as avg_rag_hallucination_rate,
           AVG(CASE WHEN rag_grounded IS NOT NULL THEN CAST(rag_grounded AS REAL) END) as avg_rag_grounded_rate
         FROM comparison_cases WHERE run_id = ?`,
      )
      .get(runId) as {
        total_cases: number;
        evaluated_cases: number;
        ck_wins: number;
        rag_wins: number;
        ties: number;
        ck_timeouts: number;
        ck_unevaluated: number;
        avg_confidence: number | null;
        answerability_rate: number | null;
        avg_claims: number | null;
        avg_ck_time: number | null;
        avg_rag_tokens: number | null;
        avg_rag_sections: number | null;
        avg_rag_time: number | null;
        avg_rag_hallucination_rate: number | null;
        avg_rag_grounded_rate: number | null;
      };

    return {
      wins: { claimkit: row.ck_wins, rag: row.rag_wins, tie: row.ties },
      evaluatedCases: row.evaluated_cases,
      ckTimeouts: row.ck_timeouts,
      ckUnevaluated: row.ck_unevaluated,
      claimkit: {
        mean: {
          confidence: row.avg_confidence ?? 0,
          answerabilityRate: row.answerability_rate ?? 0,
          avgClaims: row.avg_claims ?? 0,
          avgTimeMs: row.avg_ck_time ?? 0,
        },
      },
      rag: {
        mean: {
          avgTokens: row.avg_rag_tokens ?? 0,
          avgSections: row.avg_rag_sections ?? 0,
          avgTimeMs: row.avg_rag_time ?? 0,
          hallucinationRate: row.avg_rag_hallucination_rate ?? 0,
          groundedRate: row.avg_rag_grounded_rate ?? 0,
        },
      },
    };
  }

  getDashboardStats(options?: { source?: ComparisonSource }): ComparisonDashboardStats {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (options?.source) {
      conditions.push("cr.source = ?");
      params.push(options.source);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const winRow = this.db
      .prepare(
        `SELECT
           COUNT(*) as total_cases,
           SUM(CASE WHEN ck_status = 'answered' OR ck_status = 'no_claims' THEN 1 ELSE 0 END) as evaluated_cases,
           SUM(CASE WHEN ck_status = 'timeout' THEN 1 ELSE 0 END) as ck_timeouts,
           SUM(CASE WHEN overall_winner = 'claimkit' THEN 1 ELSE 0 END) as ck_wins,
           SUM(CASE WHEN overall_winner = 'rag' THEN 1 ELSE 0 END) as rag_wins,
           SUM(CASE WHEN overall_winner = 'tie' THEN 1 ELSE 0 END) as ties,
           AVG(ck_confidence) as avg_confidence,
           AVG(CASE WHEN ck_answerability = 'answerable' THEN 1.0 ELSE 0.0 END) as answerability_rate,
           AVG(ck_time_ms) as avg_ck_time,
           AVG(rag_time_ms) as avg_rag_time,
           AVG(CASE WHEN rag_hallucination_rate IS NOT NULL THEN rag_hallucination_rate END) as avg_rag_hallucination_rate,
           AVG(CASE WHEN rag_grounded IS NOT NULL THEN CAST(rag_grounded AS REAL) END) as avg_rag_grounded_rate,
           SUM(CASE WHEN winner_reason = 'rag_hallucinated' THEN 1 ELSE 0 END) as ck_rescues,
           SUM(CASE WHEN rag_hallucination_rate IS NOT NULL THEN 1 ELSE 0 END) as grounded_measurements,
           SUM(CASE WHEN citation_boost_applied > 0 THEN 1 ELSE 0 END) as citation_boost_n,
           SUM(CASE WHEN gap_fill_docs_added > 0 THEN 1 ELSE 0 END) as gap_fill_n,
           SUM(CASE WHEN entity_claims_injected > 0 THEN 1 ELSE 0 END) as entity_claims_n,
           SUM(CASE WHEN contradictions_flagged > 0 THEN 1 ELSE 0 END) as contradictions_n,
           AVG(CASE WHEN ck_section_tokens IS NOT NULL THEN rag_tokens END) as avg_rag_tokens_measured,
           AVG(CASE WHEN ck_section_tokens IS NOT NULL THEN ck_section_tokens END) as avg_ck_tokens,
           SUM(CASE WHEN ck_section_tokens IS NOT NULL AND ck_section_tokens < rag_tokens
                     THEN (rag_tokens - ck_section_tokens) ELSE 0 END) as total_tokens_saved,
           SUM(CASE WHEN ck_section_tokens IS NOT NULL THEN 1 ELSE 0 END) as token_measured_n
         FROM comparison_cases cc
         JOIN comparison_runs cr ON cr.id = cc.run_id
         ${whereClause}`,
      )
      .get(...params) as {
        total_cases: number;
        evaluated_cases: number;
        ck_timeouts: number;
        ck_wins: number | null;
        rag_wins: number | null;
        ties: number | null;
        avg_confidence: number | null;
        answerability_rate: number | null;
        avg_ck_time: number | null;
        avg_rag_time: number | null;
        avg_rag_hallucination_rate: number | null;
        avg_rag_grounded_rate: number | null;
        ck_rescues: number | null;
        grounded_measurements: number | null;
        citation_boost_n: number | null;
        gap_fill_n: number | null;
        entity_claims_n: number | null;
        contradictions_n: number | null;
        avg_rag_tokens_measured: number | null;
        avg_ck_tokens: number | null;
        total_tokens_saved: number | null;
        token_measured_n: number | null;
      };

    const totalRunsRow = this.db
      .prepare(`SELECT COUNT(*) as total FROM comparison_runs cr ${whereClause}`)
      .get(...params) as { total: number };

    const catRows = this.db
      .prepare(
        `SELECT
           cc.category,
           COUNT(*) as total,
           SUM(CASE WHEN cc.overall_winner = 'claimkit' THEN 1 ELSE 0 END) as ck_wins,
           SUM(CASE WHEN cc.overall_winner = 'rag' THEN 1 ELSE 0 END) as rag_wins,
           SUM(CASE WHEN cc.overall_winner = 'tie' THEN 1 ELSE 0 END) as ties
         FROM comparison_cases cc
         JOIN comparison_runs cr ON cr.id = cc.run_id
         ${whereClause}
         GROUP BY cc.category
         ORDER BY total DESC`,
      )
      .all(...params) as Array<{
        category: string;
        total: number;
        ck_wins: number | null;
        rag_wins: number | null;
        ties: number | null;
      }>;

    const recentRuns = this.listRuns({ source: options?.source, limit: 10 }).runs;

    return {
      source: options?.source ?? "all",
      totalRuns: totalRunsRow.total,
      totalCases: winRow.total_cases,
      evaluatedCases: winRow.evaluated_cases ?? 0,
      ckTimeouts: winRow.ck_timeouts ?? 0,
      overallWins: {
        claimkit: winRow.ck_wins ?? 0,
        rag: winRow.rag_wins ?? 0,
        tie: winRow.ties ?? 0,
      },
      avgCkConfidence: winRow.avg_confidence ?? 0,
      avgAnswerabilityRate: winRow.answerability_rate ?? 0,
      avgCkTimeMs: winRow.avg_ck_time ?? 0,
      avgRagTimeMs: winRow.avg_rag_time ?? 0,
      avgRagHallucinationRate: winRow.avg_rag_hallucination_rate ?? 0,
      avgRagGroundedRate: winRow.avg_rag_grounded_rate ?? 0,
      ckRescues: winRow.ck_rescues ?? 0,
      groundedMeasurements: winRow.grounded_measurements ?? 0,
      collaboration: {
        citationBoostApplied: winRow.citation_boost_n ?? 0,
        gapFillTriggered: winRow.gap_fill_n ?? 0,
        entityClaimsInjected: winRow.entity_claims_n ?? 0,
        contradictionsFlagged: winRow.contradictions_n ?? 0,
      },
      tokenSavings: {
        avgRagTokens: winRow.avg_rag_tokens_measured ?? 0,
        avgCkTokens: winRow.avg_ck_tokens ?? 0,
        totalTokensSaved: winRow.total_tokens_saved ?? 0,
        avgSavingsPerQuery:
          winRow.token_measured_n && winRow.token_measured_n > 0
            ? (winRow.total_tokens_saved ?? 0) / winRow.token_measured_n
            : 0,
        measuredCases: winRow.token_measured_n ?? 0,
      },
      lowConfidenceBreakdown: this.computeLowConfidenceBreakdown(options),
      byCategory: catRows.map((r) => ({
        category: r.category as CategoryBreakdown["category"],
        total: r.total,
        claimkitWins: r.ck_wins ?? 0,
        ragWins: r.rag_wins ?? 0,
        ties: r.ties ?? 0,
      })),
      recentRuns,
    };
  }

  getConfidenceOverTime(
    days: number = 30,
    options?: { source?: ComparisonSource },
  ): ConfidenceTrendPoint[] {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const conditions = ["cc.ck_confidence IS NOT NULL", "cc.created_at >= ?"];
    const params: unknown[] = [cutoff];
    if (options?.source) {
      conditions.push("cr.source = ?");
      params.push(options.source);
    }
    const rows = this.db
      .prepare(
        `SELECT
           date(cc.created_at) as date,
           AVG(cc.ck_confidence) as avg_confidence,
           COUNT(*) as case_count
         FROM comparison_cases cc
         JOIN comparison_runs cr ON cr.id = cc.run_id
         WHERE ${conditions.join(" AND ")}
         GROUP BY date(cc.created_at)
         ORDER BY date(cc.created_at)`,
      )
      .all(...params) as Array<{ date: string; avg_confidence: number; case_count: number }>;

    return rows.map((r) => ({
      date: r.date,
      avgConfidence: r.avg_confidence,
      caseCount: r.case_count,
    }));
  }

  getTruthfulnessOverTime(
    days: number = 30,
    options?: { source?: ComparisonSource },
  ): TruthfulnessTrendPoint[] {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const conditions = ["cc.created_at >= ?"];
    const params: unknown[] = [cutoff];
    if (options?.source) {
      conditions.push("cr.source = ?");
      params.push(options.source);
    }
    const rows = this.db
      .prepare(
        `SELECT
           date(cc.created_at) as date,
           AVG(CASE WHEN cc.rag_hallucination_rate IS NOT NULL THEN cc.rag_hallucination_rate END) as avg_hallucination_rate,
           AVG(CASE WHEN cc.rag_grounded IS NOT NULL THEN CAST(cc.rag_grounded AS REAL) END) as avg_grounded_rate,
           COUNT(*) as case_count
         FROM comparison_cases cc
         JOIN comparison_runs cr ON cr.id = cc.run_id
         WHERE ${conditions.join(" AND ")}
         GROUP BY date(cc.created_at)
         ORDER BY date(cc.created_at)`,
      )
      .all(...params) as Array<{
        date: string;
        avg_hallucination_rate: number | null;
        avg_grounded_rate: number | null;
        case_count: number;
      }>;

    return rows.map((r) => ({
      date: r.date,
      avgHallucinationRate: r.avg_hallucination_rate ?? 0,
      avgGroundedRate: r.avg_grounded_rate ?? 0,
      caseCount: r.case_count,
    }));
  }

  /**
   * Daily counts of each RAG+ClaimKit collaboration feature firing.
   * Renders the "Collaboration trend" line chart so uptake (or decline)
   * of each feature is visible over time. Each value is the number of
   * cases on that day where the corresponding column was > 0.
   */
  getCollaborationOverTime(
    days: number = 30,
    options?: { source?: ComparisonSource },
  ): Array<{
    date: string;
    citationBoostApplied: number;
    gapFillTriggered: number;
    entityClaimsInjected: number;
    contradictionsFlagged: number;
    caseCount: number;
  }> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const conditions = ["cc.created_at >= ?"];
    const params: unknown[] = [cutoff];
    if (options?.source) {
      conditions.push("cr.source = ?");
      params.push(options.source);
    }
    const rows = this.db
      .prepare(
        `SELECT
           date(cc.created_at) as date,
           SUM(CASE WHEN citation_boost_applied > 0 THEN 1 ELSE 0 END) as citation_boost_n,
           SUM(CASE WHEN gap_fill_docs_added > 0 THEN 1 ELSE 0 END) as gap_fill_n,
           SUM(CASE WHEN entity_claims_injected > 0 THEN 1 ELSE 0 END) as entity_claims_n,
           SUM(CASE WHEN contradictions_flagged > 0 THEN 1 ELSE 0 END) as contradictions_n,
           COUNT(*) as case_count
         FROM comparison_cases cc
         JOIN comparison_runs cr ON cr.id = cc.run_id
         WHERE ${conditions.join(" AND ")}
         GROUP BY date(cc.created_at)
         ORDER BY date(cc.created_at)`,
      )
      .all(...params) as Array<{
        date: string;
        citation_boost_n: number | null;
        gap_fill_n: number | null;
        entity_claims_n: number | null;
        contradictions_n: number | null;
        case_count: number;
      }>;
    return rows.map((r) => ({
      date: r.date,
      citationBoostApplied: r.citation_boost_n ?? 0,
      gapFillTriggered: r.gap_fill_n ?? 0,
      entityClaimsInjected: r.entity_claims_n ?? 0,
      contradictionsFlagged: r.contradictions_n ?? 0,
      caseCount: r.case_count,
    }));
  }

  /**
   * Classify each ck_confidence ≤ 0.1 case by the most likely root cause.
   * Mirrors the [ClaimKit:lowconf] reason heuristic added in ClaimKit's
   * query() method. Derived entirely from existing columns — no schema
   * changes needed.
   *
   * Buckets (mutually exclusive, evaluated in order):
   *   1. noClaimsRetrieved  — ck_claim_count = 0 (retrieval gap, fix ingestion)
   *   2. notAnswerable      — ck_answerability = 'not_answerable'
   *   3. lowConfidenceSignal — claims found and answerable, but confidence still low
   *                           (generator or verifier issue inside ClaimKit)
   */
  private computeLowConfidenceBreakdown(options?: { source?: ComparisonSource }): {
    noClaimsRetrieved: number;
    notAnswerable: number;
    lowConfidenceSignal: number;
    total: number;
  } {
    const conditions: string[] = [
      "ck_confidence IS NOT NULL",
      "ck_confidence <= 0.1",
    ];
    const params: unknown[] = [];
    if (options?.source) {
      conditions.push("cr.source = ?");
      params.push(options.source);
    }
    const where = `WHERE ${conditions.join(" AND ")}`;
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN ck_claim_count = 0 OR ck_claim_count IS NULL THEN 1 ELSE 0 END) as no_claims,
           SUM(CASE WHEN (ck_claim_count IS NOT NULL AND ck_claim_count > 0)
                     AND ck_answerability = 'not_answerable' THEN 1 ELSE 0 END) as not_answerable,
           SUM(CASE WHEN (ck_claim_count IS NOT NULL AND ck_claim_count > 0)
                     AND (ck_answerability IS NULL OR ck_answerability != 'not_answerable') THEN 1 ELSE 0 END) as low_signal
         FROM comparison_cases cc
         JOIN comparison_runs cr ON cr.id = cc.run_id
         ${where}`,
      )
      .get(...params) as {
        total: number;
        no_claims: number | null;
        not_answerable: number | null;
        low_signal: number | null;
      };
    return {
      total: row.total ?? 0,
      noClaimsRetrieved: row.no_claims ?? 0,
      notAnswerable: row.not_answerable ?? 0,
      lowConfidenceSignal: row.low_signal ?? 0,
    };
  }

  // ── Row mapping ─────────────────────────────────────────────────────

  private mapRunRow(row: Record<string, unknown>): ComparisonRunRow {
    return {
      id: row.id as string,
      source: row.source as ComparisonRunRow["source"],
      description: row.description as string | null,
      created_at: row.created_at as string,
    };
  }

  private mapCaseRow(row: Record<string, unknown>): ComparisonCaseRow {
    return {
      id: row.id as string,
      run_id: row.run_id as string,
      query: row.query as string,
      category: row.category as ComparisonCaseRow["category"],
      overall_winner: row.overall_winner as ComparisonCaseRow["overall_winner"],
      rag_tokens: row.rag_tokens as number,
      rag_sections: row.rag_sections as number,
      rag_time_ms: row.rag_time_ms as number,
      ck_confidence: row.ck_confidence as number | null,
      ck_answerability: row.ck_answerability as string | null,
      ck_claim_count: row.ck_claim_count as number | null,
      ck_time_ms: row.ck_time_ms as number | null,
      ck_contradictions: row.ck_contradictions as number | null,
      ck_answer: row.ck_answer as string | null,
      ck_retrieval_score: row.ck_retrieval_score as number | null,
      ck_source_count: row.ck_source_count as number | null,
      ck_missing_evidence: row.ck_missing_evidence as string | null,
      winner_reason: row.winner_reason as string | null,
      ck_status: (row.ck_status as CkStatus | null) ?? null,
      ck_included_in_context: row.ck_included_in_context != null ? Boolean(row.ck_included_in_context) : null,
      rag_hallucination_rate: row.rag_hallucination_rate as number | null,
      rag_grounded: row.rag_grounded != null ? Boolean(row.rag_grounded) : null,
      ck_section_tokens: row.ck_section_tokens as number | null,
      created_at: row.created_at as string,
    };
  }

  clearAll(): { deletedRuns: number } {
    const before = this.db.prepare("SELECT COUNT(*) as n FROM comparison_runs").get() as { n: number };
    this.db.prepare("DELETE FROM comparison_cases").run();
    this.db.prepare("DELETE FROM comparison_runs").run();
    this.db.prepare("VACUUM").run();
    return { deletedRuns: before.n };
  }

  close(): void {
    this.db.close();
  }
}

export { ComparisonRunDatabase };
export const comparisonRunDatabase = new ComparisonRunDatabase();
