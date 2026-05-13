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
const STATE_FILE = path.join(DEFAULT_WORKSPACE, ".aicoder", "convergence-state.json");

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

export function loadConvergenceState(): ConvergenceState {
  if (currentState) return currentState;
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      if (data && typeof data.roundNumber === "number") {
        currentState = deserializeConvergence(data);
        return currentState;
      }
    }
  } catch {
    // File doesn't exist or is corrupt — start fresh
  }
  currentState = initConvergenceState();
  return currentState;
}

export function saveConvergenceState(state: ConvergenceState): void {
  currentState = state;
  try {
    const dir = path.dirname(STATE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(serializeConvergence(state), null, 2), "utf-8");
  } catch {
    // Persistence failure is non-fatal
  }
}

export function clearConvergenceState(): void {
  currentState = null;
  try {
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
  } catch {
    // Non-fatal
  }
}

/** Reset in-memory cache only (for testing). Does NOT delete the file on disk. */
export function _resetCache(): void {
  currentState = null;
}