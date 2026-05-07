import { describe, it, expect, vi, beforeEach } from "vitest";
import { enforceMaxRange, todayRange, HawkIrService } from "../../../src/integrations/hawk-ir/hawk-ir-service";
import { HawkIrClient } from "../../../src/integrations/hawk-ir/hawk-ir-client";
import type { HawkCase } from "../../../src/integrations/hawk-ir/types";

describe("HawkIrService helpers", () => {
  describe("todayRange", () => {
    it("returns start at midnight today", () => {
      const range = todayRange();
      const start = new Date(range.startDate);
      const now = new Date();

      expect(start.getFullYear()).toBe(now.getFullYear());
      expect(start.getMonth()).toBe(now.getMonth());
      expect(start.getDate()).toBe(now.getDate());
      expect(start.getHours()).toBe(0);
      expect(start.getMinutes()).toBe(0);
      expect(start.getSeconds()).toBe(0);
    });

    it("returns stop at current time", () => {
      const range = todayRange();
      const stop = new Date(range.stopDate);
      const now = new Date();

      expect(Math.abs(stop.getTime() - now.getTime())).toBeLessThan(5000);
    });
  });

  describe("enforceMaxRange", () => {
    it("allows ranges within 10 days", () => {
      const to = new Date("2025-06-15T12:00:00Z");
      const from = new Date("2025-06-10T12:00:00Z");

      const result = enforceMaxRange(from, to);
      expect(result.from).toBe(from.toISOString());
      expect(result.to).toBe(to.toISOString());
    });

    it("allows exactly 10 days", () => {
      const to = new Date("2025-06-15T12:00:00Z");
      const from = new Date("2025-06-05T12:00:00Z");

      const result = enforceMaxRange(from, to);
      expect(result.from).toBe(from.toISOString());
    });

    it("rejects ranges exceeding 10 days", () => {
      const to = new Date("2025-06-15T12:00:00Z");
      const from = new Date("2025-06-01T12:00:00Z"); // 14 days

      expect(() => enforceMaxRange(from, to)).toThrow("exceeds 10 days");
    });

    it("rejects 30-day ranges", () => {
      const to = new Date("2025-06-30T00:00:00Z");
      const from = new Date("2025-06-01T00:00:00Z");

      expect(() => enforceMaxRange(from, to)).toThrow("exceeds 10 days");
    });

    it("accepts string dates", () => {
      const result = enforceMaxRange(
        "2025-06-10T00:00:00Z",
        "2025-06-15T00:00:00Z",
      );
      expect(result.from).toContain("2025-06-10");
      expect(result.to).toContain("2025-06-15");
    });

    it("includes weekly/monthly suggestion in the error message", () => {
      try {
        enforceMaxRange("2025-05-01T00:00:00Z", "2025-06-01T00:00:00Z");
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as Error).message).toContain("weeklyReport() or monthlySummary()");
      }
    });
  });
});

describe("HawkIrService write operations", () => {
  let service: HawkIrService;
  let mockClient: HawkIrClient;

  beforeEach(() => {
    mockClient = {
      isConfigured: vi.fn().mockReturnValue(true),
      addCaseNote: vi.fn().mockResolvedValue({ status: true }),
      updateCaseStatus: vi.fn().mockResolvedValue({ status: true }),
      updateCaseRisk: vi.fn().mockResolvedValue({ status: true }),
      mergeCases: vi.fn().mockResolvedValue({ status: true }),
      renameCase: vi.fn().mockResolvedValue({ status: true }),
      updateCaseDetails: vi.fn().mockResolvedValue({ status: true }),
      setCaseCategories: vi.fn().mockResolvedValue({ status: true }),
      addIgnoreLabel: vi.fn().mockResolvedValue({ status: true }),
      deleteIgnoreLabel: vi.fn().mockResolvedValue({ status: true }),
      getCaseCategories: vi.fn().mockResolvedValue(["False Positive"]),
      getCaseLabels: vi.fn().mockResolvedValue({ categories: [], ignoreLabels: [] }),
    } as unknown as HawkIrClient;
    service = new HawkIrService(mockClient);
  });

  describe("addCaseNote", () => {
    it("should delegate to client.addCaseNote", async () => {
      await service.addCaseNote("#635:1069", "Linked to Jira MDR-1");
      expect(mockClient.addCaseNote).toHaveBeenCalledWith("#635:1069", "Linked to Jira MDR-1");
    });
  });

  describe("updateCaseStatus", () => {
    it("should normalize status and delegate to client", async () => {
      await service.updateCaseStatus("#635:1069", "in_progress");
      expect(mockClient.updateCaseStatus).toHaveBeenCalledWith("#635:1069", "In Progress");
    });

    it("should throw on invalid status", async () => {
      await expect(service.updateCaseStatus("#635:1069", "Invalid"))
        .rejects.toThrow("Invalid case status");
    });

    it("should accept all valid statuses", async () => {
      for (const status of ["New", "Open", "In Progress", "Closed", "Resolved"]) {
        await service.updateCaseStatus("#635:1069", status);
      }
      expect(mockClient.updateCaseStatus).toHaveBeenCalledTimes(5);
    });
  });

  describe("updateCaseRisk", () => {
    it("should map 'medium' to 'Moderate' and delegate to client", async () => {
      await service.updateCaseRisk("#635:1069", "medium");
      expect(mockClient.updateCaseRisk).toHaveBeenCalledWith("#635:1069", "Moderate");
    });

    it("should throw on invalid risk level", async () => {
      await expect(service.updateCaseRisk("#635:1069", "Extreme"))
        .rejects.toThrow("Invalid risk level");
    });

    it("should accept all valid risk levels", async () => {
      for (const level of ["Informational", "Low", "Moderate", "High", "Critical"]) {
        await service.updateCaseRisk("#635:1069", level);
      }
      expect(mockClient.updateCaseRisk).toHaveBeenCalledTimes(5);
    });
  });

  describe("P2 case management operations", () => {
    it("mergeCases validates distinct source and target", async () => {
      await service.mergeCases("#635:1068", "#635:1069");
      expect(mockClient.mergeCases).toHaveBeenCalledWith("#635:1068", "#635:1069");

      await expect(service.mergeCases("#635:1069", "635:1069"))
        .rejects.toThrow("must be different");
    });

    it("renameCase requires a non-empty name", async () => {
      await service.renameCase("#635:1069", "Java RCE Scanning");
      expect(mockClient.renameCase).toHaveBeenCalledWith("#635:1069", "Java RCE Scanning");

      await expect(service.renameCase("#635:1069", "  "))
        .rejects.toThrow("name is required");
    });

    it("updateCaseDetails requires non-empty details", async () => {
      await service.updateCaseDetails("#635:1069", "Confirmed scanner.");
      expect(mockClient.updateCaseDetails).toHaveBeenCalledWith("#635:1069", "Confirmed scanner.");

      await expect(service.updateCaseDetails("#635:1069", ""))
        .rejects.toThrow("details is required");
    });

    it("setCaseCategories normalizes and validates categories", async () => {
      await service.setCaseCategories("#635:1069", [" False Positive ", "Scanner"]);
      expect(mockClient.setCaseCategories).toHaveBeenCalledWith("#635:1069", ["False Positive", "Scanner"]);

      await expect(service.setCaseCategories("#635:1069", []))
        .rejects.toThrow("categories must be a non-empty array");
    });

    it("addIgnoreLabel trims label and optional category", async () => {
      await service.addIgnoreLabel(" tenable ", " scanner ");
      expect(mockClient.addIgnoreLabel).toHaveBeenCalledWith("tenable", "scanner");

      await expect(service.addIgnoreLabel(" "))
        .rejects.toThrow("label is required");
    });

    it("deleteIgnoreLabel trims and validates labelId", async () => {
      await service.deleteIgnoreLabel(" label-1 ");
      expect(mockClient.deleteIgnoreLabel).toHaveBeenCalledWith("label-1");

      await expect(service.deleteIgnoreLabel(""))
        .rejects.toThrow("labelId is required");
    });

    it("delegates read-only category and label discovery", async () => {
      await expect(service.getCaseCategories()).resolves.toEqual(["False Positive"]);
      await expect(service.getCaseLabels()).resolves.toEqual({ categories: [], ignoreLabels: [] });
    });
  });
});

describe("HawkIrService getRiskyOpenCases and getEscalatedCases", () => {
  let service: HawkIrService;
  let mockClient: HawkIrClient;

  const makeCase = (overrides: Partial<HawkCase> & Record<string, unknown> = {}): HawkCase => ({
    rid: overrides.rid ?? "#1",
    name: overrides.name ?? "Test Case",
    groupId: overrides.groupId ?? "default",
    riskLevel: overrides.riskLevel ?? "high",
    progressStatus: overrides.progressStatus ?? "open",
    category: overrides.category ?? null,
    owner: overrides.owner ?? null,
    ownerName: overrides.ownerName ?? null,
    escalated: overrides.escalated ?? false,
    escalationTicket: overrides.escalationTicket ?? null,
    escalationModule: overrides.escalationModule ?? null,
    escalationId: overrides.escalationId ?? null,
    escalationTimestamp: overrides.escalationTimestamp ?? null,
    firstSeen: overrides.firstSeen ?? "2026-05-01T00:00:00Z",
    lastSeen: overrides.lastSeen ?? "2026-05-07T00:00:00Z",
    ipSrcs: overrides.ipSrcs ?? [],
    ipDsts: overrides.ipDsts ?? [],
    alertNames: overrides.alertNames ?? [],
    analytics: overrides.analytics ?? [],
    summary: overrides.summary ?? null,
    rootCause: overrides.rootCause ?? null,
    feedback: overrides.feedback ?? null,
    feedbackDetails: overrides.feedbackDetails ?? null,
    actions: overrides.actions ?? [],
    notes: overrides.notes ?? [],
    events: overrides.events ?? [],
    linkedCount: overrides.linkedCount ?? 0,
    ...overrides,
  }) as HawkCase;

  beforeEach(() => {
    mockClient = {
      isConfigured: vi.fn().mockReturnValue(true),
      getCases: vi.fn(),
    } as unknown as HawkIrClient;
    service = new HawkIrService(mockClient);
  });

  describe("getRiskyOpenCases", () => {
    it("excludes escalated cases", async () => {
      (mockClient.getCases as any).mockResolvedValue([
        makeCase({ rid: "#1", name: "Escalated", riskLevel: "high", escalated: true }),
        makeCase({ rid: "#2", name: "Not Escalated", riskLevel: "high", escalated: false }),
      ]);
      const result = await service.getRiskyOpenCases({ minRiskLevel: "high" });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Not Escalated");
    });

    it("excludes closed and resolved cases", async () => {
      (mockClient.getCases as any).mockResolvedValue([
        makeCase({ rid: "#1", name: "Closed", riskLevel: "high", progressStatus: "closed" }),
        makeCase({ rid: "#2", name: "Resolved", riskLevel: "high", progressStatus: "resolved" }),
        makeCase({ rid: "#3", name: "Open", riskLevel: "high", progressStatus: "open" }),
      ]);
      const result = await service.getRiskyOpenCases({ minRiskLevel: "high" });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Open");
    });

    it("handles 'moderate' risk level from API", async () => {
      (mockClient.getCases as any).mockResolvedValue([
        makeCase({ rid: "#1", name: "Moderate Risk", riskLevel: "moderate", progressStatus: "open" }),
        makeCase({ rid: "#2", name: "Low Risk", riskLevel: "low", progressStatus: "open" }),
      ]);
      const result = await service.getRiskyOpenCases({ minRiskLevel: "moderate" });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Moderate Risk");
    });

    it("handles snake_case risk_level field", async () => {
      (mockClient.getCases as any).mockResolvedValue([
        makeCase({ rid: "#1", riskLevel: undefined, risk_level: "high", progressStatus: "open" }),
      ]);
      const result = await service.getRiskyOpenCases({ minRiskLevel: "high" });
      expect(result).toHaveLength(1);
    });

    it("handles escalated field as string 'true'", async () => {
      (mockClient.getCases as any).mockResolvedValue([
        makeCase({ rid: "#1", name: "String True", riskLevel: "high", escalated: "true" }),
        makeCase({ rid: "#2", name: "String False", riskLevel: "high", escalated: "false" }),
      ]);
      const result = await service.getRiskyOpenCases({ minRiskLevel: "high" });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("String False");
    });

    it("handles escalated field as number 1", async () => {
      (mockClient.getCases as any).mockResolvedValue([
        makeCase({ rid: "#1", name: "Number One", riskLevel: "high", escalated: 1 }),
        makeCase({ rid: "#2", name: "Number Zero", riskLevel: "high", escalated: 0 }),
      ]);
      const result = await service.getRiskyOpenCases({ minRiskLevel: "high" });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Number Zero");
    });

    it("sorts by risk level descending (critical first)", async () => {
      (mockClient.getCases as any).mockResolvedValue([
        makeCase({ rid: "#1", name: "High", riskLevel: "high", progressStatus: "open" }),
        makeCase({ rid: "#2", name: "Critical", riskLevel: "critical", progressStatus: "open" }),
        makeCase({ rid: "#3", name: "Medium", riskLevel: "medium", progressStatus: "open" }),
      ]);
      const result = await service.getRiskyOpenCases({ minRiskLevel: "medium" });
      expect(result[0].name).toBe("Critical");
      expect(result[1].name).toBe("High");
      expect(result[2].name).toBe("Medium");
    });
  });

  describe("getEscalatedCases", () => {
    it("returns only escalated cases", async () => {
      (mockClient.getCases as any).mockResolvedValue([
        makeCase({ rid: "#1", name: "Escalated", riskLevel: "high", escalated: true, progressStatus: "open" }),
        makeCase({ rid: "#2", name: "Not Escalated", riskLevel: "high", escalated: false, progressStatus: "open" }),
        makeCase({ rid: "#3", name: "Also Escalated", riskLevel: "critical", escalated: true, progressStatus: "in_progress" }),
      ]);
      const result = await service.getEscalatedCases();
      expect(result).toHaveLength(2);
      expect(result.every((c) => c.escalated === true)).toBe(true);
    });

    it("excludes closed and resolved escalated cases", async () => {
      (mockClient.getCases as any).mockResolvedValue([
        makeCase({ rid: "#1", name: "Escalated Open", escalated: true, progressStatus: "open" }),
        makeCase({ rid: "#2", name: "Escalated Closed", escalated: true, progressStatus: "closed" }),
        makeCase({ rid: "#3", name: "Escalated Resolved", escalated: true, progressStatus: "resolved" }),
      ]);
      const result = await service.getEscalatedCases();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Escalated Open");
    });

    it("handles escalated as string 'true'", async () => {
      (mockClient.getCases as any).mockResolvedValue([
        makeCase({ rid: "#1", name: "String True", riskLevel: "high", escalated: "true", progressStatus: "open" }),
        makeCase({ rid: "#2", name: "String One", riskLevel: "high", escalated: "1", progressStatus: "open" }),
      ]);
      const result = await service.getEscalatedCases();
      expect(result).toHaveLength(2);
    });

    it("handles escalated as number 1", async () => {
      (mockClient.getCases as any).mockResolvedValue([
        makeCase({ rid: "#1", name: "Number One", riskLevel: "high", escalated: 1, progressStatus: "open" }),
        makeCase({ rid: "#2", name: "Number Zero", riskLevel: "high", escalated: 0, progressStatus: "open" }),
      ]);
      const result = await service.getEscalatedCases();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Number One");
    });

    it("sorts by escalationTimestamp descending", async () => {
      (mockClient.getCases as any).mockResolvedValue([
        makeCase({ rid: "#1", name: "Earlier", escalated: true, progressStatus: "open", escalationTimestamp: "2026-05-01T00:00:00Z" }),
        makeCase({ rid: "#2", name: "Later", escalated: true, progressStatus: "open", escalationTimestamp: "2026-05-05T00:00:00Z" }),
      ]);
      const result = await service.getEscalatedCases();
      expect(result[0].name).toBe("Later");
      expect(result[1].name).toBe("Earlier");
    });

    it("returns all risk levels (not just high+)", async () => {
      (mockClient.getCases as any).mockResolvedValue([
        makeCase({ rid: "#1", name: "Low Escalated", riskLevel: "low", escalated: true, progressStatus: "open" }),
        makeCase({ rid: "#2", name: "Critical Escalated", riskLevel: "critical", escalated: true, progressStatus: "open" }),
      ]);
      const result = await service.getEscalatedCases();
      expect(result).toHaveLength(2);
    });
  });
});
