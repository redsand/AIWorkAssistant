import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// classifyIntent and shouldRunContradictionCheck both use the
// embedding-based classifier in intent-classifier.ts. To exercise it
// without a live embedding model we mock embeddingService.embed +
// embedBatch with deterministic vectors so cosine math gives us the
// expected nearest prototype.
//
// The mock pattern: each canonical intent gets its own "axis"
// (1.0 in one dimension, 0 elsewhere). The test question vector
// projects strongly onto whichever axis we want to win. This is
// cleaner than trying to chain a real embedding model in a unit test
// and proves the classifier's nearest-prototype logic without
// depending on model quality.

// Seven dimensions: [fact_lookup, procedural, comparison, verification, temporal_audit, general1, general2]
const AXIS = {
  fact_lookup: [1, 0, 0, 0, 0, 0, 0],
  procedural: [0, 1, 0, 0, 0, 0, 0],
  comparison: [0, 0, 1, 0, 0, 0, 0],
  verification: [0, 0, 0, 1, 0, 0, 0],
  temporal_audit: [0, 0, 0, 0, 1, 0, 0],
  unrelated: [0, 0, 0, 0, 0, 1, 1], // low cosine vs every axis
};

// Map prototype text → expected axis. Mirror PROTOTYPES from
// intent-classifier.ts. Anything not listed defaults to unrelated.
const PROTOTYPE_VECTORS: Record<string, number[]> = {
  "what is the status of the case": AXIS.fact_lookup,
  "who is the owner of this issue": AXIS.fact_lookup,
  "describe the auth flow": AXIS.fact_lookup,
  "get the session count": AXIS.fact_lookup,
  "tell me how many cases are open": AXIS.fact_lookup,

  "show me the failed runs": AXIS.procedural,
  "list the active runners": AXIS.procedural,
  "display the dashboard": AXIS.procedural,
  "open the settings page": AXIS.procedural,
  "pull up the latest report": AXIS.procedural,

  "compare last week and this week": AXIS.comparison,
  "what is the difference between A and B": AXIS.comparison,
  "how does X compare to Y": AXIS.comparison,
  "kimi vs glm performance": AXIS.comparison,
  "which model performs better": AXIS.comparison,

  "verify the report numbers": AXIS.verification,
  "is that correct": AXIS.verification,
  "confirm that the ticket is closed": AXIS.verification,
  "validate the claim about the model": AXIS.verification,
  "is this accurate": AXIS.verification,

  "did the status change since yesterday": AXIS.temporal_audit,
  "history of the case": AXIS.temporal_audit,
  "audit the close dispositions": AXIS.temporal_audit,
  "what changed in the last week": AXIS.temporal_audit,
  "when was this updated": AXIS.temporal_audit,
};

vi.mock("../../../agent/embedding-service", async () => {
  const cosineSimilarity = (a: number[], b: number[]): number => {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  };

  // Test queue: set this before calling classifyIntent and the next
  // embed() call will return this vector.
  const queue: number[][] = [];

  return {
    cosineSimilarity,
    embeddingService: {
      isAvailable: async () => true,
      embed: async (text: string) => {
        // Prototype embeds come from the canonical table; query
        // embeds come from the queue (set by test). If we run out of
        // queue, return a neutral vector.
        const proto = PROTOTYPE_VECTORS[text];
        if (proto) return { embedding: proto, model: "test", provider: "test" };
        const v = queue.shift() ?? AXIS.unrelated;
        return { embedding: v, model: "test", provider: "test" };
      },
      embedBatch: async (texts: string[]) => {
        return texts.map((t) => {
          const proto = PROTOTYPE_VECTORS[t];
          if (proto) return { embedding: proto, model: "test", provider: "test" };
          const v = queue.shift() ?? AXIS.unrelated;
          return { embedding: v, model: "test", provider: "test" };
        });
      },
    },
    // Test hook so tests can stage the query vector.
    __TEST_queueVector: (v: number[]) => queue.push(v),
  };
});

async function loadModule() {
  const mod = await import("../intent-classifier.js");
  const adapter = await import("../claimkit-adapter.js");
  const emb = await import("../../../agent/embedding-service.js");
  mod.__resetIntentClassifierForTests();
  return {
    classifyIntent: mod.classifyIntent,
    shouldRunContradictionCheck: adapter.shouldRunContradictionCheck,
    queueVector: (emb as any).__TEST_queueVector as (v: number[]) => void,
  };
}

describe("classifyIntent — embedding-based intent classification", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("classifies fact-lookup queries as fact_lookup", async () => {
    const { classifyIntent, queueVector } = await loadModule();
    queueVector(AXIS.fact_lookup);
    const result = await classifyIntent("anything — vector is staged");
    expect(result.intent).toBe("fact_lookup");
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("classifies procedural queries as procedural", async () => {
    const { classifyIntent, queueVector } = await loadModule();
    queueVector(AXIS.procedural);
    const result = await classifyIntent("show me the dashboard");
    expect(result.intent).toBe("procedural");
  });

  it("classifies comparison queries as comparison", async () => {
    const { classifyIntent, queueVector } = await loadModule();
    queueVector(AXIS.comparison);
    const result = await classifyIntent("compare X to Y");
    expect(result.intent).toBe("comparison");
  });

  it("classifies verification queries as verification", async () => {
    const { classifyIntent, queueVector } = await loadModule();
    queueVector(AXIS.verification);
    const result = await classifyIntent("is this right");
    expect(result.intent).toBe("verification");
  });

  it("classifies temporal queries as temporal_audit", async () => {
    const { classifyIntent, queueVector } = await loadModule();
    queueVector(AXIS.temporal_audit);
    const result = await classifyIntent("did it change");
    expect(result.intent).toBe("temporal_audit");
  });

  it("falls back to 'general' when no prototype is similar enough", async () => {
    const { classifyIntent, queueVector } = await loadModule();
    queueVector(AXIS.unrelated);
    const result = await classifyIntent("random orthogonal vector");
    expect(result.intent).toBe("general");
  });
});

describe("shouldRunContradictionCheck — gate the SDK's pairwise LLM detector", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("skips contradictions only for procedural intent", async () => {
    const { shouldRunContradictionCheck, queueVector } = await loadModule();
    queueVector(AXIS.procedural);
    expect(await shouldRunContradictionCheck("anything")).toBe(false);
  });

  it("runs contradictions for fact_lookup intent — conflicting single values are the core hazard", async () => {
    const { shouldRunContradictionCheck, queueVector } = await loadModule();
    queueVector(AXIS.fact_lookup);
    expect(await shouldRunContradictionCheck("anything")).toBe(true);
  });

  it("runs contradictions for comparison intent", async () => {
    const { shouldRunContradictionCheck, queueVector } = await loadModule();
    queueVector(AXIS.comparison);
    expect(await shouldRunContradictionCheck("anything")).toBe(true);
  });

  it("runs contradictions for verification intent", async () => {
    const { shouldRunContradictionCheck, queueVector } = await loadModule();
    queueVector(AXIS.verification);
    expect(await shouldRunContradictionCheck("anything")).toBe(true);
  });

  it("runs contradictions for temporal_audit intent", async () => {
    const { shouldRunContradictionCheck, queueVector } = await loadModule();
    queueVector(AXIS.temporal_audit);
    expect(await shouldRunContradictionCheck("anything")).toBe(true);
  });

  it("runs contradictions for unclassified 'general' queries — conservative default", async () => {
    const { shouldRunContradictionCheck, queueVector } = await loadModule();
    queueVector(AXIS.unrelated);
    expect(await shouldRunContradictionCheck("anything")).toBe(true);
  });
});
