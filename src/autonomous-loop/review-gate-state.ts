/**
 * Review gate state persistence — per-issue, per-workspace.
 *
 * Stores the last known review findings in
 * `.aicoder/review-gate-state-<issueKey>.json` so the tool dispatcher can
 * check whether a Jira ticket can be transitioned to "Done" before the
 * autonomous loop completes.
 *
 * The aicoder pipeline writes findings here after each review round.
 * The tool dispatcher reads from here when `jira.close_issue` is called.
 */

import * as fs from "fs";
import * as path from "path";
import type { ReviewGateFinding, ReviewGateState } from "./review-gate";
import { initReviewGateState } from "./review-gate";
import { WORKSPACE } from "./arg-parser";

const INVALID_KEY_RE = /[/\\]|\.\./;

function validateIssueKey(issueKey: string): void {
  if (INVALID_KEY_RE.test(issueKey)) {
    throw new Error(`Invalid issueKey "${issueKey}": must not contain /, \\, or ..`);
  }
}

function getStateFile(issueKey: string): string {
  validateIssueKey(issueKey);
  return path.join(WORKSPACE, ".aicoder", `review-gate-state-${issueKey}.json`);
}

const DEFAULT_KEY = "__default__";

function resolveIssueKey(issueKey?: string): string {
  if (issueKey && issueKey !== "") return issueKey;
  console.warn("[review-gate-state] No issueKey provided — using default file. Pass issueKey for concurrency safety.");
  return DEFAULT_KEY;
}

export function loadReviewGateState(issueKey?: string): ReviewGateState {
  const key = resolveIssueKey(issueKey);
  const filePath = getStateFile(key);
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (data && Array.isArray(data.lastFindings)) {
        return data as ReviewGateState;
      }
    }
  } catch {
    // File doesn't exist or is corrupt — start fresh
  }
  return initReviewGateState();
}

export function saveReviewGateState(state: ReviewGateState, issueKey?: string): void {
  const key = resolveIssueKey(issueKey);
  const filePath = getStateFile(key);
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // Persistence failure is non-fatal
  }
}

export function clearReviewGateState(issueKey?: string): void {
  const key = resolveIssueKey(issueKey);
  const filePath = getStateFile(key);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Record review findings from a review round.
 * Merges with existing state, preserving the forceDone flag.
 */
export function recordGateFindings(findings: ReviewGateFinding[], issueKey?: string): void {
  const state = loadReviewGateState(issueKey);
  state.lastFindings = findings;
  state.reviewOccurred = true;
  saveReviewGateState(state, issueKey);
}

/**
 * Mark force-done as used, with an audit timestamp.
 */
export function markForceDone(issueKey?: string): void {
  const state = loadReviewGateState(issueKey);
  state.forceDoneUsed = true;
  state.forceDoneAt = new Date().toISOString();
  saveReviewGateState(state, issueKey);
}

/**
 * Get the last findings for gate checking.
 */
export function getLastFindings(issueKey?: string): ReviewGateFinding[] {
  return loadReviewGateState(issueKey).lastFindings;
}
