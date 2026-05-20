import { vi } from "vitest";

vi.mock("claimkit", () => ({
  ClaimKit: vi.fn(() => ({
    ingest: vi.fn(),
    query: vi.fn(),
  })),
  createMemoryStores: vi.fn(() => ({})),
  MemoryLLMAdapter: vi.fn(),
  MemoryEmbeddingAdapter: vi.fn(),
}));
