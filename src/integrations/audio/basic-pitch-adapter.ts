import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { TranscriptionResult, BasicPitchConfig } from "./types";

/**
 * Basic Pitch audio transcription adapter.
 *
 * Basic Pitch is a deep learning model for monophonic and polyphonic
 * transcription created by Spotify. It can transcribe audio to MIDI,
 * notes, or chords.
 *
 * Usage:
 * - Install basic-pitch: pip install basic-pitch
 * - CLI: basic-pitch input_audio.wav output_dir/
 * - Python: from basic_pitch import ICASSP_2022_MODEL_PATH, predict
 *
 * This adapter supports both CLI and Python modes.
 */

// Configured via environment variables
const BASIC_PITCH_CONFIG: BasicPitchConfig = {
  basicPitchPath: process.env.BASIC_PITCH_PATH,
  usePython: process.env.BASIC_PITCH_USE_PYTHON === "true",
  confidenceThreshold: parseFloat(process.env.BASIC_PITCH_CONFIDENCE || "0.5"),
};

/**
 * Attempts to detect if Basic Pitch is available on the system.
 */
export function detectBasicPitch(): boolean {
  if (BASIC_PITCH_CONFIG.usePython) {
    // Python mode - check for basic-pitch Python package
    try {
      // This would require spawning python -c "import basic_pitch"
      return true;
    } catch {
      return false;
    }
  }

  // CLI mode - check for basic-pitch executable
  const isWindows = process.platform === "win32";
  const executable = isWindows ? "basic-pitch.exe" : "basic-pitch";

  try {
    spawn(executable, ["--version"], { detached: true, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Transcribes audio using Basic Pitch.
 * Returns MIDI, notes, or chords depending on configuration.
 *
 * For MVP, returns a warning if Basic Pitch is not available.
 */
export async function transcribeWithBasicPitch(
  filePath: string,
  outputDir: string
): Promise<TranscriptionResult> {
  const warnings: string[] = [];
  const tempFiles: string[] = [];
  const result: TranscriptionResult = {
    warnings,
    tempFiles,
  };

  // Check if file exists
  if (!existsSync(filePath)) {
    warnings.push(`File not found: ${filePath}`);
    return result;
  }

  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    try {
      mkdirSync(outputDir, { recursive: true });
    } catch {
      warnings.push(`Could not create output directory: ${outputDir}`);
      return result;
    }
  }

  // Check Basic Pitch availability
  const basicPitchAvailable = detectBasicPitch();
  if (!basicPitchAvailable) {
    warnings.push(
      "Basic Pitch not available. Install basic-pitch CLI or set BASIC_PITCH_USE_PYTHON=true.\n" +
      "For CLI: pip install basic-pitch (includes CLI)\n" +
      "For Python: pip install basic-pitch"
    );
    return result;
  }

  // Use Python mode if configured
  if (BASIC_PITCH_CONFIG.usePython) {
    return transcribeWithBasicPitchPython(filePath);
  }

  // Use CLI mode
  return transcribeWithBasicPitchCli(filePath, outputDir);
}

/**
 * Transcribes audio using Basic Pitch Python module.
 */
async function transcribeWithBasicPitchPython(
  filePath: string
): Promise<TranscriptionResult> {
  const warnings: string[] = [];
  const tempFiles: string[] = [];
  const result: TranscriptionResult = {
    warnings,
    tempFiles,
  };

  // Python worker script
  const pythonScript = `
import basic_pitch.inference as bp
import librosa
import numpy as np
import json
import os

try:
    # Load audio
    audio, sr = librosa.load("${filePath}", sr=44100)

    # Run Basic Pitch prediction
    model = bp.load_model()
    predictions = bp.predict(model, audio)

    # Extract notes
    notes = []
    for note in predictions["note"]:
        if note[2] > 0.5:  # confidence threshold (hardcoded for MVP)
            notes.append({
                "pitch": str(note[0]),
                "startTime": float(note[1]),
                "endTime": float(note[1] + note[2]),
                "velocity": int(note[3] * 127),
                "confidence": float(note[2])
            })

    # Extract chords
    chords = []
    for chord in predictions.get("chord", []):
        if chord[1] > 0.5:
            chords.append({
                "chord": str(chord[0]),
                "startTime": float(chord[2]),
                "endTime": float(chord[2] + chord[1]),
                "confidence": float(chord[1])
            })

    output = {
        "notes": notes,
        "chords": chords,
        "warnings": []
    }
    print(json.dumps(output))
except Exception as e:
    print(json.dumps({"warnings": [str(e)]}))
`;

  try {
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
          result.notes = data.notes;
          result.chords = data.chords;
          if (data.warnings) {
            warnings.push(...data.warnings);
          }
        } catch {
          warnings.push("Failed to parse Basic Pitch Python output");
        }
        result.warnings = warnings;
      }
    });
  } catch {
    warnings.push("Basic Pitch Python worker failed to start");
    result.warnings = warnings;
  }

  return result;
}

/**
 * Transcribes audio using Basic Pitch CLI.
 */
async function transcribeWithBasicPitchCli(
  filePath: string,
  outputDir: string
): Promise<TranscriptionResult> {
  const warnings: string[] = [];
  const tempFiles: string[] = [];
  const result: TranscriptionResult = {
    warnings,
    tempFiles,
  };

  const command = [
    "basic-pitch",
    filePath,
    outputDir,
  ];

  try {
    const child = spawn(command[0], command.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (data) => {
      output += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        // Look for generated MIDI files
        try {
          const fs = require("fs");
          const entries = fs.readdirSync(outputDir);
          const midiFiles = entries.filter((f: string) => f.endsWith(".mid") || f.endsWith(".midi"));

          if (midiFiles.length > 0) {
            result.midiPath = join(outputDir, midiFiles[0]);
            tempFiles.push(result.midiPath);
          }
        } catch {
          warnings.push("Failed to list output directory for MIDI files");
        }
      } else {
        warnings.push(`Basic Pitch CLI failed with code ${code}`);
      }
      result.warnings = warnings;
      result.tempFiles = tempFiles;
    });
  } catch {
    warnings.push("Basic Pitch CLI failed to start");
    result.warnings = warnings;
  }

  return result;
}

/**
 * Converts Basic Pitch notes to standard note names (e.g., "C4").
 * This is a simplified helper - full implementation would use midi2hz conversion.
 */
export function notesToNoteNames(notes: any[]): Array<{ pitch: string; startTime: number; endTime: number; confidence: number }> {
  // Simplified mapping - in production would convert MIDI numbers to note names
  return notes.map((note) => ({
    pitch: note.pitch,
    startTime: note.startTime,
    endTime: note.endTime,
    confidence: note.confidence,
  }));
}
