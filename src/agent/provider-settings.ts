import axios from "axios";
import fs from "fs";
import path from "path";
import { env } from "../config/env";
import { aiClient } from "./opencode-client";
import { agentRunDatabase } from "../agent-runs/database";
import type { ProviderHost } from "../agent-runs/types";

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

interface PersistedProviderSelection {
  provider: AIProviderName;
  model: string;
  /**
   * Optional id from provider_hosts (see {@link ProviderHost}). When set, the
   * runtime overrides the provider's *_API_URL / *_API_KEY env vars with this
   * host's values so chat traffic targets a user-saved remote (e.g. a LAN
   * Ollama box) instead of the server's default.
   */
  hostId?: string | null;
  updatedAt: string;
}

function settingsPath(): string {
  if (process.env.PROVIDER_SETTINGS_PATH) return process.env.PROVIDER_SETTINGS_PATH;
  return path.join(process.cwd(), "data", "provider-settings.json");
}

function readPersistedSelection(): PersistedProviderSelection | null {
  if (process.env.VITEST && !process.env.PROVIDER_SETTINGS_PATH) return null;
  try {
    const file = settingsPath();
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<PersistedProviderSelection>;
    if (!parsed.provider || !isProviderName(parsed.provider)) return null;
    return {
      provider: parsed.provider,
      model: typeof parsed.model === "string" ? parsed.model : rawDefaultModelForProvider(parsed.provider),
      hostId: typeof parsed.hostId === "string" && parsed.hostId ? parsed.hostId : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function writePersistedSelection(selection: PersistedProviderSelection): void {
  if (process.env.VITEST && !process.env.PROVIDER_SETTINGS_PATH) return;
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(selection, null, 2)}\n`, "utf-8");
}

function providerFromEnv(): AIProviderName {
  const persisted = readPersistedSelection();
  if (persisted) return persisted.provider;
  const value = process.env.AI_PROVIDER || env.AI_PROVIDER;
  return isProviderName(value) ? value : "opencode";
}

function isProviderName(value: string | undefined): value is AIProviderName {
  if (!value) return false;
  return providerSet.has(value);
}

function rawDefaultModelForProvider(provider: AIProviderName): string {
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

function defaultModelForProvider(provider: AIProviderName): string {
  const persisted = readPersistedSelection();
  if (persisted?.provider === provider && persisted.model) {
    return persisted.model;
  }
  return rawDefaultModelForProvider(provider);
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

/**
 * Apply (or clear) a provider host's URL/key as runtime env overrides. Today
 * only Ollama is remoteable; this layer is provider-aware so we can extend to
 * a remote OpenAI-compatible gateway without changing call sites.
 *
 * Pass `host=null` to revert to the static config (i.e. env defaults from
 * .env). We intentionally `delete process.env[*]` rather than restoring some
 * captured "original" — config/env.ts already captured the originals at boot,
 * so deleting the override lets the next createProvider() fall back to env.
 */
function applyHostOverride(provider: AIProviderName, host: ProviderHost | null): void {
  // Always clear cross-cutting overrides first; we'll re-set them below if
  // applicable. AI_FIRST_CHUNK_TIMEOUT_MS lives in the base provider class
  // (installFirstChunkAbort) and affects every provider, so leaving a stale
  // 900s value behind when the user switches from a slow ollama host back
  // to opencode would suppress the watchdog where it's still useful.
  delete process.env.AI_FIRST_CHUNK_TIMEOUT_MS;

  if (provider === "ollama") {
    if (host && host.provider === "ollama") {
      process.env.OLLAMA_API_URL = host.baseUrl;
      process.env.OLLAMA_API_KEY = host.apiKey ?? "";
      // Per-host timeout. factory.ts reads OLLAMA_TIMEOUT_MS when creating
      // the OllamaProvider; null clears the override so we fall back to the
      // 300s default. Stored as ms (host.timeoutSeconds * 1000) so the env
      // var matches the axios `timeout` unit and grep'ing is unambiguous.
      if (host.timeoutSeconds) {
        const ms = String(host.timeoutSeconds * 1000);
        process.env.OLLAMA_TIMEOUT_MS = ms;
        // Also raise the first-chunk idle watchdog — a slow local box may
        // take 30–90s to load weights into VRAM and process a long prompt
        // before the first token streams. Default 30s kills it before it
        // ever emits a byte. Reuse the same value: if the user says "wait
        // up to N seconds for this host", they mean total + first-chunk.
        process.env.AI_FIRST_CHUNK_TIMEOUT_MS = ms;
      } else {
        delete process.env.OLLAMA_TIMEOUT_MS;
      }
    } else {
      delete process.env.OLLAMA_API_URL;
      delete process.env.OLLAMA_API_KEY;
      delete process.env.OLLAMA_TIMEOUT_MS;
    }
  }
  // No other providers are user-host-overridable today.
}

function resolveHost(hostId: string | null | undefined): ProviderHost | null {
  if (!hostId) return null;
  try {
    return agentRunDatabase.getProviderHost(hostId);
  } catch {
    return null;
  }
}

export const providerSettings = {
  providers,

  isProviderName,

  applyPersistedSelection(): void {
    const persisted = readPersistedSelection();
    if (!persisted) return;
    process.env.AI_PROVIDER = persisted.provider;
    process.env[modelEnvKey(persisted.provider)] = persisted.model;
    applyHostOverride(persisted.provider, resolveHost(persisted.hostId));
    aiClient.refresh();
  },

  getCurrent(): {
    provider: AIProviderName;
    model: string;
    hostId: string | null;
    providers: readonly AIProviderName[];
  } {
    const provider = providerFromEnv();
    const persisted = readPersistedSelection();
    const hostId = persisted?.provider === provider ? persisted.hostId ?? null : null;
    return { provider, model: defaultModelForProvider(provider), hostId, providers };
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
    hostId?: string | null,
  ): Promise<{
    provider: AIProviderName;
    model: string;
    hostId: string | null;
    models: ProviderModelCacheEntry;
  }> {
    // Resolve & apply host BEFORE fetching models so the model list comes
    // from the chosen host's /api/tags, not the singleton env-default URL.
    // An explicit null clears any prior override; undefined preserves the
    // currently-persisted host so callers that don't care about hosts (the
    // existing tests, mostly) keep working unchanged.
    const persisted = readPersistedSelection();
    const effectiveHostId =
      hostId === undefined
        ? persisted?.provider === provider
          ? persisted?.hostId ?? null
          : null
        : hostId;
    const host = resolveHost(effectiveHostId);
    if (effectiveHostId && !host) {
      throw new Error(`Provider host '${effectiveHostId}' not found`);
    }
    if (host && host.provider !== provider) {
      throw new Error(
        `Provider host '${host.name}' is for ${host.provider}, not ${provider}`,
      );
    }
    applyHostOverride(provider, host);
    // Bust the model cache for this provider — host change means a different
    // model list. Cheap; the next getModels() will refetch from the new URL.
    modelCache.delete(provider);

    const models = await this.getModels(provider);
    const normalizedModel = model?.toLowerCase();
    const normalizedList = models.models.map((m) => m.toLowerCase());
    const matchIdx = normalizedModel ? normalizedList.indexOf(normalizedModel) : -1;
    if (normalizedModel && models.models.length > 0 && matchIdx === -1) {
      throw new Error(
        `Model '${model}' is not available for provider '${provider}'`,
      );
    }
    const selectedModel =
      (matchIdx >= 0 ? models.models[matchIdx] : undefined) ||
      models.models[0] ||
      defaultModelForProvider(provider);

    process.env.AI_PROVIDER = provider;
    process.env[modelEnvKey(provider)] = selectedModel;
    writePersistedSelection({
      provider,
      model: selectedModel,
      hostId: effectiveHostId,
      updatedAt: new Date().toISOString(),
    });
    aiClient.refresh();

    return { provider, model: selectedModel, hostId: effectiveHostId, models };
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

// Auto-apply persisted selection on module load so child processes (aicoder,
// reviewer) that read process.env see the user’s chosen provider/model.
// Guarded in test environments where PROVIDER_SETTINGS_PATH is not set.
if (!process.env.VITEST || process.env.PROVIDER_SETTINGS_PATH) {
  providerSettings.applyPersistedSelection();
}
