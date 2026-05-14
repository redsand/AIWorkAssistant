/**
 * Convergence state persistence.
 *
 * Stores convergence state in `.aicoder/convergence-state.json`
 * so that convergence detection survives aicoder restarts across
 * autonomous-loop cycles.
 *
 * Follows the same pattern as review-gate-state.ts.
 * Handles Map/Set → JSON serialization transparently.
 */

import * as fs from "fs";
import * as path from "path";
import { type ConvergenceState, initConvergenceState } from "./convergence";

const DEFAULT_WORKSPACE = process.cwd();

function stateFilePath(issueKey?: string): string {
  const base = path.join(DEFAULT_WORKSPACE, ".aicoder");
  if (issueKey) {
    // Sanitize issue key for use as a filename (e.g. "IR-110" → safe)
    const safe = issueKey.replace(/[^a-zA-Z0-9_\-]/g, "_");
    return path.join(base, `convergence-state-${safe}.json`);
  }
  return path.join(base, "convergence-state.json");
}

let currentState: ConvergenceState | null = null;

/** Deserialize a plain object back into a ConvergenceState with Map/Set instances. */
function deserializeConvergence(data: Record<string, unknown>): ConvergenceState {
  return {
    roundNumber: typeof data.roundNumber === "number" ? data.roundNumber : 0,
    previousFindings: Array.isArray(data.previousFindings) ? data.previousFindings : [],
    identicalCount: new Map(Object.entries(data.identicalCount ?? {})),
    emptyPRCount: typeof data.emptyPRCount === "number" ? data.emptyPRCount : 0,
    findingsResolved: typeof data.findingsResolved === "number" ? data.findingsResolved : 0,
    findingsNew: typeof data.findingsNew === "number" ? data.findingsNew : 0,
    noProgressCount: typeof data.noProgressCount === "number" ? data.noProgressCount : 0,
    lastRoundFindings: new Set(Array.isArray(data.lastRoundFindings) ? data.lastRoundFindings : []),
  };
}

export interface SerializedConvergenceState {
  roundNumber: number;
  previousFindings: string[];
  identicalCount: Record<string, number>;
  emptyPRCount: number;
  findingsResolved: number;
  findingsNew: number;
  noProgressCount: number;
  lastRoundFindings: string[];
}

/** Serialize a ConvergenceState to a JSON-safe plain object. */
export function serializeConvergence(state: ConvergenceState): SerializedConvergenceState {
  return {
    roundNumber: state.roundNumber,
    previousFindings: state.previousFindings,
    identicalCount: Object.fromEntries(state.identicalCount),
    emptyPRCount: state.emptyPRCount,
    findingsResolved: state.findingsResolved,
    findingsNew: state.findingsNew,
    noProgressCount: state.noProgressCount,
    lastRoundFindings: [...state.lastRoundFindings],
  };
}

export function loadConvergenceState(issueKey?: string): ConvergenceState {
  if (!issueKey && currentState) return currentState;
  const file = stateFilePath(issueKey);
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (data && typeof data.roundNumber === "number") {
        const state = deserializeConvergence(data);
        if (!issueKey) currentState = state;
        return state;
      }
    }
  } catch {
    // File doesn't exist or is corrupt — start fresh
  }
  const fresh = initConvergenceState();
  if (!issueKey) currentState = fresh;
  return fresh;
}

export function saveConvergenceState(state: ConvergenceState, issueKey?: string): void {
  if (!issueKey) currentState = state;
  const file = stateFilePath(issueKey);
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(serializeConvergence(state), null, 2), "utf-8");
  } catch {
    // Persistence failure is non-fatal
  }
}

export function clearConvergenceState(issueKey?: string): void {
  if (!issueKey) currentState = null;
  const file = stateFilePath(issueKey);
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch {
    // Non-fatal
  }
}

/** Reset in-memory cache only (for testing). Does NOT delete the file on disk. */
export function _resetCache(): void {
  currentState = null;
}