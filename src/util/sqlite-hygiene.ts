/**
 * Shared SQLite hygiene applied to every Database instance the app opens.
 *
 * The default better-sqlite3 / SQLite settings produce a ~4MB WAL on every
 * actively-written DB because the autocheckpoint threshold is 1000 pages
 * (~4MB at 4KB page size). On this app's data/ directory that was 14 WALs
 * × ~4MB = ~56MB of journal that never got truncated, plus a per-commit
 * cost spike whenever the WAL reached the threshold.
 *
 * applyWalHygiene() lowers the threshold to 200 pages (~800KB), runs an
 * immediate TRUNCATE checkpoint at open time to recover any leftover WAL
 * from a prior crash, and sets a few safe pragmas (foreign_keys=ON,
 * busy_timeout) that callers usually want but sometimes forget.
 *
 * Safe to call repeatedly on the same connection; all pragmas are
 * idempotent.
 */

import type Database from "better-sqlite3";

export interface WalHygieneOptions {
  /**
   * Page count threshold for automatic checkpoint. SQLite default is 1000
   * (~4MB at 4KB pages). 200 is ~800KB — checkpoints more often but each
   * checkpoint walks less log, so commits don't spike when the WAL hits
   * the threshold.
   */
  autoCheckpoint?: number;
  /**
   * Skip the boot-time TRUNCATE checkpoint. Set true for read-only opens
   * or when the caller knows another process may be holding the WAL.
   */
  skipBootTruncate?: boolean;
  /**
   * Pragma: busy_timeout in ms. Defaults to 5000 so a contention spike
   * doesn't immediately SQLITE_BUSY callers.
   */
  busyTimeoutMs?: number;
  /**
   * Pragma: foreign_keys. Defaults to true. Tests sometimes want it off.
   */
  foreignKeys?: boolean;
  /**
   * Label for log messages (e.g. "agent-runs"). Optional.
   */
  label?: string;
}

export function applyWalHygiene(
  db: Database.Database,
  opts: WalHygieneOptions = {},
): void {
  // WAL journaling — idempotent if already set. Most callers already set
  // this immediately after opening; calling again is a no-op.
  db.pragma("journal_mode = WAL");
  // Smaller checkpoint window — keeps the WAL bounded.
  const autoCheckpoint = opts.autoCheckpoint ?? 200;
  db.pragma(`wal_autocheckpoint = ${autoCheckpoint}`);
  // Reasonable busy timeout so a short contention spike doesn't immediately
  // surface as SQLITE_BUSY.
  const busyTimeoutMs = opts.busyTimeoutMs ?? 5000;
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  // foreign_keys: most schemas in this app declare FOREIGN KEY constraints;
  // enable enforcement unless the caller opted out (some tests want them off
  // to insert orphan rows for migration coverage). Explicitly set in both
  // directions so test/dev environments where another path enabled FK don't
  // bleed state across re-opens.
  db.pragma(`foreign_keys = ${opts.foreignKeys === false ? "OFF" : "ON"}`);
  // Boot-time truncate — recovers WAL space leftover from a previous
  // process that crashed before its final checkpoint. Best-effort: if
  // another process has the WAL locked we just skip and rely on the
  // next normal checkpoint.
  if (!opts.skipBootTruncate) {
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch (err) {
      const label = opts.label ? `[SQLite:${opts.label}] ` : "[SQLite] ";
      console.warn(
        `${label}wal_checkpoint(TRUNCATE) skipped: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

/**
 * Run a TRUNCATE checkpoint on the given database. Best-effort — safe to
 * schedule periodically from a setInterval. Returns true on success.
 */
export function truncateWal(
  db: Database.Database,
  label?: string,
): boolean {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    return true;
  } catch (err) {
    const tag = label ? `[SQLite:${label}] ` : "[SQLite] ";
    console.warn(
      `${tag}periodic wal_checkpoint(TRUNCATE) failed: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}
