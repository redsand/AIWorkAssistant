import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as gate from "../autorepair-gate";

describe("autorepair-gate", () => {
  let originalWorkspace: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalWorkspace = process.env.AICODER_WORKSPACE;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "autorepair-gate-"));
    process.env.AICODER_WORKSPACE = tempDir;
  });

  afterEach(() => {
    if (originalWorkspace === undefined) delete process.env.AICODER_WORKSPACE;
    else process.env.AICODER_WORKSPACE = originalWorkspace;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it("starts OPEN for an unknown issue key", () => {
    const rec = gate.loadAutorepairGate("PROJ-1");
    expect(rec.state).toBe("OPEN");
    expect(rec.attempts).toEqual([]);
    expect(gate.isGatePaused("PROJ-1")).toBe(false);
    expect(gate.isGateEscalated("PROJ-1")).toBe(false);
  });

  it("flips to PAUSED on recordConvergenceStuck and persists across reads", () => {
    gate.recordConvergenceStuck("PROJ-2", {
      reason: "identical_findings",
      roundNumber: 4,
      details: "Same lint finding 5 times",
    });
    const rec = gate.loadAutorepairGate("PROJ-2");
    expect(rec.state).toBe("PAUSED");
    expect(rec.triggeringStopReason).toBe("identical_findings");
    expect(rec.triggeringRoundNumber).toBe(4);
    expect(rec.pausedReason).toBe("Same lint finding 5 times");
    expect(gate.isGatePaused("PROJ-2")).toBe(true);
  });

  it("repeated recordConvergenceStuck is idempotent (no double-pause)", () => {
    gate.recordConvergenceStuck("PROJ-3", { reason: "max_rounds", roundNumber: 10 });
    const first = gate.loadAutorepairGate("PROJ-3");
    const firstPausedAt = first.pausedAt;
    gate.recordConvergenceStuck("PROJ-3", { reason: "max_rounds", roundNumber: 11 });
    const second = gate.loadAutorepairGate("PROJ-3");
    expect(second.pausedAt).toBe(firstPausedAt);
    expect(second.triggeringRoundNumber).toBe(10);
  });

  it("beginAutorepairAttempt records attempts incrementally", () => {
    const a1 = gate.beginAutorepairAttempt("PROJ-4", { originalTicketHash: "h1" });
    expect(a1.attemptNumber).toBe(1);
    const a2 = gate.beginAutorepairAttempt("PROJ-4", { originalTicketHash: "h2" });
    expect(a2.attemptNumber).toBe(2);
    expect(gate.getAttemptCount("PROJ-4")).toBe(2);
  });

  it("markRepaired flips state to RELEASED with diagnosis summary", () => {
    gate.recordConvergenceStuck("PROJ-5", { reason: "no_progress", roundNumber: 6 });
    gate.beginAutorepairAttempt("PROJ-5", { originalTicketHash: "h" });
    gate.markRepaired("PROJ-5", { diagnosisSummary: "missing acceptance criteria" });
    const rec = gate.loadAutorepairGate("PROJ-5");
    expect(rec.state).toBe("RELEASED");
    expect(rec.attempts[0].outcome).toBe("repaired");
    expect(rec.attempts[0].diagnosisSummary).toBe("missing acceptance criteria");
    expect(gate.isGatePaused("PROJ-5")).toBe(false);
  });

  it("markEscalated flips state to ESCALATED with error message", () => {
    gate.recordConvergenceStuck("PROJ-6", { reason: "empty_prs", roundNumber: 3 });
    gate.beginAutorepairAttempt("PROJ-6", { originalTicketHash: "h" });
    gate.markEscalated("PROJ-6", { errorMessage: "LLM timeout" });
    const rec = gate.loadAutorepairGate("PROJ-6");
    expect(rec.state).toBe("ESCALATED");
    expect(rec.attempts[0].outcome).toBe("escalated");
    expect(rec.attempts[0].errorMessage).toBe("LLM timeout");
    expect(gate.isGateEscalated("PROJ-6")).toBe(true);
  });

  it("releaseGate manually opens an ESCALATED gate but keeps audit history", () => {
    gate.recordConvergenceStuck("PROJ-7", { reason: "max_rounds", roundNumber: 10 });
    gate.beginAutorepairAttempt("PROJ-7", { originalTicketHash: "h" });
    gate.markEscalated("PROJ-7", { errorMessage: "give up" });
    gate.releaseGate("PROJ-7", { reason: "human fixed the ticket" });
    const rec = gate.loadAutorepairGate("PROJ-7");
    expect(rec.state).toBe("OPEN");
    expect(rec.attempts.length).toBe(1);
    expect(rec.attempts[0].outcome).toBe("escalated");
    expect(rec.pausedReason).toContain("Released manually");
  });

  it("clearAutorepairGate wipes the on-disk record", () => {
    gate.recordConvergenceStuck("PROJ-8", { reason: "no_progress", roundNumber: 4 });
    expect(gate.loadAutorepairGate("PROJ-8").state).toBe("PAUSED");
    gate.clearAutorepairGate("PROJ-8");
    expect(gate.loadAutorepairGate("PROJ-8").state).toBe("OPEN");
    expect(gate.loadAutorepairGate("PROJ-8").attempts).toEqual([]);
  });

  it("safely handles path-traversal issue keys", () => {
    gate.recordConvergenceStuck("../escape", { reason: "max_rounds", roundNumber: 1 });
    const escaped = path.join(tempDir, "..", "autorepair-gate-..escape.json");
    expect(fs.existsSync(escaped)).toBe(false);
    const safeDir = path.join(tempDir, ".aicoder");
    const files = fs.existsSync(safeDir) ? fs.readdirSync(safeDir) : [];
    expect(files.some((f) => f.startsWith("autorepair-gate-"))).toBe(true);
  });
});
