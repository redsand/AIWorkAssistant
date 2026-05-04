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

export function blendScores(
  doc: ScoredDocument,
  query: string,
  options: RerankOptions,
): number {
  const importance = computeImportance(doc);
  const queryRelevance = computeQueryRelevance(doc, query);

  return (
    doc.baseScore * options.baseScoreWeight +
    importance * options.importanceWeight +
    queryRelevance * options.queryRelevanceWeight
  );
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
  const scored = docs.map((doc) => ({
    ...doc,
    score: blendScores(doc, query, options),
    importanceScore: computeImportance(doc),
  }));

  scored.sort((a, b) => b.score - a.score);

  return applyDiversityPenalty(scored, options.diversityPenalty);
}