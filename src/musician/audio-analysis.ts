/**
 * Musician Assistant - Audio Analysis Pipeline
 *
 * Orchestrates audio analysis from file input to feedback report generation.
 * Handles multiple analysis types with graceful degradation when optional
 * backends are unavailable.
 */

import { existsSync, copyFileSync, mkdirSync } from "fs";
import { join, extname } from "path";
import { env } from "../config/env";
import type {
  AudioAnalysisRequest,
  AudioTechnicalMetrics,
  MixFeedbackReport,
  MasteringFeedbackReport,
} from "./analysis-types";
import { getAudioAsset, getMusicianAssetFilePath } from "./assets";
import { runFfprobe, extractMetricsFromFfprobe, detectFfprobe } from "../integrations/audio/metadata";
import { generateMixFeedback } from "./mix-feedback";
import { generateMasteringFeedback } from "./mastering";

// =============================================================================
// Configuration
// =============================================================================

const AUDIO_ANALYSIS_DIR = env.MUSICIAN_AUDIO_ANALYSIS_DIR;

/**
 * Check if Essentia is enabled and available.
 */
function isEssentiaEnabled(): boolean {
  return process.env.MUSICIAN_ENABLE_ESSENTIA === "true";
}

/**
 * Check if Basic Pitch is enabled and available.
 */
function isBasicPitchEnabled(): boolean {
  return process.env.MUSICIAN_ENABLE_BASIC_PITCH === "true";
}

// =============================================================================
// Types
// =============================================================================

/**
 * Analysis result including metrics, report, and optional transcription.
 */
export interface AudioAnalysisResult {
  /**
   * Technical audio metrics extracted from the file.
   * May be partial if some analysis backends are unavailable.
   */
  metrics: AudioTechnicalMetrics;

  /**
   * Generated feedback report based on analysis type.
   * Type depends on analysisType in request.
   */
  report: MixFeedbackReport | MasteringFeedbackReport | string;

  /**
   * Transcription result if requested and available.
   * Only present when analysisType includes "transcription".
   */
  transcription?: unknown;

  /**
   * Warnings encountered during analysis.
   * Non-fatal issues like unavailable backends or partial data.
   */
  warnings: string[];

  /**
   * Confidence level in the analysis (0-1).
   * Based on availability of analysis backends and data quality.
   */
  confidence: number;
}

// =============================================================================
// Pipeline Steps
// =============================================================================

/**
 * Step 1: Resolve file ID to safe file path.
 *
 * @param fileId - The file ID or direct file path
 * @returns Resolved file path
 * @throws Error if file doesn't exist or is inaccessible
 */
async function resolveFilePath(fileId?: string, filePath?: string): Promise<string> {
  if (filePath) {
    // Direct file path provided
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    return filePath;
  }

  if (fileId) {
    // Resolve file ID to path
    try {
      const resolvedPath = await getMusicianAssetFilePath(fileId);
      if (!existsSync(resolvedPath)) {
        throw new Error(`File not found for ID: ${fileId}`);
      }
      return resolvedPath;
    } catch (error) {
      throw new Error(`Failed to resolve file ID ${fileId}: ${error}`);
    }
  }

  throw new Error("Either fileId or filePath must be provided");
}

/**
 * Step 2: Read metadata using ffprobe.
 *
 * @param filePath - Path to the audio file
 * @returns Audio technical metrics
 */
async function readMetadata(filePath: string): Promise<{
  metrics: Partial<AudioTechnicalMetrics>;
  warnings: string[];
}> {
  const warnings: string[] = [];

  // Check if ffprobe is available
  if (!detectFfprobe()) {
    warnings.push(
      "ffprobe not available - metadata extraction limited. " +
      "Install ffmpeg to enable full metadata extraction."
    );
    // Return minimal stub metrics
    return {
      metrics: {
        durationSeconds: 0,
        sampleRate: 44100,
        channels: 2,
      },
      warnings,
    };
  }

  // Run ffprobe
  const ffprobeData = await runFfprobe(filePath);
  if (!ffprobeData) {
    warnings.push("ffprobe failed to extract metadata - using stub values");
    return {
      metrics: {
        durationSeconds: 0,
        sampleRate: 44100,
        channels: 2,
      },
      warnings,
    };
  }

  // Extract metrics from ffprobe data
  const metrics = extractMetricsFromFfprobe(ffprobeData);
  return { metrics, warnings };
}

/**
 * Step 3: Normalize/copy to analysis directory.
 *
 * Creates a working copy in the analysis directory for processing.
 * Optionally normalizes audio to standard format.
 *
 * @param sourcePath - Original file path
 * @param fileId - File identifier for naming
 * @returns Path to analysis copy
 */
function prepareAnalysisFile(sourcePath: string, fileId: string): {
  analysisPath: string;
  warnings: string[];
} {
  const warnings: string[] = [];

  // Ensure analysis directory exists
  if (!existsSync(AUDIO_ANALYSIS_DIR)) {
    mkdirSync(AUDIO_ANALYSIS_DIR, { recursive: true });
  }

  // Create analysis filename
  const ext = extname(sourcePath);
  const analysisFilename = `analysis_${fileId}_${Date.now()}${ext}`;
  const analysisPath = join(AUDIO_ANALYSIS_DIR, analysisFilename);

  // For now, just copy the file
  // TODO: Add normalization with ffmpeg when available
  try {
    copyFileSync(sourcePath, analysisPath);
  } catch (error) {
    warnings.push(`Failed to copy file to analysis directory: ${error}`);
  }

  return { analysisPath, warnings };
}

/**
 * Step 4: Run lightweight waveform metrics.
 *
 * Basic metrics that can be extracted without external tools.
 *
 * @param filePath - Path to audio file
 * @param baseMetrics - Metrics already extracted from metadata
 * @returns Enhanced metrics with waveform data
 */
async function extractWaveformMetrics(
  filePath: string,
  baseMetrics: Partial<AudioTechnicalMetrics>
): Promise<{
  metrics: Partial<AudioTechnicalMetrics>;
  warnings: string[];
}> {
  const warnings: string[] = [];

  // For now, return base metrics
  // TODO: Implement actual waveform analysis when needed
  warnings.push("Waveform analysis not yet implemented - using metadata only");

  return { metrics: baseMetrics, warnings };
}

/**
 * Step 5: Run Essentia analysis if enabled.
 *
 * Extracts advanced metrics like key, tempo, spectral features.
 *
 * @param filePath - Path to audio file
 * @param baseMetrics - Metrics already extracted
 * @returns Enhanced metrics with Essentia data
 */
async function runEssentiaAnalysis(
  filePath: string,
  baseMetrics: Partial<AudioTechnicalMetrics>
): Promise<{
  metrics: Partial<AudioTechnicalMetrics>;
  warnings: string[];
}> {
  const warnings: string[] = [];

  if (!isEssentiaEnabled()) {
    warnings.push(
      "Essentia analysis not enabled. " +
      "Set MUSICIAN_ENABLE_ESSENTIA=true to enable advanced analysis."
    );
    return { metrics: baseMetrics, warnings };
  }

  // TODO: Implement actual Essentia integration
  warnings.push("Essentia integration not yet implemented");

  return { metrics: baseMetrics, warnings };
}

/**
 * Step 6: Run Basic Pitch transcription if requested and enabled.
 *
 * @param filePath - Path to audio file
 * @param requested - Whether transcription was requested
 * @returns Transcription result or undefined
 */
async function runTranscription(
  filePath: string,
  requested: boolean
): Promise<{
  transcription?: unknown;
  warnings: string[];
}> {
  const warnings: string[] = [];

  if (!requested) {
    return { warnings };
  }

  if (!isBasicPitchEnabled()) {
    warnings.push(
      "Basic Pitch transcription not enabled. " +
      "Set MUSICIAN_ENABLE_BASIC_PITCH=true to enable transcription."
    );
    return { warnings };
  }

  // TODO: Implement actual Basic Pitch integration
  warnings.push("Basic Pitch transcription not yet implemented");

  return { warnings };
}

/**
 * Step 7: Generate feedback report based on analysis type.
 *
 * @param analysisType - Type of analysis requested
 * @param metrics - Extracted audio metrics
 * @param genre - Genre for context-aware analysis
 * @param request - Full analysis request for context
 * @returns Generated report
 */
function generateReport(
  analysisType: AudioAnalysisRequest["analysisType"],
  metrics: AudioTechnicalMetrics,
  genre?: string,
  request?: AudioAnalysisRequest
): MixFeedbackReport | MasteringFeedbackReport | string {
  switch (analysisType) {
    case "mixdown":
      return generateMixFeedback(metrics, {
        genre,
        targetReferences: request?.targetReferences,
        listeningContext: request?.listeningContext,
      });

    case "mastering":
      return generateMasteringFeedback(metrics, {
        genre,
        targetReferences: request?.targetReferences,
      });

    case "composition":
    case "arrangement":
      return buildCompositionFeedback(metrics, analysisType, genre);

    case "performance":
      return buildPerformanceFeedback(metrics, genre);

    case "transcription":
      return "Transcription analysis complete. See transcription field for note data.";

    case "all":
      return buildCombinedReport(metrics, genre, request);

    default:
      return `Analysis type ${analysisType} not implemented yet.`;
  }
}

/**
 * Build composition/arrangement feedback.
 *
 * @param metrics - Audio metrics
 * @param type - Analysis type
 * @param genre - Genre context
 * @returns Feedback string
 */
function buildCompositionFeedback(
  metrics: AudioTechnicalMetrics,
  type: "composition" | "arrangement",
  genre?: string
): string {
  const lines: string[] = [];

  lines.push(`# ${type === "composition" ? "Composition" : "Arrangement"} Analysis`);
  lines.push("");

  if (metrics.keyEstimate) {
    lines.push(`**Detected Key:** ${metrics.keyEstimate}`);
  }

  if (metrics.tempoBpm) {
    lines.push(`**Tempo:** ${metrics.tempoBpm} BPM`);
  }

  if (metrics.timeSignatureEstimate) {
    lines.push(`**Time Signature:** ${metrics.timeSignatureEstimate}`);
  }

  lines.push("");
  lines.push("**Note:** Full composition analysis requires additional analysis backends.");
  lines.push("Enable Essentia and Basic Pitch for detailed harmonic and melodic analysis.");

  return lines.join("\n");
}

/**
 * Build performance feedback.
 *
 * @param metrics - Audio metrics
 * @param genre - Genre context
 * @returns Feedback string
 */
function buildPerformanceFeedback(
  metrics: AudioTechnicalMetrics,
  genre?: string
): string {
  const lines: string[] = [];

  lines.push("# Performance Analysis");
  lines.push("");
  lines.push(`**Duration:** ${metrics.durationSeconds.toFixed(1)}s`);

  if (metrics.tempoBpm) {
    lines.push(`**Tempo:** ${metrics.tempoBpm} BPM`);
  }

  if (metrics.onsetDensity) {
    lines.push(`**Rhythmic Complexity:** ${metrics.onsetDensity.toFixed(2)} onsets/second`);
  }

  lines.push("");
  lines.push("**Note:** Full performance analysis requires additional analysis backends.");
  lines.push("Enable transcription for detailed timing and intonation analysis.");

  return lines.join("\n");
}

/**
 * Build combined report for "all" analysis type.
 *
 * @param metrics - Audio metrics
 * @param genre - Genre context
 * @param request - Full request for context
 * @returns Combined report string
 */
function buildCombinedReport(
  metrics: AudioTechnicalMetrics,
  genre?: string,
  request?: AudioAnalysisRequest
): string {
  const lines: string[] = [];

  lines.push("# Complete Audio Analysis");
  lines.push("");

  // Technical summary
  lines.push("## Technical Summary");
  lines.push(`- Duration: ${metrics.durationSeconds.toFixed(1)}s`);
  lines.push(`- Sample Rate: ${metrics.sampleRate} Hz`);
  lines.push(`- Channels: ${metrics.channels === 1 ? "Mono" : "Stereo"}`);

  if (metrics.integratedLufs !== undefined) {
    lines.push(`- Integrated Loudness: ${metrics.integratedLufs.toFixed(1)} LUFS`);
  }

  if (metrics.truePeakDbtp !== undefined) {
    lines.push(`- True Peak: ${metrics.truePeakDbtp.toFixed(1)} dBTP`);
  }

  lines.push("");

  // Mix analysis
  lines.push("## Mix Analysis");
  const mixReport = generateMixFeedback(metrics, { genre });
  lines.push(mixReport.summary);

  lines.push("");

  // Mastering analysis
  lines.push("## Mastering Analysis");
  const masterReport = generateMasteringFeedback(metrics, { genre });
  lines.push(`Release Readiness: ${masterReport.releaseReadiness}`);

  lines.push("");
  lines.push("---");
  lines.push("*For detailed analysis in each category, run individual analysis types.*");

  return lines.join("\n");
}

/**
 * Calculate confidence level based on available data.
 *
 * @param metrics - Extracted metrics
 * @param warnings - Analysis warnings
 * @returns Confidence score 0-1
 */
function calculateConfidence(
  metrics: Partial<AudioTechnicalMetrics>,
  warnings: string[]
): number {
  let confidence = 1.0;

  // Reduce confidence for each warning
  confidence -= warnings.length * 0.1;

  // Reduce confidence for missing critical metrics
  if (!metrics.integratedLufs) confidence -= 0.2;
  if (!metrics.truePeakDbtp) confidence -= 0.1;
  if (!metrics.tempoBpm) confidence -= 0.1;
  if (!metrics.keyEstimate) confidence -= 0.1;

  // Ensure confidence stays in valid range
  return Math.max(0.1, Math.min(1.0, confidence));
}

// =============================================================================
// Main Analysis Function
// =============================================================================

/**
 * Analyze an audio file and generate feedback report.
 *
 * This is the main entry point for the audio analysis pipeline.
 * It orchestrates all analysis steps and handles graceful degradation
 * when optional backends are unavailable.
 *
 * @param request - Audio analysis request
 * @returns Analysis result with metrics, report, and warnings
 * @throws Error if file cannot be accessed or critical analysis fails
 */
export async function analyzeAudio(
  request: AudioAnalysisRequest
): Promise<AudioAnalysisResult> {
  const allWarnings: string[] = [];

  try {
    // Step 1: Resolve file ID to safe file path
    const filePath = await resolveFilePath(request.fileId, request.filePath);

    // Generate a file ID for analysis artifacts
    const fileId = request.fileId || `direct_${Date.now()}`;

    // Step 2: Read metadata
    const { metrics: baseMetrics, warnings: metadataWarnings } = await readMetadata(filePath);
    allWarnings.push(...metadataWarnings);

    // Step 3: Normalize/copy to analysis directory
    const { analysisPath, warnings: prepWarnings } = prepareAnalysisFile(filePath, fileId);
    allWarnings.push(...prepWarnings);

    // Step 4: Run lightweight waveform metrics
    const { metrics: waveformMetrics, warnings: waveformWarnings } = await extractWaveformMetrics(
      analysisPath,
      baseMetrics
    );
    allWarnings.push(...waveformWarnings);

    // Step 5: Run Essentia analysis if enabled
    const { metrics: essentiaMetrics, warnings: essentiaWarnings } = await runEssentiaAnalysis(
      analysisPath,
      waveformMetrics
    );
    allWarnings.push(...essentiaWarnings);

    // Step 6: Run transcription if requested
    const isTranscriptionRequested =
      request.analysisType === "transcription" || request.analysisType === "all";
    const { transcription, warnings: transcriptionWarnings } = await runTranscription(
      analysisPath,
      isTranscriptionRequested
    );
    allWarnings.push(...transcriptionWarnings);

    // Ensure we have required metrics for report generation
    const completeMetrics: AudioTechnicalMetrics = {
      durationSeconds: essentiaMetrics.durationSeconds || 0,
      sampleRate: essentiaMetrics.sampleRate || 44100,
      channels: essentiaMetrics.channels || 2,
      ...essentiaMetrics,
    } as AudioTechnicalMetrics;

    // Step 7: Generate report based on analysis type
    const report = generateReport(
      request.analysisType,
      completeMetrics,
      request.genre,
      request
    );

    // Calculate confidence level
    const confidence = calculateConfidence(completeMetrics, allWarnings);

    return {
      metrics: completeMetrics,
      report,
      transcription,
      warnings: allWarnings,
      confidence,
    };
  } catch (error) {
    // If file doesn't exist or required parameters are missing, throw error
    // These should be handled by the route layer with proper HTTP status codes
    if (error instanceof Error) {
      if (error.message.includes("not found") ||
          error.message.includes("must be provided") ||
          error.message.includes("Failed to resolve")) {
        throw error;
      }
    }

    // For other errors, provide fallback response
    allWarnings.push(`Analysis failed: ${error}`);

    return {
      metrics: {
        durationSeconds: 0,
        sampleRate: 44100,
        channels: 2,
      } as AudioTechnicalMetrics,
      report: `Analysis failed: ${error}`,
      warnings: allWarnings,
      confidence: 0,
    };
  }
}

/**
 * Validate that a file exists and is accessible.
 *
 * @param fileId - File ID to validate
 * @returns True if file exists, false otherwise
 */
export async function validateAudioFile(fileId: string): Promise<boolean> {
  try {
    const filePath = await getMusicianAssetFilePath(fileId);
    return existsSync(filePath);
  } catch {
    return false;
  }
}

/**
 * Get analysis artifacts directory path.
 *
 * @returns Path to analysis directory
 */
export function getAnalysisDirectory(): string {
  return AUDIO_ANALYSIS_DIR;
}
