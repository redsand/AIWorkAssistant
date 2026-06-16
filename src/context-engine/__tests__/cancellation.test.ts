import { describe, it, expect, vi, beforeEach } from "vitest";
import { withAbortableTimeout } from "../context-packet.js";

describe("withAbortableTimeout", () => {
  it("aborts the underlying promise when the timeout fires", async () => {
    let receivedSignal: AbortSignal | undefined;
    const makePromise = vi.fn(async (signal: AbortSignal) => {
      receivedSignal = signal;
      await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return "done";
    });

    const result = await withAbortableTimeout(makePromise, 50, "timeout-value");

    expect(result).toBe("timeout-value");
    expect(receivedSignal?.aborted).toBe(true);
    expect(makePromise).toHaveBeenCalledTimes(1);
  });

  it("returns the resolved value when the promise finishes in time", async () => {
    const makePromise = vi.fn(async (_signal: AbortSignal) => "finished");
    const result = await withAbortableTimeout(makePromise, 1000, "timeout-value");
    expect(result).toBe("finished");
  });
});

describe("ingestScoredDocumentsForQuery cancellation", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("stops early when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const ingest = vi.fn(async () => ({ sourceId: "src-1" }));
    vi.doMock("../adapters/claimkit-adapter.js", () => ({
      claimKitAdapter: {
        isAvailable: () => true,
        ingest,
      },
    }));

    const { ingestScoredDocumentsForQuery } = await import("../claimkit-ingestion.js");
    const stats = await ingestScoredDocumentsForQuery(
      [{
        id: "d1",
        content: "doc 1",
        source: "memory" as const,
        title: "Doc 1",
        score: 1,
        baseScore: 1,
        importanceScore: 1,
        recencyScore: 1,
        trustScore: 1,
        claimKitBoost: 0,
        tokens: 2,
        metadata: {},
      }],
      "query",
      5,
      controller.signal,
    );

    expect(stats.total).toBe(1);
    expect(ingest).not.toHaveBeenCalled();
  });
});
