import axios from "axios";
import { env } from "../config/env";
import { aiClient } from "./opencode-client";

export type AIProviderName = "opencode" | "zai" | "ollama" | "openai";

export interface ProviderModelCacheEntry {
  provider: AIProviderName;
  models: string[];
  fetchedAt: string | null;
  expiresAt: string | null;
  cached: boolean;
  error?: string;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const providers = ["opencode", "zai", "ollama", "openai"] as const;
const providerSet = new Set<string>(providers);
const modelCache = new Map<
  AIProviderName,
  { models: string[]; fetchedAt: number }
>();

function providerFromEnv(): AIProviderName {
  const value = process.env.AI_PROVIDER || env.AI_PROVIDER;
  return isProviderName(value) ? value : "opencode";
}

function isProviderName(value: string): value is AIProviderName {
  return providerSet.has(value);
}

function defaultModelForProvider(provider: AIProviderName): string {
  switch (provider) {
    case "zai":
      return process.env.ZAI_MODEL || env.ZAI_MODEL;
    case "ollama":
      return process.env.OLLAMA_MODEL || env.OLLAMA_MODEL;
    case "openai":
      return process.env.OPENAI_MODEL || env.OPENAI_MODEL;
    case "opencode":
      return process.env.OPENCODE_MODEL || env.OPENCODE_MODEL || "glm-5";
  }
}

function providerConfig(provider: AIProviderName): {
  apiKey: string;
  baseUrl: string;
} {
  switch (provider) {
    case "zai":
      return { apiKey: env.ZAI_API_KEY, baseUrl: env.ZAI_API_URL };
    case "ollama":
      return {
        apiKey: process.env.OLLAMA_API_KEY || env.OLLAMA_API_KEY,
        baseUrl: process.env.OLLAMA_API_URL || env.OLLAMA_API_URL,
      };
    case "openai":
      return {
        apiKey: process.env.OPENAI_API_KEY || env.OPENAI_API_KEY,
        baseUrl: process.env.OPENAI_API_URL || env.OPENAI_API_URL,
      };
    case "opencode":
      return { apiKey: env.OPENCODE_API_KEY, baseUrl: env.OPENCODE_API_URL };
  }
}

function modelEnvKey(
  provider: AIProviderName,
): "OPENCODE_MODEL" | "ZAI_MODEL" | "OLLAMA_MODEL" | "OPENAI_MODEL" {
  switch (provider) {
    case "zai":
      return "ZAI_MODEL";
    case "ollama":
      return "OLLAMA_MODEL";
    case "openai":
      return "OPENAI_MODEL";
    case "opencode":
      return "OPENCODE_MODEL";
  }
}

function extractOpenAICompatibleModels(data: unknown): string[] {
  const root = data as {
    data?: Array<{ id?: unknown; name?: unknown }>;
    models?: Array<{ id?: unknown; name?: unknown }>;
  };
  const items = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.models)
      ? root.models
      : [];
  return items
    .map((item) =>
      typeof item.id === "string"
        ? item.id
        : typeof item.name === "string"
          ? item.name
          : "",
    )
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function extractOllamaModels(data: unknown): string[] {
  const root = data as {
    models?: Array<{ name?: unknown; model?: unknown; id?: unknown }>;
  };
  return (Array.isArray(root.models) ? root.models : [])
    .map((item) => {
      if (typeof item.name === "string") return item.name;
      if (typeof item.model === "string") return item.model;
      if (typeof item.id === "string") return item.id;
      return "";
    })
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

async function fetchModelsFromProvider(
  provider: AIProviderName,
): Promise<string[]> {
  const { apiKey, baseUrl } = providerConfig(provider);
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  if (provider === "ollama") {
    try {
      const response = await axios.get(
        `${baseUrl.replace(/\/$/, "")}/api/tags`,
        { headers, timeout: 10000 },
      );
      return extractOllamaModels(response.data);
    } catch {
      const response = await axios.get(
        `${baseUrl.replace(/\/$/, "")}/v1/models`,
        { headers, timeout: 10000 },
      );
      return extractOpenAICompatibleModels(response.data);
    }
  }

  const response = await axios.get(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers,
    timeout: 10000,
  });
  return extractOpenAICompatibleModels(response.data);
}

function cacheEntry(
  provider: AIProviderName,
  cached: boolean,
  error?: string,
): ProviderModelCacheEntry {
  const entry = modelCache.get(provider);
  return {
    provider,
    models: entry?.models ?? [],
    fetchedAt: entry ? new Date(entry.fetchedAt).toISOString() : null,
    expiresAt: entry
      ? new Date(entry.fetchedAt + CACHE_TTL_MS).toISOString()
      : null,
    cached,
    error,
  };
}

export const providerSettings = {
  providers,

  isProviderName,

  getCurrent(): {
    provider: AIProviderName;
    model: string;
    providers: readonly AIProviderName[];
  } {
    const provider = providerFromEnv();
    return { provider, model: defaultModelForProvider(provider), providers };
  },

  async getModels(
    provider: AIProviderName,
    forceRefresh = false,
  ): Promise<ProviderModelCacheEntry> {
    const now = Date.now();
    const cached = modelCache.get(provider);
    if (!forceRefresh && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      return cacheEntry(provider, true);
    }

    try {
      const fetched = await fetchModelsFromProvider(provider);
      const models =
        fetched.length > 0
          ? fetched
          : [defaultModelForProvider(provider)].filter(Boolean);
      modelCache.set(provider, { models, fetchedAt: now });
      return cacheEntry(provider, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (cached) return cacheEntry(provider, true, message);
      const fallback = defaultModelForProvider(provider);
      modelCache.set(provider, {
        models: fallback ? [fallback] : [],
        fetchedAt: now,
      });
      return cacheEntry(provider, false, message);
    }
  },

  async setProvider(
    provider: AIProviderName,
    model?: string,
  ): Promise<{
    provider: AIProviderName;
    model: string;
    models: ProviderModelCacheEntry;
  }> {
    const models = await this.getModels(provider);
    const selectedModel =
      model || models.models[0] || defaultModelForProvider(provider);
    if (model && models.models.length > 0 && !models.models.includes(model)) {
      throw new Error(
        `Model '${model}' is not available for provider '${provider}'`,
      );
    }

    process.env.AI_PROVIDER = provider;
    process.env[modelEnvKey(provider)] = selectedModel;
    aiClient.refresh();

    return { provider, model: selectedModel, models };
  },

  warmDefaultProvider(): void {
    const provider = providerFromEnv();
    this.getModels(provider).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[ProviderSettings] Failed to warm ${provider} models:`,
        message,
      );
    });
  },
};
