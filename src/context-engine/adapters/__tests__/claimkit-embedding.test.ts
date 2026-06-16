import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClaimKitEmbeddingAdapter } from "../claimkit-embedding";
import { embeddingService } from "../../../agent/embedding-service";

const makeVector = (dim: number) => Array.from({ length: dim }, (_, i) => i / dim);

describe("ClaimKitEmbeddingAdapter", () => {
  beforeEach(() => {
    vi.spyOn(embeddingService, "getProviderInfo").mockReturnValue({
      provider: "test",
      model: "text-embedding-3-small",
      available: true,
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("advertises the constructor dimension across multiple embed calls", async () => {
    vi.spyOn(embeddingService, "embed").mockResolvedValue({
      embedding: makeVector(1536),
      model: "text-embedding-3-small",
      provider: "test",
    });

    const adapter = new ClaimKitEmbeddingAdapter(1536);
    expect(adapter.dimensions).toBe(1536);

    await adapter.embed("hello");
    expect(adapter.dimensions).toBe(1536);

    await adapter.embedBatch(["a", "b"]);
    expect(adapter.dimensions).toBe(1536);
  });

  it("logs a warning but does not mutate dimensions when result length mismatches", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(embeddingService, "embed").mockResolvedValue({
      embedding: makeVector(768),
      model: "nomic-embed-text",
      provider: "test",
    });

    const adapter = new ClaimKitEmbeddingAdapter(1536);
    const result = await adapter.embed("hello");

    expect(result.length).toBe(768);
    expect(adapter.dimensions).toBe(1536);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Dimension mismatch"),
    );
    warnSpy.mockRestore();
  });

  it("defaults to 1536 when no override is provided", () => {
    const adapter = new ClaimKitEmbeddingAdapter();
    expect(adapter.dimensions).toBe(1536);
  });

  it("honors a custom dimension override", () => {
    const adapter = new ClaimKitEmbeddingAdapter(768);
    expect(adapter.dimensions).toBe(768);
  });
});
