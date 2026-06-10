import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/context-engine/adapters/claimkit-adapter", () => ({
  claimKitAdapter: {
    isAvailable: vi.fn(),
    ingest: vi.fn(),
  },
}));

vi.mock("../../../src/integrations/tenable-cloud/tenable-cloud-service", () => ({
  tenableCloudService: {
    isConfigured: vi.fn(),
    listWorkbenchAssets: vi.fn(),
    listScans: vi.fn(),
    listVulnerabilities: vi.fn(),
  },
}));

vi.mock("../../../src/integrations/jira/jira-client", () => ({
  jiraClient: {
    isConfigured: vi.fn(),
    searchIssues: vi.fn(),
  },
}));

vi.mock("../../../src/integrations/hawk-ir/hawk-ir-service", () => ({
  hawkIrService: {
    isConfigured: vi.fn(),
    getCases: vi.fn(),
    getRiskyOpenCases: vi.fn(),
  },
}));

import { claimKitAdapter } from "../../../src/context-engine/adapters/claimkit-adapter";
import { tenableCloudService } from "../../../src/integrations/tenable-cloud/tenable-cloud-service";
import { jiraClient } from "../../../src/integrations/jira/jira-client";
import { hawkIrService } from "../../../src/integrations/hawk-ir/hawk-ir-service";
import {
  ingestTenableData,
  ingestJiraData,
  ingestHawkIRData,
  ingestAllIntegrations,
} from "../../../src/context-engine/integrations-ingestion";

describe("Integration Ingestion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claimKitAdapter.isAvailable).mockReturnValue(true);
    vi.mocked(claimKitAdapter.ingest).mockResolvedValue({ sourceId: "s-test" });
  });

  describe("ingestTenableData", () => {
    it("skips when Tenable is not configured", async () => {
      vi.mocked(tenableCloudService.isConfigured).mockReturnValue(false);
      const stats = await ingestTenableData();
      expect(stats.ingested).toBe(0);
      expect(stats.skipped).toBe(0);
      expect(stats.errors).toBe(0);
      expect(claimKitAdapter.ingest).not.toHaveBeenCalled();
    });

    it("ingests assets when configured", async () => {
      vi.mocked(tenableCloudService.isConfigured).mockReturnValue(true);
      vi.mocked(tenableCloudService.listWorkbenchAssets).mockResolvedValue([
        {
          id: "asset-1",
          hostname: ["web-01"],
          device_type: ["server"],
          operating_system: ["Ubuntu 22.04"],
          exposure_score: 42,
          severities: [{ name: "Critical", count: 1 }],
          last_seen: "2026-06-01",
          fqdn: ["web-01.local"],
          ipv4: ["10.0.0.1"],
        },
      ]);
      vi.mocked(tenableCloudService.listScans).mockResolvedValue([]);
      vi.mocked(tenableCloudService.listVulnerabilities).mockResolvedValue([]);

      const stats = await ingestTenableData();
      expect(stats.ingested).toBe(1);
      expect(stats.errors).toBe(0);
      expect(claimKitAdapter.ingest).toHaveBeenCalledTimes(1);
      const call = vi.mocked(claimKitAdapter.ingest).mock.calls[0];
      expect(call![1]).toMatchObject({ source: "tenable", trustTier: "curated" });
    });

    it("handles asset ingestion errors gracefully", async () => {
      vi.mocked(tenableCloudService.isConfigured).mockReturnValue(true);
      vi.mocked(tenableCloudService.listWorkbenchAssets).mockRejectedValue(new Error("API down"));
      vi.mocked(tenableCloudService.listScans).mockResolvedValue([]);
      vi.mocked(tenableCloudService.listVulnerabilities).mockResolvedValue([]);

      const stats = await ingestTenableData();
      expect(stats.ingested).toBe(0);
      expect(stats.errors).toBe(1);
    });

    it("deduplicates assets by key", async () => {
      vi.mocked(tenableCloudService.isConfigured).mockReturnValue(true);
      vi.mocked(tenableCloudService.listWorkbenchAssets).mockResolvedValue([
        { id: "asset-dedup", hostname: ["web-dedup"], device_type: [], operating_system: [], exposure_score: 0, severities: [], last_seen: "", fqdn: [], ipv4: [] },
        { id: "asset-dedup", hostname: ["web-dedup"], device_type: [], operating_system: [], exposure_score: 0, severities: [], last_seen: "", fqdn: [], ipv4: [] },
      ]);
      vi.mocked(tenableCloudService.listScans).mockResolvedValue([]);
      vi.mocked(tenableCloudService.listVulnerabilities).mockResolvedValue([]);

      const stats = await ingestTenableData();
      expect(stats.ingested).toBe(1);
      expect(stats.skipped).toBe(1);
    });
  });

  describe("ingestJiraData", () => {
    it("skips when Jira is not configured", async () => {
      vi.mocked(jiraClient.isConfigured).mockReturnValue(false);
      const stats = await ingestJiraData();
      expect(stats.ingested).toBe(0);
      expect(claimKitAdapter.ingest).not.toHaveBeenCalled();
    });

    it("ingests issues when configured", async () => {
      vi.mocked(jiraClient.isConfigured).mockReturnValue(true);
      vi.mocked(jiraClient.searchIssues).mockResolvedValue([
        {
          key: "PROJ-123",
          fields: {
            summary: "Fix login bug",
            status: { name: "In Progress" },
            priority: { name: "High" },
            assignee: { displayName: "Alice" },
            issuetype: { name: "Bug" },
            project: { key: "PROJ" },
            created: "2026-06-01T00:00:00Z",
            updated: "2026-06-02T00:00:00Z",
            labels: ["frontend", "urgent"],
          },
        },
      ]);

      const stats = await ingestJiraData();
      expect(stats.ingested).toBe(1);
      expect(claimKitAdapter.ingest).toHaveBeenCalledTimes(1);
      const call = vi.mocked(claimKitAdapter.ingest).mock.calls[0];
      expect(call![1]).toMatchObject({ source: "jira", trustTier: "curated" });
    });

    it("handles Jira API errors gracefully", async () => {
      vi.mocked(jiraClient.isConfigured).mockReturnValue(true);
      vi.mocked(jiraClient.searchIssues).mockRejectedValue(new Error("timeout"));
      const stats = await ingestJiraData();
      expect(stats.ingested).toBe(0);
      expect(stats.errors).toBe(1);
    });
  });

  describe("ingestHawkIRData", () => {
    it("skips when HAWK IR is not configured", async () => {
      vi.mocked(hawkIrService.isConfigured).mockReturnValue(false);
      const stats = await ingestHawkIRData();
      expect(stats.ingested).toBe(0);
      expect(claimKitAdapter.ingest).not.toHaveBeenCalled();
    });

    it("ingests cases and risky summary when configured", async () => {
      vi.mocked(hawkIrService.isConfigured).mockReturnValue(true);
      vi.mocked(hawkIrService.getCases).mockResolvedValue([
        { rid: "case-1", name: "Phishing alert", riskLevel: 3, progressStatus: "open", escalated: true, firstSeen: "2026-06-01", lastSeen: "2026-06-02", summary: "Suspicious email" },
      ]);
      vi.mocked(hawkIrService.getRiskyOpenCases).mockResolvedValue([
        { rid: "case-1", name: "Phishing alert", riskLevel: 3 },
      ]);

      const stats = await ingestHawkIRData();
      expect(stats.ingested).toBe(2); // one case + one summary
      expect(claimKitAdapter.ingest).toHaveBeenCalledTimes(2);
    });

    it("handles HAWK IR API errors gracefully", async () => {
      vi.mocked(hawkIrService.isConfigured).mockReturnValue(true);
      vi.mocked(hawkIrService.getCases).mockRejectedValue(new Error("timeout"));
      vi.mocked(hawkIrService.getRiskyOpenCases).mockResolvedValue([]);
      const stats = await ingestHawkIRData();
      expect(stats.ingested).toBe(0);
      expect(stats.errors).toBe(1);
    });
  });

  describe("ingestAllIntegrations", () => {
    it("runs all three integrations and returns aggregated stats", async () => {
      vi.mocked(tenableCloudService.isConfigured).mockReturnValue(false);
      vi.mocked(jiraClient.isConfigured).mockReturnValue(false);
      vi.mocked(hawkIrService.isConfigured).mockReturnValue(false);

      const results = await ingestAllIntegrations();
      expect(results).toHaveLength(3);
      expect(results[0]!.source).toBe("tenable");
      expect(results[1]!.source).toBe("jira");
      expect(results[2]!.source).toBe("hawk-ir");
    });
  });
});
