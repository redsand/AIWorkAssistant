// Query rewriting before embedding (issue #230).
//
// Natural-language queries carry conversational filler ("can you tell me how"),
// abbreviations ("CK", "IR"), and structured entity references ("IR-42",
// "src/auth/login.ts") that degrade embedding similarity. This module rewrites
// the raw query into a denser, retrieval-friendly form BEFORE it is embedded —
// purely synchronous regex/heuristics, no LLM calls, so it adds negligible
// latency to the retrieval path. If anything throws, callers fall back to the
// original query via rewriteQuerySafe().
import { env } from "../config/env";
import type { ScoredDocument } from "./types";

export interface EntityRef {
  type: "ticket" | "file" | "function" | "class" | "api";
  value: string;
  confidence: number;
}

export interface RewrittenQuery {
  /** The query exactly as the user typed it. */
  original: string;
  /** Cleaned + abbreviation-expanded form used for the primary retrieval. */
  rewritten: string;
  /** Alternative formulations for ambiguous queries (may be empty). */
  variants: string[];
  /** Structured references extracted from the query (tickets, files, etc.). */
  entityRefs: EntityRef[];
  /** Map of abbreviation -> expansion that was applied. */
  abbreviationExpansions: Map<string, string>;
  /** Wall-clock cost of the rewrite, for the < 100ms budget assertion. */
  rewriteLatencyMs: number;
}

export interface QueryContext {
  /** Optional free-text project context (unused by heuristics today). */
  projectContext?: string;
  /** Project-specific abbreviations layered on top of the built-in map. */
  customAbbreviations?: Map<string, string>;
}

// Built-in abbreviation expansions. Keys are matched case-sensitively (users
// write these uppercase) and guarded against ticket IDs (see expandAbbreviations).
const ABBREVIATION_MAP = new Map<string, string>([
  ["CK", "ClaimKit"],
  ["IR", "incident response"],
  ["MR", "merge request"],
  ["PR", "pull request"],
  ["MFA", "multi-factor authentication"],
  ["SSO", "single sign-on"],
  ["RAG", "retrieval augmented generation"],
  ["KG", "knowledge graph"],
]);

// Leading conversational filler. Ordered most-specific-first; each is anchored
// to the start so we never strip these words from the middle of a query (where
// they may be meaningful).
const FILLER_PATTERNS: RegExp[] = [
  /^can you (?:please )?(?:tell me|help me|explain to me|explain|show me)\s*(?:how|what|about|if|where|why)?\s*/i,
  /^(?:i'?m wondering|i would like to know|i'?d like to know|i want to know)\s*(?:if|about|how|what|whether)?\s*/i,
  /^please (?:help me|tell me|explain|show me)\s*(?:with|how|what|about)?\s*/i,
  /^(?:could you|would you|can you)\s*(?:please\s*)?/i,
  /^(?:what is|what are|what's|how does|how do|how can i|how would i|can you explain)\s+/i,
];

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "how", "what", "why", "when", "where", "which", "who",
  "can", "could", "would", "should", "i", "you", "we", "it", "this", "that",
  "to", "of", "in", "on", "for", "with", "and", "or", "about", "me", "my",
  "please", "tell", "explain", "help", "wondering", "like", "know", "want",
]);

// Synonym expansions applied during variant generation to widen recall.
const SYNONYM_MAP = new Map<string, string>([
  ["auth", "authentication login"],
  ["authentication", "login auth credentials"],
  ["authorization", "permissions access control"],
  ["error", "exception failure"],
  ["login", "sign-in authentication"],
  ["db", "database"],
  ["config", "configuration settings"],
]);

/** Strip leading conversational filler. Returns a trimmed copy of the query. */
export function removeFiller(query: string): string {
  let cleaned = query;
  for (const pattern of FILLER_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }
  cleaned = cleaned.trim();
  // Never return an empty string — if filler removal nuked everything (e.g. the
  // query WAS just filler), keep the original so retrieval still has signal.
  return cleaned.length > 0 ? cleaned : query.trim();
}

/**
 * Extract structured references. Technical tokens (function/class names, file
 * paths, ticket IDs, API routes) are preserved verbatim in `value` so callers
 * can boost docs that mention them.
 */
export function extractEntities(query: string): EntityRef[] {
  const entities: EntityRef[] = [];
  const seen = new Set<string>();
  const push = (type: EntityRef["type"], value: string, confidence: number) => {
    const key = `${type}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    entities.push({ type, value, confidence });
  };

  // Ticket IDs: IR-42, SIEM-123, PROJ-456 (uppercase prefix + number).
  for (const m of query.matchAll(/\b([A-Z]{2,}-\d+)\b/g)) {
    push("ticket", m[1], 1.0);
  }

  // File paths: src/auth/login.ts, lib/foo/bar.js, tests/x.test.ts.
  for (const m of query.matchAll(/(?:src|lib|tests|test|dist|scripts|web)\/[\w./-]+/g)) {
    push("file", m[0], 0.9);
  }

  // API routes: /api/v1/users, GET /users/:id.
  for (const m of query.matchAll(/(?:GET|POST|PUT|DELETE|PATCH)\s+(\/\S+)/gi)) {
    push("api", m[1], 0.9);
  }
  for (const m of query.matchAll(/\/api\/[\w/:{}.-]+/g)) {
    push("api", m[0], 0.85);
  }

  // Code identifiers — only those that LOOK like code (internal capital,
  // underscore, or trailing parens) so plain English words aren't captured.
  // Strip a trailing () before classifying.
  for (const m of query.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{2,})(\(\))?/g)) {
    const raw = m[1];
    const hasCall = Boolean(m[2]);
    // Skip if this token is part of an already-extracted ticket/file.
    if (/^[A-Z]{2,}$/.test(raw) && ABBREVIATION_MAP.has(raw)) continue;
    const hasInternalUpper = /[a-z][A-Z]/.test(raw) || /[A-Z][a-z].*[A-Z]/.test(raw);
    const hasUnderscore = raw.includes("_");
    const isPascal = /^[A-Z][a-z]/.test(raw) && /[a-z][A-Z]/.test(raw);
    const isCamel = /^[a-z]/.test(raw) && /[a-z][A-Z]/.test(raw);

    if (hasCall) {
      push("function", raw, 0.95);
    } else if (isPascal) {
      push("class", raw, 0.75);
    } else if (isCamel) {
      push("function", raw, 0.7);
    } else if (hasUnderscore && !hasInternalUpper) {
      push("function", raw, 0.65);
    }
  }

  return entities;
}

/**
 * Expand known abbreviations. Ticket references like "IR-42" are protected by a
 * negative lookahead so "IR" isn't expanded inside an entity ID.
 */
export function expandAbbreviations(
  query: string,
  context: QueryContext = {},
): { expanded: string; expansions: Map<string, string> } {
  const expansions = new Map<string, string>();
  let expanded = query;

  const map = new Map(ABBREVIATION_MAP);
  if (context.customAbbreviations) {
    for (const [k, v] of context.customAbbreviations) map.set(k, v);
  }

  for (const [abbr, full] of map) {
    // \bABBR\b but NOT when immediately followed by "-<digits>" (a ticket ID).
    const pattern = new RegExp(`\\b${escapeRegExp(abbr)}\\b(?!-?\\d)`, "g");
    if (pattern.test(expanded)) {
      expanded = expanded.replace(pattern, full);
      expansions.set(abbr, full);
    }
  }

  return { expanded, expansions };
}

/** Heuristic: would this query benefit from alternative formulations? */
export function isAmbiguous(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  // Short queries are under-specified.
  if (words.length > 0 && words.length <= 4) return true;
  // Question-word openers ("how does auth work", "what is X").
  if (/^(how|what|why|when|where|which|who|can|does|is|are)\b/i.test(trimmed)) return true;
  // Vague verbs that don't pin down a concrete artifact.
  if (/\b(work|works|working|handle|handles|do|use|uses|deal)\b/i.test(trimmed)) return true;
  return false;
}

function extractKeywords(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/** Generate up to `count` alternative formulations. Pure heuristics. */
export function generateVariants(query: string, count: number): string[] {
  if (count <= 0) return [];
  const variants: string[] = [];
  const add = (v: string) => {
    const trimmed = v.trim().replace(/\s+/g, " ");
    if (trimmed && trimmed.toLowerCase() !== query.trim().toLowerCase() && !variants.includes(trimmed)) {
      variants.push(trimmed);
    }
  };

  // Variant 1: dense keyword form (stopwords removed).
  const keywords = extractKeywords(query);
  if (keywords.length > 0) add(keywords.join(" "));

  // Variant 2: rephrase a "how ..." question as a noun phrase.
  if (/^how\b/i.test(query.trim())) {
    add(query.trim().replace(/^how\s+(does|do|can|to|would|will)?\s*/i, "the way "));
  }

  // Variant 3: synonym substitution to widen recall.
  let synonymVariant = ` ${keywords.length > 0 ? keywords.join(" ") : query.toLowerCase()} `;
  let substituted = false;
  for (const [term, syn] of SYNONYM_MAP) {
    const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, "g");
    if (pattern.test(synonymVariant)) {
      synonymVariant = synonymVariant.replace(pattern, syn);
      substituted = true;
    }
  }
  if (substituted) add(synonymVariant);

  return variants.slice(0, count);
}

/**
 * Rewrite a raw user query for retrieval. Never throws on its own, but callers
 * that want a guaranteed result should use rewriteQuerySafe().
 */
export function rewriteQuery(query: string, context: QueryContext = {}): RewrittenQuery {
  const start = Date.now();

  const cleaned = removeFiller(query);
  const entityRefs = extractEntities(cleaned);
  const { expanded, expansions } = expandAbbreviations(cleaned, context);
  const variants = isAmbiguous(query)
    ? generateVariants(expanded, env.QUERY_REWRITE_VARIANT_COUNT)
    : [];

  return {
    original: query,
    rewritten: expanded,
    variants,
    entityRefs,
    abbreviationExpansions: expansions,
    rewriteLatencyMs: Date.now() - start,
  };
}

/** Identity rewrite — used when the rewriter is disabled or fails. */
export function identityRewrite(query: string): RewrittenQuery {
  return {
    original: query,
    rewritten: query,
    variants: [],
    entityRefs: [],
    abbreviationExpansions: new Map(),
    rewriteLatencyMs: 0,
  };
}

/**
 * Rewrite with a guaranteed result: returns the identity rewrite if the
 * rewriter is disabled or throws, so the retrieval path always has a query.
 */
export function rewriteQuerySafe(query: string, context: QueryContext = {}): RewrittenQuery {
  if (!env.QUERY_REWRITER_ENABLED) return identityRewrite(query);
  try {
    return rewriteQuery(query, context);
  } catch (err) {
    console.log("[QueryRewriter] rewrite failed, falling back to original query:", err instanceof Error ? err.message : err);
    return identityRewrite(query);
  }
}

/**
 * Merge several retrieval result sets, deduplicating by document id and keeping
 * the highest-scoring instance of each. Order is by descending score.
 */
export function mergeAndDedupe(resultSets: ScoredDocument[][]): ScoredDocument[] {
  const byId = new Map<string, ScoredDocument>();
  for (const set of resultSets) {
    for (const doc of set) {
      const existing = byId.get(doc.id);
      if (!existing || doc.score > existing.score) {
        byId.set(doc.id, existing && existing.score > doc.score ? existing : doc);
      }
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.score - a.score);
}

/**
 * Boost documents that mention an extracted entity reference. Each matching doc
 * gets a score bump proportional to the entity's confidence; the strongest
 * match per doc wins. Returns a new, re-sorted array (input is not mutated).
 */
export function boostEntityMatches(
  docs: ScoredDocument[],
  entityRefs: EntityRef[],
  boostWeight = 0.5,
): ScoredDocument[] {
  if (entityRefs.length === 0 || docs.length === 0) return docs;

  let boostedCount = 0;
  const boosted = docs.map((doc) => {
    const haystack = (
      doc.title +
      " " +
      doc.content +
      " " +
      String(doc.metadata?.filePath ?? "")
    ).toLowerCase();

    let bestBoost = 0;
    for (const ref of entityRefs) {
      if (haystack.includes(ref.value.toLowerCase())) {
        bestBoost = Math.max(bestBoost, ref.confidence * boostWeight);
      }
    }
    if (bestBoost <= 0) return doc;
    boostedCount++;
    return { ...doc, score: doc.score + bestBoost };
  });

  if (boostedCount > 0) {
    boosted.sort((a, b) => b.score - a.score);
    console.log(`[QueryRewriter] entity boost applied to ${boostedCount}/${docs.length} doc(s)`);
  }
  return boosted;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
