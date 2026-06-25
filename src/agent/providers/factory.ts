import { env } from "../../config/env";
import { AIProvider } from "./types";
import { OpenCodeProvider } from "./opencode-provider";
import { ZaiProvider } from "./zai-provider";
import { OllamaProvider } from "./ollama-provider";
import { OpenAIProvider } from "./openai-provider";

/**
 * Parse an env-supplied timeout (in ms) safely. Empty string, non-numeric, or
 * out-of-range values fall back to the supplied default — we never want a
 * user typo to wedge the provider with a 0ms timeout (which axios treats as
 * "infinite" silently and breaks reaper assumptions).
 */
function parseTimeoutEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * Resolve the effective context limit for a model by checking per-model
 * overrides before falling back to the default.
 */
export function getEffectiveContextLimit(
  model: string,
  defaultLimit: number,
  limitsJson?: string,
): number {
  const json = limitsJson ?? env.OLLAMA_MODEL_CONTEXT_LIMITS;
  if (!json) return defaultLimit;
  try {
    const limits = JSON.parse(json) as Record<string, number>;
    return limits[model] ?? defaultLimit;
  } catch {
    return defaultLimit;
  }
}

export function createProvider(): AIProvider {
  // Read process.env first so --provider/--model CLI overrides take effect.
  // The env object is a frozen snapshot from import time and won't reflect
  // runtime changes to process.env made by applyProviderOverrides().
  const provider = process.env.AI_PROVIDER || env.AI_PROVIDER;

  switch (provider) {
    case "zai":
      return new ZaiProvider({
        apiKey: env.ZAI_API_KEY,
        baseUrl: env.ZAI_API_URL,
        model: process.env.ZAI_MODEL || env.ZAI_MODEL,
        temperature: env.ZAI_TEMPERATURE,
        topP: env.ZAI_TOP_P,
        maxRetries: 2,
        timeout: 300000,
        maxContextTokens: env.ZAI_MAX_CONTEXT_TOKENS,
      });

    case "ollama":
      return new OllamaProvider({
        apiKey: process.env.OLLAMA_API_KEY || env.OLLAMA_API_KEY,
        baseUrl: process.env.OLLAMA_API_URL || env.OLLAMA_API_URL,
        model: process.env.OLLAMA_MODEL || env.OLLAMA_MODEL,
        temperature: env.OLLAMA_TEMPERATURE,
        topP: 0.9,
        maxRetries: env.OLLAMA_API_KEY ? 5 : 2,
        // Per-host override (set by provider-settings.applyHostOverride when
        // a saved host with timeoutSeconds is selected). Falls back to 300s
        // for default localhost.
        timeout: parseTimeoutEnv(process.env.OLLAMA_TIMEOUT_MS, 300000),
        maxContextTokens: getEffectiveContextLimit(
          process.env.OLLAMA_MODEL || env.OLLAMA_MODEL || "",
          env.OLLAMA_MAX_CONTEXT_TOKENS,
        ),
      });

    case "openai":
      return new OpenAIProvider({
        apiKey: process.env.OPENAI_API_KEY || env.OPENAI_API_KEY,
        baseUrl: process.env.OPENAI_API_URL || env.OPENAI_API_URL,
        model: process.env.OPENAI_MODEL || env.OPENAI_MODEL,
        temperature: 1,
        topP: 1,
        maxRetries: 3,
        timeout: 300000,
        maxContextTokens: env.OPENAI_MAX_CONTEXT_TOKENS,
      });

    default:
      return new OpenCodeProvider({
        apiKey: env.OPENCODE_API_KEY,
        baseUrl: env.OPENCODE_API_URL,
        model: process.env.OPENCODE_MODEL || env.OPENCODE_MODEL || "glm-5",
        temperature: 0.7,
        topP: 0.95,
        maxRetries: 3,
        timeout: 120000,
        maxContextTokens: getEffectiveContextLimit(
          process.env.OPENCODE_MODEL || env.OPENCODE_MODEL || "glm-5",
          env.OPENCODE_MAX_CONTEXT_TOKENS,
          env.OPENCODE_MODEL_CONTEXT_LIMITS,
        ),
      });
  }
}

/** Create a provider by name without reading or mutating process.env.AI_PROVIDER. */
export function createProviderFor(name: string): AIProvider | null {
  switch (name) {
    case "zai":
      return new ZaiProvider({
        apiKey: env.ZAI_API_KEY,
        baseUrl: env.ZAI_API_URL,
        model: process.env.ZAI_MODEL || env.ZAI_MODEL,
        temperature: env.ZAI_TEMPERATURE,
        topP: env.ZAI_TOP_P,
        maxRetries: 2,
        timeout: 300000,
        maxContextTokens: env.ZAI_MAX_CONTEXT_TOKENS,
      });
    case "ollama":
      return new OllamaProvider({
        apiKey: process.env.OLLAMA_API_KEY || env.OLLAMA_API_KEY,
        baseUrl: process.env.OLLAMA_API_URL || env.OLLAMA_API_URL,
        model: process.env.OLLAMA_MODEL || env.OLLAMA_MODEL,
        temperature: env.OLLAMA_TEMPERATURE,
        topP: 0.9,
        maxRetries: env.OLLAMA_API_KEY ? 5 : 2,
        // Per-host override (set by provider-settings.applyHostOverride when
        // a saved host with timeoutSeconds is selected). Falls back to 300s
        // for default localhost.
        timeout: parseTimeoutEnv(process.env.OLLAMA_TIMEOUT_MS, 300000),
        maxContextTokens: getEffectiveContextLimit(
          process.env.OLLAMA_MODEL || env.OLLAMA_MODEL || "",
          env.OLLAMA_MAX_CONTEXT_TOKENS,
        ),
      });
    case "openai":
      return new OpenAIProvider({
        apiKey: process.env.OPENAI_API_KEY || env.OPENAI_API_KEY,
        baseUrl: process.env.OPENAI_API_URL || env.OPENAI_API_URL,
        model: process.env.OPENAI_MODEL || env.OPENAI_MODEL,
        temperature: 1,
        topP: 1,
        maxRetries: 3,
        timeout: 300000,
        maxContextTokens: env.OPENAI_MAX_CONTEXT_TOKENS,
      });
    case "opencode":
      return new OpenCodeProvider({
        apiKey: env.OPENCODE_API_KEY,
        baseUrl: env.OPENCODE_API_URL,
        model: process.env.OPENCODE_MODEL || env.OPENCODE_MODEL || "glm-5",
        temperature: 0.7,
        topP: 0.95,
        maxRetries: 3,
        timeout: 120000,
        maxContextTokens: getEffectiveContextLimit(
          process.env.OPENCODE_MODEL || env.OPENCODE_MODEL || "glm-5",
          env.OPENCODE_MAX_CONTEXT_TOKENS,
          env.OPENCODE_MODEL_CONTEXT_LIMITS,
        ),
      });
    default:
      return null;
  }
}

let _provider: AIProvider | null = null;

export function getProvider(): AIProvider {
  if (!_provider) {
    _provider = createProvider();
  }
  return _provider;
}

/** Clear the cached provider so the next getProvider() re-creates it from current env. */
export function resetProvider(): void {
  _provider = null;
}
