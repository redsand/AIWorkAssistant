import { describe, it, expect, vi, beforeEach } from "vitest";
import { enforceMaxRange, todayRange, HawkIrService } from "../../../src/integrations/hawk-ir/hawk-ir-service";
import { HawkIrClient } from "../../../src/integrations/hawk-ir/hawk-ir-client";

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
