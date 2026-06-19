/**
 * Issue autorepair orchestrator — the single entry point coders / reviewers
 * call when they detect convergence has flagged the loop as stuck.
 *
 * Flow:
 *   1. Caller passes a RepairRequest (issue id, source, convergence summary,
 *      reviewer findings, coder rounds, prompt strategies tried).
 *   2. Orchestrator pauses the gate (so neither agent runs while we work).
 *   3. Per-item attempt cap is checked (AUTOREPAIR_MAX_PER_ITEM).
 *      Over budget → mark escalated, return outcome=quota_exceeded.
 *   4. Fetch the current ticket (in case the user edited it since we last
 *      pulled it). If the ticket already contains an AUTOREPAIR-V1 marker,
 *      we extract the ORIGINAL body so the diagnosis sees the user's words,
 *      not the prior rewrite (otherwise we'd be diagnosing our own output).
 *   5. analyzeGap → diagnosis JSON.
 *   6. rewriteTicket → new body.
 *   7. publishRepair → push body + audit comment to source.
 *   8. markRepaired → release the gate. Coder/reviewer can resume.
 *
 * Failures at any step → markEscalated with the error message. The loop
 * does NOT retry an escalated ticket (human intervention required).
 */

import { env } from "../../config/env";
import {
  beginAutorepairAttempt,
  clearAutorepairGate as _clearGate,
  getAttemptCount,
  isGateEscalated,
  loadAutorepairGate,
  markEscalated,
  markRepaired,
  recordConvergenceStuck,
  releaseGate,
} from "../autorepair-gate";
import { analyzeGap, type CoderRoundSummary, type ReviewerFindingSummary } from "./gap-analyzer";
import {
  AUTOREPAIR_BODY_MARKER,
  extractOriginalBody,
  isAutorepairedBody,
  rewriteTicket,
} from "./ticket-rewriter";
import {
  fetchTicket,
  publishRepair,
  type Source,
  type TicketIdentifier,
} from "./source-updater";

export interface RepairRequest {
  issueKey: string;
  ticket: TicketIdentifier;
  convergence: {
    /** Stop reason from checkConvergence(): "max_rounds" | "identical_findings" | "empty_prs" | "no_progress" | ... */
    reason: string;
    /** Human-readable summary text (e.g. from formatConvergenceReport). */
    summary?: string;
    roundNumber: number;
  };
  reviewerFindings: ReviewerFindingSummary[];
  coderRounds: CoderRoundSummary[];
  promptStrategiesTried: string[];
}

export type RepairOutcome =
  | "repaired"
  | "quota_exceeded"
  | "disabled"
  | "already_escalated"
  | "diagnosis_failed"
  | "rewrite_failed"
  | "publish_failed";

export interface RepairResult {
  outcome: RepairOutcome;
  attemptNumber?: number;
  message: string;
  diagnosisCategory?: string;
  diagnosisRootCause?: string;
  diagnosisConfidence?: string;
  newBodyPreview?: string;
}

/**
 * Run a full autorepair attempt. Returns immediately if disabled, already
 * escalated, or out of quota — caller should check `outcome` to decide
 * whether to keep going.
 */
export async function runAutorepair(req: RepairRequest): Promise<RepairResult> {
  const { issueKey } = req;

  if (!env.AUTOREPAIR_ENABLED) {
    return { outcome: "disabled", message: "AUTOREPAIR_ENABLED=false" };
  }
  if (isGateEscalated(issueKey)) {
    return {
      outcome: "already_escalated",
      message: `Issue ${issueKey} is already in ESCALATED state. Human action required to clear it.`,
    };
  }

  // Mark the gate paused first thing, so even if anything below crashes the
  // agents won't pick up the still-broken ticket on the next cycle.
  recordConvergenceStuck(issueKey, {
    reason: req.convergence.reason,
    roundNumber: req.convergence.roundNumber,
    details: req.convergence.summary,
  });

  // Quota check happens AFTER the gate flip so a stuck ticket stays paused
  // even when we refuse to repair it.
  const existingAttempts = getAttemptCount(issueKey);
  if (existingAttempts >= env.AUTOREPAIR_MAX_PER_ITEM) {
    markEscalated(issueKey, {
      errorMessage: `Per-item autorepair quota exhausted (${existingAttempts}/${env.AUTOREPAIR_MAX_PER_ITEM}).`,
    });
    return {
      outcome: "quota_exceeded",
      attemptNumber: existingAttempts,
      message: `Issue ${issueKey} has used all ${env.AUTOREPAIR_MAX_PER_ITEM} autorepair attempts. Escalating to human.`,
    };
  }

  // Fetch current ticket — the user may have edited it since the agents last
  // pulled. Use the ORIGINAL body (the user's words) if this is a re-repair.
  let originalBody: string;
  let originalTitle: string;
  try {
    const fetched = await fetchTicket(req.ticket);
    originalTitle = fetched.title;
    if (isAutorepairedBody(fetched.body)) {
      const recovered = extractOriginalBody(fetched.body);
      if (recovered) {
        originalBody = recovered;
        console.log(
          `[autorepair] ${issueKey} already contains AUTOREPAIR-V1 marker — using preserved original body for re-diagnosis.`,
        );
      } else {
        // Marker present but inner block unparseable. Fall back to current body.
        originalBody = fetched.body;
      }
    } else {
      originalBody = fetched.body;
    }
  } catch (err) {
    markEscalated(issueKey, {
      errorMessage: `Failed to fetch ticket from ${req.ticket.source}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return {
      outcome: "publish_failed",
      message: `Could not fetch ticket ${issueKey} from ${req.ticket.source}.`,
    };
  }

  const { attemptNumber } = beginAutorepairAttempt(issueKey, {
    originalTicketHash: undefined, // hash computed by rewriter
  });

  // ── Step 1: diagnose ───────────────────────────────────────────────
  let diagnosis;
  try {
    console.log(`[autorepair] ${issueKey} attempt #${attemptNumber} — running gap analyzer`);
    diagnosis = await analyzeGap({
      issueKey,
      originalTicketText: originalBody,
      originalTitle,
      reviewerFindings: req.reviewerFindings,
      coderRounds: req.coderRounds,
      convergenceReason: req.convergence.reason,
      convergenceSummary: req.convergence.summary,
      promptStrategiesTried: req.promptStrategiesTried,
      attemptNumber,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    markEscalated(issueKey, { errorMessage: `Gap analyzer failed: ${msg}` });
    return {
      outcome: "diagnosis_failed",
      attemptNumber,
      message: `Gap analyzer failed for ${issueKey}: ${msg}`,
    };
  }
  console.log(
    `[autorepair] ${issueKey} diagnosis category=${diagnosis.category} confidence=${diagnosis.confidence} root="${diagnosis.rootCause.slice(0, 120)}"`,
  );

  // ── Step 2: rewrite ────────────────────────────────────────────────
  let rewritten;
  const recurringFindings = summarizeRecurringFindings(req.reviewerFindings);
  try {
    rewritten = await rewriteTicket({
      issueKey,
      originalTitle,
      originalBody,
      diagnosis,
      attemptNumber,
      promptStrategiesTried: req.promptStrategiesTried,
      recurringFindings,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    markEscalated(issueKey, { errorMessage: `Ticket rewriter failed: ${msg}` });
    return {
      outcome: "rewrite_failed",
      attemptNumber,
      message: `Ticket rewriter failed for ${issueKey}: ${msg}`,
    };
  }

  // ── Step 3: publish ────────────────────────────────────────────────
  const auditComment = buildAuditComment({
    issueKey,
    attemptNumber,
    diagnosisCategory: diagnosis.category,
    diagnosisRootCause: diagnosis.rootCause,
    diagnosisConfidence: diagnosis.confidence,
    convergenceReason: req.convergence.reason,
    convergenceRoundNumber: req.convergence.roundNumber,
  });
  try {
    await publishRepair(req.ticket, {
      newBody: rewritten.body,
      newTitle: rewritten.title,
      auditComment,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    markEscalated(issueKey, { errorMessage: `Source publish failed: ${msg}` });
    return {
      outcome: "publish_failed",
      attemptNumber,
      message: `Publishing repaired ticket to ${req.ticket.source} failed for ${issueKey}: ${msg}`,
    };
  }

  // ── Step 4: release ────────────────────────────────────────────────
  markRepaired(issueKey, {
    diagnosisSummary: `[${diagnosis.category}] ${diagnosis.rootCause}`.slice(0, 240),
  });
  console.log(
    `[autorepair] ${issueKey} attempt #${attemptNumber} succeeded; gate released. Loop will resume.`,
  );

  return {
    outcome: "repaired",
    attemptNumber,
    diagnosisCategory: diagnosis.category,
    diagnosisRootCause: diagnosis.rootCause,
    diagnosisConfidence: diagnosis.confidence,
    newBodyPreview: rewritten.body.slice(0, 600),
    message: `Autorepair attempt #${attemptNumber} on ${issueKey} succeeded (${diagnosis.category}, confidence: ${diagnosis.confidence}).`,
  };
}

function summarizeRecurringFindings(findings: ReviewerFindingSummary[]): string[] {
  // Group by message-prefix so identical (or near-identical) messages don't
  // each become a separate bullet in the "do not repeat" section.
  const buckets = new Map<string, { count: number; sample: string }>();
  for (const f of findings) {
    const key = (f.message ?? "").slice(0, 80).toLowerCase().trim();
    if (!key) continue;
    const cur = buckets.get(key);
    if (cur) cur.count++;
    else buckets.set(key, { count: 1, sample: f.message ?? "" });
  }
  return [...buckets.values()]
    .filter((b) => b.count > 1) // only "recurring"
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((b) => `(${b.count}× across rounds) ${b.sample.slice(0, 220)}`);
}

function buildAuditComment(opts: {
  issueKey: string;
  attemptNumber: number;
  diagnosisCategory: string;
  diagnosisRootCause: string;
  diagnosisConfidence: string;
  convergenceReason: string;
  convergenceRoundNumber: number;
}): string {
  return [
    `### 🤖 Autorepair v1 · attempt #${opts.attemptNumber}`,
    "",
    `The coder/reviewer loop stalled on \`${opts.convergenceReason}\` at round ${opts.convergenceRoundNumber}.`,
    `Autorepair has rewritten this ticket to clarify the requirements and unblock the loop.`,
    "",
    `**Diagnosis category:** \`${opts.diagnosisCategory}\``,
    `**Root cause:** ${opts.diagnosisRootCause}`,
    `**Confidence:** ${opts.diagnosisConfidence}`,
    "",
    `The original ticket body has been preserved at the bottom of the description, between the \`${AUTOREPAIR_BODY_MARKER.replace("V1", "V1-ORIGINAL")}\`-style markers.`,
    "",
    `If this rewrite is incorrect, revert by restoring the original body and removing the \`${AUTOREPAIR_BODY_MARKER}\` marker. To pause further autorepair on this ticket, add the label \`autorepair:hold\`.`,
    "",
    `_Tag: [autorepair-v1]_`,
  ].join("\n");
}

// ── Operator helpers (also exported so the CLI / chat tools can call them)

export function getAutorepairStatus(issueKey: string) {
  const rec = loadAutorepairGate(issueKey);
  return {
    issueKey: rec.issueKey,
    state: rec.state,
    paused: rec.state === "PAUSED",
    escalated: rec.state === "ESCALATED",
    pausedReason: rec.pausedReason,
    pausedAt: rec.pausedAt,
    attemptCount: rec.attempts.length,
    attempts: rec.attempts,
  };
}

export function forceReleaseAutorepair(issueKey: string, reason: string) {
  return releaseGate(issueKey, { reason });
}

export function clearAutorepairGate(issueKey: string) {
  _clearGate(issueKey);
}

// Re-exports for convenience callers (e.g. aicoder.ts) — single import path.
export { isGatePaused, isGateEscalated } from "../autorepair-gate";
export type { AutorepairGateState, AutorepairGateRecord } from "../autorepair-gate";
export type TicketSource = Source;
