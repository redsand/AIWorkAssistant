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
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          now,
        );
      }
    });

    txn();
    return this.getRun(runId)!;
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
           AVG(CASE WHEN rag_grounded IS NOT NULL THEN CAST(rag_grounded AS REAL) END) as avg_rag_grounded_rate
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
