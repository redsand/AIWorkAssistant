/**
 * Durable knowledge-claims store (issue #247 — Sprint 3 active knowledge
 * acquisition).
 *
 * The cost-aware retrieval cascade (issue #245) escalates a low-confidence
 * ClaimKit probe through teacher-LLM verification and tool research before
 * falling back to full RAG. Without persistence, the next time a similar
 * query arrives the agent pays for that escalation all over again. U-Mem
 * (arXiv:2602.22406, §3.1) formalizes the fix as memory evolution:
 *
 *     M_{t+1} <- Update(M_t, E(q_t, y_t, r_t))
 *
 * This module persists each cascade resolution as a durable knowledge claim,
 * retrieves the most useful claims for a new query using the same
 * semantic-aware Thompson sampling (SA-CTS) introduced in Sprint 2 (issue
 * #246), updates each claim's Beta utility distribution from downstream task
 * outcomes, and prunes claims that have not been retrieved in N days.
 *
 * The SQLite schema mirrors the existing memory-store pattern: a CREATE TABLE
 * IF NOT EXISTS migration with a content-addressed FTS5 virtual table for
 * candidate-pool retrieval. The pure Thompson-sampling helpers from
 * session-utility.ts are reused verbatim so claim selection uses the exact
 * same exploit/explore policy as session selection.
 */

import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { env, resolvePath } from "../config/env";
import { applyWalHygiene } from "../util/sqlite-hygiene";
import {
  thompsonSelect,
  DEFAULT_PRIOR_ALPHA,
  DEFAULT_PRIOR_BETA,
  type UtilityCandidate,
  type ThompsonSelectOptions,
} from "./session-utility";

/** Cascade level that produced the resolution (mirrors retrieval-cascade.ts). */
export type ClaimCascadeLevel =
  | "claimkit"
  | "teacher_verify"
  | "tool_research"
  | "full_rag";

/** A persisted cascade resolution retrievable for future similar queries. */
export interface KnowledgeClaim {
  id: string;
  /** Original (rewritten) query that produced this resolution. */
  query: string;
  /** The resolution text — the teacher's confirmed answer or the web evidence. */
  resolution: string;
  /** Which cascade level produced this resolution. */
  cascadeLevel: ClaimCascadeLevel;
  /** Cascade confidence in [0, 1]. */
  confidence: number;
  /** Provenance, e.g. "teacher:glm-5.2" or "web_search:tavily". */
  source: string;
  /** Beta(alpha, beta) utility distribution, updated from task outcomes. */
  alpha: number;
  beta: number;
  createdAt: Date;
  lastRetrievedAt: Date;
}

/** Input for storing a new claim (id/timestamps/utility are derived). */
export interface StoreClaimInput {
  query: string;
  resolution: string;
  cascadeLevel: ClaimCascadeLevel;
  confidence: number;
  source: string;
}

/** A claim with its retrieval-round diagnostics, returned by retrieveClaims(). */
export interface RetrievedClaim extends KnowledgeClaim {
  sampledUtility: number;
  similarity: number;
  combinedScore: number;
  explored: boolean;
}

export interface RetrieveClaimsOptions extends ThompsonSelectOptions {
  /** Ceiling on the FTS candidate-pool size before SA-CTS reranking. */
  candidatePool?: number;
}

interface ClaimRow {
  id: string;
  query: string;
  resolution: string;
  cascadeLevel: string;
  confidence: number;
  source: string;
  alpha: number;
  beta: number;
  createdAt: number;
  lastRetrievedAt: number;
}

interface ScoredClaimRow extends ClaimRow {
  /** FTS BM25 relevance score (or word-overlap fallback score). Higher = better. */
  relevanceScore: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function rowToClaim(row: ClaimRow): KnowledgeClaim {
  return {
    id: row.id,
    query: row.query,
    resolution: row.resolution,
    cascadeLevel: row.cascadeLevel as ClaimCascadeLevel,
    confidence: row.confidence,
    source: row.source,
    alpha: row.alpha,
    beta: row.beta,
    createdAt: new Date(row.createdAt),
    lastRetrievedAt: new Date(row.lastRetrievedAt),
  };
}

function resolveBasePath(): string {
  // Operator override — explicit path wins.
  if (env.CLAIMS_STORE_PATH && env.CLAIMS_STORE_PATH.trim().length > 0) {
    return env.CLAIMS_STORE_PATH;
  }
  // Test isolation — each worker gets its own temp directory so parallel vitest
  // workers don't stamp on each other's claims database.
  if (process.env.VITEST) {
    return path.join(
      os.tmpdir(),
      "ai-assist-tim-vitest-claims",
      `${process.env.VITEST_WORKER_ID || "worker"}-${process.pid}`,
    );
  }
  // Default: co-located with the agent memory database.
  return resolvePath("memories");
}

/**
 * Render a list of retrieved claims as the "PRIOR KNOWLEDGE" context section.
 * Returns null when the list is empty so the context assembler can skip the
 * section entirely. Truncates each resolution to keep the section bounded.
 */
export function formatClaimsSection(claims: RetrievedClaim[]): string | null {
  if (claims.length === 0) return null;
  const lines: string[] = ["=== PRIOR KNOWLEDGE (from prior cascade resolutions) ==="];
  for (const claim of claims) {
    const confidencePct = Math.round(clamp01(claim.confidence) * 100);
    lines.push(
      `- [${claim.cascadeLevel} | ${confidencePct}% | src: ${claim.source}] ` +
        claim.resolution.substring(0, 500),
    );
  }
  return lines.join("\n");
}

/**
 * Build a FTS5 MATCH query from raw user input. Splits on word boundaries,
 * quotes each term so punctuation in the query can't break the MATCH syntax,
 * and ORs them together so any matching term surfaces the claim. Mirrors the
 * conversation-manager FTS5 query builder.
 */
function buildFtsQuery(query: string): string {
  const terms =
    query
      .match(/[\p{L}\p{N}_-]+/gu)
      ?.map((t) => t.trim())
      .filter((t) => t.length >= 2)
      .slice(0, 12) ?? [];
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

/**
 * Map FTS relevance scores onto a [0.05, 1] similarity weight when embeddings
 * are unavailable (claims store doesn't depend on the embedding service so
 * the agent's retrieval still works without a provider configured). Min–max
 * normalized: the best candidate keeps full weight, the worst keeps a small
 * floor so exploration never starves to zero combined score.
 */
function ftsFallbackSimilarities(rows: ScoredClaimRow[]): number[] {
  const scores = rows.map((r) =>
    Number.isFinite(r.relevanceScore) ? r.relevanceScore : 0,
  );
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  const range = max - min;
  return scores.map((s) => (range <= 0 ? 1 : 0.05 + 0.95 * ((s - min) / range)));
}

/**
 * Persistent store of cascade-resolution knowledge claims. Singleton export at
 * the bottom of the file (`claimsStore`); tests construct instances directly
 * against a temp directory.
 */
export class ClaimsStore {
  private db: Database.Database | null = null;
  private readonly basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath ?? resolveBasePath();
    this.init();
  }

  private init(): void {
    try {
      if (!fs.existsSync(this.basePath)) {
        fs.mkdirSync(this.basePath, { recursive: true });
      }
      const dbPath = path.join(this.basePath, "claims.db");
      this.db = new Database(dbPath);
      applyWalHygiene(this.db, { label: "claims" });
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS claims (
          id TEXT PRIMARY KEY,
          query TEXT NOT NULL,
          resolution TEXT NOT NULL,
          cascadeLevel TEXT NOT NULL,
          confidence REAL NOT NULL,
          source TEXT NOT NULL,
          alpha REAL NOT NULL,
          beta REAL NOT NULL,
          createdAt INTEGER NOT NULL,
          lastRetrievedAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_claims_last_retrieved
          ON claims(lastRetrievedAt);
      `);
      // FTS5 virtual table over the searchable text. content='claims' keeps the
      // indexed text inside the source table (no duplication); the external
      // content API is the lightest-weight sync option and matches the existing
      // sessions_fts pattern.
      try {
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS claims_fts
            USING fts5(query, resolution, content='claims', content_rowid='rowid');
        `);
      } catch (err) {
        // FTS5 is bundled with SQLite since 3.9 but some embedded builds strip
        // it; retrieval still works via the in-memory fallback.
        console.warn(
          "[ClaimsStore] FTS5 unavailable, falling back to in-memory scan:",
          err instanceof Error ? err.message : err,
        );
      }
    } catch (err) {
      console.warn(
        "[ClaimsStore] SQLite unavailable, claims store disabled:",
        err instanceof Error ? err.message : err,
      );
      this.db = null;
    }
  }

  /**
   * Persist a knowledge claim. Returns the new claim id, or null when the
   * store is unavailable. Cold-start prior Beta(DEFAULT_PRIOR_ALPHA,
   * DEFAULT_PRIOR_BETA) is written alongside so the very first retrieval can
   * still Thompson-sample.
   */
  storeClaim(input: StoreClaimInput): string | null {
    if (!this.db) return null;
    const id = randomUUID();
    const now = Date.now();
    try {
      this.db
        .prepare(
          `INSERT INTO claims
             (id, query, resolution, cascadeLevel, confidence, source, alpha, beta, createdAt, lastRetrievedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.query,
          input.resolution,
          input.cascadeLevel,
          clamp01(input.confidence),
          input.source,
          DEFAULT_PRIOR_ALPHA,
          DEFAULT_PRIOR_BETA,
          now,
          now,
        );
      this.indexClaimFts(id, input.query, input.resolution);
    } catch (err) {
      console.warn(
        "[ClaimsStore] storeClaim failed:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
    return id;
  }

  /** Keep the FTS index in sync with an INSERT (no-op without FTS5). */
  private indexClaimFts(id: string, query: string, resolution: string): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT INTO claims_fts (rowid, query, resolution) VALUES ((SELECT rowid FROM claims WHERE id = ?), ?, ?)`,
        )
        .run(id, query, resolution);
    } catch {
      // FTS5 may be unavailable or the rowid lookup may fail; retrieval still
      // works via the in-memory fallback.
    }
  }

  /**
   * Retrieve the most useful claims for a query using semantic-aware Thompson
   * sampling: pull a candidate pool from FTS5, score each by FTS relevance
   * (semantic-similarity proxy when embeddings are unavailable), sample each
   * claim's Beta utility distribution, multiply sample × similarity, and pick
   * the top-k (with epsilon-greedy exploration). Stamps lastRetrievedAt on
   * every returned claim so pruneStaleClaims can see them as recently used.
   */
  retrieveClaims(
    query: string,
    topK: number,
    options: RetrieveClaimsOptions = {},
  ): RetrievedClaim[] {
    if (!this.db || !query.trim() || topK <= 0) return [];

    const candidatePool = options.candidatePool ?? Math.max(topK * 4, 12);
    const ftsRows = this.fetchFtsCandidates(query, candidatePool);
    if (ftsRows.length === 0) return [];

    const similarities = ftsFallbackSimilarities(ftsRows);

    const candidates: UtilityCandidate[] = ftsRows.map((row, i) => ({
      sessionId: row.id,
      similarity: similarities[i],
      utility: {
        sessionId: row.id,
        alpha: row.alpha,
        beta: row.beta,
        lastUsed: new Date(row.lastRetrievedAt),
      },
    }));

    const ranked = thompsonSelect(candidates, {
      topK,
      epsilon: options.epsilon,
      rng: options.rng,
    });

    if (ranked.length === 0) return [];

    const byId = new Map(ftsRows.map((r) => [r.id, r]));
    const selectedIds: string[] = [];
    const out: RetrievedClaim[] = [];
    for (const r of ranked) {
      const row = byId.get(r.sessionId);
      if (!row) continue;
      selectedIds.push(row.id);
      out.push({
        ...rowToClaim(row),
        sampledUtility: r.sampledUtility,
        similarity: r.similarity,
        combinedScore: r.combinedScore,
        explored: r.explored,
      });
    }

    this.touchRetrievedAt(selectedIds);
    return out;
  }

  /** Pull a candidate pool for the query via FTS5 (or in-memory fallback). */
  private fetchFtsCandidates(query: string, limit: number): ScoredClaimRow[] {
    if (!this.db) return [];
    const ftsQuery = buildFtsQuery(query);
    if (ftsQuery) {
      try {
        const rows = this.db
          .prepare(
            `SELECT c.id, c.query, c.resolution, c.cascadeLevel, c.confidence, c.source,
                    c.alpha, c.beta, c.createdAt, c.lastRetrievedAt,
                    -bm25(claims_fts) AS relevanceScore
             FROM claims_fts
             JOIN claims c ON c.rowid = claims_fts.rowid
             WHERE claims_fts MATCH ?
             ORDER BY relevanceScore DESC
             LIMIT ?`,
          )
          .all(ftsQuery, limit) as ScoredClaimRow[];
        if (rows.length > 0) {
          return rows;
        }
      } catch (err) {
        console.warn(
          "[ClaimsStore] FTS5 retrieval failed, using fallback scan:",
          err instanceof Error ? err.message : err,
        );
      }
    }
    // Fallback: linear scan with simple word overlap scoring.
    return this.fallbackScan(query, limit);
  }

  private fallbackScan(query: string, limit: number): ScoredClaimRow[] {
    if (!this.db) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT id, query, resolution, cascadeLevel, confidence, source,
                  alpha, beta, createdAt, lastRetrievedAt
           FROM claims`,
        )
        .all() as ClaimRow[];
      const qLower = query.toLowerCase();
      const terms = new Set(
        qLower
          .split(/\s+/)
          .map((t) => t.trim())
          .filter((t) => t.length >= 2),
      );
      const scored: ScoredClaimRow[] = rows
        .map((row) => {
          const hay = `${row.query} ${row.resolution}`.toLowerCase();
          let hits = 0;
          for (const t of terms) if (hay.includes(t)) hits++;
          return { ...row, relevanceScore: hits };
        })
        .filter((s) => s.relevanceScore > 0)
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
        .slice(0, limit);
      return scored;
    } catch {
      return [];
    }
  }

  /**
   * Stamp lastRetrievedAt = now on every claim that was surfaced this turn so
   * pruneStaleClaims sees them as recently used. Best-effort batch update.
   */
  private touchRetrievedAt(ids: string[]): void {
    if (!this.db || ids.length === 0) return;
    try {
      const now = Date.now();
      const stmt = this.db.prepare(
        "UPDATE claims SET lastRetrievedAt = ? WHERE id = ?",
      );
      const tx = this.db.transaction((idList: string[]) => {
        for (const id of idList) stmt.run(now, id);
      });
      tx(ids);
    } catch (err) {
      console.warn(
        "[ClaimsStore] lastRetrievedAt update failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Update a claim's Beta utility distribution from a downstream task outcome.
   * Success increments alpha; failure increments beta. No-op when the store
   * is unavailable or the id doesn't exist.
   */
  updateClaimUtility(claimId: string, success: boolean): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          "UPDATE claims SET alpha = alpha + ?, beta = beta + ? WHERE id = ?",
        )
        .run(success ? 1 : 0, success ? 0 : 1, claimId);
    } catch (err) {
      console.warn(
        "[ClaimsStore] updateClaimUtility failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Remove claims not retrieved in the last maxAgeDays days. Returns the
   * number of claims removed. Best-effort: a failure logs and returns 0 so
   * the startup pruning job is non-fatal.
   *
   * The delete runs in a single transaction that ALSO removes the matching
   * rows from the claims_fts external-content virtual table. Without the FTS
   * sweep, deletes on the source table orphan the index rows, which silently
   * corrupts BM25 ranking (the FTS5 rowid namespace keeps growing while the
   * source shrinks, and stale entries still match MATCH queries). The FTS
   * sweep is best-effort: if FTS5 was unavailable at init there is no
   * claims_fts table to clean, and the transaction still completes.
   */
  pruneStaleClaims(maxAgeDays: number): number {
    if (!this.db) return 0;
    if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return 0;
    const cutoff = Date.now() - maxAgeDays * DAY_MS;
    try {
      const tx = this.db.transaction((ts: number) => {
        // External-content FTS5 maps claims_fts.rowid -> claims.rowid, so
        // delete the index rows first while the source rowids still exist.
        // Best-effort: skip if FTS5 was never created.
        try {
          this.db!
            .prepare(
              `DELETE FROM claims_fts
               WHERE rowid IN (
                 SELECT rowid FROM claims WHERE lastRetrievedAt < ?
               )`,
            )
            .run(ts);
        } catch {
          /* FTS5 unavailable — nothing to prune in the index */
        }
        const info = this.db!
          .prepare("DELETE FROM claims WHERE lastRetrievedAt < ?")
          .run(ts);
        return info.changes;
      });
      return tx(cutoff);
    } catch (err) {
      console.warn(
        "[ClaimsStore] pruneStaleClaims failed:",
        err instanceof Error ? err.message : err,
      );
      return 0;
    }
  }

  /**
   * Internal diagnostic that returns the rowid set still present in the FTS
   * index. Used by tests to assert that pruneStaleClaims does not orphan
   * index rows when FTS5 is available. Returns an empty array when FTS5 is
   * unavailable or the query fails.
   */
  ftsRowids(): number[] {
    if (!this.db) return [];
    try {
      const rows = this.db.prepare("SELECT rowid FROM claims_fts").all() as {
        rowid: number;
      }[];
      return rows.map((r) => r.rowid);
    } catch {
      return [];
    }
  }

  /** All persisted claims — primarily for tests/diagnostics. */
  allClaims(): KnowledgeClaim[] {
    if (!this.db) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT id, query, resolution, cascadeLevel, confidence, source,
                  alpha, beta, createdAt, lastRetrievedAt
           FROM claims
           ORDER BY createdAt DESC`,
        )
        .all() as ClaimRow[];
      return rows.map(rowToClaim);
    } catch {
      return [];
    }
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

/** Module-level singleton. Constructed lazily-side-effect-free for tests. */
export const claimsStore = new ClaimsStore();

/**
 * Run a one-shot startup prune so claims that have not been retrieved in
 * maxAgeDays (default 30) are removed before the first query lands. Designed
 * to be called from server.ts after memory/profile init has settled. Logs
 * the count removed (or a warning when the store is unavailable).
 */
export function runStartupClaimPrune(maxAgeDays = 30): number {
  const removed = claimsStore.pruneStaleClaims(maxAgeDays);
  if (removed > 0) {
    console.log(
      `[ClaimsStore] startup prune removed ${removed} claim(s) older than ${maxAgeDays}d`,
    );
  } else {
    console.log(
      `[ClaimsStore] startup prune — nothing to remove (max age ${maxAgeDays}d)`,
    );
  }
  return removed;
}

/**
 * Resolve the on-disk directory that backs the singleton claims store. Server
 * startup uses this to mkdir -p the directory BEFORE the singleton opens its
 * SQLite handle, so an operator-supplied CLAIMS_STORE_PATH lands a clear
 * boot-time error if the parent is missing or read-only rather than a silent
 * self-disable later.
 */
export function getClaimsStoreBasePath(): string {
  return resolveBasePath();
}
