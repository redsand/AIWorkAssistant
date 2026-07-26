/**
 * Live verification of the HAWK IR cases integration after the API's
 * snake_case/pagination change. Exercises the real client + service:
 * getCases (windowed fetch), getCase (detail), getRiskyOpenCases (filters).
 * Prints normalized fields only — no secrets.
 * Usage: npx tsx scripts/test-hawk-cases.ts
 */
import { hawkIrService } from "../src/integrations/hawk-ir/hawk-ir-service";

async function main() {
  if (!hawkIrService.isConfigured()) {
    console.error("HAWK IR not configured");
    process.exit(1);
  }

  const t0 = Date.now();
  const cases = await hawkIrService.getRecentCases(5);
  console.log(`getRecentCases(5) → ${cases.length} in ${Date.now() - t0}ms`);
  for (const c of cases) {
    console.log(`  ${hawkIrService.formatCaseLabel(c)}`);
    console.log(`    rid=${c.rid} risk=${c.riskLevel} status=${c.progressStatus} firstSeen=${c.firstSeen} alerts=${c.alertNames.length} assets=${c.assets.length}`);
  }

  if (cases[0]) {
    const t1 = Date.now();
    const detail = await hawkIrService.getCase(cases[0].rid);
    console.log(`\ngetCase(${cases[0].rid}) → ${detail ? "ok" : "null"} in ${Date.now() - t1}ms`);
    if (detail) {
      console.log(`  events=${detail.events.length} notes=${detail.notes.length} escalated=${detail.escalated}`);
      const ev = detail.events[0];
      if (ev) console.log(`  event[0]: alertName=${JSON.stringify(ev.alertName)} eventId=${ev.eventId} dateAdded=${ev.dateAdded} blocked=${ev.blocked}`);
    }
  }

  const t2 = Date.now();
  const risky = await hawkIrService.getRiskyOpenCases({ minRiskLevel: "high", limit: 10 });
  console.log(`\ngetRiskyOpenCases(high, 10) → ${risky.length} in ${Date.now() - t2}ms`);
  for (const c of risky.slice(0, 5)) console.log(`  ${hawkIrService.formatCaseLabel(c)}`);

  console.log("\nall checks completed");
}

main().catch((err) => {
  console.error("FAILED:", err?.message ?? err);
  process.exit(1);
});
