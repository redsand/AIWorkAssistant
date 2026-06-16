import { describe, it, expect, vi, beforeEach } from "vitest";
import { DetectionAssistant } from "../../../src/detection/detection-assistant";
import { workItemDatabase } from "../../../src/work-items/database";

vi.mock("../../../src/work-items/database", () => ({
  workItemDatabase: {
    createWorkItem: vi.fn(),
  },
}));

describe("DetectionAssistant", () => {
  let assistant: DetectionAssistant;

  beforeEach(() => {
    assistant = new DetectionAssistant();
    vi.mocked(workItemDatabase.createWorkItem).mockReset();
    vi.mocked(workItemDatabase.createWorkItem).mockReturnValue({ id: "test-work-item-id" } as any);
  });

  describe("generateDetectionIdea", () => {
    it("returns all required sections", async () => {
      const result = await assistant.generateDetectionIdea({
        name: "Suspicious OAuth Consent Grant Abuse",
        description: "User grants OAuth consent to an unverified third-party application",
        dataSource: "audit_logs",
        mitreTechniques: ["T1528"],
        severity: "high",
      });

      expect(result.summary).toBeDefined();
      expect(result.hypothesis).toBeDefined();
      expect(Array.isArray(result.dataSources)).toBe(true);
      expect(result.dataSources.length).toBeGreaterThan(0);
      expect(result.candidateLogic).toBeDefined();
      expect(Array.isArray(result.mitreMapping)).toBe(true);
      expect(Array.isArray(result.falsePositiveConsiderations)).toBe(true);
      expect(Array.isArray(result.testCases)).toBe(true);
      expect(result.testCases.length).toBeGreaterThanOrEqual(3);
      expect(Array.isArray(result.validationPlan)).toBe(true);
      expect(Array.isArray(result.rolloutNotes)).toBe(true);
      expect(Array.isArray(result.workItems)).toBe(true);
      expect(Array.isArray(result.draftFormats)).toBe(true);
    });

    it("uses provided severity and data source", async () => {
      const result = await assistant.generateDetectionIdea({
        name: "Test Detection",
        description: "Test description",
        dataSource: "endpoint",
        severity: "critical",
      });

      expect(result.dataSources).toContain("endpoint");
      expect(result.workItems[0].priority).toBe("critical");
    });

    it("defaults to medium severity when not provided", async () => {
      const result = await assistant.generateDetectionIdea({
        name: "Test Detection",
        description: "Test description",
      });

      expect(result.workItems[0].priority).toBe("medium");
    });
  });

  describe("mapToMitre", () => {
    it("returns technique details when technique is provided", async () => {
      const result = await assistant.mapToMitre({
        technique: "T1528",
        name: "Application Access Token",
        tactic: "Credential Access",
      });

      expect(result.techniques).toHaveLength(1);
      expect(result.techniques[0].id).toBe("T1528");
      expect(result.techniques[0].name).toBe("Application Access Token");
      expect(Array.isArray(result.suggestedDataSources)).toBe(true);
    });

    it("returns empty techniques array when technique is unknown/not provided", async () => {
      const result = await assistant.mapToMitre({
        name: "Unknown Activity",
        description: "No technique specified",
      });

      expect(result.techniques).toHaveLength(0);
    });

    it("falls back to generated name and unknown tactic", async () => {
      const result = await assistant.mapToMitre({
        technique: "T9999",
      });

      expect(result.techniques).toHaveLength(1);
      expect(result.techniques[0].name).toBe("Technique T9999");
      expect(result.techniques[0].tactic).toBe("Unknown");
    });
  });

  describe("generateTestCases", () => {
    it("returns test cases for the detection idea", async () => {
      const result = await assistant.generateTestCases({
        name: "Suspicious OAuth Consent Grant Abuse",
        description: "User grants OAuth consent to an unverified third-party application",
      });

      expect(result.length).toBeGreaterThanOrEqual(3);
      const types = result.map((t) => t.type);
      expect(types).toContain("true_positive");
      expect(types).toContain("true_negative");
      expect(types).toContain("false_positive");
    });
  });

  describe("reviewDetectionLogic", () => {
    it("returns structured review with strengths and weaknesses", async () => {
      const result = await assistant.reviewDetectionLogic({
        name: "OAuth Abuse Detection",
        logic: "event where oauth_consent granted to unknown app",
        format: "kql",
      });

      expect(Array.isArray(result.strengths)).toBe(true);
      expect(Array.isArray(result.weaknesses)).toBe(true);
      expect(["low", "medium", "high", "critical"]).toContain(result.falsePositiveRisk);
      expect(Array.isArray(result.tuningSuggestions)).toBe(true);
      expect(result.improvedLogic).toBeDefined();
    });
  });

  describe("createDetectionWorkItems", () => {
    it("creates work items with type detection and source hawk-ir", async () => {
      const idea = await assistant.generateDetectionIdea({
        name: "OAuth Abuse Detection",
        description: "Detect suspicious OAuth consent grants",
        severity: "high",
      });

      await assistant.createDetectionWorkItems({ idea });

      expect(vi.mocked(workItemDatabase.createWorkItem)).toHaveBeenCalledTimes(idea.workItems.length);
      for (const call of vi.mocked(workItemDatabase.createWorkItem).mock.calls) {
        const params = call[0];
        expect(params.type).toBe("detection");
        expect(params.source).toBe("hawk-ir");
        expect(params.status).toBe("proposed");
      }
    });
  });

  describe("summarizeCoverageGaps", () => {
    it("returns coverage gap analysis", async () => {
      const result = await assistant.summarizeCoverageGaps({
        existingDetections: ["Detect-1", "Detect-2"],
      });

      expect(Array.isArray(result.gaps)).toBe(true);
      expect(Array.isArray(result.suggestedDetections)).toBe(true);
      expect(typeof result.coveragePercentage).toBe("number");
      expect(result.coveragePercentage).toBeGreaterThanOrEqual(0);
      expect(result.coveragePercentage).toBeLessThanOrEqual(100);
    });

    it("returns 0 coverage percentage when no existing detections are provided", async () => {
      const result = await assistant.summarizeCoverageGaps({});

      expect(result.coveragePercentage).toBe(0);
    });
  });

  it("does not contain any production deployment actions", () => {
    const source = DetectionAssistant.toString();
    expect(source).not.toContain("deploy");
    expect(source).not.toContain("production");
    expect(source).not.toContain("enableDetection");
    expect(source).not.toContain("pushRule");
  });
});
