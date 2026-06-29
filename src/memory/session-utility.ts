/**
 * Semantic-aware Thompson sampling for memory-session retrieval (issue #246).
 *
 * Each past session carries a Beta(alpha, beta) utility distribution where
 * `alpha` counts successful uses and `beta` counts failures. Session retrieval
 * samples from each session's Beta, multiplies the sample by the session's
 * semantic similarity to the current query, and selects the top-k by that
 * combined score. An epsilon-greedy step occasionally swaps in a low-utility
 * (high-uncertainty) session so under-explored sessions still get a chance to
 * prove themselves.
 *
 * Based on U-Mem's SA-CTS algorithm (arXiv:2602.22406, Section 3.3), which
 * reports a 14.6% retrieval-quality lift over recency-only selection.
 *
 * The persisted utility counts live in their own SQLite database alongside the
 * conversation session records. The pure sampling/selection helpers take an
 * injectable RNG so the behavior is deterministic under test.
 */

import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { env, resolvePath } from "../config/env";
import { applyWalHygiene } from "../util/sqlite-hygiene";

export interface SessionUtility {
  sessionId: string;
  alpha: number;
  beta: number;
  lastUsed: Date;
}

/**
 * Optimistic cold-start prior. Beta(2,1) has mean 2/3, biasing brand-new
 * sessions upward so the bandit explores them before deciding they're low
 * value. Overridable via SESSION_UTILITY_PRIOR_ALPHA / _PRIOR_BETA.
 */
export const DEFAULT_PRIOR_ALPHA = 2;
export const DEFAULT_PRIOR_BETA = 1;

function priorAlpha(): number {
  const v = env.SESSION_UTILITY_PRIOR_ALPHA;
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_PRIOR_ALPHA;
}

function priorBeta(): number {
  const v = env.SESSION_UTILITY_PRIOR_BETA;
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_PRIOR_BETA;
}

// ── Pure sampling helpers ───────────────────────────────────────────────────

type Rng = () => number;

/** Standard normal via Box–Muller. Avoids log(0) by resampling exact zeros. */
function sampleStandardNormal(rng: Rng): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Sample from a Gamma(shape, 1) distribution. Uses the Marsaglia & Tsang
 * method for shape >= 1 and a boosting transform for shape < 1. Non-positive
 * shapes collapse to 0 so callers never divide by a NaN.
 */
export function sampleGamma(shape: number, rng: Rng = Math.random): number {
  if (!Number.isFinite(shape) || shape <= 0) return 0;
  if (shape < 1) {
    // Boosting: Gamma(a) = Gamma(a+1) * U^(1/a)
    const u = rng();
    return sampleGamma(shape + 1, rng) * Math.pow(u === 0 ? Number.MIN_VALUE : u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  // Bounded loop guard — the acceptance probability is high, but a pathological
  // RNG must never wedge the assembler.
  for (let i = 0; i < 1000; i++) {
    let x: number;
    let v: number;
    do {
      x = sampleStandardNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u === 0 ? Number.MIN_VALUE : u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
  // Fallback to the distribution mean if the loop never accepted.
  return d;
}

/**
 * Sample from Beta(alpha, beta) using the ratio of two Gamma samples.
 * Returns a value in [0, 1].
 */
export function sampleBeta(alpha: number, beta: number, rng: Rng = Math.random): number {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  const denom = x + y;
  if (denom === 0) return 0;
  const r = x / denom;
  return r < 0 ? 0 : r > 1 ? 1 : r;
}

/** Posterior mean of a Beta(alpha, beta): alpha / (alpha + beta). */
export function utilityMean(u: Pick<SessionUtility, "alpha" | "beta">): number {
  const denom = u.alpha + u.beta;
  return denom === 0 ? 0 : u.alpha / denom;
}

export interface UtilityCandidate {
  sessionId: string;
  /** Cosine similarity (or normalized relevance) in [0, 1]. */
  similarity: number;
  utility: SessionUtility;
}

export interface RankedSession {
  sessionId: string;
  similarity: number;
  utility: SessionUtility;
  /** The Beta sample drawn this round. */
  sampledUtility: number;
  /** sampledUtility * similarity — the value used for ranking. */
  combinedScore: number;
  /** True when this slot was filled by the epsilon-greedy exploration branch. */
  explored: boolean;
}

export interface ThompsonSelectOptions {
  topK?: number;
  /** Probability of swapping the weakest exploit slot for an exploration pick. */
  epsilon?: number;
  rng?: Rng;
}

/**
 * Rank candidate sessions with Thompson sampling and select the top-k.
 *
 * For each candidate, draw a sample from its Beta utility distribution and
 * multiply by its semantic similarity. Sort by that combined score and keep
 * the top-k (exploitation). Then, with probability `epsilon`, replace the
 * weakest selected slot with the most-uncertain unselected session
 * (exploration). This yields the 80/20 exploit/explore balance the issue asks
 * for at the default epsilon of 0.2.
 */
export function thompsonSelect(
  candidates: UtilityCandidate[],
  options: ThompsonSelectOptions = {},
): RankedSession[] {
  const topK = options.topK ?? 3;
  const epsilon = options.epsilon ?? 0.2;
  const rng = options.rng ?? Math.random;

  if (candidates.length === 0 || topK <= 0) return [];

  const scored: RankedSession[] = candidates.map((c) => {
    const sampledUtility = sampleBeta(c.utility.alpha, c.utility.beta, rng);
    return {
      sessionId: c.sessionId,
      similarity: c.similarity,
      utility: c.utility,
      sampledUtility,
      combinedScore: sampledUtility * c.similarity,
      explored: false,
    };
  });

  scored.sort((a, b) => b.combinedScore - a.combinedScore);
  const selected = scored.slice(0, topK);

  if (epsilon > 0 && scored.length > selected.length && rng() < epsilon) {
    const selectedIds = new Set(selected.map((s) => s.sessionId));
    const pool = scored.filter((s) => !selectedIds.has(s.sessionId));
    // Most uncertain = lowest posterior-mean utility. These are the sessions
    // the bandit is least sure about and most benefits from sampling.
    pool.sort((a, b) => utilityMean(a.utility) - utilityMean(b.utility));
    const explore: RankedSession = { ...pool[0], explored: true };
    if (selected.length >= topK) {
      selected[selected.length - 1] = explore;
    } else {
      selected.push(explore);
    }
  }

  return selected;
}

// ── Persistent utility store ────────────────────────────────────────────────

function resolveBasePath(): string {
  if (process.env.SESSION_UTILITY_DB_DIR) {
    return process.env.SESSION_UTILITY_DB_DIR;
  }
  if (process.env.CONVERSATION_MEMORY_PATH) {
    return process.env.CONVERSATION_MEMORY_PATH;
  }
  if (process.env.VITEST) {
    return path.join(
      os.tmpdir(),
      "ai-assist-tim-vitest-session-utility",
      `${process.env.VITEST_WORKER_ID || "worker"}-${process.pid}`,
    );
  }
  return resolvePath("memories");
}

export class SessionUtilityStore {
  private db: Database.Database | null = null;
  private basePath: string;
  // Remembers, per chat session, which past-session IDs were surfaced on the
  // most recent turn so a downstream success/failure signal can be attributed
  // back to the exact sessions that were "pulled" as bandit arms.
  private lastRetrieval = new Map<string, string[]>();

  constructor(basePath?: string) {
    this.basePath = basePath ?? resolveBasePath();
    this.init();
  }

  private init(): void {
    try {
      if (!fs.existsSync(this.basePath)) {
        fs.mkdirSync(this.basePath, { recursive: true });
      }
      const dbPath = path.join(this.basePath, "session-utility.db");
      this.db = new Database(dbPath);
      applyWalHygiene(this.db, { label: "session-utility" });
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS session_utility (
          sessionId TEXT PRIMARY KEY,
          alpha REAL NOT NULL,
          beta REAL NOT NULL,
          lastUsed INTEGER NOT NULL
        );
      `);
    } catch (err) {
      console.warn(
        "[SessionUtility] SQLite unavailable, utility tracking disabled:",
        err instanceof Error ? err.message : err,
      );
      this.db = null;
    }
  }

  private rowToUtility(row: {
    sessionId: string;
    alpha: number;
    beta: number;
    lastUsed: number;
  }): SessionUtility {
    return {
      sessionId: row.sessionId,
      alpha: row.alpha,
      beta: row.beta,
      lastUsed: new Date(row.lastUsed),
    };
  }

  /**
   * Return the stored utility for a session, or an optimistic cold-start prior
   * Beta(2,1) when the session has never been scored. The prior is NOT
   * persisted until the first real update, so unused sessions don't accrete
   * rows.
   */
  getUtility(sessionId: string): SessionUtility {
    if (this.db) {
      try {
        const row = this.db
          .prepare(
            "SELECT sessionId, alpha, beta, lastUsed FROM session_utility WHERE sessionId = ?",
          )
          .get(sessionId) as
          | { sessionId: string; alpha: number; beta: number; lastUsed: number }
          | undefined;
        if (row) return this.rowToUtility(row);
      } catch (err) {
        console.warn(
          "[SessionUtility] getUtility failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
    return {
      sessionId,
      alpha: priorAlpha(),
      beta: priorBeta(),
      lastUsed: new Date(0),
    };
  }

  /** Batch variant of getUtility — one map lookup per requested id. */
  getUtilities(sessionIds: string[]): Map<string, SessionUtility> {
    const out = new Map<string, SessionUtility>();
    for (const id of sessionIds) {
      out.set(id, this.getUtility(id));
    }
    return out;
  }

  /**
   * Apply one feedback observation to a session's Beta distribution.
   * Success increments alpha; failure increments beta. Returns the updated
   * utility (or the cold-start prior unchanged when the store is unavailable).
   */
  updateSessionUtility(sessionId: string, success: boolean): SessionUtility {
    const current = this.getUtility(sessionId);
    const updated: SessionUtility = {
      sessionId,
      alpha: current.alpha + (success ? 1 : 0),
      beta: current.beta + (success ? 0 : 1),
      lastUsed: new Date(),
    };
    if (this.db) {
      try {
        this.db
          .prepare(
            `INSERT INTO session_utility (sessionId, alpha, beta, lastUsed)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(sessionId) DO UPDATE SET
               alpha = excluded.alpha,
               beta = excluded.beta,
               lastUsed = excluded.lastUsed`,
          )
          .run(updated.sessionId, updated.alpha, updated.beta, updated.lastUsed.getTime());
      } catch (err) {
        console.warn(
          "[SessionUtility] updateSessionUtility failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
    return updated;
  }

  /** All persisted utilities (cold-start-only sessions are not included). */
  all(): SessionUtility[] {
    if (!this.db) return [];
    try {
      const rows = this.db
        .prepare("SELECT sessionId, alpha, beta, lastUsed FROM session_utility")
        .all() as Array<{
        sessionId: string;
        alpha: number;
        beta: number;
        lastUsed: number;
      }>;
      return rows.map((r) => this.rowToUtility(r));
    } catch {
      return [];
    }
  }

  /**
   * Record which past-session IDs were surfaced for a chat session this turn,
   * so a later outcome signal can be attributed back to them.
   */
  rememberRetrieval(chatSessionId: string, retrievedSessionIds: string[]): void {
    if (!chatSessionId) return;
    if (retrievedSessionIds.length === 0) {
      this.lastRetrieval.delete(chatSessionId);
      return;
    }
    this.lastRetrieval.set(chatSessionId, [...retrievedSessionIds]);
  }

  /**
   * Apply a success/failure signal to every session surfaced on the chat
   * session's most recent turn, then clear the pending retrieval so the same
   * observation can't be double-counted. Returns the number of sessions
   * updated.
   */
  recordTurnOutcome(chatSessionId: string, success: boolean): number {
    const ids = this.lastRetrieval.get(chatSessionId);
    if (!ids || ids.length === 0) return 0;
    for (const id of ids) {
      this.updateSessionUtility(id, success);
    }
    this.lastRetrieval.delete(chatSessionId);
    return ids.length;
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* already closed */
      }
      this.db = null;
    }
  }
}

export const sessionUtilityStore = new SessionUtilityStore();

/**
 * Module-level convenience matching the issue's `updateSessionUtility(sessionId,
 * success)` signature. Delegates to the shared singleton store.
 */
export function updateSessionUtility(sessionId: string, success: boolean): SessionUtility {
  return sessionUtilityStore.updateSessionUtility(sessionId, success);
}

/** Record a turn outcome against the shared singleton store. */
export function recordSessionFeedback(chatSessionId: string, success: boolean): number {
  return sessionUtilityStore.recordTurnOutcome(chatSessionId, success);
}

/**
 * Heuristic follow-up vs. rephrase classifier (issue #246 feedback signals).
 *
 * A genuine follow-up (new question that builds on the answer) is an implicit
 * success signal for the sessions that were retrieved; a near-verbatim
 * rephrase of the immediately-prior question signals the previous retrieval
 * did NOT help (implicit failure). Returns `null` when the relationship is
 * ambiguous so callers don't apply a noisy signal.
 */
export function classifyFollowUpSignal(
  previousUserMessage: string,
  currentUserMessage: string,
): "success" | "failure" | null {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const a = norm(previousUserMessage);
  const b = norm(currentUserMessage);
  if (!a || !b) return null;
  if (a === b) return "failure";

  const wordsA = new Set(a.split(" ").filter((w) => w.length >= 3));
  const wordsB = new Set(b.split(" ").filter((w) => w.length >= 3));
  if (wordsA.size === 0 || wordsB.size === 0) return null;
  let inter = 0;
  for (const w of wordsA) if (wordsB.has(w)) inter++;
  const jaccard = inter / (wordsA.size + wordsB.size - inter);

  // Heavy lexical overlap with a different surface form ⇒ the user is asking
  // the same thing again because the prior answer missed.
  if (jaccard >= 0.6) return "failure";
  // Low overlap ⇒ a distinct follow-up the prior context helped enable.
  if (jaccard <= 0.2) return "success";
  return null;
}
