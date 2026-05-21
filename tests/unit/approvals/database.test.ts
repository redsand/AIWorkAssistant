import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockPrepare = vi.fn();
const mockExec = vi.fn();
const mockPragma = vi.fn();

vi.mock("better-sqlite3", () => {
  return {
    default: vi.fn(function (this: any, _path: string) {
      this.prepare = mockPrepare;
      this.exec = mockExec;
      this.pragma = mockPragma;
    }),
  };
});

vi.spyOn(console, "log").mockImplementation(() => {});

import type { ApprovalRequest } from "../../../src/policy/types";

let approvalDatabase: any;

beforeEach(async () => {
  vi.clearAllMocks();
  mockPragma.mockReturnValue(undefined);
  mockExec.mockReturnValue(undefined);

  vi.resetModules();

  vi.doMock("better-sqlite3", () => ({
    default: vi.fn(function (this: any, _path: string) {
      this.prepare = mockPrepare;
      this.exec = mockExec;
      this.pragma = mockPragma;
    }),
  }));

  const mod = await import("../../../src/approvals/database");
  approvalDatabase = mod.approvalDatabase;
});

function makeApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "approval-1",
    action: {
      id: "approval-1",
      type: "file_write",
      description: "Write a file",
      params: { path: "/tmp/test.txt" },
      userId: "user-1",
      timestamp: new Date("2025-01-15T10:00:00.000Z"),
    },
    decision: {
      action: {
        id: "approval-1",
        type: "file_write",
        description: "Write a file",
        params: { path: "/tmp/test.txt" },
        userId: "user-1",
        timestamp: new Date("2025-01-15T10:00:00.000Z"),
      },
      result: "requires_approval" as any,
      riskLevel: "high" as any,
      reason: "Writing to filesystem",
    },
    status: "pending",
    requestedAt: new Date("2025-01-15T10:00:00.000Z"),
    ...overrides,
  };
}

describe("ApprovalDatabase", () => {
  // ── Schema initialization ─────────────────────────────────────────────────────

  describe("constructor", () => {
    it("initializes the schema with foreign keys pragma", () => {
      expect(mockPragma).toHaveBeenCalledWith("foreign_keys = ON");
      expect(mockExec).toHaveBeenCalled();
    });
  });

  // ── save (INSERT) ─────────────────────────────────────────────────────────────

  describe("save -- insert", () => {
    it("inserts a new approval when no existing row is found", () => {
      const mockGetStmt = { get: vi.fn().mockReturnValue(undefined) };
      const mockRunStmt = { run: vi.fn() };
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id")) return mockGetStmt;
        return mockRunStmt;
      });

      const approval = makeApproval();
      approvalDatabase.save(approval);

      expect(mockRunStmt.run).toHaveBeenCalled();
      const runArgs = mockRunStmt.run.mock.calls[0];
      expect(runArgs[0]).toBe("approval-1");
      expect(runArgs[1]).toBe("file_write");
      expect(runArgs[5]).toBe("requires_approval");
      expect(runArgs[6]).toBe("high");
    });

    it("serializes action params as JSON", () => {
      const mockGetStmt = { get: vi.fn().mockReturnValue(undefined) };
      const mockRunStmt = { run: vi.fn() };
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id")) return mockGetStmt;
        return mockRunStmt;
      });

      const approval = makeApproval();
      approvalDatabase.save(approval);

      const runArgs = mockRunStmt.run.mock.calls[0];
      expect(runArgs[4]).toBe(JSON.stringify({ path: "/tmp/test.txt" }));
    });

    it("stores execution result fields when present", () => {
      const mockGetStmt = { get: vi.fn().mockReturnValue(undefined) };
      const mockRunStmt = { run: vi.fn() };
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id")) return mockGetStmt;
        return mockRunStmt;
      });

      const approval = makeApproval({
        status: "executed",
        respondedAt: new Date("2025-01-15T11:00:00.000Z"),
        responseBy: "admin",
        executionResult: {
          success: true,
          output: { linesWritten: 42 },
          error: undefined,
          executedAt: new Date("2025-01-15T11:01:00.000Z"),
        },
      });
      approvalDatabase.save(approval);

      const runArgs = mockRunStmt.run.mock.calls[0];
      expect(runArgs[12]).toBe(1);
      expect(runArgs[13]).toBe(JSON.stringify({ linesWritten: 42 }));
      expect(runArgs[14]).toBeNull();
      expect(runArgs[15]).toBe("2025-01-15T11:01:00.000Z");
    });

    it("stores 0 for execution_success when success is false", () => {
      const mockGetStmt = { get: vi.fn().mockReturnValue(undefined) };
      const mockRunStmt = { run: vi.fn() };
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id")) return mockGetStmt;
        return mockRunStmt;
      });

      const approval = makeApproval({
        status: "failed",
        executionResult: {
          success: false,
          error: "Permission denied",
          executedAt: new Date("2025-01-15T12:00:00.000Z"),
        },
      });
      approvalDatabase.save(approval);

      const runArgs = mockRunStmt.run.mock.calls[0];
      expect(runArgs[12]).toBe(0);
      expect(runArgs[14]).toBe("Permission denied");
    });

    it("stores null for execution_success when no executionResult", () => {
      const mockGetStmt = { get: vi.fn().mockReturnValue(undefined) };
      const mockRunStmt = { run: vi.fn() };
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id")) return mockGetStmt;
        return mockRunStmt;
      });

      const approval = makeApproval();
      approvalDatabase.save(approval);

      const runArgs = mockRunStmt.run.mock.calls[0];
      expect(runArgs[12]).toBeNull();
    });
  });

  // ── save (UPDATE) ─────────────────────────────────────────────────────────────

  describe("save -- update", () => {
    it("updates an existing approval when row is found", () => {
      const mockGetStmt = { get: vi.fn().mockReturnValue({ id: "approval-1" }) };
      const mockRunStmt = { run: vi.fn() };
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id")) return mockGetStmt;
        return mockRunStmt;
      });

      const approval = makeApproval({
        status: "approved",
        respondedAt: new Date("2025-01-15T11:00:00.000Z"),
        responseBy: "admin",
      });
      approvalDatabase.save(approval);

      expect(mockRunStmt.run).toHaveBeenCalled();
      const sql = mockPrepare.mock.calls[1][0];
      expect(sql).toContain("UPDATE approvals");
    });

    it("stores updated execution result in update path", () => {
      const mockGetStmt = { get: vi.fn().mockReturnValue({ id: "approval-1" }) };
      const mockRunStmt = { run: vi.fn() };
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id")) return mockGetStmt;
        return mockRunStmt;
      });

      const approval = makeApproval({
        status: "executed",
        executionResult: {
          success: true,
          output: null,
          error: undefined,
          executedAt: new Date("2025-01-15T12:00:00.000Z"),
        },
      });
      approvalDatabase.save(approval);

      const runArgs = mockRunStmt.run.mock.calls[0];
      expect(runArgs[0]).toBe("executed");
      expect(runArgs[3]).toBe(1); // execution_success = 1 for true
      expect(runArgs[4]).toBeNull(); // execution_output is null when output is falsy
    });
  });

  // ── get ───────────────────────────────────────────────────────────────────────

  describe("get", () => {
    it("returns null when no row is found", () => {
      mockPrepare.mockReturnValue({ get: vi.fn().mockReturnValue(undefined) });

      const result = approvalDatabase.get("nonexistent");

      expect(result).toBeNull();
    });

    it("maps a database row to an ApprovalRequest", () => {
      const row = {
        id: "approval-1",
        action_type: "file_write",
        action_description: "Write a file",
        action_user_id: "user-1",
        action_params: '{"path":"/tmp/test.txt"}',
        policy_result: "requires_approval",
        policy_risk_level: "high",
        policy_reason: "Writing to filesystem",
        status: "approved",
        requested_at: "2025-01-15T10:00:00.000Z",
        responded_at: "2025-01-15T11:00:00.000Z",
        response_by: "admin",
        execution_success: null,
        execution_output: null,
        execution_error: null,
        executed_at: null,
      };
      mockPrepare.mockReturnValue({ get: vi.fn().mockReturnValue(row) });

      const result = approvalDatabase.get("approval-1");

      expect(result).not.toBeNull();
      expect(result.id).toBe("approval-1");
      expect(result.action.type).toBe("file_write");
      expect(result.action.params).toEqual({ path: "/tmp/test.txt" });
      expect(result.decision.result).toBe("requires_approval");
      expect(result.status).toBe("approved");
      expect(result.requestedAt).toEqual(new Date("2025-01-15T10:00:00.000Z"));
      expect(result.respondedAt).toEqual(new Date("2025-01-15T11:00:00.000Z"));
      expect(result.responseBy).toBe("admin");
    });

    it("maps execution result when present with success", () => {
      const row = {
        id: "approval-2",
        action_type: "cmd",
        action_description: "Run command",
        action_user_id: "user-2",
        action_params: null,
        policy_result: "auto_approved",
        policy_risk_level: "low",
        policy_reason: "Safe command",
        status: "executed",
        requested_at: "2025-01-15T10:00:00.000Z",
        responded_at: null,
        response_by: null,
        execution_success: 1,
        execution_output: '{"exitCode":0}',
        execution_error: null,
        executed_at: "2025-01-15T10:01:00.000Z",
      };
      mockPrepare.mockReturnValue({ get: vi.fn().mockReturnValue(row) });

      const result = approvalDatabase.get("approval-2");

      expect(result.executionResult).toBeDefined();
      expect(result.executionResult.success).toBe(true);
      expect(result.executionResult.output).toEqual({ exitCode: 0 });
      expect(result.executionResult.executedAt).toEqual(new Date("2025-01-15T10:01:00.000Z"));
    });

    it("maps execution result with failure", () => {
      const row = {
        id: "approval-3",
        action_type: "cmd",
        action_description: "Run command",
        action_user_id: "user-2",
        action_params: null,
        policy_result: "auto_approved",
        policy_risk_level: "low",
        policy_reason: "Safe command",
        status: "failed",
        requested_at: "2025-01-15T10:00:00.000Z",
        responded_at: null,
        response_by: null,
        execution_success: 0,
        execution_output: null,
        execution_error: "Command not found",
        executed_at: "2025-01-15T10:01:00.000Z",
      };
      mockPrepare.mockReturnValue({ get: vi.fn().mockReturnValue(row) });

      const result = approvalDatabase.get("approval-3");

      expect(result.executionResult.success).toBe(false);
      expect(result.executionResult.error).toBe("Command not found");
    });

    it("maps execution result without executed_at, defaulting to now", () => {
      const row = {
        id: "approval-4",
        action_type: "test",
        action_description: "Test",
        action_user_id: "u1",
        action_params: null,
        policy_result: "auto_approved",
        policy_risk_level: "low",
        policy_reason: "",
        status: "executed",
        requested_at: "2025-01-15T10:00:00.000Z",
        responded_at: null,
        response_by: null,
        execution_success: 1,
        execution_output: null,
        execution_error: null,
        executed_at: null,
      };
      mockPrepare.mockReturnValue({ get: vi.fn().mockReturnValue(row) });

      const result = approvalDatabase.get("approval-4");

      expect(result.executionResult.executedAt).toBeInstanceOf(Date);
    });

    it("handles null action_params as empty object", () => {
      const row = {
        id: "approval-5",
        action_type: "test",
        action_description: "Test",
        action_user_id: "u1",
        action_params: null,
        policy_result: "auto_approved",
        policy_risk_level: "low",
        policy_reason: "",
        status: "pending",
        requested_at: "2025-01-15T10:00:00.000Z",
        responded_at: null,
        response_by: null,
        execution_success: null,
        execution_output: null,
        execution_error: null,
        executed_at: null,
      };
      mockPrepare.mockReturnValue({ get: vi.fn().mockReturnValue(row) });

      const result = approvalDatabase.get("approval-5");

      expect(result.action.params).toEqual({});
    });

    it("returns undefined for respondedAt when null", () => {
      const row = {
        id: "a1",
        action_type: "t",
        action_description: "d",
        action_user_id: "u",
        action_params: null,
        policy_result: "auto_approved",
        policy_risk_level: "low",
        policy_reason: "",
        status: "pending",
        requested_at: "2025-01-15T10:00:00.000Z",
        responded_at: null,
        response_by: null,
        execution_success: null,
        execution_output: null,
        execution_error: null,
        executed_at: null,
      };
      mockPrepare.mockReturnValue({ get: vi.fn().mockReturnValue(row) });

      const result = approvalDatabase.get("a1");

      expect(result.respondedAt).toBeUndefined();
      expect(result.responseBy).toBeUndefined();
    });
  });

  // ── list ──────────────────────────────────────────────────────────────────────

  describe("list", () => {
    it("returns empty list with total count when no rows", () => {
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("COUNT")) return { get: vi.fn().mockReturnValue({ count: 0 }) };
        return { all: vi.fn().mockReturnValue([]) };
      });

      const result = approvalDatabase.list();

      expect(result.approvals).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.filtered).toBe(0);
    });

    it("applies status filter", () => {
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("COUNT")) return { get: vi.fn().mockReturnValue({ count: 5 }) };
        return { all: vi.fn().mockReturnValue([]) };
      });

      approvalDatabase.list({ status: "pending" });

      const listQuery = mockPrepare.mock.calls.find(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("SELECT *") && !c[0].includes("COUNT"),
      );
      expect(listQuery![0]).toContain("status = ?");
    });

    it("applies userId filter", () => {
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("COUNT")) return { get: vi.fn().mockReturnValue({ count: 3 }) };
        return { all: vi.fn().mockReturnValue([]) };
      });

      approvalDatabase.list({ userId: "user-1" });

      const listQuery = mockPrepare.mock.calls.find(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("SELECT *") && !c[0].includes("COUNT"),
      );
      expect(listQuery![0]).toContain("action_user_id = ?");
    });

    it("applies limit and offset", () => {
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("COUNT")) return { get: vi.fn().mockReturnValue({ count: 100 }) };
        return { all: vi.fn().mockReturnValue([]) };
      });

      approvalDatabase.list({ limit: 10, offset: 20 });

      const listQuery = mockPrepare.mock.calls.find(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("SELECT *") && !c[0].includes("COUNT"),
      );
      expect(listQuery![0]).toContain("LIMIT ?");
      expect(listQuery![0]).toContain("OFFSET ?");
    });

    it("orders by requested_at DESC", () => {
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("COUNT")) return { get: vi.fn().mockReturnValue({ count: 0 }) };
        return { all: vi.fn().mockReturnValue([]) };
      });

      approvalDatabase.list();

      const listQuery = mockPrepare.mock.calls.find(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("SELECT *") && !c[0].includes("COUNT"),
      );
      expect(listQuery![0]).toContain("ORDER BY requested_at DESC");
    });

    it("maps rows and returns filtered count", () => {
      const rows = [
        {
          id: "a1",
          action_type: "t1",
          action_description: "d1",
          action_user_id: "u1",
          action_params: null,
          policy_result: "auto_approved",
          policy_risk_level: "low",
          policy_reason: "",
          status: "pending",
          requested_at: "2025-01-15T10:00:00.000Z",
          responded_at: null,
          response_by: null,
          execution_success: null,
          execution_output: null,
          execution_error: null,
          executed_at: null,
        },
        {
          id: "a2",
          action_type: "t2",
          action_description: "d2",
          action_user_id: "u2",
          action_params: null,
          policy_result: "requires_approval",
          policy_risk_level: "high",
          policy_reason: "Risk",
          status: "approved",
          requested_at: "2025-01-15T11:00:00.000Z",
          responded_at: null,
          response_by: null,
          execution_success: null,
          execution_output: null,
          execution_error: null,
          executed_at: null,
        },
      ];
      mockPrepare.mockImplementation((sql: string) => {
        if (sql.includes("COUNT")) return { get: vi.fn().mockReturnValue({ count: 50 }) };
        return { all: vi.fn().mockReturnValue(rows) };
      });

      const result = approvalDatabase.list({ limit: 10 });

      expect(result.approvals).toHaveLength(2);
      expect(result.total).toBe(50);
      expect(result.filtered).toBe(2);
      expect(result.approvals[0].id).toBe("a1");
      expect(result.approvals[1].id).toBe("a2");
    });
  });

  // ── cleanup ───────────────────────────────────────────────────────────────────

  describe("cleanup", () => {
    it("deletes old resolved approvals and returns change count", () => {
      mockPrepare.mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 7 }) });

      const deleted = approvalDatabase.cleanup(30);

      expect(deleted).toBe(7);
      const sql = mockPrepare.mock.calls[0][0];
      expect(sql).toContain("DELETE FROM approvals");
      expect(sql).toContain("status IN ('approved', 'rejected', 'executed', 'failed')");
      expect(sql).toContain("responded_at < ?");
    });

    it("defaults to 30 days when no argument passed", () => {
      mockPrepare.mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }) });

      approvalDatabase.cleanup();

      expect(mockPrepare).toHaveBeenCalled();
    });

    it("returns 0 when nothing to delete", () => {
      mockPrepare.mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }) });

      const deleted = approvalDatabase.cleanup(7);

      expect(deleted).toBe(0);
    });
  });
});
