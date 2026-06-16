import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  IngestionDedupeStore,
  hashContent,
  ingestedIds,
} from "../claimkit-ingestion";

vi.mock("../../agent/embedding-service", () => ({
  embeddingService: {
    getProviderInfo: vi.fn().mockReturnValue({ model: "test-model" }),
  },
}));

// Force in-memory mode for this test file so migrations don't touch disk.
process.env.VITEST = "true";

describe("IngestionDedupeStore", () => {
  let store: IngestionDedupeStore;

  beforeEach(() => {
    store = new IngestionDedupeStore();
  });

  it("should treat an unseen key as changed", () => {
    expect(store.hasChanged("a", hashContent("x"))).toBe(true);
  });

  it("should treat an identical key+hash as unchanged", () => {
    const hash = hashContent("x");
    store.add("a", hash);
    expect(store.hasChanged("a", hash)).toBe(false);
  });

  it("should detect a changed hash", () => {
    const hashA = hashContent("x");
    const hashB = hashContent("y");
    store.add("a", hashA);
    expect(store.hasChanged("a", hashB)).toBe(true);
  });

  it("should detect an updated upstream timestamp", () => {
    store.add("a", hashContent("x"), "2026-01-01T00:00:00Z");
    expect(store.hasChanged("a", hashContent("x"), "2026-06-16T00:00:00Z")).toBe(true);
  });

  it("should not flag a stale upstream timestamp as changed", () => {
    store.add("a", hashContent("x"), "2026-06-16T00:00:00Z");
    expect(store.hasChanged("a", hashContent("x"), "2026-01-01T00:00:00Z")).toBe(false);
  });

  it("legacy has() returns true when unchanged", () => {
    const hash = hashContent("x");
    store.add("a", hash);
    expect(store.has("a")).toBe(true);
  });

  it("legacy has() returns false when never seen", () => {
    expect(store.has("a")).toBe(false);
  });

  it("global ingestedIds singleton is available", () => {
    expect(ingestedIds).toBeDefined();
  });

  it("hashContent is deterministic", () => {
    expect(hashContent("hello")).toBe(hashContent("hello"));
  });

  it("hashContent differs for different content", () => {
    expect(hashContent("hello")).not.toBe(hashContent("world"));
  });
});

