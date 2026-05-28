import { EmbeddingAdapter } from "@redsand/claimkit";
import type { EmbeddingModelMetadata } from "@redsand/claimkit";
import { embeddingService } from "../../agent/embedding-service";
import { env } from "../../config/env";

const KNOWN_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "bge-m3": 1024,
  "all-minilm": 384,
};

function guessDimensions(model: string | undefined): number {
  if (!model) return 1536;
  const key = Object.keys(KNOWN_DIMENSIONS).find(
    (k) => k === model || model.includes(k),
  );
  return key ? KNOWN_DIMENSIONS[key] : 1536;
}

export class ClaimKitEmbeddingAdapter implements EmbeddingAdapter {
  private _dimensions: number;
  private _detected = false;

  constructor() {
    this._dimensions = guessDimensions(env.RAG_EMBEDDING_MODEL);
  }

  get dimensions(): number {
    return this._dimensions;
  }

  get model(): EmbeddingModelMetadata {
    const info = embeddingService.getProviderInfo();
    return {
      provider: info.provider,
      model: info.model,
      dimensions: this._dimensions,
      normalized: true,
    };
  }

  async embed(text: string): Promise<number[]> {
    const result = await embeddingService.embed(text);
    if (!result) {
      // Return empty array so ClaimRetriever skips vector search and falls back to keyword search.
      // A zero-vector would make ALL cosine similarities 0, giving the same score to every claim
      // and preventing the keyword-match fallback (0.4) from ever applying.
      return [];
    }
    this.recordDimensions(result.embedding.length);
    return result.embedding;
  }

  async embedBatch(texts: readonly string[]): Promise<number[][]> {
    const arr = texts as string[];
    const results = await embeddingService.embedBatch(arr);
    const embeddings: number[][] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r) {
        embeddings.push([]);
      } else {
        this.recordDimensions(r.embedding.length);
        embeddings.push(r.embedding);
      }
    }
    return embeddings;
  }

  private recordDimensions(dim: number): void {
    if (!this._detected || dim !== this._dimensions) {
      this._dimensions = dim;
      this._detected = true;
    }
  }
}
