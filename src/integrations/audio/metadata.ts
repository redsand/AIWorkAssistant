import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { AudioTechnicalMetrics } from "../../musician/analysis-types";
import type { FfprobeData } from "./types";

/**
 * Attempts to detect if ffprobe is available on the system.
 */
export function detectFfprobe(): boolean {
  // On Windows, check for ffprobe.exe
  // On Unix-like systems, check for ffprobe
  const isWindows = process.platform === "win32";
  const executable = isWindows ? "ffprobe.exe" : "ffprobe";

  try {
    spawn(executable, ["-version"], { detached: true, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Executes ffprobe on an audio file and returns parsed JSON output.
 * Returns null if ffprobe is not available or fails.
 */
export async function runFfprobe(filePath: string): Promise<FfprobeData | null> {
  const isWindows = process.platform === "win32";
  const executable = isWindows ? "ffprobe.exe" : "ffprobe";

  return new Promise((resolve) => {
    const child = spawn(executable, [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ]);

    let output = "";
    let error = "";

    child.stdout.on("data", (data) => {
      output += data.toString();
    });

    child.stderr.on("data", (data) => {
      error += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }

      try {
        const data: FfprobeData = JSON.parse(output);
        resolve(data);
      } catch {
        resolve(null);
      }
    });

    child.on("error", () => {
      resolve(null);
    });
  });
}

/**
 * Converts ffprobe duration string to number of seconds.
 * Handles formats like "123.456789" or "00:01:23.456".
 */
export function parseDuration(durationStr?: string): number | undefined {
  if (!durationStr) return undefined;

  const num = parseFloat(durationStr);
  if (!isNaN(num)) return num;

  // Try parsing HH:MM:SS format
  const parts = durationStr.split(":").map(Number);
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return hours * 3600 + minutes * 60 + seconds;
  }

  return undefined;
}

/**
 * Extracts audio technical metrics from ffprobe data.
 */
export function extractMetricsFromFfprobe(
  data: FfprobeData
): AudioTechnicalMetrics {
  const format = data.format;
  const audioStream = data.streams.find((s) => s.codec_type === "audio");

  const durationSeconds = parseDuration(format.duration || audioStream?.duration);

  return {
    durationSeconds: durationSeconds || 0,
    sampleRate: audioStream?.sample_rate ? parseInt(audioStream.sample_rate, 10) : 48000,
    channels: audioStream?.channels ?? 2,
    // These require additional analysis beyond ffprobe
    // Set to undefined to indicate they need further processing
    integratedLufs: undefined,
    truePeakDbtp: undefined,
    peakDbfs: undefined,
    rmsDb: undefined,
    dynamicRange: undefined,
    crestFactor: undefined,
    spectralCentroid: undefined,
    stereoWidth: undefined,
    phaseCorrelation: undefined,
    tempoBpm: undefined,
    keyEstimate: undefined,
    timeSignatureEstimate: undefined,
    onsetDensity: undefined,
    clippingDetected: undefined,
    silencePercent: undefined,
    dcOffset: undefined,
  };
}

/**
 * Result of audio metadata extraction.
 */
export interface AudioMetadataResult {
  /** Audio technical metrics (may be partial) */
  metrics: AudioTechnicalMetrics;
  /** Warnings encountered during extraction */
  warnings: string[];
  /** Error message if failed */
  error?: string;
}

/**
 * Gets audio metadata from a file using ffprobe if available.
 * Falls back to partial metadata with warnings if ffprobe is not available.
 */
export async function getAudioMetadata(
  filePath: string
): Promise<AudioMetadataResult> {
  const warnings: string[] = [];
  const result: AudioTechnicalMetrics = {
    durationSeconds: 0,
    sampleRate: 48000,
    channels: 2,
  };

  // Check if file exists
  if (!existsSync(filePath)) {
    warnings.push(`File not found: ${filePath}`);
    return { metrics: result, warnings };
  }

  // Try to run ffprobe
  const ffprobeAvailable = detectFfprobe();
  if (!ffprobeAvailable) {
    warnings.push(
      "ffprobe not available. Using default metadata values. Install FFmpeg for detailed analysis."
    );
    return { metrics: result, warnings };
  }

  const ffprobeData = await runFfprobe(filePath);
  if (!ffprobeData) {
    warnings.push(
      "ffprobe returned no data. Check file format support. Using default metadata values."
    );
    return { metrics: result, warnings };
  }

  // Extract metrics
  const metrics = extractMetricsFromFfprobe(ffprobeData);

  // Add format-specific warnings
  if (metrics.durationSeconds === 0) {
    warnings.push("Could not determine audio duration");
  }

  if (metrics.sampleRate === 48000 && !ffprobeData.streams.find((s) => s.codec_type === "audio")?.sample_rate) {
    warnings.push("Could not determine sample rate, using default 48000 Hz");
  }

  return { metrics, warnings };
}

/**
 * Normalizes an audio file for analysis.
 * Converts to WAV format with consistent sample rate and channel configuration.
 * Does not modify the original file.
 */
export async function normalizeAudioForAnalysis(
  inputPath: string,
  outputPath: string,
  options: NormalizeOptions = {}
): Promise<AudioNormalizationResult> {
  const warnings: string[] = [];
  const result: AudioNormalizationResult = {
    outputPath: outputPath,
    warnings,
  };

  const { sampleRate = 48000, channels = "stereo", outputFormat = "wav" } = options;

  // Check if ffmpeg is available
  const isWindows = process.platform === "win32";
  const executable = isWindows ? "ffmpeg.exe" : "ffmpeg";

  if (!existsSync(inputPath)) {
    warnings.push(`Input file not found: ${inputPath}`);
    result.warnings = warnings;
    return result;
  }

  // Check if ffmpeg is available
  try {
    spawn(executable, ["-version"], { detached: true, stdio: "ignore" });
  } catch {
    warnings.push(
      "ffmpeg not available. Returning original file path without normalization."
    );
    result.outputPath = inputPath;
    return result;
  }

  // Ensure output directory exists
  const outputDir = dirname(outputPath);
  if (!existsSync(outputDir)) {
    try {
      mkdirSync(outputDir, { recursive: true });
    } catch {
      warnings.push(`Could not create output directory: ${outputDir}`);
      result.warnings = warnings;
      return result;
    }
  }

  return new Promise((resolve) => {
    // Build ffmpeg command
    const args = ["-i", inputPath];

    // Set sample rate
    args.push("-ar", sampleRate.toString());

    // Set channels
    if (channels === "mono") {
      args.push("-ac", "1");
    } else {
      args.push("-ac", "2");
    }

    // Set output format
    args.push("-f", outputFormat);

    // Add output path
    args.push(outputPath);

    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.on("close", (code) => {
      if (code !== 0) {
        warnings.push(`ffmpeg failed with code ${code}`);
        // Return original file if normalization fails
        result.outputPath = inputPath;
        result.warnings = warnings;
        resolve(result);
        return;
      }

      // Get output file info
      runFfprobe(outputPath).then((data) => {
        if (data) {
          const audioStream = data.streams.find((s) => s.codec_type === "audio");
          result.sampleRate = audioStream?.sample_rate
            ? parseInt(audioStream.sample_rate, 10)
            : sampleRate;
          result.channels = audioStream?.channels ?? (channels === "mono" ? 1 : 2);
        }
        resolve(result);
      });
    });

    child.on("error", () => {
      warnings.push("ffmpeg process error");
      result.outputPath = inputPath;
      result.warnings = warnings;
      resolve(result);
    });
  });
}

/**
 * Options for audio normalization.
 */
export interface NormalizeOptions {
  /** Target sample rate in Hz (default: 48000) */
  sampleRate?: number;
  /** Target channels: 'stereo' or 'mono' (default: 'stereo') */
  channels?: "stereo" | "mono";
  /** Output format: 'wav', 'mp3', 'flac' (default: 'wav') */
  outputFormat?: "wav" | "mp3" | "flac";
}

/**
 * Result of audio normalization process.
 */
export interface AudioNormalizationResult {
  /** Path to the normalized audio file */
  outputPath: string;
  /** Any warnings encountered during normalization */
  warnings: string[];
  /** Actual sample rate after normalization */
  sampleRate?: number;
  /** Actual channels after normalization */
  channels?: number;
}