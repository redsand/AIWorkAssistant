import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import { env } from "../config/env";
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
        provider TEXT,
        model TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        error_message TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        tool_loop_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        last_activity_at TEXT,
        completed_at TEXT,
        cancelled_at TEXT
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
      CREATE INDEX IF NOT EXISTS idx_agent_runs_session_id ON agent_runs(session_id);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_started_at ON agent_runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_agent_run_steps_run_id ON agent_run_steps(run_id);
      CREATE INDEX IF NOT EXISTS idx_agent_run_steps_tool_name ON agent_run_steps(tool_name);
    `);
    this.ensureColumn("agent_runs", "last_activity_at", "TEXT");
    this.ensureColumn("agent_runs", "cancelled_at", "TEXT");
    this.ensureColumn("agent_runs", "issue_id", "TEXT");
    this.ensureColumn("agent_runs", "issue_platform", "TEXT");
    this.ensureColumn("agent_runs", "issue_repo", "TEXT");
    this.ensureColumn("agent_runs", "worktree_path", "TEXT");
    this.ensureColumn("agent_runs", "branch", "TEXT");
    this.ensureColumn("agent_runs", "agent_type", "TEXT");
    this.ensureColumn("agent_runs", "provider", "TEXT");
    // pid: the OS process id that started this run. Lets us detect
    // cross-process zombies at boot without any time threshold.
    this.ensureColumn("agent_runs", "pid", "INTEGER");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_runs_last_activity_at ON agent_runs(last_activity_at);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_issue ON agent_runs(issue_platform, issue_repo, issue_id);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_pid ON agent_runs(pid);
    `);
    this.db
      .prepare(
        "UPDATE agent_runs SET last_activity_at = started_at WHERE last_activity_at IS NULL",
      )
      .run();

    // Processed issues ledger — idempotent, concurrency-safe alternative to JSON file
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processed_issues (
        issue_key TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        processed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_processed_issues_workspace ON processed_issues(workspace);
    `);

    // Kanban settings — singleton k/v store for autoCleanupHours etc.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kanban_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Failed attempts tracker — persists retry counts across process restarts
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS failed_attempts (
        issue_key TEXT NOT NULL,
        workspace TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT NOT NULL,
        PRIMARY KEY (issue_key, workspace)
      );
      CREATE INDEX IF NOT EXISTS idx_failed_attempts_workspace ON failed_attempts(workspace);
    `);

    // Blacklisted issues — permanently skipped after MAX_FAILED_ATTEMPTS
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blacklisted_issues (
        issue_key TEXT NOT NULL,
        workspace TEXT NOT NULL,
        reason TEXT NOT NULL,
        blacklisted_at TEXT NOT NULL,
        PRIMARY KEY (issue_key, workspace)
      );
    `);
  }

  startRun(params: AgentRunCreateParams): AgentRun {
    const id = uuidv4();
    const now = new Date().toISOString();
    const pid = process.pid;
    this.db
      .prepare(
        `INSERT INTO agent_runs (id, session_id, user_id, mode, provider, model, status, started_at, last_activity_at, issue_id, issue_platform, issue_repo, worktree_path, branch, agent_type, pid)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.sessionId ?? null,
        params.userId,
        params.mode,
        params.provider ?? null,
        params.model ?? null,
        now,
        now,
        params.issueId ?? null,
        params.issuePlatform ?? null,
        params.issueRepo ?? null,
        params.worktreePath ?? null,
        params.branch ?? null,
        params.agentType ?? null,
        pid,
      );

    return {
      id,
      sessionId: params.sessionId ?? null,
      userId: params.userId,
      mode: params.mode,
      provider: params.provider ?? null,
      model: params.model ?? null,
      status: "running",
      errorMessage: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      toolLoopCount: 0,
      startedAt: now,
      lastActivityAt: now,
      completedAt: null,
      cancelledAt: null,
      issueId: params.issueId ?? null,
      issuePlatform: params.issuePlatform ?? null,
      issueRepo: params.issueRepo ?? null,
      worktreePath: params.worktreePath ?? null,
      branch: params.branch ?? null,
      agentType: params.agentType ?? null,
      pid,
    };
  }

  completeRun(id: string, data: AgentRunCompleteParams): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE agent_runs
         SET status = 'completed', model = ?, prompt_tokens = ?, completion_tokens = ?,
             total_tokens = ?, tool_loop_count = ?, last_activity_at = ?, completed_at = ?, error_message = NULL
         WHERE id = ?`,
      )
      .run(
        data.model ?? null,
        data.promptTokens ?? null,
        data.completionTokens ?? null,
        data.totalTokens ?? null,
        data.toolLoopCount,
        now,
        now,
        id,
      );
  }

  failRun(id: string, errorMessage: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE agent_runs SET status = 'failed', error_message = ?, last_activity_at = ?, completed_at = ? WHERE id = ?`,
      )
      .run(errorMessage, now, now, id);
  }

  /**
   * Update tool_loop_count + last_activity_at without changing status.
   * Called inside the model/tool loop so the counter is persisted even
   * when the run later fails, is cancelled, or stalls. The completeRun
   * path also writes the counter; this ensures the value is current at
   * every step rather than only on clean completion.
   */
  updateToolLoopCount(id: string, toolLoopCount: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE agent_runs SET tool_loop_count = ?, last_activity_at = ? WHERE id = ?`,
      )
      .run(toolLoopCount, now, id);
  }

  /**
   * Mark runs that have gone silent as failed. Catches the pattern from
   * session 0a6a8d8d (2026-06-11) where runs entered the model loop and
   * stopped responding without ever calling completeRun / failRun, so
   * the dashboard showed them as "running" indefinitely.
   *
   * Returns the number of rows reaped and the distinct session_ids that
   * were affected. The caller uses sessionIds to also abort the in-memory
   * ProcessingJob — without that, the AbortController never fires and the
   * aiRequestLimiter slot held by the stalled provider call leaks until the
   * upstream socket closes.
   */
  /**
   * Wipe zombie runs left behind by prior server processes.
   *
   * Any 'running' row whose pid differs from the current process (or whose pid
   * is NULL because it predates the migration) is dead by definition — the
   * prior process is gone and so is its in-memory ProcessingJob and
   * aiRequestLimiter slot. This is purely a cross-process detection and is NOT
   * gated on AICODER_STALE_TIMEOUT_MINUTES: there's no policy decision here.
   *
   * Call this at server startup BEFORE the periodic reaper begins, so the
   * dashboard and slot accounting reflect reality immediately.
   *
   * Returns affected row count and the distinct session_ids — symmetric with
   * reapStaleRunningRuns so the caller can fire onReapCallback, although on
   * startup there are no in-memory jobs to abort (the prior process owned
   * them) so the session-id list is mostly informational at boot.
   */
  markZombieRunsFromPriorProcess(): { count: number; sessionIds: string[] } {
    const currentPid = process.pid;
    const rows = this.db
      .prepare(
        `SELECT DISTINCT session_id FROM agent_runs
         WHERE status = 'running'
           AND (pid IS NULL OR pid != ?)
           AND session_id IS NOT NULL`,
      )
      .all(currentPid) as Array<{ session_id: string }>;
    const sessionIds = rows
      .map((r) => r.session_id)
      .filter((s): s is string => !!s);

    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE agent_runs
         SET status = 'failed',
             error_message = COALESCE(error_message, 'Zombie run from prior process (pid mismatch)'),
             completed_at = ?,
             cancelled_at = COALESCE(cancelled_at, ?),
             last_activity_at = ?
         WHERE status = 'running'
           AND (pid IS NULL OR pid != ?)`,
      )
      .run(now, now, now, currentPid);
    return { count: result.changes, sessionIds };
  }

  reapStaleRunningRuns(staleAfterMs: number): { count: number; sessionIds: string[] } {
    const cutoffIso = new Date(Date.now() - staleAfterMs).toISOString();
    // Snapshot session_ids BEFORE the UPDATE so we know who to abort.
    const rows = this.db
      .prepare(
        `SELECT DISTINCT session_id FROM agent_runs
         WHERE status = 'running' AND last_activity_at < ? AND session_id IS NOT NULL`,
      )
      .all(cutoffIso) as Array<{ session_id: string }>;
    const sessionIds = rows.map((r) => r.session_id).filter((s): s is string => !!s);

    const result = this.db
      .prepare(
        `UPDATE agent_runs
         SET status = 'failed',
             error_message = COALESCE(error_message, 'Reaped: no activity for ' || ? || 's'),
             completed_at = ?,
             cancelled_at = COALESCE(cancelled_at, ?)
         WHERE status = 'running' AND last_activity_at < ?`,
      )
      .run(Math.round(staleAfterMs / 1000), new Date().toISOString(), new Date().toISOString(), cutoffIso);
    return { count: result.changes, sessionIds };
  }

  cancelRun(id: string, errorMessage = "Run cancelled by user"): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE agent_runs
         SET status = 'failed', error_message = ?, last_activity_at = ?, completed_at = ?, cancelled_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(errorMessage, now, now, now, id);
  }

  touchRun(id: string): void {
    this.db
      .prepare(
        "UPDATE agent_runs SET last_activity_at = ? WHERE id = ? AND status = 'running'",
      )
      .run(new Date().toISOString(), id);
  }

  markStaleRunsAsFailed(olderThanMinutes?: number): number {
    // Read AICODER_STALE_TIMEOUT_MINUTES from LIVE process.env only — the
    // zod-frozen `env` object is captured at module-import time and won't
    // reflect runtime changes. dotenv populates process.env at startup, so
    // production behavior is unchanged; tests can flip the value at runtime.
    const rawEnv = process.env.AICODER_STALE_TIMEOUT_MINUTES;
    const envValue = rawEnv !== undefined && rawEnv !== "" ? Number(rawEnv) : NaN;
    // Three layers of resolution:
    //   1. Explicit caller-supplied threshold wins.
    //   2. Env=0 means DISABLED (matches reaper.ts semantics). Without this
    //      check, a 0-threshold reaps every running row immediately on every
    //      sweep — observed killing chat jobs after ~21s when a user set
    //      AICODER_STALE_TIMEOUT_MINUTES=0 expecting it to disable reaping.
    //   3. NaN/missing falls back to 120 minutes.
    let threshold: number;
    if (olderThanMinutes !== undefined) {
      threshold = olderThanMinutes;
    } else if (Number.isNaN(envValue)) {
      threshold = 120;
    } else if (envValue <= 0) {
      return 0; // disabled — no rows reaped
    } else {
      threshold = envValue;
    }
    const cutoff = new Date(
      Date.now() - threshold * 60 * 1000,
    ).toISOString();
    const result = this.db
      .prepare(
        `UPDATE agent_runs
         SET status = 'failed', error_message = 'Run timed out (stale)', completed_at = ?, last_activity_at = ?
         WHERE status = 'running' AND COALESCE(last_activity_at, started_at) < ?`,
      )
      .run(new Date().toISOString(), new Date().toISOString(), cutoff);
    return result.changes;
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
        step.success == null ? null : step.success ? 1 : 0,
        step.errorMessage ?? null,
        step.durationMs ?? null,
        step.stepOrder,
        now,
      );
    this.touchRun(step.runId);

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
    sessionId?: string;
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
    if (filters?.sessionId) {
      conditions.push("session_id = ?");
      params.push(filters.sessionId);
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
    this.markStaleRunsAsFailed();
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
      provider: (row.provider as string | null) ?? null,
      model: row.model as string | null,
      status: row.status as AgentRun["status"],
      errorMessage: row.error_message as string | null,
      promptTokens: row.prompt_tokens as number | null,
      completionTokens: row.completion_tokens as number | null,
      totalTokens: row.total_tokens as number | null,
      toolLoopCount: row.tool_loop_count as number,
      startedAt: row.started_at as string,
      lastActivityAt:
        (row.last_activity_at as string | null) ?? (row.started_at as string),
      completedAt: row.completed_at as string | null,
      cancelledAt: row.cancelled_at as string | null,
      issueId: (row.issue_id as string | null) ?? null,
      issuePlatform: (row.issue_platform as string | null) ?? null,
      issueRepo: (row.issue_repo as string | null) ?? null,
      worktreePath: (row.worktree_path as string | null) ?? null,
      branch: (row.branch as string | null) ?? null,
      agentType: (row.agent_type as string | null) ?? null,
      pid: (row.pid as number | null) ?? null,
    };
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (!rows.some((row) => row.name === column)) {
      this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
    }
  }

  // ── Processed issues ledger ──────────────────────────────────────────────────

  /**
   * Record that an issue has been processed. Idempotent — safe to call concurrently.
   */
  markIssueProcessed(issueKey: string, workspace: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO processed_issues (issue_key, workspace, processed_at) VALUES (?, ?, ?)`,
      )
      .run(issueKey, workspace, now);
  }

  /**
   * Check whether an issue has already been processed.
   */
  isIssueProcessed(issueKey: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM processed_issues WHERE issue_key = ?`)
      .get(issueKey);
    return row !== undefined;
  }

  /**
   * Remove an issue from the processed set (e.g. for --force re-processing).
   */
  unmarkIssueProcessed(issueKey: string): void {
    this.db
      .prepare(`DELETE FROM processed_issues WHERE issue_key = ?`)
      .run(issueKey);
  }

  /**
   * List all processed issue keys for a workspace.
   */
  listProcessedIssues(workspace?: string): string[] {
    const rows = workspace
      ? this.db
          .prepare(`SELECT issue_key FROM processed_issues WHERE workspace = ? ORDER BY processed_at DESC`)
          .all(workspace)
      : this.db
          .prepare(`SELECT issue_key FROM processed_issues ORDER BY processed_at DESC`)
          .all();
    return (rows as Array<{ issue_key: string }>).map((r) => r.issue_key);
  }

  // ── Kanban settings ──────────────────────────────────────────────────────────

  getKanbanSetting(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM kanban_settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setKanbanSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO kanban_settings (key, value) VALUES (?, ?)")
      .run(key, value);
  }

  getAllKanbanSettings(): Record<string, string> {
    const rows = this.db
      .prepare("SELECT key, value FROM kanban_settings")
      .all() as Array<{ key: string; value: string }>;
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  // ── Failed attempts ──────────────────────────────────────────────────────────

  getFailedAttemptCount(issueKey: string, workspace: string): number {
    const row = this.db
      .prepare("SELECT count FROM failed_attempts WHERE issue_key = ? AND workspace = ?")
      .get(issueKey, workspace) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  incrementFailedAttempt(issueKey: string, workspace: string): number {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO failed_attempts (issue_key, workspace, count, last_attempt_at)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(issue_key, workspace) DO UPDATE SET
          count = count + 1,
          last_attempt_at = excluded.last_attempt_at
      `)
      .run(issueKey, workspace, now);
    return this.getFailedAttemptCount(issueKey, workspace);
  }

  clearFailedAttempt(issueKey: string, workspace: string): void {
    this.db
      .prepare("DELETE FROM failed_attempts WHERE issue_key = ? AND workspace = ?")
      .run(issueKey, workspace);
  }

  isIssueBlacklisted(issueKey: string, workspace: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM blacklisted_issues WHERE issue_key = ? AND workspace = ?")
      .get(issueKey, workspace);
    return row !== undefined;
  }

  blacklistIssue(issueKey: string, workspace: string, reason: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT OR REPLACE INTO blacklisted_issues (issue_key, workspace, reason, blacklisted_at) VALUES (?, ?, ?, ?)")
      .run(issueKey, workspace, reason, now);
  }

  getBlacklistedIssues(workspace?: string): Array<{ issueKey: string; reason: string; blacklistedAt: string }> {
    const rows = workspace
      ? this.db.prepare("SELECT issue_key, reason, blacklisted_at FROM blacklisted_issues WHERE workspace = ? ORDER BY blacklisted_at DESC").all(workspace)
      : this.db.prepare("SELECT issue_key, reason, blacklisted_at FROM blacklisted_issues ORDER BY blacklisted_at DESC").all();
    return (rows as Array<{ issue_key: string; reason: string; blacklisted_at: string }>).map((r) => ({
      issueKey: r.issue_key,
      reason: r.reason,
      blacklistedAt: r.blacklisted_at,
    }));
  }

  unblacklistIssue(issueKey: string, workspace: string): void {
    this.db
      .prepare("DELETE FROM blacklisted_issues WHERE issue_key = ? AND workspace = ?")
      .run(issueKey, workspace);
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
