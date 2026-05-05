import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import { AgentRunDatabase } from "../../../src/agent-runs/database";

describe("AgentRunDatabase", () => {
  let db: AgentRunDatabase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runs-test-"));
    db = new AgentRunDatabase(path.join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("startRun / completeRun / failRun", () => {
    it("should start a run with status 'running'", () => {
      const run = db.startRun({ userId: "user1", mode: "chat" });
      expect(run.status).toBe("running");
      expect(run.userId).toBe("user1");
      expect(run.mode).toBe("chat");
      expect(run.id).toBeTruthy();
      expect(run.startedAt).toBeTruthy();
    });

    it("should start a run with optional sessionId", () => {
      const run = db.startRun({ userId: "user1", mode: "chat", sessionId: "sess-1" });
      expect(run.sessionId).toBe("sess-1");
    });

    it("should complete a run", () => {
      const run = db.startRun({ userId: "user1", mode: "chat" });
      db.completeRun(run.id, {
        model: "gpt-4",
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        toolLoopCount: 3,
      });

      const fetched = db.getRun(run.id);
      expect(fetched!.status).toBe("completed");
      expect(fetched!.model).toBe("gpt-4");
      expect(fetched!.promptTokens).toBe(100);
      expect(fetched!.completionTokens).toBe(50);
      expect(fetched!.totalTokens).toBe(150);
      expect(fetched!.toolLoopCount).toBe(3);
      expect(fetched!.completedAt).toBeTruthy();
    });

    it("should fail a run", () => {
      const run = db.startRun({ userId: "user1", mode: "chat" });
      db.failRun(run.id, "Something went wrong");

      const fetched = db.getRun(run.id);
      expect(fetched!.status).toBe("failed");
      expect(fetched!.errorMessage).toBe("Something went wrong");
      expect(fetched!.completedAt).toBeTruthy();
    });
  });

  describe("addStep / getRunSteps", () => {
    it("should add and retrieve steps", () => {
      const run = db.startRun({ userId: "user1", mode: "chat" });

      const step1 = db.addStep({
        runId: run.id,
        stepType: "model_request",
        stepOrder: 0,
      });
      const step2 = db.addStep({
        runId: run.id,
        stepType: "tool_call",
        toolName: "read_file",
        sanitizedParams: { path: "/src/index.ts" },
        stepOrder: 1,
      });

      const steps = db.getRunSteps(run.id);
      expect(steps).toHaveLength(2);
      expect(steps[0].stepType).toBe("model_request");
      expect(steps[1].toolName).toBe("read_file");
      expect(steps[1].sanitizedParams).toEqual({ path: "/src/index.ts" });
    });

    it("should handle steps with content and success flags", () => {
      const run = db.startRun({ userId: "user1", mode: "chat" });

      db.addStep({
        runId: run.id,
        stepType: "tool_result",
        toolName: "read_file",
        content: { output: "file contents here" },
        success: true,
        durationMs: 150,
        stepOrder: 0,
      });

      const steps = db.getRunSteps(run.id);
      expect(steps[0].success).toBe(true);
      expect(steps[0].durationMs).toBe(150);
      expect(steps[0].content).toEqual({ output: "file contents here" });
    });

    it("should handle failed tool steps", () => {
      const run = db.startRun({ userId: "user1", mode: "chat" });

      db.addStep({
        runId: run.id,
        stepType: "tool_result",
        toolName: "read_file",
        success: false,
        errorMessage: "File not found",
        stepOrder: 0,
      });

      const steps = db.getRunSteps(run.id);
      expect(steps[0].success).toBe(false);
      expect(steps[0].errorMessage).toBe("File not found");
    });

    it("should order steps by step_order", () => {
      const run = db.startRun({ userId: "user1", mode: "chat" });

      db.addStep({ runId: run.id, stepType: "content", stepOrder: 2 });
      db.addStep({ runId: run.id, stepType: "model_request", stepOrder: 0 });
      db.addStep({ runId: run.id, stepType: "model_response", stepOrder: 1 });

      const steps = db.getRunSteps(run.id);
      expect(steps[0].stepType).toBe("model_request");
      expect(steps[1].stepType).toBe("model_response");
      expect(steps[2].stepType).toBe("content");
    });
  });

  describe("listRuns", () => {
    it("should list runs with default pagination", () => {
      db.startRun({ userId: "user1", mode: "chat" });
      db.startRun({ userId: "user2", mode: "agent" });

      const result = db.listRuns();
      expect(result.runs.length).toBe(2);
      expect(result.total).toBe(2);
    });

    it("should filter by status", () => {
      const run = db.startRun({ userId: "user1", mode: "chat" });
      db.startRun({ userId: "user1", mode: "chat" });
      db.completeRun(run.id, { toolLoopCount: 1 });

      const result = db.listRuns({ status: "completed" });
      expect(result.runs.length).toBe(1);
      expect(result.total).toBe(1);
      expect(result.runs[0].status).toBe("completed");
    });

    it("should filter by userId", () => {
      db.startRun({ userId: "user1", mode: "chat" });
      db.startRun({ userId: "user2", mode: "chat" });

      const result = db.listRuns({ userId: "user1" });
      expect(result.runs.length).toBe(1);
      expect(result.total).toBe(1);
      expect(result.runs[0].userId).toBe("user1");
    });

    it("should apply limit and offset", () => {
      for (let i = 0; i < 5; i++) {
        db.startRun({ userId: "user1", mode: "chat" });
      }

      const page1 = db.listRuns({ limit: 2, offset: 0 });
      expect(page1.runs.length).toBe(2);
      expect(page1.total).toBe(5);

      const page2 = db.listRuns({ limit: 2, offset: 2 });
      expect(page2.runs.length).toBe(2);
    });
  });

  describe("getRunWithSteps", () => {
    it("should return run with steps", () => {
      const run = db.startRun({ userId: "user1", mode: "chat" });
      db.addStep({ runId: run.id, stepType: "model_request", stepOrder: 0 });
      db.addStep({ runId: run.id, stepType: "model_response", stepOrder: 1 });

      const result = db.getRunWithSteps(run.id);
      expect(result).not.toBeNull();
      expect(result!.steps).toHaveLength(2);
      expect(result!.id).toBe(run.id);
    });

    it("should return null for nonexistent run", () => {
      expect(db.getRunWithSteps("nonexistent")).toBeNull();
    });
  });

  describe("getStats", () => {
    it("should return aggregate statistics", () => {
      const run1 = db.startRun({ userId: "user1", mode: "chat" });
      const run2 = db.startRun({ userId: "user1", mode: "chat" });
      const run3 = db.startRun({ userId: "user1", mode: "chat" });

      db.completeRun(run1.id, { toolLoopCount: 2 });
      db.completeRun(run2.id, { toolLoopCount: 4 });
      db.failRun(run3.id, "error");

      const stats = db.getStats();
      expect(stats.totalRuns).toBe(3);
      expect(stats.completedRuns).toBe(2);
      expect(stats.failedRuns).toBe(1);
      expect(stats.runningRuns).toBe(0);
      expect(stats.avgToolLoopCount).toBe(3); // (2 + 4) / 2
    });
  });

  describe("cleanup", () => {
    it("should delete old completed runs", () => {
      const run = db.startRun({ userId: "user1", mode: "chat" });
      db.completeRun(run.id, { toolLoopCount: 1 });

      // Manually set completed_at to 31 days ago
      const dbAny = db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } };
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      dbAny.db.prepare("UPDATE agent_runs SET completed_at = ? WHERE id = ?").run(oldDate, run.id);

      const deleted = db.cleanup(30);
      expect(deleted).toBe(1);
      expect(db.getRun(run.id)).toBeNull();
    });

    it("should not delete running runs", () => {
      const run = db.startRun({ userId: "user1", mode: "chat" });
      // Still running — no completed_at

      const deleted = db.cleanup(30);
      expect(deleted).toBe(0);
      expect(db.getRun(run.id)).not.toBeNull();
    });
  });
});