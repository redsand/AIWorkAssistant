import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "data", "app.db");

interface ActionRequestRow {
  id: string;
  action_id: string;
  user_id: string;
  timestamp: string;
  params: string;
  justification: string | null;
  environment: string;
  status: string;
  approver_id: string | null;
  approval_timestamp: string | null;
  execution_success: number | null;
  execution_error: string | null;
  execution_data: string | null;
}

class GuardrailsDatabase {
  private db: Database.Database;

  constructor() {
    this.db = new Database(DB_PATH);
    this.initializeSchema();
  }

  private initializeSchema() {
    this.db.pragma("foreign_keys = ON");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guardrails_actions (
        id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        params TEXT,
        justification TEXT,
        environment TEXT NOT NULL DEFAULT 'development',
        status TEXT NOT NULL DEFAULT 'pending',
        approver_id TEXT,
        approval_timestamp TEXT,
        execution_success INTEGER,
        execution_error TEXT,
        execution_data TEXT
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_guardrails_action_id ON guardrails_actions(action_id);
      CREATE INDEX IF NOT EXISTS idx_guardrails_user_id ON guardrails_actions(user_id);
      CREATE INDEX IF NOT EXISTS idx_guardrails_status ON guardrails_actions(status);
    `);

    console.log("[GuardrailsDB] Schema initialized");
  }

  saveActionRequest(request: {
    id: string;
    actionId: string;
    userId: string;
    timestamp: Date;
    params: Record<string, unknown>;
    justification?: string;
    environment: string;
    status: string;
    approverId?: string;
    approvalTimestamp?: Date;
    executionResult?: {
      success: boolean;
      error?: string;
      data?: Record<string, unknown>;
    };
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO guardrails_actions (
          id, action_id, user_id, timestamp, params, justification,
          environment, status, approver_id, approval_timestamp,
          execution_success, execution_error, execution_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.id,
        request.actionId,
        request.userId,
        request.timestamp.toISOString(),
        JSON.stringify(request.params),
        request.justification ?? null,
        request.environment,
        request.status,
        request.approverId ?? null,
        request.approvalTimestamp?.toISOString() ?? null,
        request.executionResult?.success
          ? 1
          : request.executionResult
            ? 0
            : null,
        request.executionResult?.error ?? null,
        request.executionResult?.data
          ? JSON.stringify(request.executionResult.data)
          : null,
      );
  }

  getActionsByUser(
    userId: string,
    limit: number = 50,
  ): Array<{
    id: string;
    actionId: string;
    userId: string;
    timestamp: Date;
    params: Record<string, unknown>;
    status: string;
  }> {
    const rows = this.db
      .prepare(
        "SELECT * FROM guardrails_actions WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?",
      )
      .all(userId, limit) as ActionRequestRow[];

    return rows.map((row) => ({
      id: row.id,
      actionId: row.action_id,
      userId: row.user_id,
      timestamp: new Date(row.timestamp),
      params: row.params ? JSON.parse(row.params) : {},
      status: row.status,
    }));
  }

  getPendingApprovals(): Array<{
    id: string;
    actionId: string;
    userId: string;
    timestamp: Date;
    status: string;
  }> {
    const rows = this.db
      .prepare(
        "SELECT * FROM guardrails_actions WHERE status = 'pending' ORDER BY timestamp ASC",
      )
      .all() as ActionRequestRow[];

    return rows.map((row) => ({
      id: row.id,
      actionId: row.action_id,
      userId: row.user_id,
      timestamp: new Date(row.timestamp),
      status: row.status,
    }));
  }

  updateStatus(id: string, status: string, approverId?: string): void {
    const updates: string[] = ["status = ?"];
    const params: any[] = [status];

    if (approverId) {
      updates.push("approver_id = ?");
      params.push(approverId);
      updates.push("approval_timestamp = ?");
      params.push(new Date().toISOString());
    }

    params.push(id);
    this.db
      .prepare(
        `UPDATE guardrails_actions SET ${updates.join(", ")} WHERE id = ?`,
      )
      .run(...params);
  }

  getStats(): {
    totalActions: number;
    pendingApprovals: number;
    executionsLast24h: number;
  } {
    const totalResult = this.db
      .prepare("SELECT COUNT(*) as count FROM guardrails_actions")
      .get() as any;
    const pendingResult = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM guardrails_actions WHERE status = 'pending'",
      )
      .get() as any;

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recentResult = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM guardrails_actions WHERE status = 'executed' AND timestamp > ?",
      )
      .get(oneDayAgo) as any;

    return {
      totalActions: totalResult.count,
      pendingApprovals: pendingResult.count,
      executionsLast24h: recentResult.count,
    };
  }
}

export const guardrailsDatabase = new GuardrailsDatabase();
