import { describe, expect, it } from "vitest";

import { ProcessRetryCircuit } from "../process-retry-circuit";

function makeCircuit(opts: { maxFailures?: number; windowMs?: number; now?: () => number } = {}) {
  return new ProcessRetryCircuit({
    maxFailures: opts.maxFailures ?? 3,
    windowMs: opts.windowMs ?? 60_000,
    now: opts.now,
  });
}

describe("ProcessRetryCircuit", () => {
  it("returns null when no failures have been recorded", () => {
    const c = makeCircuit();
    expect(c.check("/ws", "ISSUE-1")).toBeNull();
  });

  it("does not trip on the first two failures inside the window", () => {
    let t = 1000;
    const c = makeCircuit({ maxFailures: 3, now: () => t });
    c.recordFailure("/ws", "ISSUE-1");
    t += 100;
    c.recordFailure("/ws", "ISSUE-1");
    expect(c.check("/ws", "ISSUE-1")).toBeNull();
  });

  it("trips on the Nth failure inside the window", () => {
    let t = 1000;
    const c = makeCircuit({ maxFailures: 3, now: () => t });
    c.recordFailure("/ws", "ISSUE-1");
    t += 100;
    c.recordFailure("/ws", "ISSUE-1");
    t += 100;
    c.recordFailure("/ws", "ISSUE-1");
    const reason = c.check("/ws", "ISSUE-1");
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/process-local circuit/);
    expect(reason).toMatch(/ISSUE-1/);
    expect(reason).toMatch(/3 time/);
  });

  it("resets the count after the sliding window elapses", () => {
    let t = 1000;
    const c = makeCircuit({ maxFailures: 3, windowMs: 5_000, now: () => t });
    c.recordFailure("/ws", "ISSUE-1");
    c.recordFailure("/ws", "ISSUE-1");
    c.recordFailure("/ws", "ISSUE-1");
    expect(c.check("/ws", "ISSUE-1")).not.toBeNull();
    // Jump well past the window.
    t += 10_000;
    expect(c.check("/ws", "ISSUE-1")).toBeNull();
    // A fresh failure starts a clean count.
    c.recordFailure("/ws", "ISSUE-1");
    expect(c.check("/ws", "ISSUE-1")).toBeNull();
  });

  it("scopes by (workspace, issueKey) — independent counts", () => {
    const c = makeCircuit({ maxFailures: 2 });
    c.recordFailure("/ws-a", "ISSUE-1");
    c.recordFailure("/ws-a", "ISSUE-1");
    expect(c.check("/ws-a", "ISSUE-1")).not.toBeNull();
    expect(c.check("/ws-b", "ISSUE-1")).toBeNull();
    expect(c.check("/ws-a", "ISSUE-2")).toBeNull();
  });

  it("clear() resets the count regardless of state", () => {
    const c = makeCircuit({ maxFailures: 2 });
    c.recordFailure("/ws", "ISSUE-1");
    c.recordFailure("/ws", "ISSUE-1");
    expect(c.check("/ws", "ISSUE-1")).not.toBeNull();
    c.clear("/ws", "ISSUE-1");
    expect(c.check("/ws", "ISSUE-1")).toBeNull();
  });

  it("recordFailure() after window-expiry starts fresh, not appended", () => {
    let t = 1000;
    const c = makeCircuit({ maxFailures: 3, windowMs: 5_000, now: () => t });
    c.recordFailure("/ws", "ISSUE-1");
    c.recordFailure("/ws", "ISSUE-1");
    t += 10_000;
    c.recordFailure("/ws", "ISSUE-1");
    // Only 1 failure inside the current window → not tripped.
    expect(c.check("/ws", "ISSUE-1")).toBeNull();
  });

  it("snapshot() reflects all open buckets", () => {
    const c = makeCircuit({ maxFailures: 5 });
    c.recordFailure("/ws", "ISSUE-1");
    c.recordFailure("/ws", "ISSUE-2");
    const snap = c.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap.find((s) => s.key.endsWith("::ISSUE-1"))?.state.count).toBe(1);
    expect(snap.find((s) => s.key.endsWith("::ISSUE-2"))?.state.count).toBe(1);
  });

  it("constructor enforces positive defaults", () => {
    const c1 = new ProcessRetryCircuit({ maxFailures: -1 });
    const c2 = new ProcessRetryCircuit({ windowMs: 0 });
    c1.recordFailure("w", "i");
    c1.recordFailure("w", "i");
    c1.recordFailure("w", "i");
    expect(c1.check("w", "i")).not.toBeNull();
    expect(c2.check("w", "i")).toBeNull();
  });
});
