import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import {
  getToolByName,
  getTools,
  getAllToolsForMode,
  getToolCategories,
  getPlatformForToolName,
} from "../../../src/agent/tool-registry";
import { AgentRunDatabase } from "../../../src/agent-runs/database";

describe("Agent Runs Tool Registry", () => {
  it("registers agent.list_runs tool in productivity mode", () => {
    const tool = getToolByName("agent.list_runs", "productivity");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("agent.list_runs");
    expect(tool!.actionType).toBe("agent.runs.read");
    expect(tool!.riskLevel).toBe("low");
  });

  it("registers agent.get_run tool in productivity mode", () => {
    const tool = getToolByName("agent.get_run", "productivity");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("agent.get_run");
    expect(tool!.actionType).toBe("agent.runs.read");
    expect(tool!.riskLevel).toBe("low");
  });

  it("registers agent.get_run_stats tool in productivity mode", () => {
    const tool = getToolByName("agent.get_run_stats", "productivity");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("agent.get_run_stats");
    expect(tool!.actionType).toBe("agent.runs.read");
    expect(tool!.riskLevel).toBe("low");
  });

  it("registers agent.get_aicoder_status tool in productivity mode", () => {
    const tool = getToolByName("agent.get_aicoder_status", "productivity");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("agent.get_aicoder_status");
    expect(tool!.actionType).toBe("agent.runs.read");
    expect(tool!.riskLevel).toBe("low");
  });

  it("includes agent run tools in engineering mode", () => {
    const tool = getToolByName("agent.list_runs", "engineering");
    expect(tool).toBeDefined();
  });

  it("agent.list_runs has optional filter params (no userId — restricted to own runs)", () => {
    const tool = getToolByName("agent.list_runs", "productivity")!;
    expect(tool.params.status).toBeDefined();
    expect(tool.params.status!.required).toBe(false);
    // userId param removed for security: runs are always scoped to the requesting user
    expect(tool.params.userId).toBeUndefined();
    expect(tool.params.limit).toBeDefined();
    expect(tool.params.limit!.required).toBe(false);
    expect(tool.params.offset).toBeDefined();
    expect(tool.params.offset!.required).toBe(false);
  });

  it("agent.get_run has required runId param", () => {
    const tool = getToolByName("agent.get_run", "productivity")!;
    expect(tool.params.runId).toBeDefined();
    expect(tool.params.runId!.required).toBe(true);
  });

  it("agent run tools appear in core tool set for productivity mode", () => {
    const tools = getTools("productivity");
    const names = tools.map((t) => t.name);
    expect(names).toContain("agent.list_runs");
    expect(names).toContain("agent.get_run");
    expect(names).toContain("agent.get_run_stats");
    expect(names).toContain("agent.get_aicoder_status");
  });

  it("agent run tools appear in core tool set for engineering mode", () => {
    const tools = getTools("engineering");
    const names = tools.map((t) => t.name);
    expect(names).toContain("agent.list_runs");
    expect(names).toContain("agent.get_run");
    expect(names).toContain("agent.get_run_stats");
    expect(names).toContain("agent.get_aicoder_status");
  });

  it("agent run tools appear in all tools for both modes", () => {
    for (const mode of ["productivity", "engineering"]) {
      const allTools = getAllToolsForMode(mode);
      const names = allTools.map((t) => t.name);
      expect(names).toContain("agent.list_runs");
      expect(names).toContain("agent.get_run");
      expect(names).toContain("agent.get_run_stats");
      expect(names).toContain("agent.get_aicoder_status");
    }
  });

  it("agent run tools are in the agent category", () => {
    const categories = getToolCategories("productivity");
    expect(categories.agent).toBeDefined();
    expect(categories.agent).toContain("agent.list_runs");
    expect(categories.agent).toContain("agent.get_run");
    expect(categories.agent).toContain("agent.get_run_stats");
    expect(categories.agent).toContain("agent.get_aicoder_status");
  });

  it("agent platform is mapped to cross-platform", () => {
    expect(getPlatformForToolName("agent.list_runs")).toBe("cross-platform");
    expect(getPlatformForToolName("agent.get_run")).toBe("cross-platform");
    expect(getPlatformForToolName("agent.spawn")).toBe("cross-platform");
  });
});

describe("Agent Runs Tool Handlers", () => {
  let db: AgentRunDatabase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runs-tools-test-"));
    db = new AgentRunDatabase(path.join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("listRuns returns created runs", () => {
    db.startRun({ userId: "user1", mode: "chat" });
    db.startRun({ userId: "user2", mode: "agent" });

    const result = db.listRuns();
    expect(result.runs).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it("listRuns filters by status", () => {
    const run = db.startRun({ userId: "user1", mode: "chat" });
    db.startRun({ userId: "user1", mode: "chat" });
    db.completeRun(run.id, { toolLoopCount: 1 });

    const result = db.listRuns({ status: "completed" });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].status).toBe("completed");
  });

  it("listRuns filters by userId", () => {
    db.startRun({ userId: "user1", mode: "chat" });
    db.startRun({ userId: "user2", mode: "chat" });

    const result = db.listRuns({ userId: "user1" });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].userId).toBe("user1");
  });

  it("getRunWithSteps returns run with steps", () => {
    const run = db.startRun({ userId: "user1", mode: "chat" });
    db.addStep({ runId: run.id, stepType: "model_request", stepOrder: 0 });
    db.addStep({ runId: run.id, stepType: "model_response", stepOrder: 1 });

    const result = db.getRunWithSteps(run.id);
    expect(result).not.toBeNull();
    expect(result!.steps).toHaveLength(2);
    expect(result!.id).toBe(run.id);
  });

  it("getStats returns aggregate statistics", () => {
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
    expect(stats.avgToolLoopCount).toBe(3);
  });

  it("getRun returns null for nonexistent run", () => {
    expect(db.getRun("nonexistent")).toBeNull();
  });

  it("getRunWithSteps returns null for nonexistent run", () => {
    expect(db.getRunWithSteps("nonexistent")).toBeNull();
  });

  it("listRuns sorts by startedAt descending (most recent first)", () => {
    const run1 = db.startRun({ userId: "user1", mode: "chat" });
    // Add a small delay to ensure different timestamps
    const dbAny = db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } };
    const oldDate = new Date(Date.now() - 60000).toISOString();
    dbAny.db.prepare("UPDATE agent_runs SET started_at = ? WHERE id = ?").run(oldDate, run1.id);

    db.startRun({ userId: "user1", mode: "chat" });

    const result = db.listRuns({ userId: "user1" });
    expect(result.runs).toHaveLength(2);
    // Most recent first
    expect(new Date(result.runs[0].startedAt).getTime()).toBeGreaterThan(
      new Date(result.runs[1].startedAt).getTime()
    );
  });

  it("listRuns with userId filter prevents cross-user access", () => {
    db.startRun({ userId: "alice", mode: "chat" });
    db.startRun({ userId: "bob", mode: "agent" });
    db.startRun({ userId: "alice", mode: "engineering" });

    // Alice can only see her own runs
    const aliceRuns = db.listRuns({ userId: "alice" });
    expect(aliceRuns.runs).toHaveLength(2);
    expect(aliceRuns.runs.every((r) => r.userId === "alice")).toBe(true);

    // Bob can only see his own runs
    const bobRuns = db.listRuns({ userId: "bob" });
    expect(bobRuns.runs).toHaveLength(1);
    expect(bobRuns.runs[0].userId).toBe("bob");
  });

  it("getRunWithSteps returns step data with content", () => {
    const run = db.startRun({ userId: "user1", mode: "chat" });
    db.addStep({
      runId: run.id,
      stepType: "tool_result",
      toolName: "read_file",
      content: { output: "sensitive data here" },
      sanitizedParams: { path: "/secret/file" },
      success: true,
      stepOrder: 0,
    });

    const result = db.getRunWithSteps(run.id);
    expect(result).not.toBeNull();
    expect(result!.steps).toHaveLength(1);
    expect(result!.steps[0].content).toEqual({ output: "sensitive data here" });
    expect(result!.steps[0].sanitizedParams).toEqual({ path: "/secret/file" });
  });
});