import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { AudioNormalizationResult, NormalizeOptions } from "./types";

/**
 * Detects if ffmpeg is available on the system.
 */
export function detectFfmpeg(): boolean {
  const isWindows = process.platform === "win32";
  const executable = isWindows ? "ffmpeg.exe" : "ffmpeg";

  try {
    spawn(executable, ["-version"], { detached: true, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalizes an audio file for analysis.
 * Converts to WAV format with consistent sample rate and channel configuration.
 * Does not modify the original file.
 *
 * @param inputPath - Path to the input audio file
 * @param outputPath - Path for the output normalized audio file
 * @param options - Normalization options (sample rate, channels, output format)
 * @returns Result containing output path and any warnings
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

  // Check if input file exists
  if (!existsSync(inputPath)) {
    warnings.push(`Input file not found: ${inputPath}`);
    return result;
  }

  // Check if ffmpeg is available
  const ffmpegAvailable = detectFfmpeg();
  if (!ffmpegAvailable) {
    warnings.push(
      "ffmpeg not available. Returning original file path without normalization. " +
      "Install FFmpeg for audio processing: https://ffmpeg.org/download.html"
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
    const isWindows = process.platform === "win32";
    const executable = isWindows ? "ffmpeg.exe" : "ffmpeg";
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
      // Note: In a full implementation, we would run ffprobe here to get exact sample rate
      result.sampleRate = sampleRate;
      result.channels = channels === "mono" ? 1 : 2;
      result.warnings = warnings;
      resolve(result);
    });

    child.on("error", () => {
      warnings.push("ffmpeg process error");
      result.outputPath = inputPath;
      result.warnings = warnings;
      resolve(result);
    });
  });
}
