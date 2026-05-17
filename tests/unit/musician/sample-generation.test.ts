/**
 * Tests for music generation provider abstraction.
 *
 * Tests:
 * - Mock provider availability and generation
 * - Provider selection logic
 * - Unsafe prompt detection and rewriting
 * - Duration validation
 * - Environment variable configuration
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MockMusicGenerationProvider,
  LocalMusicGenProvider,
  HuggingFaceMusicGenProvider,
  createProvider,
  getConfiguredProviderType,
  selectProvider,
  validateGenerationRequest,
  generateMusic,
  type MusicGenerationProvider,
  type PromptValidationResult,
} from "../../../src/musician/sample-generation";
import type { MusicGenerationRequest } from "../../../src/musician/analysis-types";

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Store original environment variables to restore after tests.
 */
let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  // Save original environment variables
  originalEnv = {
    MUSICIAN_GENERATION_PROVIDER: process.env.MUSICIAN_GENERATION_PROVIDER,
    MUSICIAN_ENABLE_MUSICGEN: process.env.MUSICIAN_ENABLE_MUSICGEN,
    HUGGINGFACE_API_TOKEN: process.env.HUGGINGFACE_API_TOKEN,
    HF_API_TOKEN: process.env.HF_API_TOKEN,
    MUSICGEN_MODE: process.env.MUSICGEN_MODE,
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
 * Create a sample music generation request for testing.
 */
function createSampleRequest(overrides?: Partial<MusicGenerationRequest>): MusicGenerationRequest {
  return {
    prompt: "upbeat electronic dance music with synth leads",
    durationSeconds: 15,
    genre: "electronic",
    mood: "energetic",
    tempo: 128,
    key: "A minor",
    ...overrides,
  };
}

// =============================================================================
// Mock Provider Tests
// =============================================================================

describe("MockMusicGenerationProvider", () => {
  it("should always be available", async () => {
    const provider = new MockMusicGenerationProvider();
    const isAvailable = await provider.isAvailable();
    expect(isAvailable).toBe(true);
  });

  it("should generate mock result with metadata", async () => {
    const provider = new MockMusicGenerationProvider();
    const request = createSampleRequest();
    const result = await provider.generate(request);

    expect(result.assetId).toMatch(/^mock_gen_/);
    expect(result.prompt).toBe(request.prompt);
    expect(result.durationSeconds).toBe(request.durationSeconds);
    expect(result.model).toBe("mock-v1");
    expect(result.metadata.genre).toBe(request.genre);
    expect(result.metadata.mood).toBe(request.mood);
    expect(result.metadata.tempo).toBe(request.tempo);
    expect(result.metadata.key).toBe(request.key);
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings[0]).toContain("Mock mode");
  });

  it("should create metadata file", async () => {
    const provider = new MockMusicGenerationProvider();
    const request = createSampleRequest();
    const result = await provider.generate(request);

    expect(result.filePath).toMatch(/\.json$/);
    expect(result.filePath).toContain("mock_gen_");
  });
});

// =============================================================================
// Local MusicGen Provider Tests
// =============================================================================

describe("LocalMusicGenProvider", () => {
  it("should not be available when MUSICIAN_ENABLE_MUSICGEN is not set", async () => {
    delete process.env.MUSICIAN_ENABLE_MUSICGEN;
    const provider = new LocalMusicGenProvider();
    const isAvailable = await provider.isAvailable();
    expect(isAvailable).toBe(false);
  });

  it("should not be available when MUSICIAN_ENABLE_MUSICGEN is false", async () => {
    process.env.MUSICIAN_ENABLE_MUSICGEN = "false";
    const provider = new LocalMusicGenProvider();
    const isAvailable = await provider.isAvailable();
    expect(isAvailable).toBe(false);
  });

  it("should be available when MUSICIAN_ENABLE_MUSICGEN is true", async () => {
    process.env.MUSICIAN_ENABLE_MUSICGEN = "true";
    const provider = new LocalMusicGenProvider();
    const isAvailable = await provider.isAvailable();
    expect(isAvailable).toBe(true);
  });

  it("should return warning when unavailable", async () => {
    delete process.env.MUSICIAN_ENABLE_MUSICGEN;
    const provider = new LocalMusicGenProvider();
    const request = createSampleRequest();
    const result = await provider.generate(request);

    expect(result.warnings).toContain(
      "Local MusicGen provider is not available."
    );
    expect(result.warnings.some((w) => w.includes("MUSICIAN_ENABLE_MUSICGEN=true"))).toBe(true);
  });

  it("should not be available when MUSICGEN_MODE is incompatible", async () => {
    process.env.MUSICIAN_ENABLE_MUSICGEN = "true";
    process.env.MUSICGEN_MODE = "hf";
    const provider = new LocalMusicGenProvider();
    const isAvailable = await provider.isAvailable();
    expect(isAvailable).toBe(false);
  });
});

// =============================================================================
// Hugging Face Provider Tests
// =============================================================================

describe("HuggingFaceMusicGenProvider", () => {
  it("should not be available when token is not set", async () => {
    delete process.env.HUGGINGFACE_API_TOKEN;
    delete process.env.HF_API_TOKEN;
    const provider = new HuggingFaceMusicGenProvider();
    const isAvailable = await provider.isAvailable();
    expect(isAvailable).toBe(false);
  });

  it("should be available when HUGGINGFACE_API_TOKEN is set", async () => {
    process.env.HUGGINGFACE_API_TOKEN = "test-token";
    const provider = new HuggingFaceMusicGenProvider();
    const isAvailable = await provider.isAvailable();
    expect(isAvailable).toBe(true);
  });

  it("should be available when HF_API_TOKEN is set", async () => {
    process.env.HF_API_TOKEN = "test-token";
    const provider = new HuggingFaceMusicGenProvider();
    const isAvailable = await provider.isAvailable();
    expect(isAvailable).toBe(true);
  });

  it("should return warning when unavailable", async () => {
    delete process.env.HUGGINGFACE_API_TOKEN;
    delete process.env.HF_API_TOKEN;
    const provider = new HuggingFaceMusicGenProvider();
    const request = createSampleRequest();
    const result = await provider.generate(request);

    expect(result.warnings).toContain(
      "Hugging Face provider is not available."
    );
    expect(result.warnings.some((w) => w.includes("HUGGINGFACE_API_TOKEN"))).toBe(true);
  });

  it("should return placeholder result with TODO note", async () => {
    process.env.HUGGINGFACE_API_TOKEN = "test-token";
    const provider = new HuggingFaceMusicGenProvider();
    const request = createSampleRequest();
    const result = await provider.generate(request);

    expect(result.warnings.some((w) => w.includes("TODO"))).toBe(true);
    expect(result.filePath).toMatch(/\.json$/);
  });
});

// =============================================================================
// Provider Factory Tests
// =============================================================================

describe("createProvider", () => {
  it("should create mock provider", () => {
    const provider = createProvider("mock");
    expect(provider).toBeInstanceOf(MockMusicGenerationProvider);
    expect(provider.name).toBe("mock");
  });

  it("should create local_musicgen provider", () => {
    const provider = createProvider("local_musicgen");
    expect(provider).toBeInstanceOf(LocalMusicGenProvider);
    expect(provider.name).toBe("local_musicgen");
  });

  it("should create huggingface provider", () => {
    const provider = createProvider("huggingface");
    expect(provider).toBeInstanceOf(HuggingFaceMusicGenProvider);
    expect(provider.name).toBe("huggingface");
  });

  it("should default to mock for unknown type", () => {
    const provider = createProvider("unknown" as any);
    expect(provider).toBeInstanceOf(MockMusicGenerationProvider);
  });
});

describe("getConfiguredProviderType", () => {
  it("should return mock by default", () => {
    delete process.env.MUSICIAN_GENERATION_PROVIDER;
    const type = getConfiguredProviderType();
    expect(type).toBe("mock");
  });

  it("should return configured provider type", () => {
    process.env.MUSICIAN_GENERATION_PROVIDER = "local_musicgen";
    expect(getConfiguredProviderType()).toBe("local_musicgen");

    process.env.MUSICIAN_GENERATION_PROVIDER = "huggingface";
    expect(getConfiguredProviderType()).toBe("huggingface");

    process.env.MUSICIAN_GENERATION_PROVIDER = "mock";
    expect(getConfiguredProviderType()).toBe("mock");
  });

  it("should default to mock for invalid provider type", () => {
    process.env.MUSICIAN_GENERATION_PROVIDER = "invalid";
    const type = getConfiguredProviderType();
    expect(type).toBe("mock");
  });
});

describe("selectProvider", () => {
  it("should honor request.modelPreference when available", async () => {
    process.env.MUSICIAN_GENERATION_PROVIDER = "mock";
    process.env.HUGGINGFACE_API_TOKEN = "test-token";

    const request = createSampleRequest({
      modelPreference: "huggingface",
    });

    const provider = await selectProvider(request);
    expect(provider.name).toBe("huggingface");
  });

  it("should fall back to env config when preference is unavailable", async () => {
    process.env.MUSICIAN_GENERATION_PROVIDER = "mock";
    delete process.env.HUGGINGFACE_API_TOKEN;

    const request = createSampleRequest({
      modelPreference: "huggingface",
    });

    const provider = await selectProvider(request);
    expect(provider.name).toBe("mock");
  });

  it("should fall back to mock when configured provider is unavailable", async () => {
    process.env.MUSICIAN_GENERATION_PROVIDER = "local_musicgen";
    delete process.env.MUSICIAN_ENABLE_MUSICGEN;

    const request = createSampleRequest();
    const provider = await selectProvider(request);
    expect(provider.name).toBe("mock");
  });

  it("should use configured provider when no preference specified", async () => {
    process.env.MUSICIAN_GENERATION_PROVIDER = "mock";
    const request = createSampleRequest();
    const provider = await selectProvider(request);
    expect(provider.name).toBe("mock");
  });
});

// =============================================================================
// Validation Tests
// =============================================================================

describe("validateGenerationRequest", () => {
  it("should pass validation for safe prompts", () => {
    const request = createSampleRequest();
    const validation = validateGenerationRequest(request);

    expect(validation.safe).toBe(true);
    expect(validation.originalPrompt).toBe(request.prompt);
    expect(validation.sanitizedPrompt).toBeUndefined();
  });

  it("should warn when duration exceeds maximum", () => {
    const request = createSampleRequest({
      durationSeconds: 120,
    });
    const validation = validateGenerationRequest(request);

    expect(validation.warnings.some((w) => w.includes("exceeds maximum"))).toBe(true);
    expect(validation.warnings.some((w) => w.includes("60s"))).toBe(true);
  });

  it("should reject direct soundalike of protected artist", () => {
    const request = createSampleRequest({
      prompt: "Make it sound like Taylor Swift",
    });
    const validation = validateGenerationRequest(request);

    expect(validation.safe).toBe(false);
    expect(validation.reason).toContain("protected artist");
    expect(validation.sanitizedPrompt).toBeDefined();
    expect(validation.warnings.some((w) => w.includes("Unsafe prompt detected"))).toBe(true);
  });

  it("should reject exact style copy requests", () => {
    const request = createSampleRequest({
      prompt: "Create music in the exact style of Drake",
    });
    const validation = validateGenerationRequest(request);

    expect(validation.safe).toBe(false);
    expect(validation.reason).toContain("protected artist");
  });

  it("should reject soundalike with 'sounds like'", () => {
    const request = createSampleRequest({
      prompt: "Something that sounds like Billie Eilish",
    });
    const validation = validateGenerationRequest(request);

    expect(validation.safe).toBe(false);
  });

  it("should reject clone requests", () => {
    const request = createSampleRequest({
      prompt: "Clone the voice of Ariana Grande",
    });
    const validation = validateGenerationRequest(request);

    expect(validation.safe).toBe(false);
  });

  it("should provide sanitized alternative for unsafe prompts", () => {
    const request = createSampleRequest({
      prompt: "Make it sound exactly like The Weeknd",
    });
    const validation = validateGenerationRequest(request);

    expect(validation.safe).toBe(false);
    expect(validation.sanitizedPrompt).toBeDefined();
    expect(validation.sanitizedPrompt).not.toContain("Weeknd");
    expect(validation.sanitizedPrompt).not.toContain("sound");
    expect(validation.warnings.some((w) => w.includes("Suggested alternative"))).toBe(true);
  });

  it("should warn about generic soundalike patterns without artist names", () => {
    const request = createSampleRequest({
      prompt: "Something sounding similar to that popular song",
    });
    const validation = validateGenerationRequest(request);

    // This should pass (not a protected artist) but with a warning
    expect(validation.safe).toBe(true);
    expect(validation.warnings.some((w) => w.includes("soundalike"))).toBe(true);
  });

  it("should allow genre and mood descriptions", () => {
    const request = createSampleRequest({
      prompt: "upbeat pop music with catchy melodies",
    });
    const validation = validateGenerationRequest(request);

    expect(validation.safe).toBe(true);
    expect(validation.warnings.length).toBe(0);
  });

  it("should allow style descriptions without specific artists", () => {
    const request = createSampleRequest({
      prompt: "80s synth-pop style with electronic drums",
    });
    const validation = validateGenerationRequest(request);

    expect(validation.safe).toBe(true);
    expect(validation.warnings.length).toBe(0);
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe("generateMusic", () => {
  it("should successfully generate with safe prompt using mock provider", async () => {
    delete process.env.MUSICIAN_GENERATION_PROVIDER;
    const request = createSampleRequest();
    const result = await generateMusic(request);

    expect(result.assetId).toBeDefined();
    expect(result.prompt).toBe(request.prompt);
    expect(result.durationSeconds).toBe(request.durationSeconds);
  });

  it("should cap duration at maximum", async () => {
    delete process.env.MUSICIAN_GENERATION_PROVIDER;
    const request = createSampleRequest({
      durationSeconds: 120,
    });
    const result = await generateMusic(request);

    expect(result.durationSeconds).toBe(60);
    expect(result.warnings.some((w) => w.includes("exceeds maximum"))).toBe(true);
  });

  it("should throw error for unsafe prompts", async () => {
    const request = createSampleRequest({
      prompt: "Make it sound like Taylor Swift",
    });

    await expect(generateMusic(request)).rejects.toThrow("Unsafe generation request");
  });

  it("should include validation warnings in result", async () => {
    const request = createSampleRequest({
      prompt: "upbeat music sounding similar to something popular",
      durationSeconds: 70,
    });
    const result = await generateMusic(request);

    expect(result.warnings.some((w) => w.includes("soundalike"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("exceeds maximum"))).toBe(true);
  });

  it("should use selected provider based on environment", async () => {
    process.env.MUSICIAN_GENERATION_PROVIDER = "mock";
    const request = createSampleRequest();
    const result = await generateMusic(request);

    expect(result.model).toBe("mock-v1");
    expect(result.warnings.some((w) => w.includes("Mock mode"))).toBe(true);
  });

  it("should respect modelPreference in request", async () => {
    process.env.MUSICIAN_GENERATION_PROVIDER = "local_musicgen";
    process.env.HUGGINGFACE_API_TOKEN = "test-token";

    const request = createSampleRequest({
      modelPreference: "huggingface",
    });
    const result = await generateMusic(request);

    expect(result.model).toBe("facebook/musicgen-small");
  });
});
