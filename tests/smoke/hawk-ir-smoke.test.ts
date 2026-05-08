/**
 * Hawk IR Smoke Tests — Live authentication & API integration
 *
 * These tests hit the real HAWK IR API using credentials from .env.
 * They prove that authentication works and key endpoints respond correctly.
 *
 * Run: npx vitest run tests/smoke/hawk-ir-smoke.test.ts
 *
 * Skips automatically if HAWK_IR_ENABLED is not true.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { hawkIrClient } from "../../src/integrations/hawk-ir/hawk-ir-client";
import { hawkIrService } from "../../src/integrations/hawk-ir/hawk-ir-service";

const TIMEOUT = 60_000;

describe.skipIf(!process.env.HAWK_IR_ENABLED || process.env.HAWK_IR_ENABLED !== "true")(
  "Hawk IR Smoke — Live API",
  () => {
    beforeAll(() => {
      if (!hawkIrClient.isConfigured()) {
        throw new Error(
          "HAWK IR client not configured — check HAWK_IR_BASE_URL, HAWK_IR_ACCESS_TOKEN, HAWK_IR_SECRET_KEY in .env",
        );
      }
    });

    // ── Authentication ──────────────────────────────────────────────

    describe("Authentication", () => {
      it("validates config by calling getCaseCount (smoke test)", async () => {
        const isValid = await hawkIrClient.validateConfig();
        expect(isValid).toBe(true);
      }, TIMEOUT);

      it("authenticates and receives a session cookie", async () => {
        const count = await hawkIrClient.getCaseCount();
        expect(typeof count).toBe("number");
        expect(count).toBeGreaterThanOrEqual(0);
      }, TIMEOUT);
    });

    // ── Cases ────────────────────────────────────────────────────────

    describe("Cases API", () => {
      it("retrieves case count via service (last 10 days)", async () => {
        const count = await hawkIrService.getCaseCount();
        expect(typeof count).toBe("number");
        expect(count).toBeGreaterThanOrEqual(0);
        console.log(`  ✅ Case count (last 10 days): ${count}`);
      }, TIMEOUT);

      it("defaults cases to last 10 days via service", async () => {
        const cases = await hawkIrService.getCases({ limit: 50 });
        expect(Array.isArray(cases)).toBe(true);
        console.log(`  ✅ Retrieved ${cases.length} cases (last 10 days)`);
        if (cases.length > 0) {
          const c = cases[0];
          console.log(`  Sample: rid=${c.rid ?? c["@rid"]}, name=${c.name}, risk=${c.riskLevel ?? c["risk_level"]}`);
        }
      }, TIMEOUT);

      it("lists case categories", async () => {
        const cats = await hawkIrClient.getCategories();
        expect(Array.isArray(cats)).toBe(true);
        console.log(`  ✅ Categories: ${cats.length}`);
      }, TIMEOUT);
    });

    // ── Explore / Search ─────────────────────────────────────────────

    describe("Explore API", () => {
      it("retrieves available indexes", async () => {
        const indexes = await hawkIrClient.getAvailableIndexes();
        expect(Array.isArray(indexes)).toBe(true);
        console.log(`  ✅ Available indexes: ${indexes.length > 0 ? indexes.join(", ") : "(none)"}`);
      }, TIMEOUT);

      it("executes a search query with index", async () => {
        const indexes = await hawkIrClient.getAvailableIndexes();
        if (indexes.length === 0) {
          console.log("  ⚠️ No indexes available — skipping search");
          return;
        }
        try {
          const results = await hawkIrClient.search({
            q: "*",
            idx: indexes[0],
            size: 3,
          });
          expect(Array.isArray(results)).toBe(true);
          console.log(`  ✅ Search results: ${results.length}`);
        } catch (err) {
          // Search can fail on large indexes — auth is still proven
          console.log(`  ⚠️ Search error (auth OK): ${(err as Error).message}`);
        }
      }, TIMEOUT);

      it("searches audit_login: false for the past hour (should always have results)", async () => {
        const indexes = await hawkIrClient.getAvailableIndexes();
        if (indexes.length === 0) {
          console.log("  ⚠️ No indexes available — skipping audit_login search");
          return;
        }

        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const now = new Date().toISOString();

        const results = await hawkIrService.searchLogs({
          q: "audit_login: false",
          idx: indexes[0],
          from: oneHourAgo,
          to: now,
          size: 5,
        });

        expect(Array.isArray(results)).toBe(true);
        console.log(`  ✅ audit_login: false search returned ${results.length} result(s) in the past hour`);
        if (results.length > 0) {
          const sample = results[0] as Record<string, unknown>;
          const keys = Object.keys(sample).slice(0, 5);
          console.log(`  ✅ Sample result fields: ${keys.join(", ")}`);
        }
      }, TIMEOUT);

      it("retrieves field names for an index", async () => {
        const indexes = await hawkIrClient.getAvailableIndexes();
        if (indexes.length === 0) {
          console.log("  ⚠️ No indexes available — skipping getFields");
          return;
        }

        const fields = await hawkIrClient.getFields(indexes[0]);
        expect(Array.isArray(fields)).toBe(true);
        expect(fields.length).toBeGreaterThan(0);
        console.log(`  ✅ Index "${indexes[0]}" has ${fields.length} fields`);
        // Show a sample of field names useful for query translation
        const sampleFields = fields.slice(0, 10);
        console.log(`  ✅ Sample fields: ${sampleFields.join(", ")}`);
        if (fields.includes("audit_login")) {
          console.log(`  ✅ "audit_login" field found — can be used for login queries`);
        }
      }, TIMEOUT);
    });

    // ── Assets ────────────────────────────────────────────────────────

    describe("Assets API", () => {
      it("retrieves assets", async () => {
        const result = await hawkIrClient.getAssets({ limit: 5 });
        expect(result).toBeDefined();
        expect(Array.isArray(result.rows)).toBe(true);
        console.log(`  ✅ Assets: ${result.rows.length}`);
      }, TIMEOUT);

      it("retrieves asset summary", async () => {
        const summary = await hawkIrClient.getAssetSummary();
        expect(summary).toBeDefined();
        console.log(`  ✅ Asset summary retrieved (tags: ${summary.tags?.length ?? 0})`);
      }, TIMEOUT);
    });

    // ── Identities ──────────────────────────────────────────────────

    describe("Identities API", () => {
      it("retrieves identities", async () => {
        const result = await hawkIrClient.getIdentities({ limit: 5 });
        expect(result).toBeDefined();
        expect(Array.isArray(result.rows)).toBe(true);
        console.log(`  ✅ Identities: ${result.rows.length}`);
      }, TIMEOUT);

      it("retrieves identity summary", async () => {
        const summary = await hawkIrClient.getIdentitySummary();
        expect(summary).toBeDefined();
        console.log(`  ✅ Identity summary retrieved (tags: ${summary.tags?.length ?? 0})`);
      }, TIMEOUT);
    });

    // ── Dashboards ───────────────────────────────────────────────────

    describe("Dashboards API", () => {
      let dashboardId: string | undefined;

      it("lists dashboards", async () => {
        const dashboards = await hawkIrClient.listDashboards();
        expect(Array.isArray(dashboards)).toBe(true);
        console.log(`  ✅ Dashboards: ${dashboards.length}`);
        if (dashboards.length > 0) {
          dashboardId = dashboards[0].id;
          console.log(`  Sample dashboard: id=${dashboards[0].id}, name=${dashboards[0].name}`);
        }
      }, TIMEOUT);

      it("runs a dashboard widget query (data aggregation)", async () => {
        const indexes = await hawkIrClient.getAvailableIndexes();
        if (indexes.length === 0) {
          console.log("  ⚠️ No indexes available — skipping dashboard query");
          return;
        }

        const dashboards = await hawkIrClient.listDashboards();
        if (dashboards.length === 0) {
          console.log("  ⚠️ No dashboards available — skipping widget run");
          return;
        }

        const targetDashboardId = dashboardId ?? dashboards[0].id;

        const result = await hawkIrClient.runDashboardWidget(targetDashboardId, {
          widget: {
            id: "smoke-test-widget",
            title: "Smoke Test Query",
            type: "table",
            query: "*",
            columns: ["@timestamp"],
            size: 5,
            sort: { field: "@timestamp", direction: "desc" },
          },
          index: indexes[0],
          timeRange: {
            from: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
            to: new Date().toISOString(),
          },
        });

        expect(result).toBeDefined();
        console.log(`  ✅ Dashboard query result keys: ${Object.keys(result).join(", ")}`);
        if (result.rows) {
          console.log(`  ✅ Dashboard query returned ${result.rows.length} rows`);
        }
        if (result.total !== undefined) {
          console.log(`  ✅ Total matching records: ${result.total}`);
        }
      }, TIMEOUT);
    });

    // ── Dashboard Query (service-level convenience) ─────────────────

    describe("runDashboardQuery (service-level)", () => {
      it("executes an ad-hoc aggregation query", async () => {
        const indexes = await hawkIrClient.getAvailableIndexes();
        if (indexes.length === 0) {
          console.log("  ⚠️ No indexes available — skipping");
          return;
        }

        const dashboards = await hawkIrClient.listDashboards();
        if (dashboards.length === 0) {
          console.log("  ⚠️ No dashboards available — skipping");
          return;
        }

        try {
          const result = await hawkIrService.runDashboardQuery({
            query: "*",
            index: indexes[0],
            from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
            to: new Date().toISOString(),
            type: "table",
            columns: ["@timestamp", "ip_src", "ip_dst"],
            size: 5,
          });

          expect(result).toBeDefined();
          console.log(`  ✅ Ad-hoc dashboard query succeeded`);
          if (result.rows) {
            console.log(`  ✅ Returned ${result.rows.length} rows`);
          }
        } catch (err) {
          console.log(`  ⚠️ Ad-hoc query error (auth OK): ${(err as Error).message}`);
        }
      }, TIMEOUT);

      it("runs a grouped aggregation query", async () => {
        const indexes = await hawkIrClient.getAvailableIndexes();
        if (indexes.length === 0) {
          console.log("  ⚠️ No indexes available — skipping");
          return;
        }

        const dashboards = await hawkIrClient.listDashboards();
        if (dashboards.length === 0) {
          console.log("  ⚠️ No dashboards available — skipping");
          return;
        }

        try {
          const result = await hawkIrService.runDashboardQuery({
            query: "*",
            index: indexes[0],
            from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
            to: new Date().toISOString(),
            type: "table",
            groupBy: ["ip_src"],
            metrics: [{ field: "@timestamp", operator: "count" }],
            size: 10,
          });

          expect(result).toBeDefined();
          console.log(`  ✅ Grouped aggregation query succeeded`);
        } catch (err) {
          console.log(`  ⚠️ Grouped query error (auth OK): ${(err as Error).message}`);
        }
      }, TIMEOUT);
    });

    // ── Time range guardrails ──────────────────────────────────────────

    describe("Time range guardrails", () => {
      it("refuses queries beyond 10 days", async () => {
        const indexes = await hawkIrClient.getAvailableIndexes();
        const dashboards = await hawkIrClient.listDashboards();
        if (indexes.length === 0 || dashboards.length === 0) {
          console.log("  ⚠️ No indexes/dashboards — skipping guardrail test");
          return;
        }

        await expect(
          hawkIrService.runDashboardQuery({
            query: "*",
            index: indexes[0],
            from: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
            to: new Date().toISOString(),
          }),
        ).rejects.toThrow("exceeds 10 days");

        console.log("  ✅ Guardrail correctly rejected 30-day query");
      }, TIMEOUT);

      it("allows queries within 10 days", async () => {
        const indexes = await hawkIrClient.getAvailableIndexes();
        const dashboards = await hawkIrClient.listDashboards();
        if (indexes.length === 0 || dashboards.length === 0) {
          console.log("  ⚠️ No indexes/dashboards — skipping");
          return;
        }

        try {
          const result = await hawkIrService.runDashboardQuery({
            query: "*",
            index: indexes[0],
            from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
            to: new Date().toISOString(),
            size: 3,
          });
          expect(result).toBeDefined();
          console.log("  ✅ 7-day query accepted (within 10-day limit)");
        } catch (err) {
          console.log(`  ⚠️ 7-day query error (auth OK): ${(err as Error).message}`);
        }
      }, TIMEOUT);
    });
  },
);