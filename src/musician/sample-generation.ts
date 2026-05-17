/**
 * Musician Assistant - Sample Generation Provider Abstraction
 *
 * Provider abstraction for text-to-music generation with safety validation.
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { MusicGenerationRequest, MusicGenerationResult } from "./analysis-types";
import { generateWithMusicGen } from "../integrations/audio/musicgen-adapter";

// =============================================================================
// Constants and Configuration
// =============================================================================

/**
 * Maximum allowed duration for generated audio (in seconds).
 * Prevents excessive generation costs and resource usage.
 */
const MAX_GENERATION_DURATION_SECONDS = 60;

/**
 * Default output directory for generated audio files.
 */
const DEFAULT_OUTPUT_DIR = join(process.cwd(), "data", "musician", "generated");

/**
 * List of phrases that indicate unsafe soundalike requests.
 * These patterns detect attempts to recreate copyrighted works or living artist styles.
 */
const UNSAFE_PROMPT_PATTERNS = [
  /sound(?:s|ing)?\s+(?:like|similar\s+to|as|identical\s+to)/i,
  /in\s+the\s+(?:exact\s+)?style\s+of/i,
  /copy(?:ing)?\s+(?:the\s+)?sound\s+of/i,
  /recreate/i,
  /exactly\s+like/i,
  /clone\s+(?:the\s+)?(?:voice|sound|style)/i,
];

/**
 * List of famous living artists whose direct soundalikes should be rejected.
 * This is a sample list - in production, this would be more comprehensive.
 */
const PROTECTED_ARTISTS = [
  "taylor swift",
  "drake",
  "beyonce",
  "ed sheeran",
  "billie eilish",
  "ariana grande",
  "the weeknd",
  "kanye west",
  "post malone",
  "dua lipa",
];

// =============================================================================
// Provider Interface
// =============================================================================

/**
 * Provider interface for music generation.
 *
 * All music generation providers must implement this interface.
 */
export interface MusicGenerationProvider {
  /**
   * Unique name identifying this provider.
   */
  name: string;

  /**
   * Check if this provider is currently available and properly configured.
   *
   * @returns Promise resolving to true if available, false otherwise
   */
  isAvailable(): Promise<boolean>;

  /**
   * Generate music from a text prompt.
   *
   * @param request - The music generation request
   * @returns Promise resolving to the generation result
   */
  generate(request: MusicGenerationRequest): Promise<MusicGenerationResult>;
}

// =============================================================================
// Mock Provider Implementation
// =============================================================================

/**
 * Mock music generation provider.
 *
 * Always available. Creates metadata only, no real audio.
 * Optionally creates a tiny placeholder JSON file in the generated audio directory.
 * Used in tests and dry-run scenarios.
 */
export class MockMusicGenerationProvider implements MusicGenerationProvider {
  name = "mock";

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async generate(request: MusicGenerationRequest): Promise<MusicGenerationResult> {
    const assetId = `mock_gen_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const outputDir = DEFAULT_OUTPUT_DIR;

    // Ensure output directory exists
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    // Create placeholder metadata file
    const metadataPath = join(outputDir, `${assetId}_metadata.json`);
    const placeholderMetadata = {
      provider: "mock",
      prompt: request.prompt,
      durationSeconds: request.durationSeconds,
      genre: request.genre,
      mood: request.mood,
      tempo: request.tempo,
      key: request.key,
      seed: request.seed,
      generatedAt: new Date().toISOString(),
      note: "This is a mock generation - no real audio was created",
    };

    writeFileSync(metadataPath, JSON.stringify(placeholderMetadata, null, 2));

    return {
      assetId,
      filePath: metadataPath,
      durationSeconds: request.durationSeconds,
      prompt: request.prompt,
      model: "mock-v1",
      seed: request.seed || Math.floor(Math.random() * 1000000),
      createdAt: new Date().toISOString(),
      metadata: {
        genre: request.genre || "unknown",
        mood: request.mood || "neutral",
        tempo: request.tempo || 120,
        key: request.key || "C",
        duration: request.durationSeconds,
        modelVersion: "mock-v1.0.0",
        generationTimeSeconds: 0,
        license: "personal",
      },
      warnings: [
        "Mock mode: This is a sample generation. No actual audio was created.",
        "To generate real audio, configure MUSICIAN_GENERATION_PROVIDER environment variable.",
        `Metadata file created at: ${metadataPath}`,
      ],
    };
  }
}

// =============================================================================
// Local MusicGen Provider Implementation
// =============================================================================

/**
 * Local MusicGen provider.
 *
 * Checks MUSICIAN_ENABLE_MUSICGEN environment variable and local command availability.
 * Calls integrations/audio/musicgen-adapter.ts for actual generation.
 * If unavailable, returns useful error/warning.
 */
export class LocalMusicGenProvider implements MusicGenerationProvider {
  name = "local_musicgen";

  async isAvailable(): Promise<boolean> {
    // Check if local MusicGen is enabled via environment variable
    const isEnabled = process.env.MUSICIAN_ENABLE_MUSICGEN === "true";
    if (!isEnabled) {
      return false;
    }

    // Check if MUSICGEN_MODE is set to local or mock
    const musicgenMode = process.env.MUSICGEN_MODE;
    if (musicgenMode && musicgenMode !== "local" && musicgenMode !== "mock") {
      return false;
    }

    // Additional checks could be added here:
    // - Check if Python is installed
    // - Check if required Python packages are available
    // - Check if model files exist

    return true;
  }

  async generate(request: MusicGenerationRequest): Promise<MusicGenerationResult> {
    const isAvail = await this.isAvailable();
    if (!isAvail) {
      const assetId = `unavail_${Date.now()}`;
      return {
        assetId,
        filePath: "",
        durationSeconds: request.durationSeconds,
        prompt: request.prompt,
        model: "local_musicgen",
        seed: request.seed || 0,
        createdAt: new Date().toISOString(),
        metadata: {
          genre: request.genre || "unknown",
          mood: request.mood || "neutral",
          tempo: request.tempo || 120,
          key: request.key || "C",
          duration: request.durationSeconds,
          modelVersion: "unavailable",
          generationTimeSeconds: 0,
          license: "personal",
        },
        warnings: [
          "Local MusicGen provider is not available.",
          "To enable: Set MUSICIAN_ENABLE_MUSICGEN=true in your environment.",
          "Ensure MUSICGEN_MODE is set to 'local' and local dependencies are installed.",
          "See musicgen-adapter.ts documentation for setup instructions.",
        ],
      };
    }

    const outputDir = DEFAULT_OUTPUT_DIR;

    // Ensure output directory exists
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    // Call the musicgen adapter
    const startTime = Date.now();
    const musicgenResult = await generateWithMusicGen(request, outputDir);
    const generationTimeSeconds = (Date.now() - startTime) / 1000;

    // Convert MusicGenGenerationResult to MusicGenerationResult
    return {
      assetId: musicgenResult.assetId,
      filePath: musicgenResult.filePath,
      durationSeconds: musicgenResult.duration,
      prompt: musicgenResult.prompt,
      model: musicgenResult.model || "facebook/musicgen-small",
      seed: musicgenResult.seed || request.seed || 0,
      createdAt: new Date().toISOString(),
      metadata: {
        genre: musicgenResult.genre || request.genre || "unknown",
        mood: musicgenResult.mood || request.mood || "neutral",
        tempo: musicgenResult.tempo || request.tempo || 120,
        key: musicgenResult.key || request.key || "C",
        duration: musicgenResult.duration,
        modelVersion: musicgenResult.model || "facebook/musicgen-small",
        generationTimeSeconds,
        license: "personal",
      },
      warnings: musicgenResult.warnings || [],
    };
  }
}

// =============================================================================
// Hugging Face MusicGen Provider Implementation
// =============================================================================

/**
 * Hugging Face MusicGen provider.
 *
 * Requires HUGGINGFACE_API_TOKEN environment variable.
 * Implementation is isolated and does not make network calls in tests.
 * Contains TODO comments for endpoint selection.
 */
export class HuggingFaceMusicGenProvider implements MusicGenerationProvider {
  name = "huggingface";

  async isAvailable(): Promise<boolean> {
    // Check if Hugging Face API token is configured
    const apiToken = process.env.HUGGINGFACE_API_TOKEN || process.env.HF_API_TOKEN;
    return !!apiToken;
  }

  async generate(request: MusicGenerationRequest): Promise<MusicGenerationResult> {
    const apiToken = process.env.HUGGINGFACE_API_TOKEN || process.env.HF_API_TOKEN;

    if (!apiToken) {
      const assetId = `unavail_hf_${Date.now()}`;
      return {
        assetId,
        filePath: "",
        durationSeconds: request.durationSeconds,
        prompt: request.prompt,
        model: "huggingface/musicgen",
        seed: request.seed || 0,
        createdAt: new Date().toISOString(),
        metadata: {
          genre: request.genre || "unknown",
          mood: request.mood || "neutral",
          tempo: request.tempo || 120,
          key: request.key || "C",
          duration: request.durationSeconds,
          modelVersion: "unavailable",
          generationTimeSeconds: 0,
          license: "personal",
        },
        warnings: [
          "Hugging Face provider is not available.",
          "To enable: Set HUGGINGFACE_API_TOKEN or HF_API_TOKEN in your environment.",
          "Get your token at: https://huggingface.co/settings/tokens",
        ],
      };
    }

    // TODO: Implement actual Hugging Face API endpoint selection
    // Options:
    // 1. Inference API: https://huggingface.co/docs/api-inference/index
    // 2. Inference Endpoints (dedicated): https://huggingface.co/inference-endpoints
    // 3. AutoTrain API for custom models
    //
    // Recommended endpoint: https://api-inference.huggingface.co/models/facebook/musicgen-small
    // For production, consider using dedicated Inference Endpoints for better reliability

    const assetId = `hf_gen_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const outputDir = DEFAULT_OUTPUT_DIR;

    // Ensure output directory exists
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    // TODO: Implement actual API call
    // const endpoint = "https://api-inference.huggingface.co/models/facebook/musicgen-small";
    // const response = await fetch(endpoint, {
    //   method: "POST",
    //   headers: {
    //     "Authorization": `Bearer ${apiToken}`,
    //     "Content-Type": "application/json",
    //   },
    //   body: JSON.stringify({
    //     inputs: request.prompt,
    //     parameters: {
    //       duration: request.durationSeconds,
    //       temperature: 1.0,
    //       top_k: 250,
    //       top_p: 0.0,
    //     },
    //   }),
    // });

    // Placeholder implementation for now
    const placeholderPath = join(outputDir, `${assetId}_placeholder.json`);
    const placeholderData = {
      provider: "huggingface",
      status: "not_implemented",
      message: "Hugging Face generation is not yet fully implemented",
      prompt: request.prompt,
      note: "This would call the Hugging Face Inference API in production",
    };

    writeFileSync(placeholderPath, JSON.stringify(placeholderData, null, 2));

    return {
      assetId,
      filePath: placeholderPath,
      durationSeconds: request.durationSeconds,
      prompt: request.prompt,
      model: "facebook/musicgen-small",
      seed: request.seed || Math.floor(Math.random() * 1000000),
      createdAt: new Date().toISOString(),
      metadata: {
        genre: request.genre || "unknown",
        mood: request.mood || "neutral",
        tempo: request.tempo || 120,
        key: request.key || "C",
        duration: request.durationSeconds,
        modelVersion: "facebook/musicgen-small",
        generationTimeSeconds: 0,
        license: "personal",
      },
      warnings: [
        "Hugging Face provider: API call implementation is pending.",
        "TODO: Implement actual Hugging Face Inference API integration.",
        `Placeholder file created at: ${placeholderPath}`,
      ],
    };
  }
}

// =============================================================================
// Provider Selection and Factory
// =============================================================================

/**
 * Provider type as specified in environment variable.
 */
export type ProviderType = "mock" | "local_musicgen" | "huggingface";

/**
 * Get the configured provider type from environment variables.
 *
 * @returns The configured provider type, defaulting to "mock"
 */
export function getConfiguredProviderType(): ProviderType {
  const envValue = process.env.MUSICIAN_GENERATION_PROVIDER;

  if (envValue === "local_musicgen" || envValue === "huggingface" || envValue === "mock") {
    return envValue;
  }

  return "mock";
}

/**
 * Create a provider instance based on the specified type.
 *
 * @param type - The provider type to create
 * @returns A provider instance
 */
export function createProvider(type: ProviderType): MusicGenerationProvider {
  switch (type) {
    case "local_musicgen":
      return new LocalMusicGenProvider();
    case "huggingface":
      return new HuggingFaceMusicGenProvider();
    case "mock":
    default:
      return new MockMusicGenerationProvider();
  }
}

/**
 * Get the appropriate provider based on request and environment.
 *
 * If request.modelPreference is specified, it will be used only if:
 * 1. The preferred provider is available
 * 2. It's safe to use (passes validation checks)
 *
 * Otherwise, falls back to the environment-configured provider.
 *
 * @param request - The music generation request
 * @returns Promise resolving to the selected provider
 */
export async function selectProvider(
  request: MusicGenerationRequest
): Promise<MusicGenerationProvider> {
  // Try to honor explicit request preference if specified
  if (request.modelPreference) {
    const preferredProvider = createProvider(request.modelPreference);
    const isAvailable = await preferredProvider.isAvailable();

    if (isAvailable) {
      return preferredProvider;
    }
  }

  // Fall back to environment-configured provider
  const configuredType = getConfiguredProviderType();
  const provider = createProvider(configuredType);

  // If configured provider is not available, fall back to mock
  const isAvailable = await provider.isAvailable();
  if (!isAvailable && configuredType !== "mock") {
    return new MockMusicGenerationProvider();
  }

  return provider;
}

// =============================================================================
// Validation and Safety
// =============================================================================

/**
 * Result of prompt validation.
 */
export interface PromptValidationResult {
  /**
   * Whether the prompt is safe to use.
   */
  safe: boolean;

  /**
   * Original prompt.
   */
  originalPrompt: string;

  /**
   * Sanitized/rewritten prompt (if applicable).
   */
  sanitizedPrompt?: string;

  /**
   * Warnings about the prompt.
   */
  warnings: string[];

  /**
   * Details about why the prompt was flagged (if unsafe).
   */
  reason?: string;
}

/**
 * Validate a generation request for safety and policy compliance.
 *
 * Checks for:
 * - Maximum duration enforcement
 * - Unsafe soundalike prompts (living artists, copyrighted works)
 *
 * @param request - The music generation request to validate
 * @returns Validation result with safety status and any warnings
 */
export function validateGenerationRequest(
  request: MusicGenerationRequest
): PromptValidationResult {
  const warnings: string[] = [];
  let safe = true;
  let sanitizedPrompt: string | undefined;
  let reason: string | undefined;

  // 1. Enforce maximum duration
  if (request.durationSeconds > MAX_GENERATION_DURATION_SECONDS) {
    warnings.push(
      `Duration ${request.durationSeconds}s exceeds maximum ${MAX_GENERATION_DURATION_SECONDS}s. ` +
      `Request will be capped at ${MAX_GENERATION_DURATION_SECONDS}s.`
    );
    // This is a warning but not a rejection - we can just cap the duration
  }

  // 2. Check for unsafe soundalike patterns
  const prompt = request.prompt.toLowerCase();

  // Check for protected artist names
  for (const artist of PROTECTED_ARTISTS) {
    if (prompt.includes(artist.toLowerCase())) {
      // Check if it's a direct soundalike request
      for (const pattern of UNSAFE_PROMPT_PATTERNS) {
        if (pattern.test(request.prompt)) {
          safe = false;
          reason = `Prompt requests a direct soundalike of protected artist: ${artist}`;
          warnings.push(
            `Unsafe prompt detected: Requests soundalike of living artist "${artist}". ` +
            `This violates copyright and personality rights.`
          );

          // Try to rewrite to style-neutral alternative
          sanitizedPrompt = rewriteUnsafePrompt(request.prompt, artist);
          warnings.push(
            `Suggested alternative: "${sanitizedPrompt}"`
          );
          break;
        }
      }
      if (!safe) break;
    }
  }

  // 3. Check for generic soundalike patterns even without specific artist names
  if (safe) {
    for (const pattern of UNSAFE_PROMPT_PATTERNS) {
      if (pattern.test(request.prompt)) {
        warnings.push(
          `Warning: Prompt may request a soundalike. ` +
          `Consider rephrasing to focus on genre, mood, and instrumentation instead of specific artists.`
        );
        // This is a warning but not a hard rejection
        break;
      }
    }
  }

  return {
    safe,
    originalPrompt: request.prompt,
    sanitizedPrompt,
    warnings,
    reason,
  };
}

/**
 * Rewrite an unsafe prompt to a style-neutral alternative.
 *
 * Attempts to extract genre/mood/instrumentation while removing artist references.
 *
 * @param prompt - The original unsafe prompt
 * @param artistName - The artist name to remove
 * @returns A sanitized prompt focusing on musical characteristics
 */
function rewriteUnsafePrompt(prompt: string, artistName: string): string {
  // Remove the artist name and soundalike phrases
  let rewritten = prompt
    .replace(new RegExp(artistName, "gi"), "")
    // Handle compound patterns first (e.g., "sound exactly like")
    .replace(/sound(?:s|ing)?\s+exactly\s+like/gi, "")
    .replace(/sound(?:s|ing)?\s+(?:like|similar\s+to|as|identical\s+to)/gi, "")
    .replace(/in\s+the\s+(?:exact\s+)?style\s+of/gi, "")
    .replace(/copy(?:ing)?\s+(?:the\s+)?sound\s+of/gi, "")
    .replace(/recreate/gi, "")
    .replace(/exactly\s+like/gi, "")
    .replace(/clone\s+(?:the\s+)?(?:voice|sound|style)/gi, "")
    // Remove common filler words that might be left over
    .replace(/\b(?:make\s+it|it)\b/gi, "");

  // Clean up extra whitespace
  rewritten = rewritten.replace(/\s+/g, " ").trim();

  // If the prompt is now too short, add generic descriptors
  if (rewritten.length < 10) {
    rewritten = "Contemporary pop music with modern production";
  }

  return rewritten;
}

/**
 * Main entry point for generating music with provider abstraction and validation.
 *
 * This function:
 * 1. Validates the request for safety and policy compliance
 * 2. Selects the appropriate provider
 * 3. Generates the music
 * 4. Returns the result with any warnings
 *
 * @param request - The music generation request
 * @returns Promise resolving to the generation result
 * @throws Error if the request is unsafe and cannot be processed
 */
export async function generateMusic(
  request: MusicGenerationRequest
): Promise<MusicGenerationResult> {
  // Step 1: Validate the request
  const validation = validateGenerationRequest(request);

  if (!validation.safe) {
    throw new Error(
      `Unsafe generation request: ${validation.reason}\n` +
      `Original prompt: "${validation.originalPrompt}"\n` +
      `Suggested alternative: "${validation.sanitizedPrompt}"`
    );
  }

  // Step 2: Cap duration if needed
  const cappedRequest: MusicGenerationRequest = {
    ...request,
    durationSeconds: Math.min(request.durationSeconds, MAX_GENERATION_DURATION_SECONDS),
  };

  // Step 3: Select provider
  const provider = await selectProvider(cappedRequest);

  // Step 4: Generate music
  const result = await provider.generate(cappedRequest);

  // Step 5: Add validation warnings to result
  if (validation.warnings.length > 0) {
    result.warnings = [...(result.warnings || []), ...validation.warnings];
  }

  return result;
}
