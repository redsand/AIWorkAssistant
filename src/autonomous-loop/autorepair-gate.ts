/**
 * Autorepair gate — pause/resume mechanism for the autonomous loop.
 *
 * When convergence detection flags a stuck coder/reviewer loop, the gate is
 * flipped to PAUSED while the ticket-autorepair pipeline diagnoses the
 * underlying issue and rewrites the ticket. Both aicoder and reviewer
 * consult the gate before each cycle and bail (with a clear log line)
 * when paused, preventing wasted LLM calls on a fundamentally broken
 * ticket.
 *
 * Per-issue gate state is persisted under
 * `.aicoder/autorepair-gate-<issueKey>.json` so it survives process
 * restarts. Workflow:
 *
 *   1. Convergence detector → recordConvergenceStuck()  → state=PAUSED
 *   2. Ticket-autorepair orchestrator runs gap-analysis + rewrite
 *   3. On success → markRepaired() flips state=RELEASED, ticket updated
 *   4. On failure → markFailed() flips state=ESCALATED, human takes over
 *   5. aicoder/reviewer poll isGatePaused() each cycle and bail when true
 *
 * Manual controls (via aicoder CLI flags or direct invocation):
 *   - releaseGate(): operator force-unpause after manual fix
 *   - clearAutorepairGate(): wipe gate file (e.g. after the issue is done)
 */

import * as fs from "fs";
import * as path from "path";

export type AutorepairGateState = "OPEN" | "PAUSED" | "RELEASED" | "ESCALATED";

export interface AutorepairAttemptRecord {
  attemptNumber: number;
  startedAt: string;
  completedAt?: string;
  outcome?: "repaired" | "failed" | "escalated";
  /** Hash of the original ticket text so we can detect re-edits. */
  originalTicketHash?: string;
  /** Brief diagnosis summary for the audit trail. */
  diagnosisSummary?: string;
  errorMessage?: string;
}

export interface AutorepairGateRecord {
  issueKey: string;
  state: AutorepairGateState;
  pausedAt?: string;
  pausedReason?: string;
  /** Convergence stop reason that triggered the pause, when applicable. */
  triggeringStopReason?: string;
  /** Round number at the time the gate flipped to PAUSED. */
  triggeringRoundNumber?: number;
  attempts: AutorepairAttemptRecord[];
}

// Resolved lazily inside getStateFile so test suites can flip
// AICODER_WORKSPACE in beforeEach without re-importing the module.
function getWorkspace(): string {
  return process.env.AICODER_WORKSPACE || process.cwd();
}
const STATE_DIR = ".aicoder";
const DEFAULT_KEY = "__default__";

function safeKey(issueKey: string | undefined): string {
  // Mirror the conservative slugging used by review-gate-state so a tampered
  // issueKey can't escape the .aicoder/ directory via path traversal.
  if (!issueKey) return DEFAULT_KEY;
  const cleaned = issueKey.replace(/[^A-Za-z0-9_.-]/g, "_");
  return cleaned || DEFAULT_KEY;
}

function getStateFile(issueKey?: string): string {
  return path.join(getWorkspace(), STATE_DIR, `autorepair-gate-${safeKey(issueKey)}.json`);
}

function initRecord(issueKey: string): AutorepairGateRecord {
  return {
    issueKey,
    state: "OPEN",
    attempts: [],
  };
}

export function loadAutorepairGate(issueKey?: string): AutorepairGateRecord {
  const filePath = getStateFile(issueKey);
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<AutorepairGateRecord>;
      if (parsed && typeof parsed.state === "string" && Array.isArray(parsed.attempts)) {
        return {
          issueKey: parsed.issueKey ?? safeKey(issueKey),
          state: parsed.state as AutorepairGateState,
          pausedAt: parsed.pausedAt,
          pausedReason: parsed.pausedReason,
          triggeringStopReason: parsed.triggeringStopReason,
          triggeringRoundNumber: parsed.triggeringRoundNumber,
          attempts: parsed.attempts as AutorepairAttemptRecord[],
        };
      }
    }
  } catch {
    // corrupt or unreadable — start fresh
  }
  return initRecord(safeKey(issueKey));
}

function persist(record: AutorepairGateRecord, issueKey?: string): void {
  const filePath = getStateFile(issueKey);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf-8");
  } catch (err) {
    console.warn(
      `[autorepair-gate] persist failed for ${issueKey ?? DEFAULT_KEY}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** True when both agents should stand down while autorepair runs. */
export function isGatePaused(issueKey?: string): boolean {
  return loadAutorepairGate(issueKey).state === "PAUSED";
}

/** True when autorepair has given up; human takes over. Loop should not retry. */
export function isGateEscalated(issueKey?: string): boolean {
  return loadAutorepairGate(issueKey).state === "ESCALATED";
}

/**
 * Convergence detector calls this when it has decided the loop is stuck.
 * Flips state to PAUSED so both agents bail on their next cycle.
 */
export function recordConvergenceStuck(
  issueKey: string,
  opts: { reason: string; roundNumber: number; details?: string },
): AutorepairGateRecord {
  const rec = loadAutorepairGate(issueKey);
  // If already paused, repeat-pause is a no-op (still paused).
  if (rec.state === "PAUSED") return rec;
  rec.state = "PAUSED";
  rec.pausedAt = new Date().toISOString();
  rec.pausedReason = opts.details ?? `Convergence stop: ${opts.reason}`;
  rec.triggeringStopReason = opts.reason;
  rec.triggeringRoundNumber = opts.roundNumber;
  persist(rec, issueKey);
  return rec;
}

/**
 * The orchestrator opens an autorepair attempt right before running the
 * gap-analyzer. Returns the new attempt number (1-indexed).
 */
export function beginAutorepairAttempt(
  issueKey: string,
  opts: { originalTicketHash?: string },
): { attemptNumber: number; record: AutorepairGateRecord } {
  const rec = loadAutorepairGate(issueKey);
  const attemptNumber = rec.attempts.length + 1;
  rec.attempts.push({
    attemptNumber,
    startedAt: new Date().toISOString(),
    originalTicketHash: opts.originalTicketHash,
  });
  persist(rec, issueKey);
  return { attemptNumber, record: rec };
}

/**
 * Mark the most recent attempt as successful and release the gate. Coder
 * and reviewer can resume with the now-repaired ticket.
 */
export function markRepaired(
  issueKey: string,
  opts: { diagnosisSummary?: string },
): AutorepairGateRecord {
  const rec = loadAutorepairGate(issueKey);
  const last = rec.attempts[rec.attempts.length - 1];
  if (last) {
    last.completedAt = new Date().toISOString();
    last.outcome = "repaired";
    last.diagnosisSummary = opts.diagnosisSummary;
  }
  rec.state = "RELEASED";
  rec.pausedReason = undefined;
  persist(rec, issueKey);
  return rec;
}

/**
 * Mark the most recent attempt as failed AND escalated. Distinct from
 * markRepaired because the loop must NOT retry — only a human can clear
 * the ESCALATED state (via releaseGate or clearAutorepairGate).
 */
export function markEscalated(
  issueKey: string,
  opts: { errorMessage: string },
): AutorepairGateRecord {
  const rec = loadAutorepairGate(issueKey);
  const last = rec.attempts[rec.attempts.length - 1];
  if (last) {
    last.completedAt = new Date().toISOString();
    last.outcome = "escalated";
    last.errorMessage = opts.errorMessage;
  }
  rec.state = "ESCALATED";
  persist(rec, issueKey);
  return rec;
}

/**
 * Manual operator override: force the gate back to OPEN. Used when the
 * operator has manually fixed the ticket and wants the loop to resume.
 * Records the manual release for audit but does NOT erase the attempt
 * history.
 */
export function releaseGate(
  issueKey: string,
  opts: { reason: string },
): AutorepairGateRecord {
  const rec = loadAutorepairGate(issueKey);
  rec.state = "OPEN";
  rec.pausedReason = `Released manually: ${opts.reason}`;
  // Leave pausedAt and attempts in place for audit trail.
  persist(rec, issueKey);
  return rec;
}

/** Erase the gate file entirely (e.g. ticket transitioned to Done). */
export function clearAutorepairGate(issueKey?: string): void {
  const filePath = getStateFile(issueKey);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // non-fatal
  }
}

/** Count of attempts so far on this ticket; used to enforce a per-item cap. */
export function getAttemptCount(issueKey?: string): number {
  return loadAutorepairGate(issueKey).attempts.length;
}
