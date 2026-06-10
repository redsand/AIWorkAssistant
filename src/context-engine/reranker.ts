import { tokenize, jaccardSimilarity } from "./compressor";
import type { ScoredDocument, RerankOptions } from "./types";
import { DEFAULT_RERANK_OPTIONS } from "./types";

export function computeImportance(doc: ScoredDocument): number {
  let score = 0;

  const contentLen = doc.content.length;
  if (contentLen > 200) score += 0.2;
  if (contentLen > 500) score += 0.15;
  if (contentLen > 1500) score += 0.1;

  if (/```[\s\S]*?```/.test(doc.content)) score += 0.15;
  if (/^\s*\d+\.\s/m.test(doc.content)) score += 0.1;

  if (doc.source === "graph") score += 0.1;
  if (doc.source === "knowledge") score += 0.05;

  return Math.min(score, 1.0);
}

export function computeQueryRelevance(doc: ScoredDocument, query: string): number {
  const docTokens = tokenize(doc.title + " " + doc.content);
  const queryTokens = tokenize(query);
  return jaccardSimilarity(docTokens, queryTokens);
}

/**
 * Trust score in [0, 1] based on the doc's source and provenance metadata.
 *
 * Hierarchy (highest trust → lowest):
 *   1.0  graph                — hand-curated entities/relations
 *   0.9  codebase             — canonical source of truth
 *   0.85 knowledge: manual    — user-asserted facts ("the prod DB is in us-east-1")
 *   0.8  knowledge: file_read — verbatim file content
 *   0.75 metadata.toolName    — observed tool result (jira/github/etc.)
 *   0.6  knowledge: web_page  — fetched web content
 *   0.55 knowledge: web_search— search snippet
 *   0.5  knowledge: conversation — chat-derived
 *   0.5  unknown — neutral default
 *
 * This is the closest thing we can compute without plumbing ClaimKit's full
 * trustTier through retrieval. When trustTier is later propagated, prefer it.
 */
export function computeTrustScore(doc: ScoredDocument): number {
  const explicitTier = (doc.metadata?.trustTier as string | undefined) ?? undefined;
  if (explicitTier === "curated") return 1.0;
  if (explicitTier === "observed") return 0.75;
  if (explicitTier === "inferred") return 0.55;

  if (doc.source === "graph") return 1.0;
  if (doc.source === "codebase") return 0.9;
  if (doc.source === "claimkit") return 0.85;

  if (doc.source === "knowledge") {
    const entrySource = doc.metadata?.source as string | undefined;
    if (entrySource === "manual") return 0.85;
    if (entrySource === "file_read") return 0.8;
    if (doc.metadata?.toolName) return 0.75;
    if (entrySource === "web_page") return 0.6;
    if (entrySource === "web_search") return 0.55;
    if (entrySource === "conversation") return 0.5;
  }

  return 0.5;
}

/**
 * Recency score in [0, 1] based on metadata.createdAt. Linear decay over a
 * half-life of ~30 days, floored at 0.2 so older content still appears.
 *
 * Returns 0.5 (neutral) when no createdAt is present so docs without
 * timestamps aren't unfairly penalized.
 */
export function computeRecencyScore(doc: ScoredDocument, now: number = Date.now()): number {
  const raw = doc.metadata?.createdAt;
  let ts: number | null = null;
  if (raw instanceof Date) ts = raw.getTime();
  else if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) ts = parsed;
  } else if (typeof raw === "number") ts = raw;

  if (ts === null) return 0.5;

  const ageMs = Math.max(0, now - ts);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  // 1.0 at <1 day, 0.5 at ~30 days, asymptote to 0.2.
  const decayed = Math.exp(-ageDays / 30);
  return Math.max(0.2, decayed);
}

export function blendScores(
  doc: ScoredDocument,
  query: string,
  options: RerankOptions,
): number {
  const importance = doc.importanceScore || computeImportance(doc);
  const queryRelevance = computeQueryRelevance(doc, query);

  let score =
    doc.baseScore * options.baseScoreWeight +
    importance * options.importanceWeight +
    queryRelevance * options.queryRelevanceWeight;

  // New signals are gated on opt-in weights so tests/callers that build
  // RerankOptions without these fields get the legacy behavior.
  if (options.recencyWeight && options.recencyWeight > 0) {
    const recency = doc.recencyScore || computeRecencyScore(doc);
    score += recency * options.recencyWeight;
  }
  if (options.trustWeight && options.trustWeight > 0) {
    const trust = doc.trustScore || computeTrustScore(doc);
    score += trust * options.trustWeight;
  }
  if (options.claimKitBoostWeight && options.claimKitBoostWeight > 0) {
    const ckBoost = doc.claimKitBoost ?? 0;
    score += ckBoost * options.claimKitBoostWeight;
  }

  return score;
}

export function applyDiversityPenalty(
  docs: ScoredDocument[],
  penalty: number,
): ScoredDocument[] {
  if (docs.length <= 1) return docs;

  const result: ScoredDocument[] = [];
  const selectedContents: Set<string>[] = [];

  for (const doc of docs) {
    const docTokens = tokenize(doc.content);
    let maxSimilarity = 0;

    for (const existing of selectedContents) {
      const sim = jaccardSimilarity(docTokens, existing);
      maxSimilarity = Math.max(maxSimilarity, sim);
    }

    const adjustedScore = doc.score - maxSimilarity * penalty;
    result.push({ ...doc, score: adjustedScore });
    selectedContents.push(docTokens);
  }

  return result.sort((a, b) => b.score - a.score);
}

export function rerank(
  docs: ScoredDocument[],
  query: string,
  options: RerankOptions = DEFAULT_RERANK_OPTIONS,
): ScoredDocument[] {
  const scored = docs.map((doc) => {
    const importanceScore = computeImportance(doc);
    const recencyScore = computeRecencyScore(doc);
    const trustScore = computeTrustScore(doc);
    const enriched: ScoredDocument = {
      ...doc,
      importanceScore,
      recencyScore,
      trustScore,
    };
    return {
      ...enriched,
      score: blendScores(enriched, query, options),
    };
  });

  scored.sort((a, b) => b.score - a.score);

  return applyDiversityPenalty(scored, options.diversityPenalty);
}
