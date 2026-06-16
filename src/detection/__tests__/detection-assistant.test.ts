import { describe, it, expect, vi, beforeEach } from "vitest";
import { DetectionAssistant } from "../detection-assistant";
import type { DetectionIdeaOutput, DetectionWorkItemInput } from "../types";

const { mockCreateWorkItem, mockAuditLog } = vi.hoisted(() => ({
  mockCreateWorkItem: vi.fn(),
  mockAuditLog: vi.fn(),
}));

vi.mock("../../work-items/database", () => ({
  workItemDatabase: {
    createWorkItem: mockCreateWorkItem,
  },
}));

vi.mock("../../audit/logger", () => ({
  auditLogger: {
    log: mockAuditLog,
  },
}));

function makeIdea(): DetectionIdeaOutput {
  return {
    summary: "Detection idea for OAuth Abuse",
    hypothesis: "If OAuth abuse, then an adversary...",
    dataSources: ["logs"],
    candidateLogic: "event where oauth abuse",
    mitreMapping: [{ technique: "T1528", tactic: "Credential Access" }],
    falsePositiveConsiderations: [],
    testCases: [
      {
        name: "OAuth Abuse - True Positive",
        description: "Verify detection fires",
        type: "true_positive",
      },
    ],
    validationPlan: [],
    rolloutNotes: [],
    workItems: [
      {
        title: "Implement detection: OAuth Abuse",
        type: "detection",
        priority: "high",
        description: "Implement detection for OAuth Abuse",
      },
      {
        title: "Write tests for detection: OAuth Abuse",
        type: "detection",
        priority: "medium",
        description: "Create test cases",
      },
    ],
    draftFormats: [],
  };
}

describe("DetectionAssistant", () => {
  let assistant: DetectionAssistant;

  beforeEach(() => {
    assistant = new DetectionAssistant();
    mockCreateWorkItem.mockReset();
    mockAuditLog.mockReset();
    mockAuditLog.mockResolvedValue(undefined);
  });

  describe("mapToMitre", () => {
    it("returns the explicitly provided tactic value", async () => {
      const result = await assistant.mapToMitre({
        technique: "T1528",
        name: "Application Access Token",
        tactic: "Credential Access",
      });

      expect(result.techniques).toHaveLength(1);
      expect(result.techniques[0].id).toBe("T1528");
      expect(result.techniques[0].tactic).toBe("Credential Access");
    });

    it("falls back to Unknown when no tactic is provided", async () => {
      const result = await assistant.mapToMitre({
        technique: "T1528",
        name: "Application Access Token",
      });

      expect(result.techniques[0].tactic).toBe("Unknown");
    });
  });

  describe("createDetectionWorkItems", () => {
    it("creates work items with default hawk-ir source", async () => {
      mockCreateWorkItem.mockReturnValue({ id: "wi-1" });

      const input: DetectionWorkItemInput = { idea: makeIdea() };
      const ids = await assistant.createDetectionWorkItems(input);

      expect(ids).toEqual(["wi-1", "wi-1"]);
      expect(mockCreateWorkItem).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "hawk-ir",
          type: "detection",
          status: "proposed",
          title: "Implement detection: OAuth Abuse",
        }),
      );
    });

    it("sets jira source and metadata when assignToJira is true", async () => {
      mockCreateWorkItem.mockReturnValue({ id: "wi-2" });

      const input: DetectionWorkItemInput = { idea: makeIdea(), assignToJira: true };
      const ids = await assistant.createDetectionWorkItems(input);

      expect(ids).toEqual(["wi-2", "wi-2"]);
      expect(mockCreateWorkItem).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "jira",
          metadata: { assignToJira: true },
        }),
      );
    });

    it("throws when the database fails to create a work item", async () => {
      mockCreateWorkItem.mockImplementation(() => {
        throw new Error("database is closed");
      });

      const input: DetectionWorkItemInput = { idea: makeIdea() };

      await expect(assistant.createDetectionWorkItems(input)).rejects.toThrow(
        "Failed to create detection work item: database is closed",
      );
      expect(mockAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "detection_work_item_failed",
          severity: "error",
        }),
      );
    });
  });

  describe("summarizeCoverageGaps", () => {
    it("calculates coverage percentage from mitreTechniques length", async () => {
      const result = await assistant.summarizeCoverageGaps({
        existingDetections: ["Detect-1", "Detect-2"],
        mitreTechniques: ["T1078", "T1528", "T1059", "T1105"],
      });

      expect(result.coveragePercentage).toBe(50);
    });

    it("returns zero coverage when no mitreTechniques are provided", async () => {
      const result = await assistant.summarizeCoverageGaps({
        existingDetections: ["Detect-1"],
      });

      expect(result.coveragePercentage).toBe(0);
    });
  });
});
