/**
 * Report storage — on-disk layout + SQLite index.
 *
 * Each report lives in its own directory:
 *   data/profiles/<profile>/reports/<reportId>/
 *     manifest.json    — full ReportManifest
 *     report.md        — markdown
 *     report.docx      — Word
 *     report.pdf       — PDF (if puppeteer ran)
 *     report.html      — HTML
 *     charts/*.svg     — chart files referenced by all formats
 *
 * SQLite index lives at data/profiles/<profile>/reports.db with one row per
 * report — sessionId, template, formats, sizes, timestamps. Cheap LIST queries.
 *
 * Quotas:
 *   REPORTS_MAX_TOTAL_GB     — total disk cap, oldest evicted when exceeded
 *   REPORTS_MAX_SIZE_MB      — per-report cap
 *   REPORTS_RETENTION_DAYS   — 0 = forever
 */

import Database from "better-sqlite3";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { resolvePath } from "../config/env";
import { applyWalHygiene } from "../util/sqlite-hygiene";
import type {
  GenerateReportResult,
  RenderedFile,
  ReportFormat,
  ReportManifest,
} from "./types";

const STATE_BASE_SUBDIR = "reports";

function getBaseDir(): string {
  if (process.env.REPORTS_BASE_PATH) return process.env.REPORTS_BASE_PATH;
  if (process.env.VITEST) {
    const tmp = process.env.VITEST_TMP_REPORTS_DIR;
    if (tmp) return tmp;
  }
  return resolvePath(STATE_BASE_SUBDIR);
}

/** The root directory reports are stored under — same resolution rules as getBaseDir(). */
export function getReportsBaseDir(): string {
  return getBaseDir();
}

function getDbPath(): string {
  return path.join(getBaseDir(), "reports.db");
}

let _db: Database.Database | null = null;
let _dbPath: string | null = null;
function db(): Database.Database {
  const want = getDbPath();
  if (_db && _dbPath === want) return _db;
  if (_db) { try { _db.close(); } catch { /* non-fatal */ } }
  fs.mkdirSync(path.dirname(want), { recursive: true });
  _db = new Database(want);
  _dbPath = want;
  applyWalHygiene(_db, { label: "reports" });
  _db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      title TEXT NOT NULL,
      template TEXT NOT NULL,
      formats TEXT NOT NULL,
      directory TEXT NOT NULL,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      generated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reports_session ON reports(session_id);
    CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);
  `);
  return _db;
}

export function generateReportId(): string {
  // UUIDv4 — safe in URLs, no path traversal risk.
  return crypto.randomUUID();
}

export function getReportDirectory(reportId: string): string {
  // Validate to be defensive — callers should always pass our own IDs.
  if (!/^[a-f0-9-]+$/i.test(reportId)) {
    throw new Error(`Invalid reportId: ${reportId}`);
  }
  return path.join(getBaseDir(), reportId);
}

export interface SaveOptions {
  files: RenderedFile[];
  warnings: string[];
}

export function saveReport(
  reportId: string,
  manifest: ReportManifest,
  opts: SaveOptions,
): GenerateReportResult {
  const directory = getReportDirectory(reportId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
  const totalBytes = opts.files.reduce((s, f) => s + f.bytes, 0);
  const formats = opts.files.map((f) => f.format).join(",");
  db()
    .prepare(`INSERT INTO reports
      (id, session_id, title, template, formats, directory, total_bytes, generated_at, created_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      reportId,
      manifest.metadata.sessionId ?? null,
      manifest.metadata.title,
      manifest.metadata.template,
      formats,
      directory,
      totalBytes,
      manifest.metadata.generatedAt,
      new Date().toISOString(),
      JSON.stringify(manifest.metadata),
    );
  return {
    reportId,
    directory,
    metadata: manifest.metadata,
    files: opts.files,
    warnings: opts.warnings,
  };
}

export interface ListFilters {
  sessionId?: string;
  template?: string;
  limit?: number;
  offset?: number;
}

export interface ReportListEntry {
  id: string;
  sessionId: string | null;
  title: string;
  template: string;
  formats: ReportFormat[];
  totalBytes: number;
  generatedAt: string;
  createdAt: string;
}

export function listReports(filters: ListFilters = {}): ReportListEntry[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filters.sessionId) { where.push("session_id = ?"); args.push(filters.sessionId); }
  if (filters.template) { where.push("template = ?"); args.push(filters.template); }
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);
  const sql = `
    SELECT id, session_id, title, template, formats, total_bytes, generated_at, created_at
    FROM reports
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?`;
  const rows = db().prepare(sql).all(...args, limit, offset) as Array<{
    id: string;
    session_id: string | null;
    title: string;
    template: string;
    formats: string;
    total_bytes: number;
    generated_at: string;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    title: r.title,
    template: r.template,
    formats: r.formats.split(",").filter(Boolean) as ReportFormat[],
    totalBytes: r.total_bytes,
    generatedAt: r.generated_at,
    createdAt: r.created_at,
  }));
}

export function getReport(reportId: string): ReportListEntry | null {
  const row = db()
    .prepare(`SELECT id, session_id, title, template, formats, total_bytes, generated_at, created_at FROM reports WHERE id = ?`)
    .get(reportId) as {
      id: string;
      session_id: string | null;
      title: string;
      template: string;
      formats: string;
      total_bytes: number;
      generated_at: string;
      created_at: string;
    } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    template: row.template,
    formats: row.formats.split(",").filter(Boolean) as ReportFormat[],
    totalBytes: row.total_bytes,
    generatedAt: row.generated_at,
    createdAt: row.created_at,
  };
}

export function getReportManifest(reportId: string): ReportManifest | null {
  const directory = getReportDirectory(reportId);
  const manifestPath = path.join(directory, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ReportManifest;
  } catch {
    return null;
  }
}

export function getReportFilePath(reportId: string, format: ReportFormat): string | null {
  const directory = getReportDirectory(reportId);
  const filename =
    format === "markdown" ? "report.md" :
    format === "docx" ? "report.docx" :
    format === "html" ? "report.html" :
    format === "pdf" ? "report.pdf" : null;
  if (!filename) return null;
  const p = path.join(directory, filename);
  return fs.existsSync(p) ? p : null;
}

export function deleteReport(reportId: string): boolean {
  const entry = getReport(reportId);
  if (!entry) return false;
  const directory = getReportDirectory(reportId);
  try {
    if (fs.existsSync(directory)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  } catch {
    // Non-fatal — index entry still removed.
  }
  db().prepare(`DELETE FROM reports WHERE id = ?`).run(reportId);
  return true;
}

/**
 * Enforce REPORTS_MAX_TOTAL_GB by deleting oldest reports until under cap.
 * Also enforces REPORTS_RETENTION_DAYS — anything older than the cutoff is
 * removed.
 */
export function enforceQuota(): { deletedCount: number; freedBytes: number } {
  const maxGb = Number(process.env.REPORTS_MAX_TOTAL_GB ?? "5");
  const retentionDays = Number(process.env.REPORTS_RETENTION_DAYS ?? "30");
  let deletedCount = 0;
  let freedBytes = 0;

  if (retentionDays > 0) {
    const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
    const oldRows = db()
      .prepare(`SELECT id, total_bytes FROM reports WHERE created_at < ?`)
      .all(cutoff) as Array<{ id: string; total_bytes: number }>;
    for (const r of oldRows) {
      if (deleteReport(r.id)) {
        deletedCount++;
        freedBytes += r.total_bytes;
      }
    }
  }

  if (maxGb > 0) {
    const cap = maxGb * 1024 ** 3;
    let total = (db().prepare(`SELECT COALESCE(SUM(total_bytes),0) AS t FROM reports`).get() as { t: number }).t;
    if (total > cap) {
      const rows = db().prepare(`SELECT id, total_bytes FROM reports ORDER BY created_at ASC`).all() as Array<{ id: string; total_bytes: number }>;
      for (const r of rows) {
        if (total <= cap) break;
        if (deleteReport(r.id)) {
          deletedCount++;
          freedBytes += r.total_bytes;
          total -= r.total_bytes;
        }
      }
    }
  }

  return { deletedCount, freedBytes };
}

/** Test/maintenance hook — closes the open SQLite handle so a fresh path can be opened. */
export function _resetForTests(): void {
  if (_db) {
    try { _db.close(); } catch { /* non-fatal */ }
  }
  _db = null;
  _dbPath = null;
}
