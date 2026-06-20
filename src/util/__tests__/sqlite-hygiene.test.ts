import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { applyWalHygiene, truncateWal } from "../sqlite-hygiene";

describe("applyWalHygiene", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-hygiene-"));
    dbPath = path.join(tmpDir, "test.db");
  });

  afterEach(() => {
    if (db) {
      try {
        db.close();
      } catch {
        /* SQLite WAL may be briefly locked on Windows */
      }
      db = null;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("sets journal_mode = WAL", () => {
    db = new Database(dbPath);
    applyWalHygiene(db);
    const mode = db.pragma("journal_mode", { simple: true });
    expect(mode).toBe("wal");
  });

  it("sets wal_autocheckpoint to the requested page count", () => {
    db = new Database(dbPath);
    applyWalHygiene(db, { autoCheckpoint: 250 });
    const v = db.pragma("wal_autocheckpoint", { simple: true });
    expect(v).toBe(250);
  });

  it("defaults wal_autocheckpoint to 200", () => {
    db = new Database(dbPath);
    applyWalHygiene(db);
    const v = db.pragma("wal_autocheckpoint", { simple: true });
    expect(v).toBe(200);
  });

  it("enables foreign_keys by default", () => {
    db = new Database(dbPath);
    applyWalHygiene(db);
    const v = db.pragma("foreign_keys", { simple: true });
    expect(v).toBe(1);
  });

  it("can be configured to skip foreign_keys", () => {
    db = new Database(dbPath);
    applyWalHygiene(db, { foreignKeys: false });
    const v = db.pragma("foreign_keys", { simple: true });
    expect(v).toBe(0);
  });

  it("sets busy_timeout to the requested value", () => {
    db = new Database(dbPath);
    applyWalHygiene(db, { busyTimeoutMs: 1234 });
    const v = db.pragma("busy_timeout", { simple: true });
    expect(v).toBe(1234);
  });

  it("is idempotent across multiple calls", () => {
    db = new Database(dbPath);
    applyWalHygiene(db);
    applyWalHygiene(db);
    applyWalHygiene(db);
    expect(db.pragma("wal_autocheckpoint", { simple: true })).toBe(200);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("runs wal_checkpoint(TRUNCATE) at boot by default", () => {
    // Pre-populate a WAL by writing some rows.
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE t(id INTEGER); INSERT INTO t(id) VALUES (1), (2), (3);`);
    // Don't commit checkpoint manually — let applyWalHygiene do it.
    applyWalHygiene(db, { autoCheckpoint: 50000 }); // big threshold so commits below don't trigger another checkpoint
    // After hygiene + TRUNCATE the WAL file size should be 0 (or near-zero).
    // Note: on Windows it's reported by fs.stat as 0 after a truncate.
    const walPath = `${dbPath}-wal`;
    if (fs.existsSync(walPath)) {
      const size = fs.statSync(walPath).size;
      expect(size).toBeLessThanOrEqual(0);
    }
  });

  it("skipBootTruncate=true leaves the WAL alone", () => {
    db = new Database(dbPath);
    applyWalHygiene(db, { skipBootTruncate: true });
    // No assertion on WAL size — just verify it doesn't throw.
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  });
});

describe("truncateWal", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-hygiene-trunc-"));
    dbPath = path.join(tmpDir, "test.db");
  });

  afterEach(() => {
    if (db) {
      try {
        db.close();
      } catch {
        /* */
      }
      db = null;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  it("returns true on success", () => {
    db = new Database(dbPath);
    applyWalHygiene(db);
    expect(truncateWal(db)).toBe(true);
  });

  it("returns false (does not throw) when the DB is already closed", () => {
    db = new Database(dbPath);
    applyWalHygiene(db);
    db.close();
    expect(truncateWal(db, "test")).toBe(false);
    db = null; // already closed
  });
});
