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
  CategoryBreakdown,
  SaveComparisonInput,
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
    ];
    for (const { col, def } of migrations) {
      try {
        this.db.exec(`ALTER TABLE comparison_cases ADD COLUMN ${col} ${def}`);
      } catch {
        // Column already exists — skip
      }
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
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
           SUM(CASE WHEN overall_winner = 'claimkit' THEN 1 ELSE 0 END) as ck_wins,
           SUM(CASE WHEN overall_winner = 'rag' THEN 1 ELSE 0 END) as rag_wins,
           SUM(CASE WHEN overall_winner = 'tie' THEN 1 ELSE 0 END) as ties,
           AVG(ck_confidence) as avg_confidence,
           AVG(CASE WHEN ck_answerability = 'answerable' THEN 1.0 ELSE 0.0 END) as answerability_rate,
           AVG(ck_claim_count) as avg_claims,
           AVG(ck_time_ms) as avg_ck_time,
           AVG(rag_tokens) as avg_rag_tokens,
           AVG(rag_sections) as avg_rag_sections,
           AVG(rag_time_ms) as avg_rag_time
         FROM comparison_cases WHERE run_id = ?`,
      )
      .get(runId) as {
        total_cases: number;
        ck_wins: number;
        rag_wins: number;
        ties: number;
        avg_confidence: number | null;
        answerability_rate: number | null;
        avg_claims: number | null;
        avg_ck_time: number | null;
        avg_rag_tokens: number | null;
        avg_rag_sections: number | null;
        avg_rag_time: number | null;
      };

    return {
      wins: { claimkit: row.ck_wins, rag: row.rag_wins, tie: row.ties },
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
        },
      },
    };
  }

  getDashboardStats(): ComparisonDashboardStats {
    const winRow = this.db
      .prepare(
        `SELECT
           COUNT(*) as total_cases,
           SUM(CASE WHEN overall_winner = 'claimkit' THEN 1 ELSE 0 END) as ck_wins,
           SUM(CASE WHEN overall_winner = 'rag' THEN 1 ELSE 0 END) as rag_wins,
           SUM(CASE WHEN overall_winner = 'tie' THEN 1 ELSE 0 END) as ties,
           AVG(ck_confidence) as avg_confidence,
           AVG(CASE WHEN ck_answerability = 'answerable' THEN 1.0 ELSE 0.0 END) as answerability_rate,
           AVG(ck_time_ms) as avg_ck_time,
           AVG(rag_time_ms) as avg_rag_time
         FROM comparison_cases`,
      )
      .get() as {
        total_cases: number;
        ck_wins: number;
        rag_wins: number;
        ties: number;
        avg_confidence: number | null;
        answerability_rate: number | null;
        avg_ck_time: number | null;
        avg_rag_time: number | null;
      };

    const totalRunsRow = this.db
      .prepare("SELECT COUNT(*) as total FROM comparison_runs")
      .get() as { total: number };

    const catRows = this.db
      .prepare(
        `SELECT
           category,
           COUNT(*) as total,
           SUM(CASE WHEN overall_winner = 'claimkit' THEN 1 ELSE 0 END) as ck_wins,
           SUM(CASE WHEN overall_winner = 'rag' THEN 1 ELSE 0 END) as rag_wins,
           SUM(CASE WHEN overall_winner = 'tie' THEN 1 ELSE 0 END) as ties
         FROM comparison_cases
         GROUP BY category
         ORDER BY total DESC`,
      )
      .all() as Array<{
        category: string;
        total: number;
        ck_wins: number;
        rag_wins: number;
        ties: number;
      }>;

    const recentRuns = this.listRuns({ limit: 10 }).runs;

    return {
      totalRuns: totalRunsRow.total,
      totalCases: winRow.total_cases,
      overallWins: { claimkit: winRow.ck_wins, rag: winRow.rag_wins, tie: winRow.ties },
      avgCkConfidence: winRow.avg_confidence ?? 0,
      avgAnswerabilityRate: winRow.answerability_rate ?? 0,
      avgCkTimeMs: winRow.avg_ck_time ?? 0,
      avgRagTimeMs: winRow.avg_rag_time ?? 0,
      byCategory: catRows.map((r) => ({
        category: r.category as CategoryBreakdown["category"],
        total: r.total,
        claimkitWins: r.ck_wins,
        ragWins: r.rag_wins,
        ties: r.ties,
      })),
      recentRuns,
    };
  }

  getConfidenceOverTime(days: number = 30): ConfidenceTrendPoint[] {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT
           date(created_at) as date,
           AVG(ck_confidence) as avg_confidence,
           COUNT(*) as case_count
         FROM comparison_cases
         WHERE ck_confidence IS NOT NULL AND created_at >= ?
         GROUP BY date(created_at)
         ORDER BY date(created_at)`,
      )
      .all(cutoff) as Array<{ date: string; avg_confidence: number; case_count: number }>;

    return rows.map((r) => ({
      date: r.date,
      avgConfidence: r.avg_confidence,
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
