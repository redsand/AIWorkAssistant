import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { MusicGenGenerationResult, MusicGenConfig } from "./types";
import type { MusicGenerationRequest } from "../../musician/analysis-types";

/**
 * MusicGen audio generation adapter.
 *
 * MusicGen is Meta's audio generation model that can generate music from text descriptions.
 * This adapter supports multiple modes:
 *
 * 1. dryRun mode: Returns a preview without generating audio
 * 2. mock mode: Returns sample/mock audio data
 * 3. local mode: Uses a local MusicGen Python implementation
 * 4. hf (Hugging Face) mode: Uses Hugging Face Inference API
 * 5. external mode: Uses an external API endpoint
 *
 * For MVP, only dryRun and mock modes are implemented.
 * To enable full functionality:
 *
 * Option 1 - Local MusicGen:
 *   - pip install torch torchvision torchaudio
 *   - pip install musicgen
 *   - Set MUSICGEN_MODE=local and MUSICGEN_LOCAL_PATH in environment
 *
 * Option 2 - Hugging Face:
 *   - pip install huggingface_hub
 *   - Set MUSICGEN_MODE=hf and HF_API_TOKEN in environment
 *
 * Option 3 - External API:
 *   - Configure external service endpoint
 *   - Set MUSICGEN_MODE=external and MUSICGEN_API_URL in environment
 */

// Configured via environment variables
const MUSICGEN_CONFIG: MusicGenConfig = {
  mode: (process.env.MUSICGEN_MODE as any) || "mock",
  localModelPath: process.env.MUSICGEN_LOCAL_PATH,
  hfModelId: process.env.MUSICGEN_HF_MODEL_ID || "facebook/musicgen-small",
  apiUrl: process.env.MUSICGEN_API_URL,
  apiKey: process.env.MUSICGEN_API_KEY,
  defaultDuration: parseInt(process.env.MUSICGEN_DEFAULT_DURATION || "15"),
};

/**
 * Validates MusicGen configuration and checks mode availability.
 */
export function validateMusicGenMode(): {
  valid: boolean;
  mode: "dryRun" | "mock" | "local" | "hf" | "external";
  warnings: string[];
} {
  const warnings: string[] = [];
  const mode = MUSICGEN_CONFIG.mode || "mock";

  // dryRun and mock are always available
  if (mode === "dryRun" || mode === "mock") {
    return { valid: true, mode, warnings };
  }

  // For other modes, check configuration
  if (mode === "local") {
    if (!MUSICGEN_CONFIG.localModelPath) {
      warnings.push("MUSICGEN_MODE=local but MUSICGEN_LOCAL_PATH not set");
      return { valid: false, mode, warnings };
    }
    return { valid: true, mode, warnings };
  }

  if (mode === "hf") {
    if (!process.env.HF_API_TOKEN) {
      warnings.push("MUSICGEN_MODE=hf but HF_API_TOKEN not set");
      return { valid: false, mode, warnings };
    }
    return { valid: true, mode, warnings };
  }

  if (mode === "external") {
    if (!MUSICGEN_CONFIG.apiUrl) {
      warnings.push("MUSICGEN_MODE=external but MUSICGEN_API_URL not set");
      return { valid: false, mode, warnings };
    }
    return { valid: true, mode, warnings };
  }

  warnings.push(`Invalid MusicGen mode: ${mode}`);
  return { valid: false, mode: "mock", warnings };
}

/**
 * Generates audio using MusicGen.
 *
 * For MVP, only dryRun and mock modes are supported.
 * Full implementation would add local, hf, and external modes.
 */
export async function generateWithMusicGen(
  request: MusicGenerationRequest,
  outputDir: string,
  config?: MusicGenConfig
): Promise<MusicGenGenerationResult> {
  const warnings: string[] = [];
  const result: MusicGenGenerationResult = {
    assetId: `gen_${Date.now()}`,
    filePath: "",
    duration: request.durationSeconds || 15,
    mode: "mock",
    prompt: request.prompt,
    warnings,
  };

  // Get effective config
  const effectiveConfig = config || MUSICGEN_CONFIG;
  const mode = effectiveConfig.mode || "mock";

  // Check if output directory exists
  if (!existsSync(outputDir)) {
    try {
      mkdirSync(outputDir, { recursive: true });
    } catch {
      warnings.push(`Could not create output directory: ${outputDir}`);
      result.warnings = warnings;
      return result;
    }
  }

  // dryRun mode - return preview without generation
  if (request.dryRun || mode === "dryRun") {
    result.mode = "dryRun";
    result.filePath = join(outputDir, "dry-run-preview.wav");
    result.warnings = ["dryRun: No audio generated - preview only"];
    return result;
  }

  // mock mode - return sample data
  if (mode === "mock") {
    result.mode = "mock";
    result.filePath = join(outputDir, `mock-generated-${Date.now()}.wav`);
    result.warnings = [
      "Mock mode: This is a sample generation. Configure MUSICGEN_MODE for real generation.",
      "Options: local (requires MusicGen installation), hf (requires Hugging Face API token), external (requires API endpoint)",
    ];
    return result;
  }

  // For non-MVP modes, validate configuration
  const validation = validateMusicGenMode();
  if (!validation.valid) {
    warnings.push(...validation.warnings);
    result.warnings = warnings;
    return result;
  }

  // Local mode
  if (mode === "local") {
    return generateWithMusicGenLocal(request, outputDir, effectiveConfig);
  }

  // Hugging Face mode
  if (mode === "hf") {
    return generateWithMusicGenHF(request, outputDir, effectiveConfig);
  }

  // External mode
  if (mode === "external") {
    return generateWithMusicGenExternal(request, outputDir, effectiveConfig);
  }

  // Fallback to mock
  result.mode = "mock";
  result.warnings = ["Falling back to mock mode - no valid MusicGen configuration found"];
  return result;
}

/**
 * Generates audio using local MusicGen (Python implementation).
 */
async function generateWithMusicGenLocal(
  request: MusicGenerationRequest,
  outputDir: string,
  config: MusicGenConfig
): Promise<MusicGenGenerationResult> {
  const warnings: string[] = [];
  const result: MusicGenGenerationResult = {
    assetId: `gen_${Date.now()}`,
    filePath: join(outputDir, `generated-${Date.now()}.wav`),
    duration: request.durationSeconds || 15,
    mode: "local",
    prompt: request.prompt,
    warnings,
  };

  // Python script for local MusicGen
  const pythonScript = `
import torch
import torchaudio
import sys
import json

try:
    from musicgen import MusicGen
    model = MusicGen.get_pretrained("${config.hfModelId || "facebook/musicgen-small"}")
    model.set_generation_params(duration=${request.durationSeconds || 15})

    audio, sampling_rate = model.generate([ "${request.prompt}" ])

    # Save audio
    torchaudio.save("${result.filePath}", audio, sampling_rate)
    print(json.dumps({"success": True}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
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
          if (!data.success) {
            warnings.push(`Local generation failed: ${data.error}`);
          }
        } catch {
          warnings.push("Failed to parse local generation output");
        }
      } else {
        warnings.push(`Local MusicGen failed with code ${code}`);
      }
      result.warnings = warnings;
    });
  } catch {
    warnings.push("Local MusicGen failed to start");
    result.warnings = warnings;
  }

  return result;
}

/**
 * Generates audio using Hugging Face Inference API.
 */
async function generateWithMusicGenHF(
  request: MusicGenerationRequest,
  outputDir: string,
  config: MusicGenConfig
): Promise<MusicGenGenerationResult> {
  const warnings: string[] = [];
  const result: MusicGenGenerationResult = {
    assetId: `gen_${Date.now()}`,
    filePath: join(outputDir, `generated-${Date.now()}.wav`),
    duration: request.durationSeconds || 15,
    mode: "hf",
    prompt: request.prompt,
    warnings,
  };

  const apiKey = process.env.HF_API_TOKEN || config.apiKey;
  if (!apiKey) {
    warnings.push("Hugging Face API token not found");
    result.warnings = warnings;
    return result;
  }

  // In a full implementation, this would make an API call to Hugging Face
  warnings.push("Hugging Face generation: API call would be made here");
  result.warnings = warnings;
  return result;
}

/**
 * Generates audio by calling the local MusicGen Python service.
 */
async function generateWithMusicGenExternal(
  request: MusicGenerationRequest,
  outputDir: string,
  config: MusicGenConfig
): Promise<MusicGenGenerationResult> {
  const warnings: string[] = [];

  const apiUrl = config.apiUrl;
  if (!apiUrl) {
    return {
      assetId: `gen_${Date.now()}`,
      filePath: "",
      duration: request.durationSeconds || 15,
      mode: "external",
      prompt: request.prompt,
      warnings: ["MUSICGEN_API_URL not set — cannot reach MusicGen service"],
    };
  }

  const response = await fetch(`${apiUrl}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: request.prompt,
      duration_seconds: request.durationSeconds || 15,
      genre: request.genre,
      key: request.key,
      tempo: request.tempo,
      model: request.modelPreference,
    }),
    signal: AbortSignal.timeout(300_000), // 5 min — large models are slow
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`MusicGen service error ${response.status}: ${text}`);
  }

  const data = await response.json() as {
    asset_id: string;
    file_path: string;
    audio_base64: string;
    sample_rate: number;
    duration: number;
    model: string;
    warnings: string[];
  };

  // Save the base64 audio locally so the Node server can serve it
  const { writeFileSync, mkdirSync, existsSync } = await import("fs");
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const filename = `${data.asset_id}.wav`;
  const filePath = join(outputDir, filename);
  writeFileSync(filePath, Buffer.from(data.audio_base64, "base64"));

  return {
    assetId: data.asset_id,
    filePath,
    duration: data.duration,
    mode: "external",
    model: data.model,
    prompt: request.prompt,
    warnings: [...warnings, ...data.warnings],
  };
}