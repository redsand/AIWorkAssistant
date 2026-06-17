#!/usr/bin/env tsx
/**
 * Graph Retrieval Evaluation Harness
 *
 * Measures whether knowledge-graph retrieval actually improves answer quality
 * rather than just firing more often. For each structural test query it records:
 *   - whether the graph surfaced any entities (retrieval frequency)
 *   - Jaccard accuracy of retrieved entities vs. authored ground truth
 *   - whether ClaimKit could verify the relationship (graph as truth layer)
 *   - whether the RAG-only answer would have hallucinated
 *   - graph retrieval latency
 *
 * The ClaimKit and RAG checks degrade gracefully: if the embedding/LLM stack
 * isn't available (no API keys), those metrics are skipped and the report says
 * so, while graph-only metrics still run. This keeps the harness runnable in
 * CI and on a laptop without live providers.
 *
 * Run: npm run eval:graph
 */

import * as fs from "fs";
import * as path from "path";
import { knowledgeGraph } from "../src/agent/knowledge-graph";
import { knowledgeStore } from "../src/agent/knowledge-store";
import { claimKitAdapter } from "../src/context-engine/adapters/claimkit-adapter";

/** Published RAG-only hallucination baseline we are trying to beat. */
export const RAG_BASELINE_HALLUCINATION_RATE = 0.325;
/** Acceptable upper bound for graph retrieval latency. */
export const GRAPH_LATENCY_TARGET_MS = 100;

const DEFAULT_QUERIES_PATH = path.join("data", "eval", "graph-queries.json");
const DEFAULT_REPORT_PATH = path.join("data", "eval", "graph-retrieval-report.md");

export interface GraphEvalQuery {
  query: string;
  groundTruth: string[];
  type: string;
}

export interface GraphEvalResult {
  query: string;
  type: string;
  graphRetrieved: boolean;
  graphAccuracy: number;
  claimkitVerified: boolean;
  /**
   * Whether a RAG-only answer for the query was ungrounded. `null` means the
   * grounding check could not run (ClaimKit unavailable), which is kept
   * distinct from `false` so unmeasured queries never inflate the rate.
   */
  ragHallucinated: boolean | null;
  latencyMs: number;
}

const STOPWORDS = new Set([
  "what", "which", "who", "whom", "whose", "how", "does", "do", "did", "is",
  "are", "was", "were", "the", "a", "an", "of", "to", "on", "in", "for", "and",
  "or", "with", "relate", "relates", "related", "depend", "depends", "between",
  "about", "this", "that", "these", "those", "by", "from", "into", "be", "it",
]);

/**
 * Pull entity-like search terms out of a natural-language structural query.
 * Keeps identifier-ish tokens (digits, hyphens, dots, mixed case) and longer
 * content words, dropping question words and filler. Falls back to the raw
 * query when nothing distinctive survives.
 */
export function extractSearchTerms(query: string): string[] {
  const tokens = query
    .replace(/[?!.,]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const terms: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    const looksLikeId = /[0-9._-]/.test(token) || /[A-Z]/.test(token.slice(1));
    if (looksLikeId) {
      terms.push(token);
      continue;
    }
    if (!STOPWORDS.has(lower) && lower.length > 2) {
      terms.push(token);
    }
  }

  return terms.length > 0 ? [...new Set(terms)] : [query.trim()];
}

/**
 * Jaccard similarity between retrieved entities and ground truth.
 * Both sets are normalized (trim + lowercase) before comparison.
 * Returns 1 when both are empty, 0 when there is no overlap.
 */
export function computeAccuracy(retrieved: string[], groundTruth: string[]): number {
  const norm = (s: string) => s.trim().toLowerCase();
  const retrievedSet = new Set(retrieved.map(norm).filter(Boolean));
  const truthSet = new Set(groundTruth.map(norm).filter(Boolean));

  if (retrievedSet.size === 0 && truthSet.size === 0) return 1;

  let intersection = 0;
  for (const item of truthSet) {
    if (retrievedSet.has(item)) intersection++;
  }
  const union = new Set([...retrievedSet, ...truthSet]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Retrieve graph entities for a query: matched nodes plus their 1-hop
 * neighbors. Returns node titles and ids so authored ground truth can match
 * on either. Latency is measured around the graph work only.
 */
export function retrieveGraphEntities(query: string): {
  entities: string[];
  latencyMs: number;
} {
  const start = Date.now();
  const entities = new Set<string>();

  try {
    const terms = extractSearchTerms(query);
    const matchedIds = new Set<string>();

    for (const term of terms) {
      const nodes = knowledgeGraph.queryNodes({ search: term, limit: 5 });
      for (const node of nodes) {
        matchedIds.add(node.id);
        entities.add(node.id);
        entities.add(node.title);
      }
    }

    for (const id of matchedIds) {
      const { nodes } = knowledgeGraph.getNeighbors(id, 1);
      for (const node of nodes) {
        entities.add(node.id);
        entities.add(node.title);
      }
    }
  } catch (err) {
    console.warn(
      "[GraphEval] graph retrieval failed:",
      err instanceof Error ? err.message : err,
    );
  }

  return { entities: [...entities], latencyMs: Date.now() - start };
}

/**
 * Whether ClaimKit can verify the query against the graph. Returns false
 * (and logs once) when the ClaimKit stack is unavailable so the harness still
 * runs without live providers.
 */
export async function checkClaimKitVerified(query: string): Promise<boolean> {
  try {
    const available =
      claimKitAdapter.isAvailable() || (await claimKitAdapter.initialize());
    if (!available) return false;

    const result = await claimKitAdapter.query(query);
    const answerable =
      result.answerability === "answerable" ||
      result.answerability === "partially-answerable";
    return answerable && result.citations.length > 0;
  } catch (err) {
    console.warn(
      "[GraphEval] ClaimKit verification failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Whether a RAG-only answer for the query would be ungrounded.
 *
 * This simulates a plain RAG pipeline: retrieve documents, generate an answer
 * from them, then check whether that *generated* answer is grounded in the
 * retrieved documents. The generated answer (from ClaimKit's LLM) is distinct
 * from the evidence (the retrieved documents), so grounding is a real signal —
 * grounding the documents against themselves would always read as "grounded".
 *
 * Returns:
 *   - `true`  when there are no documents to ground against, or the generated
 *             answer is not supported by the retrieved documents
 *   - `false` when the generated answer is supported
 *   - `null`  when the check could not run (ClaimKit unavailable or produced no
 *             answer), so callers can distinguish "not measured" from "grounded"
 */
export async function checkRagHallucinated(query: string): Promise<boolean | null> {
  try {
    const hits = knowledgeStore.search(query, { limit: 5 });
    if (hits.length === 0) return true;

    const available =
      claimKitAdapter.isAvailable() || (await claimKitAdapter.initialize());
    if (!available) return null;

    // Generate an answer first, then ground it against the retrieved docs.
    const generated = await claimKitAdapter.query(query);
    const answer = generated.answer?.trim();
    if (!answer) return null;

    const evidence = hits.map((h) => ({
      title: h.entry.title,
      content: h.entry.content,
    }));
    const grounding = await claimKitAdapter.ground({ text: answer, evidence });
    return !grounding.grounded;
  } catch (err) {
    console.warn(
      "[GraphEval] RAG grounding check failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function avg(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Render the markdown evaluation report. Always includes Summary, Retrieval
 * Comparison, Hallucination Rate, Per-Query Results, and Recommendations
 * sections regardless of how many queries ran.
 */
export function generateReport(results: GraphEvalResult[]): string {
  const total = results.length;
  const retrievedCount = results.filter((r) => r.graphRetrieved).length;
  const retrievalFrequency = total === 0 ? 0 : retrievedCount / total;
  const avgAccuracy = avg(results.map((r) => r.graphAccuracy));
  const avgLatency = avg(results.map((r) => r.latencyMs));

  // graph-only: accuracy on queries where the graph retrieved anything.
  const retrievedResults = results.filter((r) => r.graphRetrieved);
  const graphOnlyAccuracy = avg(retrievedResults.map((r) => r.graphAccuracy));

  // graph+ClaimKit: queries where graph retrieved AND ClaimKit verified.
  const graphClaimKit = results.filter(
    (r) => r.graphRetrieved && r.claimkitVerified,
  );
  const graphClaimKitAccuracy = avg(graphClaimKit.map((r) => r.graphAccuracy));

  // graph+RAG: queries where graph retrieved and RAG was measured as grounded.
  // `null` (not measured) is excluded rather than treated as grounded.
  const graphRag = results.filter(
    (r) => r.graphRetrieved && r.ragHallucinated === false,
  );
  const graphRagAccuracy = avg(graphRag.map((r) => r.graphAccuracy));

  // Hallucination rate is computed only over queries where grounding actually
  // ran. Unmeasured (null) queries are excluded so an unavailable ClaimKit
  // can never masquerade as a 0% rate / false improvement over the baseline.
  const measuredResults = results.filter((r) => r.ragHallucinated !== null);
  const measuredCount = measuredResults.length;
  const ragHallucinatedCount = measuredResults.filter(
    (r) => r.ragHallucinated === true,
  ).length;
  const newHallucinationRate =
    measuredCount === 0 ? null : ragHallucinatedCount / measuredCount;
  const hallucinationDelta =
    newHallucinationRate === null
      ? null
      : RAG_BASELINE_HALLUCINATION_RATE - newHallucinationRate;

  const lines: string[] = [];
  lines.push("# Graph Retrieval Evaluation Report");
  lines.push("");
  lines.push(`_Generated: ${new Date().toISOString()}_`);
  lines.push(`_Queries evaluated: ${total}_`);
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push(`- Graph retrieval frequency: ${pct(retrievalFrequency)} (${retrievedCount}/${total})`);
  lines.push(`- Average accuracy (all queries): ${pct(avgAccuracy)}`);
  lines.push(`- Average graph latency: ${avgLatency.toFixed(1)}ms (target < ${GRAPH_LATENCY_TARGET_MS}ms)`);
  lines.push(`- Latency within target: ${avgLatency <= GRAPH_LATENCY_TARGET_MS ? "yes" : "no"}`);
  lines.push("");

  lines.push("## Retrieval Comparison");
  lines.push("");
  lines.push("| Strategy | Queries | Avg Accuracy |");
  lines.push("| --- | --- | --- |");
  lines.push(`| Graph-only | ${retrievedResults.length} | ${pct(graphOnlyAccuracy)} |`);
  lines.push(`| Graph + ClaimKit | ${graphClaimKit.length} | ${pct(graphClaimKitAccuracy)} |`);
  lines.push(`| Graph + RAG | ${graphRag.length} | ${pct(graphRagAccuracy)} |`);
  lines.push("");

  lines.push("## Hallucination Rate");
  lines.push("");
  lines.push(`- RAG baseline (published): ${pct(RAG_BASELINE_HALLUCINATION_RATE)}`);
  if (newHallucinationRate === null || hallucinationDelta === null) {
    lines.push(
      `- Measured RAG hallucination: not measured (ClaimKit grounding unavailable for all ${total} ${total === 1 ? "query" : "queries"})`,
    );
    lines.push("- Delta vs baseline: n/a — cannot compare without measured grounding");
  } else {
    lines.push(
      `- Measured RAG hallucination: ${pct(newHallucinationRate)} (${measuredCount}/${total} ${total === 1 ? "query" : "queries"} measured)`,
    );
    lines.push(
      `- Delta vs baseline: ${hallucinationDelta >= 0 ? "-" : "+"}${pct(Math.abs(hallucinationDelta))} ` +
        `(${hallucinationDelta >= 0 ? "improvement" : "regression"})`,
    );
  }
  lines.push("");

  lines.push("## Per-Query Results");
  lines.push("");
  lines.push("| Query | Type | Retrieved | Accuracy | CK Verified | RAG Hallucinated | Latency |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    const hallucinatedCell =
      r.ragHallucinated === null ? "n/a" : r.ragHallucinated ? "yes" : "no";
    lines.push(
      `| ${r.query.replace(/\|/g, "\\|")} | ${r.type} | ${r.graphRetrieved ? "yes" : "no"} | ` +
        `${pct(r.graphAccuracy)} | ${r.claimkitVerified ? "yes" : "no"} | ` +
        `${hallucinatedCell} | ${r.latencyMs}ms |`,
    );
  }
  lines.push("");

  lines.push("## Recommendations");
  lines.push("");
  const recommendations: string[] = [];
  if (total === 0) {
    recommendations.push("No queries were evaluated — add test queries to `data/eval/graph-queries.json`.");
  } else {
    if (retrievalFrequency < 0.5) {
      recommendations.push(
        "Graph retrieval fired on fewer than half of queries — review seeding/coverage of the knowledge graph.",
      );
    }
    if (avgAccuracy < 0.5) {
      recommendations.push(
        "Average accuracy is below 0.5 — graph retrieval is not reliably surfacing ground-truth entities yet.",
      );
    } else {
      recommendations.push(
        "Average accuracy is at or above 0.5 — graph retrieval is surfacing relevant entities.",
      );
    }
    if (avgLatency > GRAPH_LATENCY_TARGET_MS) {
      recommendations.push(
        `Average latency (${avgLatency.toFixed(1)}ms) exceeds the ${GRAPH_LATENCY_TARGET_MS}ms target — consider caching or index tuning.`,
      );
    }
    if (hallucinationDelta === null) {
      recommendations.push(
        "Hallucination was not measured (ClaimKit grounding unavailable) — run with live providers before claiming any improvement over the RAG baseline.",
      );
    } else if (hallucinationDelta > 0) {
      recommendations.push(
        `Measured RAG hallucination is ${pct(hallucinationDelta)} below the published baseline — the ClaimKit grounding layer is helping.`,
      );
    } else {
      recommendations.push(
        "Measured RAG hallucination did not beat the published baseline — investigate grounding before relying on it.",
      );
    }
  }
  for (const rec of recommendations) {
    lines.push(`- ${rec}`);
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Read and validate the queries file. Throws an actionable error (rather than
 * a raw fs/JSON error or a silent type-cast) when the file is missing,
 * malformed, or has entries that don't match the {@link GraphEvalQuery} shape.
 */
export function loadQueries(queriesPath: string): GraphEvalQuery[] {
  let raw: string;
  try {
    raw = fs.readFileSync(queriesPath, "utf-8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read queries file at "${queriesPath}": ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Queries file at "${queriesPath}" is not valid JSON: ${reason}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `Queries file at "${queriesPath}" must contain a JSON array of queries.`,
    );
  }

  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Query at index ${index} must be an object.`);
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.query !== "string" || candidate.query.trim() === "") {
      throw new Error(
        `Query at index ${index} is missing a non-empty "query" string.`,
      );
    }
    if (
      !Array.isArray(candidate.groundTruth) ||
      !candidate.groundTruth.every((item) => typeof item === "string")
    ) {
      throw new Error(
        `Query at index ${index} ("${candidate.query}") must have a "groundTruth" array of strings.`,
      );
    }
    if (typeof candidate.type !== "string" || candidate.type.trim() === "") {
      throw new Error(
        `Query at index ${index} ("${candidate.query}") is missing a non-empty "type" string.`,
      );
    }
    return {
      query: candidate.query,
      groundTruth: candidate.groundTruth as string[],
      type: candidate.type,
    };
  });
}

export async function evaluateGraphRetrieval(
  queriesPath: string = DEFAULT_QUERIES_PATH,
  reportPath: string = DEFAULT_REPORT_PATH,
): Promise<GraphEvalResult[]> {
  const queries = loadQueries(queriesPath);

  const results: GraphEvalResult[] = [];
  for (const q of queries) {
    const { entities, latencyMs } = retrieveGraphEntities(q.query);
    const graphRetrieved = entities.length > 0;
    const graphAccuracy = computeAccuracy(entities, q.groundTruth);

    const claimkitVerified = await checkClaimKitVerified(q.query);
    // Preserve null ("not measured") so the report never treats an unavailable
    // ClaimKit as a grounded answer.
    const ragHallucinated = await checkRagHallucinated(q.query);

    results.push({
      query: q.query,
      type: q.type,
      graphRetrieved,
      graphAccuracy,
      claimkitVerified,
      ragHallucinated,
      latencyMs,
    });
  }

  const report = generateReport(results);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, report);
  console.log(`[GraphEval] Wrote report to ${reportPath} (${results.length} queries)`);

  return results;
}

if (require.main === module) {
  evaluateGraphRetrieval()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[GraphEval] Fatal error:", err);
      process.exit(1);
    });
}
