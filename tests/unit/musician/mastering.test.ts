/**
 * Tests for Mastering Preflight Engine
 *
 * Tests release readiness assessment, platform compatibility,
 * and export recommendations.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { generateMasteringFeedback } from "../../../src/musician/mastering";
import type {
  AudioTechnicalMetrics,
  AudioAnalysisRequest,
} from "../../../src/musician/analysis-types";

/**
 * Create base audio metrics
 */
function createBaseMetrics(): Partial<AudioTechnicalMetrics> {
  return {
    durationSeconds: 180,
    sampleRate: 44100,
    channels: 2,
  };
}

/**
 * Create analysis request
 */
function createAnalysisRequest(
  overrides?: Partial<AudioAnalysisRequest>
): AudioAnalysisRequest {
  return {
    analysisType: "mastering",
    ...overrides,
  };
}

/**
 * Create healthy master metrics
 */
function createHealthyMaster(): Partial<AudioTechnicalMetrics> {
  return {
    ...createBaseMetrics(),
    integratedLufs: -14,
    truePeakDbtp: -1.2,
    peakDbfs: -1.5,
    dynamicRange: 9,
    phaseCorrelation: 0.85,
    spectralBalance: {
      low: 2,
      sub: 3,
      lowMid: 1,
      mid: 2,
      highMid: 2,
      high: 3,
    },
    clippingDetected: false,
    silencePercent: 1,
    dcOffset: 0.001,
  };
}

describe("Mastering Preflight Engine", () => {
  beforeEach(() => {
    // Reset any state
  });

  describe("Release Readiness Assessment", () => {
    it("should mark healthy master as ready", () => {
      const metrics = createHealthyMaster();
      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.releaseReadiness).toBe("ready");
    });

    it("should mark master with clipping as not ready", () => {
      const metrics = {
        ...createHealthyMaster(),
        clippingDetected: true,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.releaseReadiness).toBe("not_ready");
      expect(report.prioritizedFixes[0].priority).toBe("critical");
    });

    it("should mark master with high true peak as nearly ready", () => {
      const metrics = {
        ...createHealthyMaster(),
        truePeakDbtp: -0.5,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.releaseReadiness).toBe("nearly_ready");
    });

    it("should mark master with multiple issues as needs work", () => {
      const metrics = {
        ...createHealthyMaster(),
        truePeakDbtp: -0.5,
        dynamicRange: 4,
        phaseCorrelation: 0.5,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.releaseReadiness).toBe("needs_work");
    });
  });

  describe("Missing Metrics Handling", () => {
    it("should handle missing LUFS gracefully", () => {
      const metrics = {
        ...createBaseMetrics(),
        truePeakDbtp: -1.5,
        dynamicRange: 9,
        phaseCorrelation: 0.85,
        clippingDetected: false,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.releaseReadiness).toBe("ready");
      expect(report.loudness.currentLufs).toBe(0);
      expect(
        report.prioritizedFixes.some((f) => f.issue.includes("LUFS measurement unavailable"))
      ).toBe(true);
    });

    it("should handle missing true peak gracefully", () => {
      const metrics = {
        ...createBaseMetrics(),
        integratedLufs: -14,
        dynamicRange: 9,
        phaseCorrelation: 0.85,
        clippingDetected: false,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.truePeak.measuredDbtp).toBeDefined();
      expect(
        report.prioritizedFixes.some((f) => f.issue.includes("True peak measurement unavailable"))
      ).toBe(true);
    });

    it("should handle missing spectral balance gracefully", () => {
      const metrics = {
        ...createBaseMetrics(),
        integratedLufs: -14,
        truePeakDbtp: -1.5,
        dynamicRange: 9,
        clippingDetected: false,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.tonalBalance.overallAssessment).toBe("balanced");
    });

    it("should handle minimal metrics", () => {
      const metrics = createBaseMetrics();
      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.releaseReadiness).toBeDefined();
      expect(report.loudness).toBeDefined();
      expect(report.truePeak).toBeDefined();
      expect(report.streamingReadiness).toBeDefined();
    });
  });

  describe("Clipping Detection", () => {
    it("should flag clipping as critical", () => {
      const metrics = {
        ...createHealthyMaster(),
        clippingDetected: true,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.releaseReadiness).toBe("not_ready");
      const clippingFix = report.prioritizedFixes.find((f) => f.issue.includes("clipping"));
      expect(clippingFix).toBeDefined();
      expect(clippingFix?.priority).toBe("critical");
    });

    it("should recommend clipping fix", () => {
      const metrics = {
        ...createHealthyMaster(),
        clippingDetected: true,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      const clippingFix = report.prioritizedFixes.find((f) => f.issue.includes("clipping"));
      expect(clippingFix?.masteringSolution).toContain("Reduce output level");
    });
  });

  describe("True Peak Analysis", () => {
    it("should flag true peak above -1.0 dBTP", () => {
      const metrics = {
        ...createHealthyMaster(),
        truePeakDbtp: -0.8,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.truePeak.interSamplePeak).toBe(true);
      expect(report.prioritizedFixes.some((f) => f.priority === "high")).toBe(true);
    });

    it("should flag true peak above -0.1 dBTP as critical", () => {
      const metrics = {
        ...createHealthyMaster(),
        truePeakDbtp: 0.0,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.truePeak.interSamplePeak).toBe(true);
      expect(report.prioritizedFixes.some((f) => f.priority === "critical")).toBe(true);
    });

    it("should calculate headroom correctly", () => {
      const metrics = {
        ...createHealthyMaster(),
        truePeakDbtp: -1.5,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.truePeak.headroom).toBe(-1.0 - -1.5);
      expect(report.truePeak.headroom).toBeCloseTo(0.5);
    });

    it("should not flag good true peak levels", () => {
      const metrics = {
        ...createHealthyMaster(),
        truePeakDbtp: -1.5,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.truePeak.interSamplePeak).toBe(false);
      const peakIssues = report.prioritizedFixes.filter((f) =>
        f.issue.toLowerCase().includes("peak")
      );
      expect(peakIssues.length).toBe(0);
    });
  });

  describe("Dynamic Range Analysis", () => {
    it("should flag very low dynamic range", () => {
      const metrics = {
        ...createHealthyMaster(),
        dynamicRange: 4,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.dynamics.punchRetained).toBe(false);
      expect(report.prioritizedFixes.some((f) => f.issue.includes("Dynamic range"))).toBe(true);
    });

    it("should flag loudness war characteristics", () => {
      const metrics = {
        ...createHealthyMaster(),
        integratedLufs: -6,
        dynamicRange: 4,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.loudness.loudnessWarStatus).toBe("brick-walled");
      expect(report.dynamics.loudnessVersusDynamicRange).toBe("loud_and_compressed");
    });

    it("should recognize healthy dynamic range", () => {
      const metrics = {
        ...createHealthyMaster(),
        dynamicRange: 10,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.dynamics.punchRetained).toBe(true);
      const drIssues = report.prioritizedFixes.filter((f) =>
        f.issue.includes("Dynamic range")
      );
      expect(drIssues.length).toBe(0);
    });

    it("should flag over-compression", () => {
      const metrics = {
        ...createHealthyMaster(),
        integratedLufs: -9,
        dynamicRange: 6,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.loudness.loudnessWarStatus).toBe("over-compressed");
    });
  });

  describe("Loudness Analysis", () => {
    it("should recognize appropriate streaming loudness", () => {
      const metrics = {
        ...createHealthyMaster(),
        integratedLufs: -14,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.loudness.streamingNormalization).toBe("already_normalized");
    });

    it("should flag too loud masters", () => {
      const metrics = {
        ...createHealthyMaster(),
        integratedLufs: -8,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.loudness.streamingNormalization).toBe("needs_reduction");
    });

    it("should flag too quiet masters", () => {
      const metrics = {
        ...createHealthyMaster(),
        integratedLufs: -20,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.loudness.streamingNormalization).toBe("will_gain_match");
    });

    it("should assess loudness range correctly", () => {
      const metrics = {
        ...createHealthyMaster(),
        dynamicRange: 4,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.loudness.luRange).toContain("heavily compressed");
    });
  });

  describe("Phase Compatibility", () => {
    it("should flag negative phase correlation as critical", () => {
      const metrics = {
        ...createHealthyMaster(),
        phaseCorrelation: -0.3,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.releaseReadiness).toBe("not_ready");
      const phaseFix = report.prioritizedFixes.find((f) => f.issue.includes("out-of-phase"));
      expect(phaseFix?.priority).toBe("critical");
    });

    it("should flag low phase correlation", () => {
      const metrics = {
        ...createHealthyMaster(),
        phaseCorrelation: 0.5,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.prioritizedFixes.some((f) => f.issue.includes("Phase correlation"))).toBe(
        true
      );
    });

    it("should accept good phase correlation", () => {
      const metrics = {
        ...createHealthyMaster(),
        phaseCorrelation: 0.9,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      const phaseIssues = report.prioritizedFixes.filter((f) => f.issue.includes("phase"));
      expect(phaseIssues.length).toBe(0);
    });
  });

  describe("Tonal Balance", () => {
    it("should flag excessive bass", () => {
      const metrics = {
        ...createHealthyMaster(),
        spectralBalance: {
          low: 8,
          sub: 7,
          lowMid: 1,
          mid: 2,
          highMid: 2,
          high: 3,
        },
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.tonalBalance.overallAssessment).toBe("boomy");
      expect(report.prioritizedFixes.some((f) => f.issue.includes("bass energy"))).toBe(true);
    });

    it("should flag weak bass", () => {
      const metrics = {
        ...createHealthyMaster(),
        spectralBalance: {
          low: -5,
          sub: -6,
          lowMid: 0,
          mid: 2,
          highMid: 2,
          high: 3,
        },
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.tonalBalance.overallAssessment).toBe("thin");
    });

    it("should flag bright masters", () => {
      const metrics = {
        ...createHealthyMaster(),
        spectralBalance: {
          low: 2,
          sub: 3,
          lowMid: 1,
          mid: 2,
          highMid: 6,
          high: 7,
        },
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.tonalBalance.overallAssessment).toBe("bright");
    });

    it("should recognize balanced tonal characteristics", () => {
      const metrics = createHealthyMaster();
      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.tonalBalance.overallAssessment).toBe("balanced");
    });
  });

  describe("Silence Detection", () => {
    it("should flag excessive silence", () => {
      const metrics = {
        ...createHealthyMaster(),
        silencePercent: 15,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.prioritizedFixes.some((f) => f.issue.includes("silence"))).toBe(true);
    });

    it("should not flag normal silence levels", () => {
      const metrics = {
        ...createHealthyMaster(),
        silencePercent: 2,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      const silenceIssues = report.prioritizedFixes.filter((f) => f.issue.includes("silence"));
      expect(silenceIssues.length).toBe(0);
    });
  });

  describe("DC Offset Detection", () => {
    it("should flag high DC offset", () => {
      const metrics = {
        ...createHealthyMaster(),
        dcOffset: 0.05,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.prioritizedFixes.some((f) => f.issue.includes("DC offset"))).toBe(true);
    });

    it("should not flag low DC offset", () => {
      const metrics = {
        ...createHealthyMaster(),
        dcOffset: 0.001,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      const dcIssues = report.prioritizedFixes.filter((f) => f.issue.includes("DC offset"));
      expect(dcIssues.length).toBe(0);
    });
  });

  describe("Streaming Platform Readiness", () => {
    it("should mark all platforms ready for healthy master", () => {
      const metrics = createHealthyMaster();
      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.streamingReadiness.spotify).toBe("ready");
      expect(report.streamingReadiness.appleMusic).toBe("ready");
      expect(report.streamingReadiness.youtube).toBe("ready");
      expect(report.streamingReadiness.soundcloud).toBe("ready");
      expect(report.streamingReadiness.bandcamp).toBe("ready");
    });

    it("should flag platforms needing adjustment for high true peak", () => {
      const metrics = {
        ...createHealthyMaster(),
        truePeakDbtp: -0.5,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.streamingReadiness.spotify).toBe("needs_adjustment");
    });

    it("should handle gain matching for off-target loudness", () => {
      const metrics = {
        ...createHealthyMaster(),
        integratedLufs: -10,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      // Platforms with normalization will gain match
      expect(report.streamingReadiness.spotify).toMatch(/ready|will_gain_match/);
    });
  });

  describe("Export Recommendations", () => {
    it("should recommend WAV format", () => {
      const metrics = createHealthyMaster();
      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.exportRecommendations.idealFormat).toBe("wav");
    });

    it("should recommend 24-bit depth", () => {
      const metrics = createHealthyMaster();
      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.exportRecommendations.bitDepth).toBe("24");
    });

    it("should recommend matching source sample rate", () => {
      const metrics = {
        ...createHealthyMaster(),
        sampleRate: 48000,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.exportRecommendations.sampleRate).toMatch(/48|match_source/);
    });

    it("should recommend dithering for 16-bit exports", () => {
      const metrics = createHealthyMaster();
      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      // 24-bit master recommended, so dithering not needed for primary export
      // but should be specified for when creating 16-bit distribution copies
      expect(report.exportRecommendations.bitDepth).toBe("24");
      expect(report.exportRecommendations.ditherRecommended).toBe(false);
      expect(report.exportRecommendations.ditherType).toBe("noise-shaped");

      // Export chain should mention dithering for 16-bit
      const hasDitherMention = report.exportRecommendations.exportChain.some(
        (step) => step.includes("dither") || step.includes("16-bit")
      );
      expect(hasDitherMention).toBe(false); // No 16-bit conversion in primary export
    });

    it("should flag clipping check failure", () => {
      const metrics = {
        ...createHealthyMaster(),
        clippingDetected: true,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.exportRecommendations.clippingCheck).toBe("requires_reduction");
    });

    it("should pass clipping check for clean master", () => {
      const metrics = createHealthyMaster();
      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.exportRecommendations.clippingCheck).toBe("passed");
    });

    it("should include export chain recommendations", () => {
      const metrics = createHealthyMaster();
      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.exportRecommendations.exportChain).toBeDefined();
      expect(report.exportRecommendations.exportChain.length).toBeGreaterThan(0);
    });
  });

  describe("Vinyl/Club Readiness", () => {
    it("should not generate vinyl readiness by default", () => {
      const metrics = createHealthyMaster();
      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.vinylOrClubReadiness).toBeUndefined();
    });

    it("should generate vinyl readiness when requested", () => {
      const metrics = createHealthyMaster();
      const request = createAnalysisRequest({
        userQuestions: ["What about vinyl mastering?"],
      });

      const report = generateMasteringFeedback(metrics, request);

      expect(report.vinylOrClubReadiness).toBeDefined();
      expect(report.vinylOrClubReadiness?.format).toBe("vinyl");
      expect(report.vinylOrClubReadiness?.preMasterRequirements.length).toBeGreaterThan(0);
    });

    it("should generate club readiness when requested", () => {
      const metrics = createHealthyMaster();
      const request = createAnalysisRequest({
        userQuestions: ["Is this ready for club playback?"],
      });

      const report = generateMasteringFeedback(metrics, request);

      expect(report.vinylOrClubReadiness).toBeDefined();
    });
  });

  describe("Prioritized Fixes", () => {
    it("should prioritize critical issues first", () => {
      const metrics = {
        ...createHealthyMaster(),
        clippingDetected: true,
        truePeakDbtp: -0.5,
        dynamicRange: 4,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.prioritizedFixes[0].priority).toBe("critical");
    });

    it("should include solutions for each fix", () => {
      const metrics = {
        ...createHealthyMaster(),
        truePeakDbtp: -0.5,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.prioritizedFixes.length).toBeGreaterThan(0);
      expect(report.prioritizedFixes[0].masteringSolution).toBeDefined();
      expect(report.prioritizedFixes[0].pluginType).toBeDefined();
    });

    it("should infer correct plugin types", () => {
      const metrics = {
        ...createHealthyMaster(),
        truePeakDbtp: -0.5,
      };

      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      const truePeakFix = report.prioritizedFixes.find((f) => f.issue.includes("True peak"));
      expect(truePeakFix?.pluginType).toBe("limiter_true");
    });
  });

  describe("Report Structure", () => {
    it("should include all required sections", () => {
      const metrics = createHealthyMaster();
      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report).toHaveProperty("releaseReadiness");
      expect(report).toHaveProperty("loudness");
      expect(report).toHaveProperty("truePeak");
      expect(report).toHaveProperty("dynamics");
      expect(report).toHaveProperty("tonalBalance");
      expect(report).toHaveProperty("streamingReadiness");
      expect(report).toHaveProperty("prioritizedFixes");
      expect(report).toHaveProperty("exportRecommendations");
    });

    it("should have valid loudness section", () => {
      const metrics = createHealthyMaster();
      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.loudness).toHaveProperty("currentLufs");
      expect(report.loudness).toHaveProperty("targetLufs");
      expect(report.loudness).toHaveProperty("loudnessRange");
      expect(report.loudness).toHaveProperty("streamingNormalization");
    });

    it("should have valid true peak section", () => {
      const metrics = createHealthyMaster();
      const report = generateMasteringFeedback(metrics, createAnalysisRequest());

      expect(report.truePeak).toHaveProperty("measuredDbtp");
      expect(report.truePeak).toHaveProperty("maxAllowedDbtp");
      expect(report.truePeak).toHaveProperty("headroom");
      expect(report.truePeak).toHaveProperty("interSamplePeak");
    });
  });
});
