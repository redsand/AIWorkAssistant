import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import type {
  AgentRun,
  AgentRunStep,
  AgentRunWithSteps,
  AgentRunStats,
  AgentRunCreateParams,
  AgentRunCompleteParams,
  AgentRunListResult,
  AgentRunStepCreate,
} from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const DEFAULT_DB_PATH = path.join(DATA_DIR, "agent-runs.db");

const MAX_CONTENT_LENGTH = 10000;

class AgentRunDatabase {
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
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        user_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        error_message TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        tool_loop_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_run_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_type TEXT NOT NULL,
        tool_name TEXT,
        content TEXT,
        sanitized_params TEXT,
        success INTEGER,
        error_message TEXT,
        duration_ms INTEGER,
        step_order INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_user_id ON agent_runs(user_id);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_started_at ON agent_runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_agent_run_steps_run_id ON agent_run_steps(run_id);
      CREATE INDEX IF NOT EXISTS idx_agent_run_steps_tool_name ON agent_run_steps(tool_name);
    `);
  }

  startRun(params: AgentRunCreateParams): AgentRun {
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO agent_runs (id, session_id, user_id, mode, status, started_at)
         VALUES (?, ?, ?, ?, 'running', ?)`,
      )
      .run(id, params.sessionId ?? null, params.userId, params.mode, now);

    return {
      id,
      sessionId: params.sessionId ?? null,
      userId: params.userId,
      mode: params.mode,
      model: null,
      status: "running",
      errorMessage: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      toolLoopCount: 0,
      startedAt: now,
      completedAt: null,
    };
  }

  completeRun(id: string, data: AgentRunCompleteParams): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE agent_runs
         SET status = 'completed', model = ?, prompt_tokens = ?, completion_tokens = ?,
             total_tokens = ?, tool_loop_count = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        data.model ?? null,
        data.promptTokens ?? null,
        data.completionTokens ?? null,
        data.totalTokens ?? null,
        data.toolLoopCount,
        now,
        id,
      );
  }

  failRun(id: string, errorMessage: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE agent_runs SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?`,
      )
      .run(errorMessage, now, id);
  }

  addStep(step: AgentRunStepCreate): AgentRunStep {
    const id = uuidv4();
    const now = new Date().toISOString();
    const contentStr = step.content
      ? truncate(JSON.stringify(step.content), MAX_CONTENT_LENGTH)
      : null;
    const paramsStr = step.sanitizedParams
      ? truncate(JSON.stringify(step.sanitizedParams), MAX_CONTENT_LENGTH)
      : null;

    this.db
      .prepare(
        `INSERT INTO agent_run_steps (id, run_id, step_type, tool_name, content, sanitized_params, success, error_message, duration_ms, step_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        step.runId,
        step.stepType,
        step.toolName ?? null,
        contentStr,
        paramsStr,
        step.success === null ? null : step.success ? 1 : 0,
        step.errorMessage ?? null,
        step.durationMs ?? null,
        step.stepOrder,
        now,
      );

    return {
      id,
      runId: step.runId,
      stepType: step.stepType,
      toolName: step.toolName ?? null,
      content: contentStr ? safeParse(contentStr) : null,
      sanitizedParams: paramsStr ? safeParse(paramsStr) : null,
      success: step.success ?? null,
      errorMessage: step.errorMessage ?? null,
      durationMs: step.durationMs ?? null,
      stepOrder: step.stepOrder,
      createdAt: now,
    };
  }

  listRuns(filters?: {
    status?: string;
    userId?: string;
    limit?: number;
    offset?: number;
  }): AgentRunListResult {
    const limit = filters?.limit ?? 50;
    const offset = filters?.offset ?? 0;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters?.status) {
      conditions.push("status = ?");
      params.push(filters.status);
    }
    if (filters?.userId) {
      conditions.push("user_id = ?");
      params.push(filters.userId);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as total FROM agent_runs ${whereClause}`)
      .get(...params) as { total: number };

    const rows = this.db
      .prepare(
        `SELECT * FROM agent_runs ${whereClause} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Record<string, unknown>[];

    return {
      runs: rows.map((r) => this.mapRunRow(r)),
      total: countRow.total,
    };
  }

  getRun(id: string): AgentRun | null {
    const row = this.db
      .prepare("SELECT * FROM agent_runs WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRunRow(row) : null;
  }

  getRunSteps(runId: string): AgentRunStep[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_run_steps WHERE run_id = ? ORDER BY step_order")
      .all(runId) as Record<string, unknown>[];
    return rows.map((r) => this.mapStepRow(r));
  }

  getRunWithSteps(id: string): AgentRunWithSteps | null {
    const run = this.getRun(id);
    if (!run) return null;
    const steps = this.getRunSteps(id);
    return { ...run, steps };
  }

  getStats(): AgentRunStats {
    const totalRow = this.db
      .prepare("SELECT COUNT(*) as count FROM agent_runs")
      .get() as { count: number };
    const completedRow = this.db
      .prepare("SELECT COUNT(*) as count FROM agent_runs WHERE status = 'completed'")
      .get() as { count: number };
    const failedRow = this.db
      .prepare("SELECT COUNT(*) as count FROM agent_runs WHERE status = 'failed'")
      .get() as { count: number };
    const runningRow = this.db
      .prepare("SELECT COUNT(*) as count FROM agent_runs WHERE status = 'running'")
      .get() as { count: number };
    const avgRow = this.db
      .prepare(
        "SELECT AVG(tool_loop_count) as avg FROM agent_runs WHERE status = 'completed'",
      )
      .get() as { avg: number | null };

    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const recentRunsRow = this.db
      .prepare("SELECT COUNT(*) as count FROM agent_runs WHERE started_at >= ?")
      .get(yesterday) as { count: number };
    const recentStepsRow = this.db
      .prepare("SELECT COUNT(*) as count FROM agent_run_steps WHERE created_at >= ?")
      .get(yesterday) as { count: number };

    return {
      totalRuns: totalRow.count,
      completedRuns: completedRow.count,
      failedRuns: failedRow.count,
      runningRuns: runningRow.count,
      avgToolLoopCount: avgRow.avg ?? 0,
      runsLast24h: recentRunsRow.count,
      totalStepsLast24h: recentStepsRow.count,
    };
  }

  cleanup(olderThanDays: number = 30): number {
    const cutoff = new Date(
      Date.now() - olderThanDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = this.db
      .prepare("DELETE FROM agent_runs WHERE completed_at < ? AND status != 'running'")
      .run(cutoff);
    return result.changes;
  }

  private mapRunRow(row: Record<string, unknown>): AgentRun {
    return {
      id: row.id as string,
      sessionId: row.session_id as string | null,
      userId: row.user_id as string,
      mode: row.mode as string,
      model: row.model as string | null,
      status: row.status as AgentRun["status"],
      errorMessage: row.error_message as string | null,
      promptTokens: row.prompt_tokens as number | null,
      completionTokens: row.completion_tokens as number | null,
      totalTokens: row.total_tokens as number | null,
      toolLoopCount: row.tool_loop_count as number,
      startedAt: row.started_at as string,
      completedAt: row.completed_at as string | null,
    };
  }

  close(): void {
    this.db.close();
  }

  private mapStepRow(row: Record<string, unknown>): AgentRunStep {
    return {
      id: row.id as string,
      runId: row.run_id as string,
      stepType: row.step_type as AgentRunStep["stepType"],
      toolName: row.tool_name as string | null,
      content: safeParse(row.content as string | null),
      sanitizedParams: safeParse(row.sanitized_params as string | null),
      success: row.success !== null ? (row.success as number) === 1 : null,
      errorMessage: row.error_message as string | null,
      durationMs: row.duration_ms as number | null,
      stepOrder: row.step_order as number,
      createdAt: row.created_at as string,
    };
  }
}

function safeParse(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + "...[truncated]";
}

export { AgentRunDatabase };
export const agentRunDatabase = new AgentRunDatabase();