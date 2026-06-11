/**
 * CLI: run RAG + ClaimKit on every unrun eval case, sequentially.
 *
 * Usage:
 *   npx tsx src/eval/calibration/run-cli.ts
 *   npx tsx src/eval/calibration/run-cli.ts --limit 5
 *
 * Sequential by design — we want stable confidence measurements, not
 * speed. Progress prints to stdout.
 */

import { calibrationDatabase } from "./database";
import { runEvalCase } from "./runner";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let limit = Infinity;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit") {
      const n = parseInt(args[i + 1], 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    }
  }

  const unrun = calibrationDatabase.listUnrunCases();
  const todo = unrun.slice(0, limit);
  console.log(
    `${unrun.length} unrun cases total, processing ${todo.length}${limit < Infinity ? ` (--limit ${limit})` : ""}`,
  );

  let ok = 0;
  let err = 0;
  const startedAt = Date.now();
  for (let i = 0; i < todo.length; i++) {
    const c = todo[i];
    const caseStart = Date.now();
    try {
      const r = await runEvalCase(c.id);
      const ms = Date.now() - caseStart;
      const ragMsg = r.skippedRag
        ? "rag-skip"
        : r.ragRun?.errorMessage
          ? `rag-err`
          : "rag-ok";
      const ckMsg = r.skippedClaimkit
        ? "ck-skip"
        : r.claimkitRun?.errorMessage
          ? `ck-err`
          : "ck-ok";
      const ckConf =
        r.claimkitRun?.confidence != null
          ? r.claimkitRun.confidence.toFixed(3)
          : "—";
      console.log(
        `[${i + 1}/${todo.length}] ${ms}ms ${ragMsg} ${ckMsg} ckConf=${ckConf}  ${c.query.slice(0, 80)}`,
      );
      ok++;
    } catch (e) {
      err++;
      console.error(
        `[${i + 1}/${todo.length}] FAILED: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\nDone. ok=${ok} err=${err} elapsed=${totalSec}s`);
  process.exit(0);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
