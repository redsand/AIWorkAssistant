/**
 * Tests for Mixdown Feedback Engine
 *
 * Tests deterministic rules and report generation with various metric scenarios.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { generateMixFeedbackReport } from "../../../src/musician/mix-feedback";
import type {
  AudioTechnicalMetrics,
  AudioAnalysisRequest,
} from "../../../src/musician/analysis-types";

/**
 * Create base audio metrics with minimal required fields.
 */
function createBaseMetrics(): AudioTechnicalMetrics {
  return {
    durationSeconds: 180,
    sampleRate: 44100,
    channels: 2,
  };
}

/**
 * Create analysis request with default values.
 */
function createAnalysisRequest(): AudioAnalysisRequest {
  return {
    analysisType: "mixdown",
  };
}

/**
 * Create full metrics with all common fields.
 */
function createFullMetrics(): AudioTechnicalMetrics {
  return {
    ...createBaseMetrics(),
    integratedLufs: -16,
    truePeakDbtp: -1.2,
    peakDbfs: -0.8,
    rmsDb: -18,
    dynamicRange: 10,
    crestFactor: 12,
    spectralCentroid: 2500,
    spectralBalance: {
      low: -3,
      sub: -6,
      lowMid: -2,
      mid: 0,
      highMid: 1,
      high: 2,
    },
    stereoWidth: 60,
    phaseCorrelation: 0.8,
    tempoBpm: 120,
    clippingDetected: false,
    silencePercent: 2,
    dcOffset: 0.001,
  };
}

describe("Mixdown Feedback Engine", () => {
  beforeEach(() => {
    // Reset any global state between tests
  });

  describe("Clipping Detection", () => {
    it("should flag clipping as critical priority", () => {
      const metrics = {
        ...createFullMetrics(),
        clippingDetected: true,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.issues.length).toBeGreaterThanOrEqual(1);
      expect(report.prioritizedFixes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            priority: "critical",
          }),
        ])
      );
    });

    it("should flag true peak above -0.5 dBTP as critical", () => {
      const metrics = {
        ...createFullMetrics(),
        truePeakDbtp: -0.3,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.prioritizedFixes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            priority: "critical",
          }),
        ])
      );
    });

    it("should flag true peak above -1.0 dBTP as high priority", () => {
      const metrics = {
        ...createFullMetrics(),
        truePeakDbtp: -0.8,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.prioritizedFixes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            priority: "high",
          }),
        ])
      );
    });
  });

  describe("Loudness Analysis", () => {
    it("should flag missing loudness as high priority", () => {
      const metrics = {
        ...createFullMetrics(),
        integratedLufs: undefined,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      // Should have issues
      expect(report.issues.length).toBeGreaterThan(0);
    });

    it("should flag loudness outside acceptable range", () => {
      const metrics = {
        ...createFullMetrics(),
        integratedLufs: -8, // Too loud
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      // Should have loudness issues
      expect(report.issues.length).toBeGreaterThan(0);
    });

    it("should have loudnessLufs in dynamics section", () => {
      const metrics = createFullMetrics();
      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.dynamics.loudnessLufs).toBeGreaterThan(-30);
      expect(report.dynamics.loudnessLufs).toBeLessThan(0);
    });
  });

  describe("Phase and Mono Compatibility", () => {
    it("should flag low phase correlation", () => {
      const metrics = {
        ...createFullMetrics(),
        phaseCorrelation: 0.1,
        integratedLufs: -23,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.lowEnd.phaseIssues).toBe(true);
    });

    it("should flag negative phase correlation", () => {
      const metrics = {
        ...createFullMetrics(),
        phaseCorrelation: -0.2,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.lowEnd.phaseIssues).toBe(true);
    });

    it("should indicate good mono compatibility with high phase correlation", () => {
      const metrics = {
        ...createFullMetrics(),
        phaseCorrelation: 0.98,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.lowEnd.phaseIssues).toBe(false);
    });
  });

  describe("Stereo Image Analysis", () => {
    it("should flag narrow stereo image", () => {
      const metrics = {
        ...createFullMetrics(),
        stereoWidth: 10,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.stereoImage.overallAssessment).toBe("narrow");
    });

    it("should flag wide stereo image", () => {
      const metrics = {
        ...createFullMetrics(),
        stereoWidth: 90,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.stereoImage.overallAssessment).toBe("wide");
    });

    it("should provide moderate assessment for balanced width", () => {
      const metrics = {
        ...createFullMetrics(),
        stereoWidth: 60,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.stereoImage.overallAssessment).toBe("moderate");
    });
  });

  describe("Low End Analysis", () => {
    it("should flag excessive low end (muddy)", () => {
      const metrics = {
        ...createFullMetrics(),
        spectralBalance: {
          low: 6,
          sub: 4,
          lowMid: 4,
          mid: 1,
          highMid: 2,
          high: 3,
        },
        integratedLufs: -23,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.frequencyBalance.overallAssessment).toBe("muddy");
    });

    it("should flag excessive sub bass (boomy)", () => {
      const metrics = {
        ...createFullMetrics(),
        spectralBalance: {
          low: 2,
          sub: 8,
          lowMid: 2,
          mid: 1,
          highMid: 2,
          high: 3,
        },
        integratedLufs: -23,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.lowEnd.subBass).toBe("uncontrolled");
      expect(report.lowEnd.overallAssessment).toBe("boomy");
    });

    it("should flag weak low end", () => {
      const metrics = {
        ...createBaseMetrics(),
        spectralBalance: {
          sub: -6,
          low: -8,
          lowMid: -4,
          mid: 1,
          highMid: 2,
          high: 3,
        },
        integratedLufs: -23,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.frequencyBalance.bassEnergy).toBe("weak");
      expect(report.lowEnd.bassClarity).toBe("indistinct");
    });
  });

  describe("High Frequency Analysis", () => {
    it("should flag excessive high frequencies (harsh)", () => {
      const metrics = {
        ...createFullMetrics(),
        spectralBalance: {
          low: -4,
          sub: -6,
          lowMid: -2,
          mid: 1,
          highMid: 2,
          high: 8,
        },
        integratedLufs: -23,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.frequencyBalance.overallAssessment).toBe("harsh");
    });

    it("should flag dull high end", () => {
      const metrics = {
        ...createFullMetrics(),
        spectralBalance: {
          low: -2,
          sub: -4,
          lowMid: 0,
          mid: 1,
          highMid: 0,
          high: -4,
        },
        integratedLufs: -23,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.frequencyBalance.highExtension).toBe("dull");
      expect(report.frequencyBalance.overallAssessment).toBe("dull");
    });
  });

  describe("Dynamic Range Analysis", () => {
    it("should flag over-compression (low dynamic range)", () => {
      const metrics = {
        ...createFullMetrics(),
        dynamicRange: 3,
        clippingDetected: false,
        integratedLufs: -23,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.dynamics.overallAssessment).toBe("crushed");
      expect(report.dynamics.compressionAmount).toBe("heavy");
      expect(report.dynamics.punch).toBe("killed");
    });

    it("should flag dynamic range below moderate threshold", () => {
      const metrics = {
        ...createFullMetrics(),
        dynamicRange: 7,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.dynamics.overallAssessment).toBe("moderate");
    });

    it("should preserve dynamics with high dynamic range", () => {
      const metrics = {
        ...createFullMetrics(),
        dynamicRange: 18,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.dynamics.overallAssessment).toBe("dynamic");
      expect(report.dynamics.compressionAmount).toBe("none");
    });
  });

  describe("Silence Detection", () => {
    it("should flag high silence percentage", () => {
      const metrics = {
        ...createFullMetrics(),
        silencePercent: 25,
        integratedLufs: -23,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.issues.length).toBeGreaterThan(0);
    });

    it("should not flag normal silence levels", () => {
      const metrics = {
        ...createBaseMetrics(),
        integratedLufs: -23,
        truePeakDbtp: -1.5,
        dynamicRange: 18,
        phaseCorrelation: 0.9,
        stereoWidth: 50,
        clippingDetected: false,
        silencePercent: 3,
        dcOffset: 0.001,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.issues.length).toBe(0);
    });
  });

  describe("DC Offset Analysis", () => {
    it("should flag high DC offset", () => {
      const metrics = {
        ...createFullMetrics(),
        dcOffset: 0.05,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.noiseArtifacts.hasNoise).toBe(true);
      expect(report.noiseArtifacts.noiseType).toBe("circuit noise");
    });

    it("should not flag low DC offset", () => {
      const metrics = {
        ...createFullMetrics(),
        dcOffset: 0.001,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.noiseArtifacts.hasNoise).toBe(false);
    });
  });

  describe("Report Structure Validation", () => {
    it("should generate all required report sections", () => {
      const metrics = createFullMetrics();
      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report).toHaveProperty("summary");
      expect(report).toHaveProperty("strengths");
      expect(report).toHaveProperty("issues");
      expect(report).toHaveProperty("frequencyBalance");
      expect(report).toHaveProperty("dynamics");
      expect(report).toHaveProperty("stereoImage");
      expect(report).toHaveProperty("depthAndSpace");
      expect(report).toHaveProperty("vocalOrLeadPresence");
      expect(report).toHaveProperty("lowEnd");
      expect(report).toHaveProperty("transients");
      expect(report).toHaveProperty("noiseArtifacts");
      expect(report).toHaveProperty("translationRisks");
      expect(report).toHaveProperty("prioritizedFixes");
      expect(report).toHaveProperty("suggestedPluginsOrProcesses");
      expect(report).toHaveProperty("confidence");
    });

    it("should include frequency balance sub-sections", () => {
      const metrics = createFullMetrics();
      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      const fb = report.frequencyBalance;
      expect(fb).toHaveProperty("overallAssessment");
      expect(fb).toHaveProperty("bassEnergy");
      expect(fb).toHaveProperty("midClarity");
      expect(fb).toHaveProperty("highExtension");
      expect(fb).toHaveProperty("frequencyGauge");
    });

    it("should include dynamics sub-sections", () => {
      const metrics = createFullMetrics();
      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      const dyn = report.dynamics;
      expect(dyn).toHaveProperty("overallAssessment");
      expect(dyn).toHaveProperty("compressionAmount");
      expect(dyn).toHaveProperty("punch");
      expect(dyn).toHaveProperty("sustain");
      expect(dyn).toHaveProperty("loudnessLufs");
    });

    it("should include stereo image sub-sections", () => {
      const metrics = createFullMetrics();
      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      const si = report.stereoImage;
      expect(si).toHaveProperty("overallAssessment");
      expect(si).toHaveProperty("width");
      expect(si).toHaveProperty("centerImageStability");
      expect(si).toHaveProperty("panningBalance");
      expect(si).toHaveProperty("stereoToolsUsed");
    });

    it("should include confidence score", () => {
      const metrics = createFullMetrics();
      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(typeof report.confidence).toBe("number");
      expect(report.confidence).toBeGreaterThanOrEqual(0);
      expect(report.confidence).toBeLessThanOrEqual(1);
    });

    it("should include prioritized fixes when problems exist", () => {
      const metrics = {
        ...createFullMetrics(),
        clippingDetected: true,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.prioritizedFixes.length).toBeGreaterThan(0);
    });
  });

  describe("Partial Metrics Handling", () => {
    it("should generate report with minimal metrics", () => {
      const metrics: AudioTechnicalMetrics = {
        durationSeconds: 120,
        sampleRate: 44100,
        channels: 2,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.summary).toBeDefined();
      expect(report.strengths).toBeDefined();
      expect(report.issues).toBeDefined();
      expect(report.frequencyBalance.overallAssessment).toBe("balanced");
      expect(report.dynamics.overallAssessment).toBe("moderate");
    });

    it("should use defaults when metrics are missing", () => {
      const metrics: AudioTechnicalMetrics = {
        durationSeconds: 120,
        sampleRate: 44100,
        channels: 1,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.stereoImage.overallAssessment).toBe("moderate");
    });
  });

  describe("Executive Summary", () => {
    it("should provide quality assessment in summary", () => {
      const metrics = createFullMetrics();
      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.summary).toContain("mix");
    });

    it("should include loudness information in summary", () => {
      const metrics = createFullMetrics();
      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.summary).toContain("LUFS");
    });

    it("should not make claims about missing metrics", () => {
      const metrics: AudioTechnicalMetrics = {
        durationSeconds: 120,
        sampleRate: 44100,
        channels: 2,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.summary).toBeDefined();
    });
  });

  describe("Plugin Suggestions", () => {
    it("should provide plugin suggestions based on analysis", () => {
      const metrics = {
        ...createFullMetrics(),
        clippingDetected: true,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.suggestedPluginsOrProcesses).toBeDefined();
      expect(Array.isArray(report.suggestedPluginsOrProcesses)).toBe(true);
    });

    it("should provide plugin suggestions when issues exist", () => {
      const metrics = {
        ...createBaseMetrics(),
        spectralBalance: {
          low: 6,
          sub: 4,
          lowMid: 4,
          mid: 1,
          highMid: 2,
          high: 3,
        },
        integratedLufs: -23,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      // There should be at least one EQ suggestion
      const eqSuggestions = report.suggestedPluginsOrProcesses.filter(
        (p) => p.type.includes("eq")
      );
      expect(eqSuggestions.length).toBeGreaterThan(0);
      expect(eqSuggestions[0]).toHaveProperty("suggestedChain");
    });
  });

  describe("Strengths and Issues Lists", () => {
    it("should list strengths when metrics are good", () => {
      const metrics = createFullMetrics();

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.strengths).toBeDefined();
      expect(report.strengths.length).toBeGreaterThan(0);
    });

    it("should list issues based on problem detection", () => {
      const metrics = {
        ...createFullMetrics(),
        clippingDetected: true,
        phaseCorrelation: 0.2,
        dynamicRange: 3,
      };

      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.issues).toBeDefined();
      expect(report.issues.length).toBeGreaterThanOrEqual(2);
    });

    it("should be empty when no problems detected", () => {
      const metrics = {
        ...createBaseMetrics(),
        integratedLufs: -23,
        truePeakDbtp: -1.5,
        dynamicRange: 18,
        phaseCorrelation: 0.9,
        stereoWidth: 50,
        clippingDetected: false,
        silencePercent: 1,
        dcOffset: 0.0001,
      };
      const report = generateMixFeedbackReport(metrics, createAnalysisRequest());

      expect(report.issues).toEqual([]);
    });
  });
});
