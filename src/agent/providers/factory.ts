import { env } from "../../config/env";
import { AIProvider } from "./types";
import { OpenCodeProvider } from "./opencode-provider";
import { ZaiProvider } from "./zai-provider";
import { OllamaProvider } from "./ollama-provider";

/**
 * Resolve the effective context limit for a model by checking per-model
 * overrides before falling back to the default.
 */
export function getEffectiveContextLimit(
  model: string,
  defaultLimit: number,
): number {
  if (!env.OLLAMA_MODEL_CONTEXT_LIMITS) return defaultLimit;
  try {
    const limits = JSON.parse(env.OLLAMA_MODEL_CONTEXT_LIMITS) as Record<
      string,
      number
    >;
    return limits[model] ?? defaultLimit;
  } catch {
    return defaultLimit;
  }
}

export function createProvider(): AIProvider {
  const provider = env.AI_PROVIDER;

  switch (provider) {
    case "zai":
      return new ZaiProvider({
        apiKey: env.ZAI_API_KEY,
        baseUrl: env.ZAI_API_URL,
        model: env.ZAI_MODEL,
        temperature: env.ZAI_TEMPERATURE,
        topP: env.ZAI_TOP_P,
        maxRetries: 5,
        timeout: 300000,
        maxContextTokens: env.ZAI_MAX_CONTEXT_TOKENS,
      });

    case "ollama":
      return new OllamaProvider({
        apiKey: env.OLLAMA_API_KEY,
        baseUrl: env.OLLAMA_API_URL,
        model: env.OLLAMA_MODEL,
        temperature: env.OLLAMA_TEMPERATURE,
        topP: 0.9,
        maxRetries: env.OLLAMA_API_KEY ? 5 : 2,
        timeout: 300000,
        maxContextTokens: getEffectiveContextLimit(
          env.OLLAMA_MODEL,
          env.OLLAMA_MAX_CONTEXT_TOKENS,
        ),
      });

    default:
      return new OpenCodeProvider({
        apiKey: env.OPENCODE_API_KEY,
        baseUrl: env.OPENCODE_API_URL,
        model: "glm-5",
        temperature: 0.7,
        topP: 0.95,
        maxRetries: 3,
        timeout: 120000,
        maxContextTokens: 64000,
      });
  }
}

let _provider: AIProvider | null = null;

export function getProvider(): AIProvider {
  if (!_provider) {
    _provider = createProvider();
  }
  return _provider;
}
