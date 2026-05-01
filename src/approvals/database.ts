import Database from "better-sqlite3";
import path from "path";
import { ApprovalRequest } from "../policy/types";

const DB_PATH = path.join(process.cwd(), "data", "app.db");

class ApprovalDatabase {
  private db: Database.Database;

  constructor() {
    this.db = new Database(DB_PATH);
    this.initializeSchema();
  }

  private initializeSchema() {
    this.db.pragma("foreign_keys = ON");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        action_description TEXT NOT NULL,
        action_user_id TEXT NOT NULL,
        action_params TEXT,
        policy_result TEXT NOT NULL,
        policy_risk_level TEXT NOT NULL,
        policy_reason TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        requested_at TEXT NOT NULL,
        responded_at TEXT,
        response_by TEXT,
        execution_success INTEGER,
        execution_output TEXT,
        execution_error TEXT,
        executed_at TEXT
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
      CREATE INDEX IF NOT EXISTS idx_approvals_user ON approvals(action_user_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_type ON approvals(action_type);
    `);

    console.log("[ApprovalDB] Schema initialized");
  }

  save(approval: ApprovalRequest): void {
    const row = this.db
      .prepare("SELECT id FROM approvals WHERE id = ?")
      .get(approval.id) as any;

    if (row) {
      this.db
        .prepare(
          `UPDATE approvals SET
            status = ?, responded_at = ?, response_by = ?,
            execution_success = ?, execution_output = ?, execution_error = ?, executed_at = ?
          WHERE id = ?`,
        )
        .run(
          approval.status,
          approval.respondedAt?.toISOString() ?? null,
          approval.responseBy ?? null,
          approval.executionResult?.success
            ? 1
            : approval.executionResult
              ? 0
              : null,
          approval.executionResult?.output
            ? JSON.stringify(approval.executionResult.output)
            : null,
          approval.executionResult?.error ?? null,
          approval.executionResult?.executedAt?.toISOString() ?? null,
          approval.id,
        );
      return;
    }

    this.db
      .prepare(
        `INSERT INTO approvals (
          id, action_type, action_description, action_user_id, action_params,
          policy_result, policy_risk_level, policy_reason, status,
          requested_at, responded_at, response_by,
          execution_success, execution_output, execution_error, executed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.action.type,
        approval.action.description,
        approval.action.userId,
        JSON.stringify(approval.action.params),
        approval.decision.result,
        approval.decision.riskLevel,
        approval.decision.reason,
        approval.status,
        approval.requestedAt.toISOString(),
        approval.respondedAt?.toISOString() ?? null,
        approval.responseBy ?? null,
        approval.executionResult?.success
          ? 1
          : approval.executionResult
            ? 0
            : null,
        approval.executionResult?.output
          ? JSON.stringify(approval.executionResult.output)
          : null,
        approval.executionResult?.error ?? null,
        approval.executionResult?.executedAt?.toISOString() ?? null,
      );
  }

  get(id: string): ApprovalRequest | null {
    const row = this.db
      .prepare("SELECT * FROM approvals WHERE id = ?")
      .get(id) as any;
    if (!row) return null;
    return this.mapRow(row);
  }

  list(
    filter: {
      status?: string;
      userId?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): {
    approvals: ApprovalRequest[];
    total: number;
    filtered: number;
  } {
    let query = "SELECT * FROM approvals WHERE 1=1";
    const params: any[] = [];

    if (filter.status) {
      query += " AND status = ?";
      params.push(filter.status);
    }
    if (filter.userId) {
      query += " AND action_user_id = ?";
      params.push(filter.userId);
    }

    const total = (
      this.db.prepare("SELECT COUNT(*) as count FROM approvals").get() as any
    ).count;

    query += " ORDER BY requested_at DESC";

    if (filter.limit) {
      query += " LIMIT ?";
      params.push(filter.limit);
    }
    if (filter.offset) {
      query += " OFFSET ?";
      params.push(filter.offset);
    }

    const rows = this.db.prepare(query).all(...params) as any[];
    const filtered = rows.length;

    return {
      approvals: rows.map((r) => this.mapRow(r)),
      total,
      filtered,
    };
  }

  private mapRow(row: any): ApprovalRequest {
    return {
      id: row.id,
      action: {
        id: row.id,
        type: row.action_type,
        description: row.action_description,
        params: row.action_params ? JSON.parse(row.action_params) : {},
        userId: row.action_user_id,
        timestamp: new Date(row.requested_at),
      },
      decision: {
        action: {
          id: row.id,
          type: row.action_type,
          description: row.action_description,
          params: row.action_params ? JSON.parse(row.action_params) : {},
          userId: row.action_user_id,
          timestamp: new Date(row.requested_at),
        },
        result: row.policy_result,
        riskLevel: row.policy_risk_level,
        reason: row.policy_reason || "",
      },
      status: row.status,
      requestedAt: new Date(row.requested_at),
      respondedAt: row.responded_at ? new Date(row.responded_at) : undefined,
      responseBy: row.response_by ?? undefined,
      executionResult:
        row.execution_success !== null
          ? {
              success: row.execution_success === 1,
              output: row.execution_output
                ? JSON.parse(row.execution_output)
                : undefined,
              error: row.execution_error ?? undefined,
              executedAt: row.executed_at
                ? new Date(row.executed_at)
                : new Date(),
            }
          : undefined,
    };
  }

  cleanup(olderThanDays: number = 30): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);

    const result = this.db
      .prepare(
        "DELETE FROM approvals WHERE status IN ('approved', 'rejected', 'executed', 'failed') AND responded_at < ?",
      )
      .run(cutoff.toISOString());

    return result.changes;
  }
}

export const approvalDatabase = new ApprovalDatabase();
