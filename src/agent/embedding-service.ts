import axios from "axios";
import { createHash } from "node:crypto";
import { env } from "../config/env";

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  provider: string;
}

/**
 * Per-text embedding cache. ClaimKit's retrieve() embeds the user's
 * question, then again for each sub-question variant; the RAG store
 * search also embeds the same query before the cosine match; the
 * query-rewriter fan-out re-embeds the rewritten variants. With no
 * cache, the same string can hit the embedding provider 3-5 times per
 * chat turn — for local Ollama nomic-embed-text that's ~150-1000ms of
 * pure-redundant CPU; for the cloud fallback it's network round-trips.
 *
 * Sized for ~500 entries; at 768-dim float32 that's ~1.5MB peak, plus
 * key overhead. TTL is generous because embeddings are deterministic
 * outputs of (text, provider, model) — only a runtime provider/model
 * swap invalidates them, and that case is gated by the dimension-lock
 * check below. CLAIMKIT_EMBEDDING_CACHE=false (or =0) disables.
 */
const EMBEDDING_CACHE_MAX_ENTRIES = parseInt(
  process.env.EMBEDDING_CACHE_MAX || "500",
  10,
);
const EMBEDDING_CACHE_TTL_MS = parseInt(
  process.env.EMBEDDING_CACHE_TTL_MS || "1800000", // 30 min
  10,
);
const EMBEDDING_CACHE_ENABLED =
  (process.env.EMBEDDING_CACHE || "true").toLowerCase() !== "false" &&
  process.env.EMBEDDING_CACHE !== "0";

interface EmbeddingCacheEntry {
  result: EmbeddingResult;
  expiresAt: number;
}

const embeddingCache = new Map<string, EmbeddingCacheEntry>();

function embeddingCacheKey(provider: string, model: string, text: string): string {
  const payload = `${provider}::${model}::${text}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

function embeddingCacheGet(key: string): EmbeddingResult | undefined {
  const entry = embeddingCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    embeddingCache.delete(key);
    return undefined;
  }
  // LRU refresh: re-insert to push to most-recent.
  embeddingCache.delete(key);
  embeddingCache.set(key, entry);
  return entry.result;
}

function embeddingCacheSet(key: string, result: EmbeddingResult): void {
  if (embeddingCache.size >= EMBEDDING_CACHE_MAX_ENTRIES) {
    const oldest = embeddingCache.keys().next().value;
    if (oldest !== undefined) embeddingCache.delete(oldest);
  }
  embeddingCache.set(key, {
    result,
    expiresAt: Date.now() + EMBEDDING_CACHE_TTL_MS,
  });
}

/** Exposed for tests + diagnostics. */
export function __clearEmbeddingCacheForTests(): void {
  embeddingCache.clear();
}

class EmbeddingService {
  private provider: string;
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private fallbackBaseUrl: string;
  private fallbackApiKey: string;
  private fallbackModel: string;
  private ollamaFallbackModel: string;
  private available: boolean | null = null;
  private lastCheck = 0;
  private checkIntervalMs = 5 * 60 * 1000;
  private pullAttempted = false;
  // Locked on first successful embed. Subsequent results with a different
  // dimension are refused — silent provider switches (e.g. Ollama 768d →
  // OpenAI 1536d) otherwise corrupt every vector store that was built
  // against the locked dim. Reset only by restarting the process, or
  // opted around with EMBEDDING_ALLOW_PROVIDER_SWITCH=true.
  private lockedDimension: number | null = null;

  constructor() {
    // Resolve embedding provider: explicit EMBEDDING_PROVIDER overrides everything;
    // "auto" falls back to RAG_EMBEDDING_MODEL hint, then AI_PROVIDER.
    const embedProvider = env.EMBEDDING_PROVIDER;
    const embedModel = env.EMBEDDING_MODEL;

    if (embedProvider !== "auto") {
      this.provider = embedProvider;
    } else if (env.RAG_EMBEDDING_MODEL) {
      // Legacy: infer provider from the model name
      const m = env.RAG_EMBEDDING_MODEL;
      if (m.startsWith("nomic") || m.startsWith("mxbai") || m.startsWith("bge") || m.startsWith("all-minilm")) {
        this.provider = "ollama";
      } else {
        this.provider = env.AI_PROVIDER;
      }
    } else {
      // Default to local Ollama for embeddings — avoids cloud API dependency
      // and keeps ClaimKit working offline. Cloud providers are fallback only.
      this.provider = "ollama";
    }
    this.model = embedModel || env.RAG_EMBEDDING_MODEL || "";

    // Fallback: prefer OpenAI when a key is available; otherwise use OpenCode endpoint
    if (env.OPENAI_API_KEY) {
      this.fallbackBaseUrl = env.OPENAI_API_URL;
      this.fallbackApiKey = env.OPENAI_API_KEY;
      this.fallbackModel = "text-embedding-3-small";
    } else {
      this.fallbackBaseUrl = env.OPENCODE_API_URL;
      this.fallbackApiKey = env.OPENCODE_API_KEY;
      this.fallbackModel = "text-embedding-3-small";
    }

    // Local Ollama is the last-resort fallback — it's always reachable and any
    // loaded model can generate embeddings via /api/embed.
    this.ollamaFallbackModel = env.EMBEDDING_OLLAMA_FALLBACK_MODEL || "nomic-embed-text";

    switch (this.provider) {
      case "ollama":
        this.baseUrl = env.OLLAMA_API_URL;
        this.apiKey = env.OLLAMA_API_KEY;
        if (!this.model) this.model = "nomic-embed-text";
        break;
      case "zai":
        this.baseUrl = env.ZAI_API_URL;
        this.apiKey = env.ZAI_API_KEY;
        if (!this.model) this.model = "embedding-3";
        break;
      case "openai":
        this.baseUrl = env.OPENAI_API_URL;
        this.apiKey = env.OPENAI_API_KEY;
        if (!this.model) this.model = "text-embedding-3-small";
        break;
      default:
        this.baseUrl = env.OPENCODE_API_URL;
        this.apiKey = env.OPENCODE_API_KEY;
        if (!this.model) this.model = "text-embedding-3-small";
        break;
    }
  }

  async embed(text: string): Promise<EmbeddingResult | null> {
    if (!(await this.isAvailable())) {
      return null;
    }

    // Cache lookup before doing any HTTP work. Hash the empty string
    // through too so a caller passing "" doesn't bypass the cache and
    // then hit the provider every time with a guaranteed-empty result.
    let cacheKey: string | null = null;
    if (EMBEDDING_CACHE_ENABLED) {
      cacheKey = embeddingCacheKey(this.provider, this.model, text);
      const hit = embeddingCacheGet(cacheKey);
      if (hit) return hit;
    }

    try {
      const result =
        this.provider === "ollama"
          ? await this.ollamaEmbed(text)
          : await this.openAICompatibleEmbed(text);
      const checked = this.enforceLockedDimension(result);
      if (checked && cacheKey) embeddingCacheSet(cacheKey, checked);
      return checked;
    } catch (error) {
      console.error(
        `[Embedding] ${this.provider} embed failed:`,
        error instanceof Error ? error.message : "Unknown error",
      );
      return null;
    }
  }

  private enforceLockedDimension(
    result: EmbeddingResult,
  ): EmbeddingResult | null {
    const dim = result.embedding.length;
    if (this.lockedDimension === null) {
      this.lockedDimension = dim;
      return result;
    }
    if (dim !== this.lockedDimension) {
      console.error(
        `[Embedding] Dimension mismatch: locked=${this.lockedDimension} got=${dim} ` +
          `provider=${this.provider} model=${this.model}. Returning null to protect ` +
          `vector stores. If you intentionally changed the embedding model, restart ` +
          `the server (or set EMBEDDING_ALLOW_PROVIDER_SWITCH=true and rebuild your ` +
          `indexes).`,
      );
      return null;
    }
    return result;
  }

  async embedBatch(texts: string[]): Promise<(EmbeddingResult | null)[]> {
    if (!(await this.isAvailable())) {
      return texts.map(() => null);
    }

    // Two-phase batching: pull cache hits out, send only the misses to
    // the provider, then weave the results back into the input order.
    // For the common case where the same query is being re-embedded
    // alongside genuinely new sub-questions, this skips the provider
    // call for the duplicate without dropping the batch optimization.
    const cacheKeys: (string | null)[] = EMBEDDING_CACHE_ENABLED
      ? texts.map((t) => embeddingCacheKey(this.provider, this.model, t))
      : texts.map(() => null);
    const finalResults: (EmbeddingResult | null)[] = new Array(texts.length).fill(null);
    const missTexts: string[] = [];
    const missIndices: number[] = [];

    for (let i = 0; i < texts.length; i++) {
      const key = cacheKeys[i];
      if (key) {
        const hit = embeddingCacheGet(key);
        if (hit) {
          finalResults[i] = hit;
          continue;
        }
      }
      missTexts.push(texts[i]);
      missIndices.push(i);
    }

    if (missTexts.length === 0) return finalResults;

    try {
      const results =
        this.provider === "ollama"
          ? await this.ollamaEmbedBatch(missTexts)
          : await this.openAICompatibleEmbedBatch(missTexts);
      for (let j = 0; j < results.length; j++) {
        const checked = results[j] === null ? null : this.enforceLockedDimension(results[j]!);
        const origIndex = missIndices[j];
        finalResults[origIndex] = checked;
        const key = cacheKeys[origIndex];
        if (checked && key) embeddingCacheSet(key, checked);
      }
      return finalResults;
    } catch (error) {
      console.error(
        `[Embedding] ${this.provider} batch embed failed:`,
        error instanceof Error ? error.message : "Unknown error",
      );
      return texts.map(() => null);
    }
  }

  async isAvailable(): Promise<boolean> {
    const now = Date.now();
    if (
      this.available !== null &&
      now - this.lastCheck < this.checkIntervalMs
    ) {
      return this.available;
    }

    this.lastCheck = now;

    try {
      switch (this.provider) {
        case "ollama":
          this.available = await this.checkOllama();
          break;
        default:
          this.available = await this.checkOpenAICompatible(
            this.baseUrl,
            this.apiKey,
          );
          break;
      }
    } catch {
      this.available = false;
    }

    // If primary provider failed, try fallback (OpenAI-compatible endpoint).
    // Blocked once a dimension is locked, because swapping providers under a
    // populated vector store guarantees dim-mismatch errors at query time.
    if (!this.available && this.fallbackBaseUrl !== this.baseUrl && this.fallbackApiKey) {
      try {
        this.available = await this.checkOpenAICompatible(
          this.fallbackBaseUrl,
          this.fallbackApiKey,
          this.fallbackModel,
        );
        if (this.available) {
          if (this.lockedDimension === null || env.EMBEDDING_ALLOW_PROVIDER_SWITCH) {
            console.log(
              `[Embedding] Primary provider ${this.provider} unavailable — using OpenAI-compatible fallback (${this.fallbackModel})`,
            );
            this.baseUrl = this.fallbackBaseUrl;
            this.apiKey = this.fallbackApiKey;
            this.model = this.fallbackModel;
            this.provider = "opencode";
          } else {
            console.warn(
              `[Embedding] Primary provider ${this.provider} unavailable; fallback ` +
                `(${this.fallbackModel}) is reachable but provider switch is blocked ` +
                `because dimension is locked at ${this.lockedDimension}. Set ` +
                `EMBEDDING_ALLOW_PROVIDER_SWITCH=true and rebuild your vector indexes ` +
                `to opt in.`,
            );
            this.available = false;
          }
        }
      } catch {
        // fallback also failed
      }
    }

    // Last-resort: local Ollama. Always reachable and any loaded model can
    // produce embeddings via /api/embed. Same dimension-lock guard as above —
    // a silent swap to a different-dim model would corrupt populated stores.
    if (!this.available && env.OLLAMA_API_URL && this.provider !== "ollama") {
      try {
        const ollamaAvailable = await this.checkOllamaEmbed(
          env.OLLAMA_API_URL,
          this.ollamaFallbackModel,
        );
        if (ollamaAvailable) {
          if (this.lockedDimension === null || env.EMBEDDING_ALLOW_PROVIDER_SWITCH) {
            console.log(
              `[Embedding] Cloud providers unavailable — falling back to Ollama (${this.ollamaFallbackModel})`,
            );
            this.baseUrl = env.OLLAMA_API_URL;
            this.apiKey = env.OLLAMA_API_KEY;
            this.model = this.ollamaFallbackModel;
            this.provider = "ollama";
            this.available = true;
          } else {
            console.warn(
              `[Embedding] All cloud providers unavailable; Ollama fallback ` +
                `(${this.ollamaFallbackModel}) is reachable but provider switch is ` +
                `blocked because dimension is locked at ${this.lockedDimension}. ` +
                `Set EMBEDDING_ALLOW_PROVIDER_SWITCH=true and rebuild vector indexes ` +
                `to opt in.`,
            );
          }
        }
      } catch {
        // Ollama also unavailable
      }
    }

    if (!this.available) {
      console.log(
        `[Embedding] Embeddings unavailable for ${this.provider}, using TF-IDF fallback`,
      );
    }

    return this.available;
  }

  getProviderInfo(): {
    provider: string;
    model: string;
    available: boolean | null;
  } {
    return {
      provider: this.provider,
      model: this.model,
      available: this.available,
    };
  }

  // Handles both old Ollama format ({ embedding: [...] }) and new format ({ embeddings: [[...]] })
  private extractOllamaEmbedding(data: Record<string, unknown>): number[] | null {
    if (Array.isArray(data.embedding)) return data.embedding as number[];
    if (Array.isArray(data.embeddings) && Array.isArray((data.embeddings as unknown[][])[0])) {
      return (data.embeddings as number[][])[0];
    }
    return null;
  }

  private hasOllamaEmbedding(data: Record<string, unknown>): boolean {
    return this.extractOllamaEmbedding(data) !== null;
  }

  private async ollamaEmbed(text: string): Promise<EmbeddingResult> {
    const response = await axios.post(
      `${this.baseUrl}/api/embeddings`,
      { model: this.model, prompt: text },
      {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        timeout: 30000,
      },
    );

    const embedding = this.extractOllamaEmbedding(response.data);
    if (!embedding) throw new Error("Ollama returned no embedding in response");
    return {
      embedding,
      model: this.model,
      provider: "ollama",
    };
  }

  private async ollamaEmbedBatch(
    texts: string[],
  ): Promise<(EmbeddingResult | null)[]> {
    // Try the newer /api/embed endpoint first — it accepts batched input in a single request
    try {
      const response = await axios.post(
        `${this.baseUrl}/api/embed`,
        { model: this.model, input: texts },
        {
          headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
          timeout: 60000,
        },
      );
      const embeddings = response.data.embeddings as number[][];
      if (Array.isArray(embeddings) && embeddings.length === texts.length) {
        return embeddings.map((embedding) => ({
          embedding,
          model: this.model,
          provider: "ollama",
        }));
      }
    } catch {
      // /api/embed not available — fall back to concurrent /api/embeddings calls
    }

    // Fall back: parallel requests with a concurrency limit to avoid overwhelming Ollama
    const CONCURRENCY = 5;
    const results: (EmbeddingResult | null)[] = new Array(texts.length).fill(null);

    const runBatch = async (batch: { text: string; index: number }[]) => {
      await Promise.all(
        batch.map(async ({ text, index }) => {
          try {
            results[index] = await this.ollamaEmbed(text);
          } catch {
            results[index] = null;
          }
        }),
      );
    };

    for (let i = 0; i < texts.length; i += CONCURRENCY) {
      const batch = texts
        .slice(i, i + CONCURRENCY)
        .map((text, j) => ({ text, index: i + j }));
      await runBatch(batch);
    }

    return results;
  }

  private async openAICompatibleEmbed(text: string): Promise<EmbeddingResult> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const response = await axios.post(
      `${this.baseUrl}/embeddings`,
      { model: this.model, input: text },
      { headers, timeout: 30000 },
    );

    const embedding = response.data.data[0].embedding;
    return {
      embedding,
      model: response.data.model || this.model,
      provider: this.provider,
    };
  }

  private async openAICompatibleEmbedBatch(
    texts: string[],
  ): Promise<(EmbeddingResult | null)[]> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/embeddings`,
        { model: this.model, input: texts },
        { headers, timeout: 60000 },
      );

      const data = response.data.data as Array<{ embedding: number[] }>;
      const model = response.data.model || this.model;

      return texts.map((_, i) =>
        data[i]
          ? { embedding: data[i].embedding, model, provider: this.provider }
          : null,
      );
    } catch {
      return texts.map(() => null);
    }
  }

  private async checkOllama(): Promise<boolean> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/api/embeddings`,
        { model: this.model, prompt: "test" },
        {
          headers: this.apiKey
            ? { Authorization: `Bearer ${this.apiKey}` }
            : {},
          timeout: 10000,
        },
      );
      return !!(response.data && this.hasOllamaEmbedding(response.data));
    } catch (err: unknown) {
      if (this.isModelNotFoundError(err) && !this.pullAttempted) {
        console.log(`[Embedding] Model "${this.model}" not found locally — attempting ollama pull...`);
        const pulled = await this.ollamaPull(this.model);
        if (pulled) {
          try {
            const retry = await axios.post(
              `${this.baseUrl}/api/embeddings`,
              { model: this.model, prompt: "test" },
              {
                headers: this.apiKey
                  ? { Authorization: `Bearer ${this.apiKey}` }
                  : {},
                timeout: 30000,
              },
            );
            return !!(retry.data && this.hasOllamaEmbedding(retry.data));
          } catch {
            return false;
          }
        }
      }
      return false;
    }
  }

  // Uses /api/embeddings (same endpoint as ollamaEmbed) so check and embed are consistent.
  private async checkOllamaEmbed(baseUrl: string, model: string, timeout = 10000): Promise<boolean> {
    try {
      const response = await axios.post(
        `${baseUrl}/api/embeddings`,
        { model, prompt: "test" },
        { timeout },
      );
      return !!(response.data && this.hasOllamaEmbedding(response.data));
    } catch (err: unknown) {
      if (this.isModelNotFoundError(err) && !this.pullAttempted) {
        console.log(`[Embedding] Model "${model}" not found locally — attempting ollama pull...`);
        const pulled = await this.ollamaPullForUrl(baseUrl, model);
        if (pulled) {
          try {
            const retry = await axios.post(
              `${baseUrl}/api/embeddings`,
              { model, prompt: "test" },
              { timeout: 30000 },
            );
            return !!(retry.data && this.hasOllamaEmbedding(retry.data));
          } catch {
            return false;
          }
        }
      }
      return false;
    }
  }

  private isModelNotFoundError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as { response?: { status?: number; data?: { error?: string } }; message?: string };
    if (e.response?.status === 404) return true;
    const msg = (e.response?.data?.error ?? e.message ?? "").toLowerCase();
    return msg.includes("not found") || msg.includes("no model") || msg.includes("does not exist");
  }

  private async ollamaPull(model: string): Promise<boolean> {
    return this.ollamaPullForUrl(this.baseUrl, model);
  }

  private async ollamaPullForUrl(baseUrl: string, model: string): Promise<boolean> {
    this.pullAttempted = true;
    try {
      const response = await axios.post(
        `${baseUrl}/api/pull`,
        { name: model, stream: false },
        { timeout: 300000 },
      );
      const ok = response.data?.status === "success" || response.status === 200;
      if (ok) {
        console.log(`[Embedding] Successfully pulled model "${model}" from Ollama`);
      } else {
        console.warn(`[Embedding] Failed to pull model "${model}" from Ollama: unexpected response`);
      }
      return ok;
    } catch (err) {
      console.warn(`[Embedding] Failed to pull model "${model}" from Ollama:`, err instanceof Error ? err.message : "Unknown error");
      return false;
    }
  }

  private async checkOpenAICompatible(baseUrl?: string, apiKey?: string, model?: string): Promise<boolean> {
    const url = baseUrl || this.baseUrl;
    const key = apiKey || this.apiKey;
    const embedModel = model || this.model;
    if (!key) return false;

    try {
      const response = await axios.post(
        `${url}/embeddings`,
        { model: embedModel, input: "test" },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          timeout: 5000,
        },
      );
      return !!(
        response.data &&
        response.data.data &&
        response.data.data.length > 0
      );
    } catch {
      return false;
    }
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

export const embeddingService = new EmbeddingService();
