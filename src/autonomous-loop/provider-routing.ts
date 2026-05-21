import type { ProviderType } from "../integrations/ollama-launcher";

export type ApiProvider = "opencode" | "zai" | null;

export interface ProviderRoutingOptions {
  apiProvider: ApiProvider;
  agent: ProviderType;
  model: string;
  env: NodeJS.ProcessEnv;
}

export interface ProviderRoutingResult {
  base?: string;
  anthropicBase?: string;
  keyPresent: boolean;
  codexKeyPresent: boolean;
}

function stripTrailingV1(url: string): string {
  return url.replace(/\/v1\/?$/, "");
}

export function hasSecret(value: string | undefined): string {
  return value ? "present" : "missing";
}

export function applyProviderRouting(options: ProviderRoutingOptions): ProviderRoutingResult | null {
  const { apiProvider, agent, model, env } = options;

  if (apiProvider === "opencode") {
    const base = env.OPENCODE_API_URL || env.OPENCODE_BASE_URL || "https://opencode.ai/zen/go/v1";
    const key = env.OPENCODE_API_KEY || "";
    const anthropicBase = env.OPENCODE_ANTHROPIC_BASE_URL || stripTrailingV1(base);
    env.OPENAI_BASE_URL = base;
    env.OPENCODE_API_URL = base;
    env.OPENCODE_BASE_URL = base;
    if (key) {
      env.OPENAI_API_KEY = key;
      env.CODEX_API_KEY = key;
      env.OPENCODE_API_KEY = key;
    }
    env.OPENCODE_MODEL = model;
    if (agent === "claude") {
      env.ANTHROPIC_BASE_URL = anthropicBase;
      if (key) {
        env.ANTHROPIC_API_KEY = key;
        env.ANTHROPIC_AUTH_TOKEN = key;
      }
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
    }
    return { base, anthropicBase, keyPresent: Boolean(key), codexKeyPresent: Boolean(env.CODEX_API_KEY) };
  }

  if (apiProvider === "zai") {
    const base = env.ZAI_API_URL || env.ZAI_BASE_URL || "https://api.z.ai/api/coding/paas/v4";
    const anthropicBase = env.ZAI_ANTHROPIC_BASE_URL || "https://api.z.ai/api/anthropic";
    const key = env.ZAI_API_KEY || "";
    env.OPENAI_BASE_URL = base;
    if (key) {
      env.OPENAI_API_KEY = key;
      env.CODEX_API_KEY = key;
      env.ZAI_API_KEY = key;
      env.Z_AI_API_KEY = key;
    }
    env.ZAI_MODEL = model;
    if (agent === "claude") {
      env.ANTHROPIC_BASE_URL = anthropicBase;
      if (key) {
        env.ANTHROPIC_API_KEY = key;
        env.ANTHROPIC_AUTH_TOKEN = key;
      }
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
    }
    return { base, anthropicBase, keyPresent: Boolean(key), codexKeyPresent: Boolean(env.CODEX_API_KEY) };
  }

  return null;
}
