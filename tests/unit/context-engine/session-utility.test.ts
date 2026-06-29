// tests/unit/context-engine/session-utility.test.ts
//
// Covers the semantic-aware Thompson sampling for memory-session retrieval
// (issue #246): the pure Beta/Gamma samplers, the epsilon-greedy top-k
// selector, the follow-up/rephrase feedback classifier, and the SQLite-backed
// SessionUtilityStore (cold-start prior, alpha/beta updates, turn-outcome
// attribution). The store is exercised against a real temp DB; no network or
// embedding provider is needed.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import {
  SessionUtilityStore,
  sampleGamma,
  sampleBeta,
  thompsonSelect,
  utilityMean,
  classifyFollowUpSignal,
  DEFAULT_PRIOR_ALPHA,
  DEFAULT_PRIOR_BETA,
  type SessionUtility,
  type UtilityCandidate,
} from "../../../src/memory/session-utility";

function tmpDir(): string {
  return path.join(
    os.tmpdir(),
    `session-utility-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

// Deterministic linear-congruential RNG so sampling-based assertions are stable.
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // Numerical Recipes LCG constants.
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function util(
  sessionId: string,
  alpha: number,
  beta: number,
): SessionUtility {
  return { sessionId, alpha, beta, lastUsed: new Date(0) };
}

describe("session-utility pure samplers", () => {
  it("sampleGamma returns 0 for non-positive shapes", () => {
    expect(sampleGamma(0)).toBe(0);
    expect(sampleGamma(-3)).toBe(0);
    expect(sampleGamma(Number.NaN)).toBe(0);
  });

  it("sampleGamma mean approximates the shape parameter (rate 1)", () => {
    const rng = seededRng(42);
    const n = 4000;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += sampleGamma(3, rng);
    const mean = sum / n;
    // E[Gamma(3,1)] = 3
    expect(mean).toBeGreaterThan(2.6);
    expect(mean).toBeLessThan(3.4);
  });

  it("sampleGamma handles shape < 1 via boosting and stays finite", () => {
    const rng = seededRng(7);
    for (let i = 0; i < 200; i++) {
      const v = sampleGamma(0.4, rng);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it("sampleBeta stays within [0,1] and approximates alpha/(alpha+beta)", () => {
    const rng = seededRng(123);
    const n = 4000;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = sampleBeta(8, 2, rng);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      sum += v;
    }
    // E[Beta(8,2)] = 0.8
    expect(sum / n).toBeGreaterThan(0.72);
    expect(sum / n).toBeLessThan(0.88);
  });

  it("sampleBeta returns 0 when both shapes collapse to 0", () => {
    expect(sampleBeta(0, 0)).toBe(0);
  });

  it("utilityMean computes the Beta posterior mean", () => {
    expect(utilityMean({ alpha: 3, beta: 1 })).toBeCloseTo(0.75, 5);
    expect(utilityMean({ alpha: 0, beta: 0 })).toBe(0);
  });
});

describe("thompsonSelect", () => {
  const candidates = (): UtilityCandidate[] => [
    { sessionId: "high", similarity: 0.9, utility: util("high", 20, 1) },
    { sessionId: "mid", similarity: 0.6, utility: util("mid", 5, 5) },
    { sessionId: "low", similarity: 0.5, utility: util("low", 1, 20) },
    { sessionId: "cold", similarity: 0.4, utility: util("cold", 2, 1) },
  ];

  it("returns at most topK results", () => {
    const out = thompsonSelect(candidates(), {
      topK: 2,
      epsilon: 0,
      rng: seededRng(1),
    });
    expect(out.length).toBe(2);
  });

  it("returns empty for no candidates or non-positive topK", () => {
    expect(thompsonSelect([], { topK: 3 })).toEqual([]);
    expect(thompsonSelect(candidates(), { topK: 0 })).toEqual([]);
  });

  it("exploitation favors the high-utility high-similarity session", () => {
    // Average selection over many seeds: the strong arm should win a slot
    // far more often than the weak one.
    let highWins = 0;
    let lowWins = 0;
    for (let s = 0; s < 200; s++) {
      const out = thompsonSelect(candidates(), {
        topK: 1,
        epsilon: 0,
        rng: seededRng(s + 1),
      });
      if (out[0].sessionId === "high") highWins++;
      if (out[0].sessionId === "low") lowWins++;
    }
    expect(highWins).toBeGreaterThan(lowWins);
    expect(highWins).toBeGreaterThan(120);
  });

  it("combinedScore equals sampledUtility * similarity", () => {
    const out = thompsonSelect(candidates(), {
      topK: 4,
      epsilon: 0,
      rng: seededRng(99),
    });
    for (const r of out) {
      expect(r.combinedScore).toBeCloseTo(r.sampledUtility * r.similarity, 10);
    }
  });

  it("epsilon-greedy can surface an explored low-utility session", () => {
    let exploredSeen = false;
    for (let s = 0; s < 100 && !exploredSeen; s++) {
      const out = thompsonSelect(candidates(), {
        topK: 2,
        epsilon: 1, // always explore
        rng: seededRng(s + 1),
      });
      if (out.some((r) => r.explored)) exploredSeen = true;
    }
    expect(exploredSeen).toBe(true);
  });

  it("never explores when epsilon is 0", () => {
    for (let s = 0; s < 50; s++) {
      const out = thompsonSelect(candidates(), {
        topK: 2,
        epsilon: 0,
        rng: seededRng(s + 1),
      });
      expect(out.every((r) => !r.explored)).toBe(true);
    }
  });
});

describe("classifyFollowUpSignal", () => {
  it("identical questions are a failure (rephrase)", () => {
    expect(classifyFollowUpSignal("what is the status?", "What is the status?")).toBe(
      "failure",
    );
  });

  it("heavy-overlap rephrases are failures", () => {
    expect(
      classifyFollowUpSignal(
        "how do I configure the ollama embedding provider",
        "how should I configure the ollama embedding provider please",
      ),
    ).toBe("failure");
  });

  it("distinct follow-ups are a success", () => {
    expect(
      classifyFollowUpSignal(
        "summarize the incident timeline",
        "now draft a customer email apology",
      ),
    ).toBe("success");
  });

  it("ambiguous overlap returns null", () => {
    expect(
      classifyFollowUpSignal(
        "show me the failing tests",
        "show me the deployment logs instead",
      ),
    ).toBeNull();
  });

  it("empty input returns null", () => {
    expect(classifyFollowUpSignal("", "anything")).toBeNull();
    expect(classifyFollowUpSignal("anything", "")).toBeNull();
  });
});

describe("SessionUtilityStore", () => {
  let dir: string;
  let store: SessionUtilityStore;

  beforeEach(() => {
    dir = tmpDir();
    store = new SessionUtilityStore(dir);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("returns an optimistic Beta(2,1) cold-start prior for unknown sessions", () => {
    const u = store.getUtility("never-seen");
    expect(u.alpha).toBe(DEFAULT_PRIOR_ALPHA);
    expect(u.beta).toBe(DEFAULT_PRIOR_BETA);
    expect(u.sessionId).toBe("never-seen");
  });

  it("does not persist the cold-start prior", () => {
    store.getUtility("ghost");
    expect(store.all()).toHaveLength(0);
  });

  it("updateSessionUtility increments alpha on success, beta on failure", () => {
    const a = store.updateSessionUtility("s1", true);
    expect(a.alpha).toBe(DEFAULT_PRIOR_ALPHA + 1);
    expect(a.beta).toBe(DEFAULT_PRIOR_BETA);

    const b = store.updateSessionUtility("s1", false);
    expect(b.alpha).toBe(DEFAULT_PRIOR_ALPHA + 1);
    expect(b.beta).toBe(DEFAULT_PRIOR_BETA + 1);
  });

  it("persists updates across reads", () => {
    store.updateSessionUtility("s2", true);
    store.updateSessionUtility("s2", true);
    const reloaded = store.getUtility("s2");
    expect(reloaded.alpha).toBe(DEFAULT_PRIOR_ALPHA + 2);
  });

  it("persists across store instances on the same directory", () => {
    store.updateSessionUtility("s3", true);
    store.close();
    const store2 = new SessionUtilityStore(dir);
    try {
      expect(store2.getUtility("s3").alpha).toBe(DEFAULT_PRIOR_ALPHA + 1);
    } finally {
      store2.close();
    }
  });

  it("getUtilities returns a map keyed by sessionId", () => {
    store.updateSessionUtility("a", true);
    const map = store.getUtilities(["a", "b"]);
    expect(map.get("a")?.alpha).toBe(DEFAULT_PRIOR_ALPHA + 1);
    expect(map.get("b")?.alpha).toBe(DEFAULT_PRIOR_ALPHA); // cold-start
  });

  it("recordTurnOutcome attributes feedback to the remembered retrieval", () => {
    store.rememberRetrieval("chat-1", ["x", "y"]);
    const n = store.recordTurnOutcome("chat-1", true);
    expect(n).toBe(2);
    expect(store.getUtility("x").alpha).toBe(DEFAULT_PRIOR_ALPHA + 1);
    expect(store.getUtility("y").alpha).toBe(DEFAULT_PRIOR_ALPHA + 1);
  });

  it("recordTurnOutcome clears the pending retrieval (no double counting)", () => {
    store.rememberRetrieval("chat-2", ["z"]);
    expect(store.recordTurnOutcome("chat-2", false)).toBe(1);
    // Second call has nothing remembered → no further updates.
    expect(store.recordTurnOutcome("chat-2", false)).toBe(0);
    expect(store.getUtility("z").beta).toBe(DEFAULT_PRIOR_BETA + 1);
  });

  it("rememberRetrieval with an empty list clears any pending retrieval", () => {
    store.rememberRetrieval("chat-3", ["q"]);
    store.rememberRetrieval("chat-3", []);
    expect(store.recordTurnOutcome("chat-3", true)).toBe(0);
  });

  it("all() returns every persisted utility", () => {
    store.updateSessionUtility("one", true);
    store.updateSessionUtility("two", false);
    const ids = store.all().map((u) => u.sessionId).sort();
    expect(ids).toEqual(["one", "two"]);
  });
});
