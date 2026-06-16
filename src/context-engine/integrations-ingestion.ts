import { claimKitAdapter } from "./adapters/claimkit-adapter";
import { ingestedIds, hashContent } from "./claimkit-ingestion";
import { tenableCloudService } from "../integrations/tenable-cloud/tenable-cloud-service";
import { jiraClient } from "../integrations/jira/jira-client";
import { hawkIrService } from "../integrations/hawk-ir/hawk-ir-service";

export interface IntegrationIngestionStats {
  source: string;
  ingested: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

function makeKey(source: string, id: string): string {
  return `${source}:${id}`;
}

async function ingestIfNew(
  source: string,
  id: string,
  title: string,
  content: string,
  metadata: Record<string, unknown>,
): Promise<boolean> {
  const key = makeKey(source, id);
  const updatedAt = typeof metadata.updated === "string" ? metadata.updated : undefined;
  const hash = hashContent(content);
  if (!ingestedIds.hasChanged(key, hash, updatedAt)) return false;
  if (!claimKitAdapter.isAvailable()) return false;

  try {
    await claimKitAdapter.ingest(content, {
      title,
      source,
      trustTier: "curated",
      ...metadata,
    });
    ingestedIds.add(key, hash, updatedAt);
    return true;
  } catch (err) {
    console.warn(`[IntegrationIngestion] Failed to ingest ${key}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

// ── Tenable ─────────────────────────────────────────────────────────────────

export async function ingestTenableData(): Promise<IntegrationIngestionStats> {
  const start = Date.now();
  const stats: IntegrationIngestionStats = { source: "tenable", ingested: 0, skipped: 0, errors: 0, durationMs: 0 };

  if (!tenableCloudService.isConfigured()) {
    console.log("[IntegrationIngestion] Tenable not configured, skipping");
    return stats;
  }

  try {
    // Ingest workbench assets with vulnerability summaries
    const assets = await tenableCloudService.listWorkbenchAssets({ num_assets: 100 });
    for (const asset of assets) {
      const id = asset.id;
      const text = [
        `Asset: ${(asset.hostname ?? []).join(", ") || id}`,
        `Type: ${(asset.device_type ?? []).join(", ") || "unknown"}`,
        `OS: ${(asset.operating_system ?? []).join(", ") || "unknown"}`,
        `Exposure Score: ${asset.exposure_score ?? "N/A"}`,
        `Severities: ${(asset.severities ?? []).map((s) => `${s.name}=${s.count}`).join(", ") || "none"}`,
        `Last Seen: ${asset.last_seen ?? "N/A"}`,
        `FQDN: ${(asset.fqdn ?? []).join(", ") || "N/A"}`,
        `IPv4: ${(asset.ipv4 ?? []).join(", ") || "N/A"}`,
      ].join("\n");

      const ok = await ingestIfNew("tenable", `asset-${id}`, `Tenable Asset ${id}`, text, {
        entityId: id,
        entityType: "asset",
        exposureScore: asset.exposure_score,
      });
      if (ok) stats.ingested++; else stats.skipped++;
    }
  } catch (err) {
    stats.errors++;
    console.warn("[IntegrationIngestion] Tenable assets failed:", err instanceof Error ? err.message : err);
  }

  try {
    // Ingest recent scan summaries
    const scans = await tenableCloudService.listScans({ folder_id: 0 });
    for (const scan of scans.slice(0, 20)) {
      const text = [
        `Scan: ${scan.name ?? "unnamed"}`,
        `Status: ${scan.status ?? "unknown"}`,
        `Type: ${scan.type ?? "unknown"}`,
        `Owner: ${scan.owner ?? "N/A"}`,
        `Enabled: ${scan.enabled}`,
        `Start Time: ${scan.starttime ?? "N/A"}`,
      ].join("\n");

      const ok = await ingestIfNew("tenable", `scan-${scan.id}`, `Tenable Scan ${scan.name ?? scan.id}`, text, {
        entityId: String(scan.id),
        entityType: "scan",
        scanStatus: scan.status,
      });
      if (ok) stats.ingested++; else stats.skipped++;
    }
  } catch (err) {
    stats.errors++;
    console.warn("[IntegrationIngestion] Tenable scans failed:", err instanceof Error ? err.message : err);
  }

  try {
    // Ingest recent vulnerabilities (top 50)
    const vulns = await tenableCloudService.listVulnerabilities({ num_assets: 50 });
    for (const vuln of vulns.slice(0, 50)) {
      const id = vuln.plugin.id;
      const text = [
        `Vulnerability: ${vuln.plugin.name}`,
        `Severity: ${vuln.severity ?? "unknown"}`,
        `Plugin Family: ${vuln.plugin.family ?? "N/A"}`,
        `CVE: ${(vuln.plugin.cve ?? []).join(", ") || "N/A"}`,
        `Asset: ${vuln.asset.hostname || vuln.asset.id}`,
        `Description: ${(vuln.plugin.description ?? "N/A").slice(0, 500)}`,
      ].join("\n");

      const ok = await ingestIfNew("tenable", `vuln-${id}`, `Tenable Vuln ${vuln.plugin.name}`, text, {
        entityId: String(id),
        entityType: "vulnerability",
        severity: vuln.severity,
      });
      if (ok) stats.ingested++; else stats.skipped++;
    }
  } catch (err) {
    stats.errors++;
    console.warn("[IntegrationIngestion] Tenable vulnerabilities failed:", err instanceof Error ? err.message : err);
  }

  stats.durationMs = Date.now() - start;
  console.log(`[IntegrationIngestion] Tenable: ${stats.ingested} ingested, ${stats.skipped} skipped, ${stats.errors} errors in ${stats.durationMs}ms`);
  return stats;
}

// ── Jira ────────────────────────────────────────────────────────────────────

export async function ingestJiraData(): Promise<IntegrationIngestionStats> {
  const start = Date.now();
  const stats: IntegrationIngestionStats = { source: "jira", ingested: 0, skipped: 0, errors: 0, durationMs: 0 };

  if (!jiraClient.isConfigured()) {
    console.log("[IntegrationIngestion] Jira not configured, skipping");
    return stats;
  }

  try {
    // Ingest recent issues from the last 30 days across all accessible projects
    const jql = `updated >= -30d ORDER BY updated DESC`;
    const issues = await jiraClient.searchIssues(jql, 100);

    for (const issue of issues) {
      const key = issue.key as string;
      const summary = (issue.fields?.summary as string) ?? "No summary";
      const status = (issue.fields?.status?.name as string) ?? "Unknown";
      const priority = (issue.fields?.priority?.name as string) ?? "Unknown";
      const assignee = (issue.fields?.assignee?.displayName as string) ?? "Unassigned";
      const issueType = (issue.fields?.issuetype?.name as string) ?? "Issue";
      const project = (issue.fields?.project?.key as string) ?? "";
      const created = (issue.fields?.created as string) ?? "";
      const updated = (issue.fields?.updated as string) ?? "";
      const labels = ((issue.fields as any).labels as string[]) ?? [];

      const text = [
        `Issue: ${key} — ${summary}`,
        `Project: ${project}`,
        `Type: ${issueType}`,
        `Status: ${status}`,
        `Priority: ${priority}`,
        `Assignee: ${assignee}`,
        `Created: ${created}`,
        `Updated: ${updated}`,
        `Labels: ${labels.join(", ") || "none"}`,
      ].join("\n");

      const ok = await ingestIfNew("jira", key, `Jira Issue ${key}`, text, {
        entityId: key,
        entityType: "jira_issue",
        project,
        status,
        priority,
        assignee,
        issueType,
        created,
        updated,
        labels,
      });
      if (ok) stats.ingested++; else stats.skipped++;
    }
  } catch (err) {
    stats.errors++;
    console.warn("[IntegrationIngestion] Jira issues failed:", err instanceof Error ? err.message : err);
  }

  stats.durationMs = Date.now() - start;
  console.log(`[IntegrationIngestion] Jira: ${stats.ingested} ingested, ${stats.skipped} skipped, ${stats.errors} errors in ${stats.durationMs}ms`);
  return stats;
}

// ── HAWK IR ─────────────────────────────────────────────────────────────────

export async function ingestHawkIRData(): Promise<IntegrationIngestionStats> {
  const start = Date.now();
  const stats: IntegrationIngestionStats = { source: "hawk-ir", ingested: 0, skipped: 0, errors: 0, durationMs: 0 };

  if (!hawkIrService.isConfigured()) {
    console.log("[IntegrationIngestion] HAWK IR not configured, skipping");
    return stats;
  }

  try {
    // Ingest recent cases (last 10 days)
    const cases = await hawkIrService.getCases({ limit: 100 });
    for (const c of cases) {
      const caseId = c.rid;
      const title = c.name ?? `Case ${caseId}`;
      const riskLevel = String(c.riskLevel ?? "low");
      const status = String(c.progressStatus ?? "unknown");
      const escalated = !!c.escalated;
      const firstSeen = String(c.firstSeen ?? "");
      const lastSeen = String(c.lastSeen ?? "");

      const text = [
        `Case: ${title}`,
        `ID: ${caseId}`,
        `Risk Level: ${riskLevel}`,
        `Status: ${status}`,
        `Escalated: ${escalated}`,
        `First Seen: ${firstSeen}`,
        `Last Seen: ${lastSeen}`,
        `Summary: ${(c.summary ?? "").slice(0, 400)}`,
      ].join("\n");

      const ok = await ingestIfNew("hawk-ir", `case-${caseId}`, `HAWK IR Case ${title}`, text, {
        entityId: caseId,
        entityType: "incident",
        riskLevel,
        status,
        escalated,
      });
      if (ok) stats.ingested++; else stats.skipped++;
    }
  } catch (err) {
    stats.errors++;
    console.warn("[IntegrationIngestion] HAWK IR cases failed:", err instanceof Error ? err.message : err);
  }

  try {
    // Ingest risky open cases as a separate summary document
    const risky = await hawkIrService.getRiskyOpenCases({ limit: 25 });
    if (risky.length > 0) {
      const summaryLines = risky.map((c) => {
        const id = c.rid;
        const title = c.name ?? `Case ${id}`;
        const risk = String(c.riskLevel ?? "low");
        return `- ${title} (risk=${risk}, id=${id})`;
      });

      const text = [
        "HAWK IR Risky Open Cases Summary",
        `Total: ${risky.length}`,
        "",
        ...summaryLines,
      ].join("\n");

      const ok = await ingestIfNew("hawk-ir", "risky-summary", "HAWK IR Risky Open Cases Summary", text, {
        entityType: "summary",
        summaryType: "risky_open_cases",
        count: risky.length,
      });
      if (ok) stats.ingested++; else stats.skipped++;
    }
  } catch (err) {
    stats.errors++;
    console.warn("[IntegrationIngestion] HAWK IR risky cases failed:", err instanceof Error ? err.message : err);
  }

  stats.durationMs = Date.now() - start;
  console.log(`[IntegrationIngestion] HAWK IR: ${stats.ingested} ingested, ${stats.skipped} skipped, ${stats.errors} errors in ${stats.durationMs}ms`);
  return stats;
}

// ── Orchestrator ──────────────────────────────────────────────────────────

export async function ingestAllIntegrations(): Promise<IntegrationIngestionStats[]> {
  const results = await Promise.all([
    ingestTenableData(),
    ingestJiraData(),
    ingestHawkIRData(),
  ]);

  const totalIngested = results.reduce((s, r) => s + r.ingested, 0);
  const totalErrors = results.reduce((s, r) => s + r.errors, 0);
  console.log(`[IntegrationIngestion] Complete: ${totalIngested} total items ingested, ${totalErrors} errors`);

  return results;
}
