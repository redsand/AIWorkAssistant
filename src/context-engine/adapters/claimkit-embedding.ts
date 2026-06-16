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

  constructor(dimensionsOverride?: number) {
    this._dimensions = dimensionsOverride ?? guessDimensions(env.RAG_EMBEDDING_MODEL);
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
      const info = embeddingService.getProviderInfo();
      throw new Error(
        `[ClaimKitEmbedding] Embed failed: provider=${info.provider} is ${
          info.available ? "available" : "unavailable"
        }`,
      );
    }
    this.guardDimension(result.embedding.length);
    return result.embedding;
  }

  async embedBatch(texts: readonly string[]): Promise<number[][]> {
    const arr = texts as string[];
    const results = await embeddingService.embedBatch(arr);
    const embeddings: number[][] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r) {
        const info = embeddingService.getProviderInfo();
        throw new Error(
          `[ClaimKitEmbedding] Batch embed[${i}] failed for provider=${info.provider}`,
        );
      }
      this.guardDimension(r.embedding.length);
      embeddings.push(r.embedding);
    }
    return embeddings;
  }

  private guardDimension(dim: number): void {
    if (dim !== this._dimensions) {
      throw new Error(
        `[ClaimKitEmbedding] Dimension mismatch: expected ${this._dimensions}, got ${dim}. ` +
          `Refusing the embedding to protect the vector store. Restart the process (or set ` +
          `EMBEDDING_ALLOW_PROVIDER_SWITCH=true and rebuild vector indexes) if you intentionally ` +
          `changed the embedding model.`,
      );
    }
  }
}
