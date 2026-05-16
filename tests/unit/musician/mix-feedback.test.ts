/**
 * Tests for Mixdown Feedback Engine
 *
 * Tests deterministic rules, genre-specific thresholds, and report generation
 * with various metric scenarios.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  generateMixFeedback,
  getSupportedGenres,
  getGenreProfileDetails,
} from "../../../src/musician/mix-feedback";
import type {
  AudioTechnicalMetrics,
  AudioAnalysisRequest,
} from "../../../src/musician/analysis-types";

/**
 * Create base audio metrics with minimal required fields.
 */
function createBaseMetrics(): Partial<AudioTechnicalMetrics> {
  return {
    durationSeconds: 180,
    sampleRate: 44100,
    channels: 2,
  };
}

/**
 * Create analysis request with default values.
 */
function createAnalysisRequest(
  overrides?: Partial<AudioAnalysisRequest>
): AudioAnalysisRequest {
  return {
    analysisType: "mixdown",
    ...overrides,
  };
}

/**
 * Create full metrics with all common fields.
 */
function createFullMetrics(): Partial<AudioTechnicalMetrics> {
  return {
    ...createBaseMetrics(),
    integratedLufs: -12,
    truePeakDbtp: -1.2,
    peakDbfs: -0.8,
    rmsDb: -18,
    dynamicRange: 10,
    crestFactor: 12,
    spectralCentroid: 2500,
    spectralBalance: {
      low: 2,
      sub: 3,
      lowMid: 1,
      mid: 2,
      highMid: 2,
      high: 3,
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

  describe("Genre Profiles", () => {
    it("should return list of supported genres", () => {
      const genres = getSupportedGenres();
      expect(genres.length).toBeGreaterThan(10);
      expect(genres).toContain("drum-and-bass");
      expect(genres).toContain("pop");
      expect(genres).toContain("jazz");
      expect(genres).toContain("classical");
    });

    it("should get genre profile details", () => {
      const dnbProfile = getGenreProfileDetails("drum-and-bass");
      expect(dnbProfile).toBeDefined();
      expect(dnbProfile?.name).toBe("Drum and Bass");
      expect(dnbProfile?.targetLufsMin).toBe(-7);
      expect(dnbProfile?.targetLufsMax).toBe(-5);
    });

    it("should handle genre aliases", () => {
      const dnbProfile1 = getGenreProfileDetails("drum-and-bass");
      const dnbProfile2 = getGenreProfileDetails("dnb");
      expect(dnbProfile1).toEqual(dnbProfile2);

      const hipHopProfile1 = getGenreProfileDetails("hip-hop");
      const hipHopProfile2 = getGenreProfileDetails("hiphop");
      const rapProfile = getGenreProfileDetails("rap");
      expect(hipHopProfile1).toEqual(hipHopProfile2);
      expect(hipHopProfile1).toEqual(rapProfile);
    });

    it("should return null for unknown genre", () => {
      const profile = getGenreProfileDetails("unknown-genre-xyz");
      expect(profile).toBeNull();
    });
  });

  describe("Genre-Specific Loudness Targets", () => {
    it("should use Drum and Bass LUFS targets (-7 to -5)", () => {
      const metrics = {
        ...createFullMetrics(),
        integratedLufs: -6,
        dynamicRange: 6,
      };

      const report = generateMixFeedback(
        metrics,
        createAnalysisRequest({ genre: "drum-and-bass" })
      );

      // Should have no loudness issues as -6 is within DnB range
      expect(report.strengths.some((s) => s.includes("Drum and Bass"))).toBe(true);
    });

    it("should flag loudness outside DnB range", () => {
      const metrics = {
        ...createFullMetrics(),
        integratedLufs: -10,
        dynamicRange: 6,
      };

      const report = generateMixFeedback(
        metrics,
        createAnalysisRequest({ genre: "drum-and-bass" })
      );

      // -10 is too quiet for DnB
      expect(report.issues.some((i) => i.includes("quieter"))).toBe(true);
    });

    it("should use Jazz LUFS targets (-18 to -14)", () => {
      const metrics = {
        ...createFullMetrics(),
        integratedLufs: -16,
        dynamicRange: 15,
      };

      const report = generateMixFeedback(
        metrics,
        createAnalysisRequest({ genre: "jazz" })
      );

      // Should have no loudness issues as -16 is within Jazz range
      expect(report.strengths.some((s) => s.includes("Jazz"))).toBe(true);
    });

    it("should use Classical LUFS targets (-23 to -18)", () => {
      const metrics = {
        ...createFullMetrics(),
        integratedLufs: -20,
        dynamicRange: 20,
      };

      const report = generateMixFeedback(
        metrics,
        createAnalysisRequest({ genre: "classical" })
      );

      // Should have no loudness issues as -20 is within Classical range
      expect(report.strengths.some((s) => s.includes("Classical"))).toBe(true);
    });

    it("should use EDM LUFS targets (-8 to -4)", () => {
      const metrics = {
        ...createFullMetrics(),
        integratedLufs: -6,
        dynamicRange: 5,
      };

      const report = generateMixFeedback(
        metrics,
        createAnalysisRequest({ genre: "edm" })
      );

      // Should have no loudness issues as -6 is within EDM range
      expect(report.strengths.some((s) => s.includes("EDM"))).toBe(true);
    });
  });

  describe("Genre-Specific Dynamic Range Expectations", () => {
    it("should accept low DR for DnB (4-8dB)", () => {
      const metrics = {
        ...createFullMetrics(),
        integratedLufs: -7,
        dynamicRange: 6,
      };

      const report = generateMixFeedback(
        metrics,
        createAnalysisRequest({ genre: "drum-and-bass" })
      );

      // 6dB is acceptable for DnB
      expect(report.strengths.some((s) => s.includes("appropriate"))).toBe(true);
    });

    it("should require high DR for Classical (15-25dB)", () => {
      const metrics = {
        ...createFullMetrics(),
        integratedLufs: -20,
        dynamicRange: 18,
      };

      const report = generateMixFeedback(
        metrics,
        createAnalysisRequest({ genre: "classical" })
      );

      // 18dB is appropriate for Classical
      expect(report.strengths.some((s) => s.includes("appropriate"))).toBe(true);
    });

    it("should flag over-compression for Jazz", () => {
      const metrics = {
        ...createFullMetrics(),
        integratedLufs: -16,
        dynamicRange: 8, // Too low for Jazz
      };

      const report = generateMixFeedback(
        metrics,
        createAnalysisRequest({ genre: "jazz" })
      );

      // Jazz expects 12-20dB, so 8dB is too low
      expect(report.issues.some((i) => i.includes("below"))).toBe(true);
    });

    it("should flag excessive DR for EDM", () => {
      const metrics = {
        ...createFullMetrics(),
        integratedLufs: -6,
        dynamicRange: 12, // Too high for EDM
      };

      const report = generateMixFeedback(
        metrics,
        createAnalysisRequest({ genre: "edm" })
      );

      // EDM expects 4-7dB, so 12dB may lack punch
      expect(report.issues.some((i) => i.includes("lack punch"))).toBe(true);
    });
  });

  describe("Genre-Specific True Peak Limits", () => {
    it("should use tighter limits for DnB (-0.3 dBTP)", () => {
      const metrics = {
        ...createFullMetrics(),
        integratedLufs: -6,
        truePeakDbtp: -0.2, // Exceeds -0.3 limit (less headroom)
        dynamicRange: 6,
      };

      const report = generateMixFeedback(
        metrics,
        createAnalysisRequest({ genre: "drum-and-bass" })
      );

      // -0.2 exceeds DnB limit of -0.3
      expect(report.issues.some((i) => i.toLowerCase().includes("peak"))).toBe(true);
    });

    it("should use looser limits for Classical (-3.0 dBTP)", () => {
      const metrics = {
        ...createFullMetrics(),
        integratedLufs: -20,
        truePeakDbtp: -3.5, // Within -3.0 limit (more headroom)
        dynamicRange: 18,
      };

      const report = generateMixFeedback(
        metrics,
        createAnalysisRequest({ genre: "classical" })
      );

      // -3.5 is within Classical limit of -3.0
      expect(report.issues.some((i) => i.toLowerCase().includes("peak"))).toBe(false);
    });
  });

  describe("Genre-Specific Frequency Balance", () => {
    it("should expect heavy low end for Hip Hop", () => {
      const metrics = {
        ...createFullMetrics(),
        integratedLufs: -8,
        spectralBalance: {
          low: 7, // Heavy sub
          sub: 6, // Heavy bass
          lowMid: 0,
          mid: 2,
          highMid: 3,
          high: 2,
        },
        dynamicRange: 8,
      };

      const report = generateMixFeedback(
        metrics,
        createAnalysisRequest({ genre: "hip-hop" })
      );

      // Hip Hop expects sub: 7, bass: 6, so this should be good
      expect(report.issues.length).toBe(0);
    });

    it("should flag excessive low end for Classical", () => {
      const metrics = {
        ...createFullMetrics(),
        integratedLufs: -20,
        spectralBalance: {
          low: 5, // Too much for Classical
          sub: 4,
          lowMid: 1,
          mid: 2,
          highMid: 2,
          high: 3,
        },
        dynamicRange: 18,
      };

      const report = generateMixFeedback(
        metrics,
        createAnalysisRequest({ genre: "classical" })
      );

      // Classical expects sub: -3, bass: 0, so this is way too much
      expect(report.issues.some((i) => i.includes("bass"))).toBe(true);
    });
  });

  describe("Clipping Detection", () => {
    it("should flag clipping as critical priority", () => {
      const metrics = {
        ...createFullMetrics(),
        clippingDetected: true,
      };

      const report = generateMixFeedback(metrics, createAnalysisRequest());

      expect(report.issues.length).toBeGreaterThanOrEqual(1);
      expect(report.prioritizedFixes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            priority: "critical",
          }),
        ])
      );
    });

    it("should flag true peak above -0.1 dBTP as critical", () => {
      const metrics = {
        ...createFullMetrics(),
        truePeakDbtp: -0.05,
      };

      const report = generateMixFeedback(metrics, createAnalysisRequest());

      expect(report.prioritizedFixes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            priority: "critical",
          }),
        ])
      );
    });
  });

  describe("Phase and Mono Compatibility", () => {
    it("should flag low phase correlation for genres requiring it", () => {
      const metrics = {
        ...createFullMetrics(),
        phaseCorrelation: 0.5, // Below Classical minimum of 0.9
        integratedLufs: -20,
        dynamicRange: 18,
      };

      const report = generateMixFeedback(
        metrics,
        createAnalysisRequest({ genre: "classical" })
      );

      expect(report.lowEnd.phaseIssues).toBe(true);
      expect(report.issues.some((i) => i.toLowerCase().includes("phase"))).toBe(true);
    });

    it("should accept lower phase correlation for EDM", () => {
      const metrics = {
        ...createFullMetrics(),
        phaseCorrelation: 0.7, // Above EDM minimum of 0.65
        integratedLufs: -6,
      };

      const report = generateMixFeedback(
        metrics,
        createAnalysisRequest({ genre: "edm" })
      );

      // Should be acceptable for EDM
      expect(report.issues.some((i) => i.includes("phase"))).toBe(false);
    });

    it("should flag negative phase correlation", () => {
      const metrics = {
        ...createFullMetrics(),
        phaseCorrelation: -0.2,
      };

      const report = generateMixFeedback(metrics, createAnalysisRequest());

      expect(report.lowEnd.phaseIssues).toBe(true);
      expect(report.issues.some((i) => i.includes("out-of-phase"))).toBe(true);
    });
  });

  describe("Stereo Width Analysis", () => {
    it("should flag narrow stereo image", () => {
      const metrics = {
        ...createFullMetrics(),
        stereoWidth: 10,
      };

      const report = generateMixFeedback(metrics, createAnalysisRequest());

      expect(report.stereoImage.overallAssessment).toBe("narrow");
    });

    it("should flag wide stereo image", () => {
      const metrics = {
        ...createFullMetrics(),
        stereoWidth: 90,
      };

      const report = generateMixFeedback(metrics, createAnalysisRequest());

      expect(report.stereoImage.overallAssessment).toBe("wide");
    });

    it("should provide moderate assessment for balanced width", () => {
      const metrics = {
        ...createFullMetrics(),
        stereoWidth: 60,
      };

      const report = generateMixFeedback(metrics, createAnalysisRequest());

      expect(report.stereoImage.overallAssessment).toBe("moderate");
    });
  });

  describe("Low End Analysis", () => {
    it("should flag excessive low end (boomy)", () => {
      const metrics = {
        ...createFullMetrics(),
        spectralBalance: {
          low: 8,
          sub: 6,
          lowMid: 4,
          mid: 2,
          highMid: 2,
          high: 3,
        },
        integratedLufs: -12,
      };

      const report = generateMixFeedback(metrics, createAnalysisRequest({ genre: "pop" }));

      expect(report.frequencyBalance.overallAssessment).toBe("boomy");
    });

    it("should flag weak low end", () => {
      const metrics = {
        ...createBaseMetrics(),
        spectralBalance: {
          sub: -6,
          low: -8,
          lowMid: -4,
          mid: 2,
          highMid: 2,
          high: 3,
        },
        integratedLufs: -12,
      };

      const report = generateMixFeedback(metrics, createAnalysisRequest({ genre: "pop" }));

      expect(report.frequencyBalance.bassEnergy).toBe("weak");
    });
  });

  describe("High Frequency Analysis", () => {
    it("should flag excessive high frequencies (harsh)", () => {
      const metrics = {
        ...createFullMetrics(),
        spectralBalance: {
          low: 2,
          sub: 3,
          lowMid: 1,
          mid: 2,
          highMid: 8,
          high: 9,
        },
        integratedLufs: -12,
      };

      const report = generateMixFeedback(metrics, createAnalysisRequest());

      expect(report.frequencyBalance.overallAssessment).toBe("harsh");
    });

    it("should flag dull high end", () => {
      const metrics = {
        ...createFullMetrics(),
        spectralBalance: {
          low: 2,
          sub: 3,
          lowMid: 1,
          mid: 2,
          highMid: 0,
          high: -4,
        },
        integratedLufs: -12,
      };

      const report = generateMixFeedback(metrics, createAnalysisRequest());

      expect(report.frequencyBalance.highExtension).toBe("dull");
    });
  });

  describe("Dynamic Range Analysis", () => {
    it("should flag over-compression (low dynamic range)", () => {
      const metrics = {
        ...createFullMetrics(),
        dynamicRange: 3,
        clippingDetected: false,
        integratedLufs: -12,
      };

      const report = generateMixFeedback(metrics, createAnalysisRequest({ genre: "pop" }));

      expect(report.dynamics.overallAssessment).toBe("crushed");
      expect(report.dynamics.compressionAmount).toBe("brick-walled");
      expect(report.dynamics.punch).toBe("killed");
    });

    it("should preserve dynamics with high dynamic range", () => {
      const metrics = {
        ...createFullMetrics(),
        dynamicRange: 18,
        integratedLufs: -16,
      };

      const report = generateMixFeedback(metrics, createAnalysisRequest({ genre: "jazz" }));

      expect(report.dynamics.overallAssessment).toBe("dynamic");
      expect(report.dynamics.compressionAmount).toBe("light");
    });
  });

  describe("Silence Detection", () => {
    it("should flag high silence percentage", () => {
      const metrics = {
        ...createFullMetrics(),
        silencePercent: 25,
        integratedLufs: -12,
      };

      const report = generateMixFeedback(metrics, createAnalysisRequest());

      expect(report.issues.some((i) => i.includes("silence"))).toBe(true);
    });

    it("should not flag normal silence levels", () => {
      const metrics = {
        ...createBaseMetrics(),
        integratedLufs: -12,
        truePeakDbtp: -1.5,
        dynamicRange: 10,
        phaseCorrelation: 0.85,
        stereoWidth: 60,
        clippingDetected: false,
        silencePercent: 3,
        dcOffset: 0.001,
        spectralBalance: {
          low: 2,
          sub: 3,
          lowMid: 1,
          mid: 2,
          highMid: 2,
          high: 3,
        },
      };

      const report = generateMixFeedback(metrics, createAnalysisRequest({ genre: "pop" }));

      expect(report.issues.some((i) => i.includes("silence"))).toBe(false);
    });
  });

  describe("Report Structure Validation", () => {
    it("should generate all required report sections", () => {
      const metrics = createFullMetrics();
      const report = generateMixFeedback(metrics, createAnalysisRequest());

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

    it("should include genre name in summary", () => {
      const metrics = createFullMetrics();
      const report = generateMixFeedback(
        metrics,
        createAnalysisRequest({ genre: "drum-and-bass" })
      );

      expect(report.summary).toContain("Drum and Bass");
    });

    it("should include confidence score", () => {
      const metrics = createFullMetrics();
      const report = generateMixFeedback(metrics, createAnalysisRequest());

      expect(typeof report.confidence).toBe("number");
      expect(report.confidence).toBeGreaterThanOrEqual(0);
      expect(report.confidence).toBeLessThanOrEqual(1);
    });

    it("should have higher confidence with more metrics", () => {
      const minimalMetrics = createBaseMetrics();
      const fullMetrics = createFullMetrics();

      const minimalReport = generateMixFeedback(minimalMetrics, createAnalysisRequest());
      const fullReport = generateMixFeedback(fullMetrics, createAnalysisRequest());

      expect(fullReport.confidence).toBeGreaterThan(minimalReport.confidence);
    });
  });

  describe("Partial Metrics Handling", () => {
    it("should generate report with minimal metrics", () => {
      const metrics: Partial<AudioTechnicalMetrics> = {
        durationSeconds: 120,
        sampleRate: 44100,
        channels: 2,
      };

      const report = generateMixFeedback(metrics, createAnalysisRequest());

      expect(report.summary).toBeDefined();
      expect(report.strengths).toBeDefined();
      expect(report.issues).toBeDefined();
      expect(report.frequencyBalance.overallAssessment).toBe("balanced");
      expect(report.dynamics.overallAssessment).toBe("moderate");
    });

    it("should not make claims about missing metrics", () => {
      const metrics: Partial<AudioTechnicalMetrics> = {
        durationSeconds: 120,
        sampleRate: 44100,
        channels: 2,
      };

      const report = generateMixFeedback(metrics, createAnalysisRequest());

      expect(report.summary).toBeDefined();
      expect(report.issues.some((i) => i.includes("unavailable"))).toBe(true);
    });
  });

  describe("Translation Risks", () => {
    it("should warn about mono collapse for wide stereo", () => {
      const metrics = {
        ...createFullMetrics(),
        stereoWidth: 90,
      };

      const report = generateMixFeedback(metrics, createAnalysisRequest());

      expect(report.translationRisks.some((r) => r.includes("mono"))).toBe(true);
    });

    it("should warn about codec issues for high true peak", () => {
      const metrics = {
        ...createFullMetrics(),
        truePeakDbtp: -0.3,
      };

      const report = generateMixFeedback(metrics, createAnalysisRequest());

      expect(report.translationRisks.some((r) => r.includes("lossy"))).toBe(true);
    });

    it("should warn about sub-bass translation for bass-heavy genres", () => {
      const metrics = {
        ...createFullMetrics(),
        integratedLufs: -7,
        spectralBalance: {
          low: 10, // Extremely heavy
          sub: 8,
          lowMid: 0,
          mid: 2,
          highMid: 4,
          high: 5,
        },
        dynamicRange: 6,
      };

      const report = generateMixFeedback(
        metrics,
        createAnalysisRequest({ genre: "dubstep" })
      );

      expect(report.translationRisks.some((r) => r.includes("small speakers"))).toBe(true);
    });
  });

  describe("Prioritized Fixes", () => {
    it("should prioritize critical issues first", () => {
      const metrics = {
        ...createFullMetrics(),
        clippingDetected: true,
        dynamicRange: 3,
      };

      const report = generateMixFeedback(metrics, createAnalysisRequest());

      const criticalFixes = report.prioritizedFixes.filter((f) => f.priority === "critical");
      expect(criticalFixes.length).toBeGreaterThan(0);
      expect(report.prioritizedFixes[0].priority).toBe("critical");
    });

    it("should include recommendations for each fix", () => {
      const metrics = {
        ...createFullMetrics(),
        clippingDetected: true,
      };

      const report = generateMixFeedback(metrics, createAnalysisRequest());

      expect(report.prioritizedFixes[0]).toHaveProperty("recommendation");
      expect(report.prioritizedFixes[0]).toHaveProperty("estimatedImpact");
    });
  });

  describe("Strengths and Issues Lists", () => {
    it("should list strengths when metrics are good", () => {
      const metrics = createFullMetrics();

      const report = generateMixFeedback(metrics, createAnalysisRequest({ genre: "pop" }));

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

      const report = generateMixFeedback(metrics, createAnalysisRequest());

      expect(report.issues).toBeDefined();
      expect(report.issues.length).toBeGreaterThanOrEqual(2);
    });

    it("should be minimal when no problems detected", () => {
      const metrics = {
        ...createBaseMetrics(),
        integratedLufs: -12,
        truePeakDbtp: -1.5,
        dynamicRange: 10,
        phaseCorrelation: 0.85,
        stereoWidth: 60,
        clippingDetected: false,
        silencePercent: 1,
        dcOffset: 0.0001,
        spectralBalance: {
          low: 2,
          sub: 3,
          lowMid: 1,
          mid: 2,
          highMid: 2,
          high: 3,
        },
      };

      const report = generateMixFeedback(metrics, createAnalysisRequest({ genre: "pop" }));

      // Should have at least one issue (missing LUFS in some sections)
      expect(report.issues.length).toBeLessThan(3);
    });
  });

  describe("Default Genre Handling", () => {
    it("should use Generic profile when no genre specified", () => {
      const metrics = {
        ...createFullMetrics(),
        integratedLufs: -12,
      };

      const report = generateMixFeedback(metrics, createAnalysisRequest());

      expect(report.summary).toContain("Generic");
    });

    it("should use Generic profile for unknown genre", () => {
      const metrics = {
        ...createFullMetrics(),
        integratedLufs: -12,
      };

      const report = generateMixFeedback(
        metrics,
        createAnalysisRequest({ genre: "unknown-genre-xyz" })
      );

      expect(report.summary).toContain("Generic");
    });
  });
});
