import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import { AgentRunDatabase } from "../../../src/agent-runs/database";
import { getToolByName } from "../../../src/agent/tool-registry";

describe("Agent Runs Security - IDOR Prevention", () => {
  let db: AgentRunDatabase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runs-security-test-"));
    db = new AgentRunDatabase(path.join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("listRuns - userId scoping prevents IDOR", () => {
    it("should only return runs for the specified userId", () => {
      db.startRun({ userId: "alice", mode: "chat" });
      db.startRun({ userId: "bob", mode: "chat" });
      db.startRun({ userId: "alice", mode: "agent" });

      const aliceRuns = db.listRuns({ userId: "alice" });
      expect(aliceRuns.runs).toHaveLength(2);
      expect(aliceRuns.runs.every((r) => r.userId === "alice")).toBe(true);
      expect(aliceRuns.total).toBe(2);
    });

    it("should not return other users' runs when filtering by userId", () => {
      db.startRun({ userId: "alice", mode: "chat" });
      db.startRun({ userId: "bob", mode: "chat" });
      db.startRun({ userId: "aicoder", mode: "code" });

      const aliceRuns = db.listRuns({ userId: "alice" });
      expect(aliceRuns.runs).toHaveLength(1);
      expect(aliceRuns.runs[0].userId).toBe("alice");

      const bobRuns = db.listRuns({ userId: "bob" });
      expect(bobRuns.runs).toHaveLength(1);
      expect(bobRuns.runs[0].userId).toBe("bob");
    });

    it("should return all runs when no userId filter is applied", () => {
      db.startRun({ userId: "alice", mode: "chat" });
      db.startRun({ userId: "bob", mode: "chat" });

      const allRuns = db.listRuns();
      expect(allRuns.runs).toHaveLength(2);
      expect(allRuns.total).toBe(2);
    });
  });

  describe("getRun / getRunWithSteps - ownership metadata for IDOR checks", () => {
    it("should include userId in run data so handlers can enforce ownership", () => {
      const run = db.startRun({ userId: "alice", mode: "chat" });
      const fetched = db.getRun(run.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.userId).toBe("alice");
    });

    it("should include userId in getRunWithSteps result for ownership checks", () => {
      const run = db.startRun({ userId: "alice", mode: "chat" });
      const withSteps = db.getRunWithSteps(run.id);
      expect(withSteps).not.toBeNull();
      expect(withSteps!.userId).toBe("alice");
    });

    it("should return null for nonexistent run", () => {
      expect(db.getRun("nonexistent-id")).toBeNull();
      expect(db.getRunWithSteps("nonexistent-id")).toBeNull();
    });
  });

  describe("aicoder runs - access restricted to metadata", () => {
    it("should filter aicoder runs by userId", () => {
      db.startRun({ userId: "aicoder", mode: "code" });
      db.startRun({ userId: "alice", mode: "chat" });

      const aicoderRuns = db.listRuns({ userId: "aicoder", limit: 5 });
      expect(aicoderRuns.runs).toHaveLength(1);
      expect(aicoderRuns.runs[0].userId).toBe("aicoder");
    });

    it("listRuns returns only run metadata, not step content", () => {
      const run = db.startRun({ userId: "aicoder", mode: "code" });
      db.addStep({
        runId: run.id,
        stepType: "model_request",
        content: { sensitive: "prompt data" },
        stepOrder: 0,
      });

      const runs = db.listRuns({ userId: "aicoder", limit: 5 });
      expect(runs.runs).toHaveLength(1);
      // The runs array from listRuns does NOT include steps
      expect("steps" in runs.runs[0]).toBe(false);
    });

    it("getRunWithSteps includes step content requiring explicit ID access", () => {
      const run = db.startRun({ userId: "aicoder", mode: "code" });
      db.addStep({
        runId: run.id,
        stepType: "model_request",
        content: { sensitive: "prompt data" },
        stepOrder: 0,
      });

      // Steps are only accessible via explicit run ID (handlers enforce ownership)
      const runWithSteps = db.getRunWithSteps(run.id);
      expect(runWithSteps!.steps).toHaveLength(1);
      expect(runWithSteps!.steps[0].content).toEqual({ sensitive: "prompt data" });
    });
  });

  describe("limit/offset validation", () => {
    it("should apply limit correctly", () => {
      for (let i = 0; i < 5; i++) {
        db.startRun({ userId: "user1", mode: "chat" });
      }

      const result = db.listRuns({ userId: "user1", limit: 3, offset: 0 });
      expect(result.runs).toHaveLength(3);
      expect(result.total).toBe(5);
    });

    it("should apply offset correctly", () => {
      for (let i = 0; i < 5; i++) {
        db.startRun({ userId: "user1", mode: "chat" });
      }

      const result = db.listRuns({ userId: "user1", limit: 2, offset: 2 });
      expect(result.runs).toHaveLength(2);
    });

    it("should handle default limit when none specified", () => {
      for (let i = 0; i < 60; i++) {
        db.startRun({ userId: "user1", mode: "chat" });
      }

      const result = db.listRuns({ userId: "user1" });
      // Default limit is 50
      expect(result.runs.length).toBe(50);
      expect(result.total).toBe(60);
    });
  });
});

describe("Agent Runs Tool Registry - Security", () => {
  it("agent.list_runs should NOT have userId parameter (IDOR prevention)", () => {
    const tool = getToolByName("agent.list_runs", "productivity");
    expect(tool).toBeDefined();
    // userId param removed to prevent users from querying other users' runs
    expect(tool!.params.userId).toBeUndefined();
  });

  it("agent.get_run should require runId", () => {
    const tool = getToolByName("agent.get_run", "productivity");
    expect(tool).toBeDefined();
    expect(tool!.params.runId).toBeDefined();
    expect(tool!.params.runId!.required).toBe(true);
  });

  it("agent.list_runs description should state it returns own runs only", () => {
    const tool = getToolByName("agent.list_runs", "productivity");
    expect(tool).toBeDefined();
    expect(tool!.description.toLowerCase()).toContain("own");
  });
});