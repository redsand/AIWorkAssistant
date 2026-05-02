import axios from "axios";
import { env } from "../config/env";

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  provider: string;
}

class EmbeddingService {
  private provider: string;
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private available: boolean | null = null;
  private lastCheck = 0;
  private checkIntervalMs = 5 * 60 * 1000;

  constructor() {
    this.provider = env.AI_PROVIDER;
    this.model = env.RAG_EMBEDDING_MODEL;

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

    try {
      switch (this.provider) {
        case "ollama":
          return await this.ollamaEmbed(text);
        default:
          return await this.openAICompatibleEmbed(text);
      }
    } catch (error) {
      console.error(
        `[Embedding] ${this.provider} embed failed:`,
        error instanceof Error ? error.message : "Unknown error",
      );
      this.available = false;
      return null;
    }
  }

  async embedBatch(texts: string[]): Promise<(EmbeddingResult | null)[]> {
    if (!(await this.isAvailable())) {
      return texts.map(() => null);
    }

    try {
      switch (this.provider) {
        case "ollama":
          return await this.ollamaEmbedBatch(texts);
        default:
          return await this.openAICompatibleEmbedBatch(texts);
      }
    } catch (error) {
      console.error(
        `[Embedding] ${this.provider} batch embed failed:`,
        error instanceof Error ? error.message : "Unknown error",
      );
      this.available = false;
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
          this.available = await this.checkOpenAICompatible();
          break;
      }
    } catch {
      this.available = false;
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

  private async ollamaEmbed(text: string): Promise<EmbeddingResult> {
    const response = await axios.post(
      `${this.baseUrl}/api/embeddings`,
      { model: this.model, prompt: text },
      {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        timeout: 30000,
      },
    );

    return {
      embedding: response.data.embedding,
      model: this.model,
      provider: "ollama",
    };
  }

  private async ollamaEmbedBatch(
    texts: string[],
  ): Promise<(EmbeddingResult | null)[]> {
    const results: (EmbeddingResult | null)[] = [];
    for (const text of texts) {
      try {
        results.push(await this.ollamaEmbed(text));
      } catch {
        results.push(null);
      }
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
      return !!(response.data && response.data.embedding);
    } catch {
      return false;
    }
  }

  private async checkOpenAICompatible(): Promise<boolean> {
    if (!this.apiKey) return false;

    try {
      const response = await axios.post(
        `${this.baseUrl}/embeddings`,
        { model: this.model, input: "test" },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          timeout: 10000,
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
