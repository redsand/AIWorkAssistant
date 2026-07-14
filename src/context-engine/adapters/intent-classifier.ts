/**
 * Lightweight intent classifier for ClaimKit gating decisions.
 *
 * Embeds the user's question and cosine-matches against canonical
 * intent prototypes — same shape as a tiny nearest-neighbor classifier
 * but with no model training, no NLP-library dep, and free reuse of
 * the project's existing EmbeddingService (and its LRU). The first
 * call after process start does a one-time pass to embed each
 * prototype text; every subsequent call is one embed + N cosines
 * (~microsecond-fast).
 *
 * Why not regex: hand-rolled patterns fragment on phrasing variants
 * ("who is the owner?" vs "who owns it" vs "tell me the owner") and
 * each gap is a separate maintenance burden. Embedding similarity
 * generalizes across phrasings automatically.
 *
 * Why not a tagger / NLP lib: would add ~250kb-3MB of dep weight to
 * the install, plus its own quirks. The project already runs an
 * embedding model for ClaimKit retrieval — reusing it for intent
 * classification is the smaller commitment with the same robustness.
 *
 * Why not the LLM: defeats the point. The whole reason we're gating
 * the contradiction stage is to AVOID an LLM round-trip — calling
 * one to decide whether to call one is circular.
 */

import {
  cosineSimilarity,
  embeddingService,
  type EmbeddingResult,
} from "../../agent/embedding-service";

/**
 * Coarse intent categories used by the contradiction-gate. Bias is
 * deliberately conservative: only `procedural` clearly skips the
 * contradiction stage. Everything else (including `general` and any
 * low-confidence classification) runs it. In particular `fact_lookup`
 * RUNS contradiction detection: a single-valued fact ("who is the
 * owner") is exactly where two sources asserting different values is
 * the core hazard — the canonical contradiction eval case is a fact
 * lookup. The cost of a false negative (skip contradiction when we
 * shouldn't have) is a silently wrong answer presented as verified;
 * the cost of a false positive (run when we didn't need to) is one
 * batched LLM call (~200ms). We lean toward the cheaper failure mode.
 */
export type QueryIntent =
  | "fact_lookup"      // "what is X", "who owns Y" — single value; conflicting values ARE contradictions
  | "procedural"       // "show me Y", "display Z", "open the page" — UI/navigation, no factual assertion to conflict
  | "comparison"       // "compare X and Y", "diff between A and B" — needs contradiction
  | "verification"     // "verify X", "is this right" — needs contradiction
  | "temporal_audit"   // "did X change", "history of Y" — needs contradiction
  | "general";         // catch-all, falls back to default behavior

interface Prototype {
  intent: QueryIntent;
  text: string;
}

/**
 * Canonical example phrasings for each intent. The classifier embeds
 * each text once on first use and stores the resulting vectors in
 * `prototypeVectors`. Vectors are kept in module-local state because
 * the embedding model is process-stable for the EmbeddingService
 * lifetime (dimension is locked on first embed — see embedding-
 * service.ts).
 *
 * Variants per intent matter: each cosine match averages across the
 * prototypes for that intent, so adding a few rephrasings hardens
 * the classifier against any one bad prototype skewing the result.
 */
const PROTOTYPES: Prototype[] = [
  // fact_lookup — single-valued factual requests where conflicting
  // source values are the primary contradiction hazard
  { intent: "fact_lookup", text: "what is the status of the case" },
  { intent: "fact_lookup", text: "who is the owner of this issue" },
  { intent: "fact_lookup", text: "describe the auth flow" },
  { intent: "fact_lookup", text: "get the session count" },
  { intent: "fact_lookup", text: "tell me how many cases are open" },

  // procedural — UI/navigation/enumeration requests with no single
  // factual assertion for sources to disagree on
  { intent: "procedural", text: "show me the failed runs" },
  { intent: "procedural", text: "list the active runners" },
  { intent: "procedural", text: "display the dashboard" },
  { intent: "procedural", text: "open the settings page" },
  { intent: "procedural", text: "pull up the latest report" },

  // comparison — explicit or implicit contrast
  { intent: "comparison", text: "compare last week and this week" },
  { intent: "comparison", text: "what is the difference between A and B" },
  { intent: "comparison", text: "how does X compare to Y" },
  { intent: "comparison", text: "kimi vs glm performance" },
  { intent: "comparison", text: "which model performs better" },

  // verification — asking to confirm correctness
  { intent: "verification", text: "verify the report numbers" },
  { intent: "verification", text: "is that correct" },
  { intent: "verification", text: "confirm that the ticket is closed" },
  { intent: "verification", text: "validate the claim about the model" },
  { intent: "verification", text: "is this accurate" },

  // temporal_audit — change history, time-based comparisons
  { intent: "temporal_audit", text: "did the status change since yesterday" },
  { intent: "temporal_audit", text: "history of the case" },
  { intent: "temporal_audit", text: "audit the close dispositions" },
  { intent: "temporal_audit", text: "what changed in the last week" },
  { intent: "temporal_audit", text: "when was this updated" },
];

interface ClassifierState {
  ready: boolean;
  prototypeVectors: Array<Prototype & { vector: number[] }>;
  initPromise: Promise<void> | null;
}

const state: ClassifierState = {
  ready: false,
  prototypeVectors: [],
  initPromise: null,
};

/**
 * Embed every prototype once. Subsequent calls reuse the vectors.
 * Concurrent first-callers share the same initPromise so we don't
 * fire N parallel embed batches on cold start.
 */
async function ensureInitialized(): Promise<void> {
  if (state.ready) return;
  if (state.initPromise) return state.initPromise;

  state.initPromise = (async () => {
    if (!(await embeddingService.isAvailable())) {
      // No embedding model available — leave state.ready=false so the
      // classifier short-circuits to a safe default on every call.
      // Don't throw; we want the gate to fail-open (run contradictions)
      // rather than block the chat path on classifier readiness.
      return;
    }
    const texts = PROTOTYPES.map((p) => p.text);
    const vectors = await embeddingService.embedBatch(texts);
    const built: Array<Prototype & { vector: number[] }> = [];
    for (let i = 0; i < PROTOTYPES.length; i++) {
      const v = vectors[i];
      if (v) built.push({ ...PROTOTYPES[i], vector: v.embedding });
    }
    state.prototypeVectors = built;
    state.ready = built.length > 0;
  })();

  await state.initPromise;
}

export interface ClassificationResult {
  intent: QueryIntent;
  confidence: number; // average cosine similarity of the winning intent's prototypes
  /** Per-intent average similarity for diagnostic / logging use. */
  scores: Record<QueryIntent, number>;
}

/**
 * Classify a natural-language question into one of the {@link QueryIntent}
 * categories. Returns `{ intent: "general", confidence: 0 }` when
 * embeddings aren't available — the caller should treat that as
 * "unknown" and pick a safe default.
 */
export async function classifyIntent(
  question: string,
): Promise<ClassificationResult> {
  const trimmed = question.trim();
  if (!trimmed) {
    return emptyResult();
  }

  await ensureInitialized();
  if (!state.ready) return emptyResult();

  let queryVector: EmbeddingResult | null = null;
  try {
    queryVector = await embeddingService.embed(trimmed);
  } catch {
    return emptyResult();
  }
  if (!queryVector) return emptyResult();

  // Average cosine per intent. Averaging across multiple prototypes
  // smooths over any single prototype that happens to be a poor match
  // for the user's exact phrasing.
  const sumByIntent: Record<QueryIntent, number> = {
    fact_lookup: 0,
    procedural: 0,
    comparison: 0,
    verification: 0,
    temporal_audit: 0,
    general: 0,
  };
  const countByIntent: Record<QueryIntent, number> = {
    fact_lookup: 0,
    procedural: 0,
    comparison: 0,
    verification: 0,
    temporal_audit: 0,
    general: 0,
  };

  for (const proto of state.prototypeVectors) {
    const sim = cosineSimilarity(queryVector.embedding, proto.vector);
    sumByIntent[proto.intent] += sim;
    countByIntent[proto.intent] += 1;
  }

  const scores: Record<QueryIntent, number> = {
    fact_lookup: 0,
    procedural: 0,
    comparison: 0,
    verification: 0,
    temporal_audit: 0,
    general: 0,
  };
  let bestIntent: QueryIntent = "general";
  let bestScore = -Infinity;
  for (const intent of Object.keys(sumByIntent) as QueryIntent[]) {
    if (countByIntent[intent] === 0) continue;
    const avg = sumByIntent[intent] / countByIntent[intent];
    scores[intent] = avg;
    if (avg > bestScore) {
      bestScore = avg;
      bestIntent = intent;
    }
  }

  // Confidence floor: if the best score is below this, treat as
  // "general" — the question doesn't look like any prototype cluster.
  // 0.45 is a soft threshold; nomic-embed-text gives ~0.6-0.8 on
  // strong matches, ~0.3-0.4 on unrelated text. Tunable via env if
  // false positives become an issue in production.
  const minConfidence = parseFloat(
    process.env.CLAIMKIT_INTENT_MIN_CONFIDENCE || "0.45",
  );
  if (!Number.isFinite(minConfidence) || bestScore < minConfidence) {
    return { intent: "general", confidence: bestScore, scores };
  }

  return { intent: bestIntent, confidence: bestScore, scores };
}

function emptyResult(): ClassificationResult {
  return {
    intent: "general",
    confidence: 0,
    scores: {
      fact_lookup: 0,
      procedural: 0,
      comparison: 0,
      verification: 0,
      temporal_audit: 0,
      general: 0,
    },
  };
}

/** Exposed for tests — resets the classifier so the next call re-embeds prototypes. */
export function __resetIntentClassifierForTests(): void {
  state.ready = false;
  state.prototypeVectors = [];
  state.initPromise = null;
}
