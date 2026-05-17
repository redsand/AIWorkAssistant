/**
 * Tests for audio analysis pipeline.
 *
 * Tests:
 * - File resolution and validation
 * - Metadata extraction with/without ffprobe
 * - Graceful degradation when backends unavailable
 * - Report generation for different analysis types
 * - Error handling for missing files
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type {
  AudioAnalysisRequest,
  AudioTechnicalMetrics,
  MixFeedbackReport,
  MasteringFeedbackReport,
} from "../../../src/musician/analysis-types";
import {
  analyzeAudio,
  validateAudioFile,
  getAnalysisDirectory,
  type AudioAnalysisResult,
} from "../../../src/musician/audio-analysis";

// =============================================================================
// Test Setup
// =============================================================================

let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  // Save original environment variables
  originalEnv = {
    MUSICIAN_ENABLE_ESSENTIA: process.env.MUSICIAN_ENABLE_ESSENTIA,
    MUSICIAN_ENABLE_BASIC_PITCH: process.env.MUSICIAN_ENABLE_BASIC_PITCH,
  };
});

afterEach(() => {
  // Restore original environment variables
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

/**
 * Create a sample audio analysis request for testing.
 */
function createSampleRequest(
  overrides?: Partial<AudioAnalysisRequest>
): AudioAnalysisRequest {
  return {
    filePath: "test-audio.wav",
    analysisType: "mixdown",
    genre: "electronic",
    ...overrides,
  };
}

// =============================================================================
// File Resolution Tests
// =============================================================================

describe("analyzeAudio - file resolution", () => {
  it("should reject when neither fileId nor filePath is provided", async () => {
    const request: AudioAnalysisRequest = {
      analysisType: "mixdown",
    };

    await expect(analyzeAudio(request)).rejects.toThrow(
      "Either fileId or filePath must be provided"
    );
  });

  it("should reject when file does not exist", async () => {
    const request = createSampleRequest({
      filePath: "/nonexistent/path/audio.wav",
    });

    await expect(analyzeAudio(request)).rejects.toThrow("not found");
  });
});

// =============================================================================
// Metadata Extraction Tests
// =============================================================================

describe("analyzeAudio - metadata extraction", () => {
  it("should handle missing ffprobe gracefully", async () => {
    // This test will pass even without ffprobe installed
    // It should return stub metrics and warnings
    const request = createSampleRequest({
      filePath: __filename, // Use this test file as a dummy audio file
    });

    const result = await analyzeAudio(request);

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.metrics).toBeDefined();
    expect(result.metrics.durationSeconds).toBeDefined();
    expect(result.metrics.sampleRate).toBeDefined();
    expect(result.metrics.channels).toBeDefined();
  });

  it("should include warnings about unavailable backends", async () => {
    delete process.env.MUSICIAN_ENABLE_ESSENTIA;
    delete process.env.MUSICIAN_ENABLE_BASIC_PITCH;

    const request = createSampleRequest({
      filePath: __filename,
    });

    const result = await analyzeAudio(request);

    expect(
      result.warnings.some((w) => w.includes("Essentia") || w.includes("ffprobe"))
    ).toBe(true);
  });
});

// =============================================================================
// Report Generation Tests
// =============================================================================

describe("analyzeAudio - report generation", () => {
  it("should generate mixdown report", async () => {
    const request = createSampleRequest({
      filePath: __filename,
      analysisType: "mixdown",
    });

    const result = await analyzeAudio(request);

    expect(result.report).toBeDefined();
    expect(typeof result.report).toBe("object");

    const mixReport = result.report as MixFeedbackReport;
    expect(mixReport.summary).toBeDefined();
    expect(mixReport.strengths).toBeDefined();
    expect(mixReport.issues).toBeDefined();
  });

  it("should generate mastering report", async () => {
    const request = createSampleRequest({
      filePath: __filename,
      analysisType: "mastering",
    });

    const result = await analyzeAudio(request);

    expect(result.report).toBeDefined();
    expect(typeof result.report).toBe("object");

    const masterReport = result.report as MasteringFeedbackReport;
    expect(masterReport.releaseReadiness).toBeDefined();
    expect(masterReport.loudness).toBeDefined();
  });

  it("should generate composition feedback", async () => {
    const request = createSampleRequest({
      filePath: __filename,
      analysisType: "composition",
    });

    const result = await analyzeAudio(request);

    expect(result.report).toBeDefined();
    expect(typeof result.report).toBe("string");
    expect(result.report).toContain("Composition Analysis");
  });

  it("should generate arrangement feedback", async () => {
    const request = createSampleRequest({
      filePath: __filename,
      analysisType: "arrangement",
    });

    const result = await analyzeAudio(request);

    expect(result.report).toBeDefined();
    expect(typeof result.report).toBe("string");
    expect(result.report).toContain("Arrangement Analysis");
  });

  it("should generate performance feedback", async () => {
    const request = createSampleRequest({
      filePath: __filename,
      analysisType: "performance",
    });

    const result = await analyzeAudio(request);

    expect(result.report).toBeDefined();
    expect(typeof result.report).toBe("string");
    expect(result.report).toContain("Performance Analysis");
  });

  it("should generate transcription feedback", async () => {
    const request = createSampleRequest({
      filePath: __filename,
      analysisType: "transcription",
    });

    const result = await analyzeAudio(request);

    expect(result.report).toBeDefined();
    expect(typeof result.report).toBe("string");
    expect(result.report).toContain("Transcription");
  });

  it("should generate combined report for 'all' analysis type", async () => {
    const request = createSampleRequest({
      filePath: __filename,
      analysisType: "all",
    });

    const result = await analyzeAudio(request);

    expect(result.report).toBeDefined();
    expect(typeof result.report).toBe("string");
    expect(result.report).toContain("Complete Audio Analysis");
    expect(result.report).toContain("Technical Summary");
  });
});

// =============================================================================
// Transcription Tests
// =============================================================================

describe("analyzeAudio - transcription", () => {
  it("should not run transcription when not requested", async () => {
    const request = createSampleRequest({
      filePath: __filename,
      analysisType: "mixdown",
    });

    const result = await analyzeAudio(request);

    expect(result.transcription).toBeUndefined();
  });

  it("should warn when transcription requested but Basic Pitch unavailable", async () => {
    delete process.env.MUSICIAN_ENABLE_BASIC_PITCH;

    const request = createSampleRequest({
      filePath: __filename,
      analysisType: "transcription",
    });

    const result = await analyzeAudio(request);

    expect(
      result.warnings.some((w) => w.includes("Basic Pitch"))
    ).toBe(true);
  });
});

// =============================================================================
// Confidence Level Tests
// =============================================================================

describe("analyzeAudio - confidence level", () => {
  it("should have lower confidence with many warnings", async () => {
    delete process.env.MUSICIAN_ENABLE_ESSENTIA;
    delete process.env.MUSICIAN_ENABLE_BASIC_PITCH;

    const request = createSampleRequest({
      filePath: __filename,
      analysisType: "all",
    });

    const result = await analyzeAudio(request);

    expect(result.confidence).toBeLessThan(1.0);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("should include confidence in result", async () => {
    const request = createSampleRequest({
      filePath: __filename,
    });

    const result = await analyzeAudio(request);

    expect(result.confidence).toBeDefined();
    expect(typeof result.confidence).toBe("number");
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});

// =============================================================================
// Error Handling Tests
// =============================================================================

describe("analyzeAudio - error handling", () => {
  it("should not crash when optional backends are unavailable", async () => {
    delete process.env.MUSICIAN_ENABLE_ESSENTIA;
    delete process.env.MUSICIAN_ENABLE_BASIC_PITCH;

    const request = createSampleRequest({
      filePath: __filename,
    });

    // Should not throw
    const result = await analyzeAudio(request);
    expect(result).toBeDefined();
  });

  it("should return structured error for missing files", async () => {
    const request = createSampleRequest({
      filePath: "/this/does/not/exist.wav",
    });

    await expect(analyzeAudio(request)).rejects.toThrow();
  });
});

// =============================================================================
// Utility Function Tests
// =============================================================================

describe("validateAudioFile", () => {
  it("should return false for nonexistent file ID", async () => {
    const result = await validateAudioFile("nonexistent-id");
    expect(result).toBe(false);
  });
});

describe("getAnalysisDirectory", () => {
  it("should return analysis directory path", () => {
    const dir = getAnalysisDirectory();
    expect(dir).toBeDefined();
    expect(typeof dir).toBe("string");
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe("analyzeAudio - integration", () => {
  it("should complete full analysis pipeline", async () => {
    const request = createSampleRequest({
      filePath: __filename,
      analysisType: "mixdown",
      genre: "electronic",
      includeTechnicalMetrics: true,
      includeActionPlan: true,
    });

    const result = await analyzeAudio(request);

    expect(result.metrics).toBeDefined();
    expect(result.report).toBeDefined();
    expect(result.warnings).toBeDefined();
    expect(result.confidence).toBeDefined();
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("should handle genre-specific analysis", async () => {
    const request = createSampleRequest({
      filePath: __filename,
      analysisType: "mixdown",
      genre: "drum-and-bass",
    });

    const result = await analyzeAudio(request);

    expect(result.report).toBeDefined();
    // Should use drum-and-bass genre profile for analysis
  });

  it("should respect listeningContext parameter", async () => {
    const request = createSampleRequest({
      filePath: __filename,
      analysisType: "mixdown",
      listeningContext: "earbuds",
    });

    const result = await analyzeAudio(request);

    expect(result.report).toBeDefined();
  });
});
