import { afterEach, describe, expect, it } from "vitest";

import { ingestionStatusTracker } from "../claimkit-ingestion";

afterEach(() => {
  ingestionStatusTracker.__resetForTests();
});

describe("ingestionStatusTracker", () => {
  it("starts in a non-ready, non-failed state with no phases", () => {
    const snap = ingestionStatusTracker.snapshot();
    expect(snap.isReady).toBe(false);
    expect(snap.failed).toBe(false);
    expect(snap.startedAt).toBeNull();
    expect(snap.completedAt).toBeNull();
    expect(snap.phases).toEqual([]);
  });

  it("beginRun() records startedAt and isReady stays false until markComplete", () => {
    ingestionStatusTracker.beginRun();
    let snap = ingestionStatusTracker.snapshot();
    expect(snap.startedAt).toBeTruthy();
    expect(snap.isReady).toBe(false);

    ingestionStatusTracker.markComplete();
    snap = ingestionStatusTracker.snapshot();
    expect(snap.isReady).toBe(true);
    expect(snap.failed).toBe(false);
    expect(snap.completedAt).toBeTruthy();
    expect(snap.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("markFailed() flips both completedAt and failed; isReady stays false", () => {
    ingestionStatusTracker.beginRun();
    ingestionStatusTracker.markFailed();
    const snap = ingestionStatusTracker.snapshot();
    expect(snap.failed).toBe(true);
    expect(snap.isReady).toBe(false);
    expect(snap.completedAt).toBeTruthy();
  });

  it("tracks phase totals, ingested/skipped/errors, and completion order", () => {
    ingestionStatusTracker.beginRun();
    ingestionStatusTracker.beginPhase("knowledge", 20);
    ingestionStatusTracker.updatePhase("knowledge", { ingested: 5, skipped: 1 });
    ingestionStatusTracker.endPhase("knowledge", { ingested: 18, skipped: 1, errors: 1 });

    ingestionStatusTracker.beginPhase("graph-nodes", 364);
    ingestionStatusTracker.updatePhase("graph-nodes", { ingested: 100 });

    const snap = ingestionStatusTracker.snapshot();
    expect(snap.phases).toHaveLength(2);

    const knowledge = snap.phases.find((p) => p.name === "knowledge");
    expect(knowledge?.total).toBe(20);
    expect(knowledge?.ingested).toBe(18);
    expect(knowledge?.skipped).toBe(1);
    expect(knowledge?.errors).toBe(1);
    expect(knowledge?.completedAt).toBeTruthy();

    const nodes = snap.phases.find((p) => p.name === "graph-nodes");
    expect(nodes?.total).toBe(364);
    expect(nodes?.ingested).toBe(100);
    expect(nodes?.completedAt).toBeNull();
  });

  it("beginRun() clears any prior state", () => {
    ingestionStatusTracker.beginRun();
    ingestionStatusTracker.beginPhase("knowledge", 5);
    ingestionStatusTracker.markComplete();

    ingestionStatusTracker.beginRun();
    const snap = ingestionStatusTracker.snapshot();
    expect(snap.phases).toEqual([]);
    expect(snap.completedAt).toBeNull();
    expect(snap.isReady).toBe(false);
  });

  it("updatePhase() on an unknown phase is a no-op", () => {
    ingestionStatusTracker.beginRun();
    ingestionStatusTracker.updatePhase("graph-edges", { ingested: 42 });
    const snap = ingestionStatusTracker.snapshot();
    expect(snap.phases).toEqual([]);
  });
});
