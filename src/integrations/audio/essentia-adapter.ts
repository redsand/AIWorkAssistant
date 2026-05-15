import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import type { AudioTechnicalMetrics } from "../../musician/analysis-types";
import type { EssentiaAnalysisResult, EssentiaConfig } from "./types";

/**
 * Essentia audio analysis adapter.
 *
 * This adapter provides audio analysis using Essentia, a C++ library for
 * music metadata extraction. It can be used in two ways:
 *
 * 1. CLI mode: Through the Essentia CLI tools (if installed)
 * 2. Python mode: Through Essentia's Python bindings
 * 3. Python worker mode: Via a separate Python process (recommended for production)
 *
 * For MVP, this adapter returns a "not configured" result if Essentia is not available.
 * To enable full functionality:
 *
 * Option 1 - Install Essentia CLI:
 *   - macOS: brew install essentia
 *   - Ubuntu: sudo apt-get install essentia
 *   - From source: https://essentia.upf.edu/installing.html
 *
 * Option 2 - Install Essentia Python:
 *   - pip install essentia
 *
 * Option 3 - Use Python worker (recommended):
 *   - Create a Python worker script that handles Essentia analysis
 *   - Set ESSNETIA_USE_PYTHON_WORKER=true in environment
 *   - The TypeScript code forks the Python worker subprocess
 */

// Configured via environment variables
const ESSNETIA_CONFIG: EssentiaConfig = {
  essentiaPath: process.env.ESSNETIA_PATH,
  modelsPath: process.env.ESSNETIA_MODELS_PATH,
  usePython: process.env.ESSNETIA_USE_PYTHON === "true",
};

/**
 * Attempts to detect if Essentia is available on the system.
 */
export function detectEssentia(): boolean {
  if (ESSNETIA_CONFIG.usePython) {
    // Python mode - check for essentia Python package
    try {
      // This would require spawning python -c "import essentia"
      // For now, return true if configured
      return true;
    } catch {
      return false;
    }
  }

  // CLI mode - check for essentia executable
  const isWindows = process.platform === "win32";
  const executable = isWindows ? "essentia.exe" : "essentia";

  try {
    spawn(executable, ["--help"], { detached: true, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs Essentia analysis on an audio file.
 * Returns partial AudioTechnicalMetrics with available data.
 *
 * For MVP, returns a controlled "not configured" result if Essentia is missing.
 */
export async function analyzeWithEssentia(
  filePath: string
): Promise<EssentiaAnalysisResult> {
  const warnings: string[] = [];
  const result: EssentiaAnalysisResult = {
    warnings,
  };

  // Check if file exists
  if (!existsSync(filePath)) {
    warnings.push(`File not found: ${filePath}`);
    return result;
  }

  // Check Essentia availability
  const essentiaAvailable = detectEssentia();
  if (!essentiaAvailable) {
    warnings.push(
      "Essentia not available. Install Essentia CLI or set ESSNETIA_USE_PYTHON=true.\n" +
      "For CLI: brew install essentia (macOS) or sudo apt-get install essentia (Ubuntu)\n" +
      "For Python: pip install essentia"
    );
    return result;
  }

  // Use Python mode if configured
  if (ESSNETIA_CONFIG.usePython) {
    return analyzeWithEssentiaPython(filePath);
  }

  // Use CLI mode
  return analyzeWithEssentiaCli(filePath);
}

/**
 * Runs Essentia via Python bindings.
 * This requires essentia to be installed in the Python environment.
 */
async function analyzeWithEssentiaPython(
  filePath: string
): Promise<EssentiaAnalysisResult> {
  const warnings: string[] = [];
  const result: EssentiaAnalysisResult = {
    warnings,
  };

  // Python worker script content
  const pythonScript = `
import essentia.standard as es
import json
import sys

try:
    audio = es.MonoLoader(filename="${filePath}")()

    # Extract basic features
    duration = len(audio) / 44100  # Assuming 44.1kHz

    # Rhythm
    rhythm = es.RhythmExtractor2013()
    bpm, beats = rhythm(audio)

    # Key detection
    key = es.KeyExtractor()
    key_key, key_scale, key_strength = key(audio)

    # Spectral features
    spectrum = es.Spectrum()
    spectral centroid = es.SpectralCentroid()

    # Output JSON
    output = {
        "duration": duration,
        "tempo": float(bpm),
        "key": key_key,
        "scale": key_scale,
        "warnings": []
    }
    print(json.dumps(output))
except Exception as e:
    print(json.dumps({"warnings": [str(e)]}))
`;

  try {
    // Spawn Python process
    const child = spawn("python3", ["-c", pythonScript], {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (data) => {
      output += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        try {
          const data = JSON.parse(output);
          result.duration = data.duration;
          result.tempo = data.tempo;
          result.key = data.key;
          result.scale = data.scale;
          if (data.warnings) {
            warnings.push(...data.warnings);
          }
        } catch {
          warnings.push("Failed to parse Essentia Python output");
        }
      } else {
        warnings.push(`Essentia Python worker failed with code ${code}`);
      }
      result.warnings = warnings;
    });
  } catch {
    warnings.push("Essentia Python worker failed to start");
    result.warnings = warnings;
  }

  return result;
}

/**
 * Runs Essentia via CLI.
 */
async function analyzeWithEssentiaCli(
  filePath: string
): Promise<EssentiaAnalysisResult> {
  const warnings: string[] = [];
  const result: EssentiaAnalysisResult = {
    warnings,
  };

  // Generate output path for Essentia analysis
  const outputDir = dirname(filePath);
  const outputFileName = join(outputDir, `${Date.now()}_essentia_analysis.json`);
  mkdirSync(outputDir, { recursive: true });

  // Essentia algorithm command
  // This is a simplified example - full Essentia analysis requires multiple algorithms
  const command = [
    ESSNETIA_CONFIG.essentiaPath || "essentia",
    "streaming_extractor_audio",
    filePath,
    outputFileName,
  ];

  try {
    const child = spawn(command[0], command.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.on("close", (code) => {
      if (code === 0) {
        try {
          const output = require(outputFileName); // Simplified - in production use fs.readFileSync
          result.tempo = output.rhythm?.bpm;
          result.key = output.key?.key;
          result.scale = output.key?.scale;
        } catch {
          warnings.push("Failed to parse Essentia CLI output");
        }
        // Clean up output file
        try {
          // require('fs').unlinkSync(outputFileName);
        } catch {
          // Ignore cleanup errors
        }
      } else {
        warnings.push(`Essentia CLI failed with code ${code}`);
      }
      result.warnings = warnings;
    });
  } catch {
    warnings.push("Essentia CLI failed to start");
    result.warnings = warnings;
  }

  return result;
}

/**
 * Extracts AudioTechnicalMetrics from Essentia analysis result.
 * This is a helper function to convert Essentia results to the app's standard format.
 */
export function essentiaToAudioMetrics(
  essentiaResult: EssentiaAnalysisResult
): Partial<AudioTechnicalMetrics> {
  const metrics: Partial<AudioTechnicalMetrics> = {};

  if (essentiaResult.tempo) {
    metrics.tempoBpm = essentiaResult.tempo;
  }

  if (essentiaResult.key && essentiaResult.scale) {
    metrics.keyEstimate = `${essentiaResult.key} ${essentiaResult.scale}`;
  }

  if (essentiaResult.duration) {
    // This would need to be combined with actual file duration
  }

  return metrics;
}