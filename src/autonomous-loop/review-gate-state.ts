/**
 * Review gate state persistence.
 *
 * Stores the last known review findings in `.aicoder/review-gate-state.json`
 * so the tool dispatcher can check whether a Jira ticket can be transitioned
 * to "Done" before the autonomous loop completes.
 *
 * The aicoder pipeline writes findings here after each review round.
 * The tool dispatcher reads from here when `jira.close_issue` is called.
 */

import * as fs from "fs";
import * as path from "path";
import type { ReviewGateFinding, ReviewGateState } from "./review-gate";
import { initReviewGateState } from "./review-gate";

const DEFAULT_WORKSPACE = process.cwd();
const GATE_STATE_FILE = path.join(DEFAULT_WORKSPACE, ".aicoder", "review-gate-state.json");

let currentState: ReviewGateState | null = null;

export function loadReviewGateState(): ReviewGateState {
  if (currentState) return currentState;
  try {
    if (fs.existsSync(GATE_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(GATE_STATE_FILE, "utf-8"));
      if (data && Array.isArray(data.lastFindings)) {
        currentState = data as ReviewGateState;
        return currentState;
      }
    }
  } catch {
    // File doesn't exist or is corrupt — start fresh
  }
  currentState = initReviewGateState();
  return currentState;
}

export function saveReviewGateState(state: ReviewGateState): void {
  currentState = state;
  try {
    const dir = path.dirname(GATE_STATE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(GATE_STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // Persistence failure is non-fatal
  }
}

export function clearReviewGateState(): void {
  currentState = null;
  try {
    if (fs.existsSync(GATE_STATE_FILE)) {
      fs.unlinkSync(GATE_STATE_FILE);
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Record review findings from a review round.
 * Merges with existing state, preserving the forceDone flag.
 */
export function recordGateFindings(findings: ReviewGateFinding[]): void {
  const state = loadReviewGateState();
  state.lastFindings = findings;
  state.reviewOccurred = true;
  saveReviewGateState(state);
}

/**
 * Mark force-done as used, with an audit timestamp.
 */
export function markForceDone(): void {
  const state = loadReviewGateState();
  state.forceDoneUsed = true;
  state.forceDoneAt = new Date().toISOString();
  saveReviewGateState(state);
}

/**
 * Get the last findings for gate checking.
 */
export function getLastFindings(): ReviewGateFinding[] {
  return loadReviewGateState().lastFindings;
}