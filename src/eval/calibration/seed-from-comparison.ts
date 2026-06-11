/**
 * One-shot seeder: mine real production queries out of
 * data/comparison-runs.db and add them to the calibration eval set.
 *
 * Filters out chat-flow noise (one-word continuations, "test", PS
 * command pastes) and maps the source `category` field to our
 * EVAL_SEGMENTS taxonomy. Imperfect by design — the UI lets you
 * delete cases that don't belong.
 *
 * Usage:
 *   npx tsx src/eval/calibration/seed-from-comparison.ts --dry-run
 *   npx tsx src/eval/calibration/seed-from-comparison.ts --apply
 */

import Database from "better-sqlite3";
import path from "path";
import { calibrationDatabase, type EvalSegment } from "./database";

const TRASH = /^(test|query \d+|continue|go|yes|no|ok|hi|hello|can you continue|keep going|.)$/i;

function isJunkPrefix(q: string): boolean {
  return q.startsWith("PS C:") || q.startsWith("#") || q.startsWith("//");
}

function mapSegment(category: string | null, query: string): EvalSegment {
  const q = query.toLowerCase();
  // Heuristic re-segmentation for queries that the source mislabels as direct_fact
  if (/\b(stream|real[- ]?time|incident|hawk|soar|escalat|contain|block)/i.test(q)) {
    return "streaming";
  }
  switch (category) {
    case "entity_linking":
      return "entity_lookup";
    case "staleness":
      return "supersession";
    case "citation_laundering":
      return "conflict";
    case "code_retrieval":
    case "planning_synthesis":
      return "other";
    case "direct_fact":
      return "direct_fact";
    default:
      return "other";
  }
}

interface CandidateRow {
  query: string;
  category: string | null;
}

function loadCandidates(dbPath: string): CandidateRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT query, category
         FROM comparison_cases
         WHERE query IS NOT NULL`,
      )
      .all() as CandidateRow[];
    return rows.filter((r) => {
      const q = (r.query || "").trim();
      if (q.length < 25) return false;
      if (TRASH.test(q)) return false;
      if (isJunkPrefix(q)) return false;
      return true;
    });
  } finally {
    db.close();
  }
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const apply = args.has("--apply");
  const dryRun = args.has("--dry-run") || !apply;
  const sourcePath = path.resolve(process.cwd(), "data/comparison-runs.db");

  const candidates = loadCandidates(sourcePath);
  console.log(`Found ${candidates.length} candidate queries`);

  // Skip cases that already exist (by exact query string) so the
  // seeder is idempotent — running --apply twice doesn't double-import.
  const existingQueries = new Set(
    calibrationDatabase.listCases().map((c) => c.query),
  );
  const fresh = candidates.filter((c) => !existingQueries.has(c.query.trim()));
  console.log(
    `${fresh.length} new (after deduping against ${existingQueries.size} existing eval cases)`,
  );

  const planned: Array<{ query: string; segment: EvalSegment; source: string | null }> = [];
  for (const c of fresh) {
    const segment = mapSegment(c.category, c.query);
    planned.push({ query: c.query.trim(), segment, source: c.category });
  }

  const segCounts: Record<string, number> = {};
  for (const p of planned) segCounts[p.segment] = (segCounts[p.segment] ?? 0) + 1;
  console.log("Proposed segment distribution:");
  for (const [seg, n] of Object.entries(segCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${seg}: ${n}`);
  }

  console.log("\nFirst 10 proposed cases:");
  for (const p of planned.slice(0, 10)) {
    console.log(
      `  [${p.segment}] (was ${p.source ?? "(null)"}) ${p.query.slice(0, 120)}`,
    );
  }

  if (dryRun) {
    console.log("\n--dry-run: no writes. Re-run with --apply to import.");
    return;
  }

  let inserted = 0;
  for (const p of planned) {
    calibrationDatabase.addCase({
      query: p.query,
      segment: p.segment,
      notes: `seeded from comparison_cases (source category: ${p.source ?? "null"})`,
    });
    inserted++;
  }
  console.log(`\nInserted ${inserted} cases into eval-calibration.db`);
}

main();
