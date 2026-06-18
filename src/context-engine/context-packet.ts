import { knowledgeStore } from "../agent/knowledge-store";
import { codebaseIndexer } from "../agent/codebase-indexer";
import { knowledgeGraph } from "../agent/knowledge-graph";
import { aiClient } from "../agent/opencode-client";
import { githubClient } from "../integrations/github/github-client";
import { gitlabClient } from "../integrations/gitlab/gitlab-client";
import { jiraClient } from "../integrations/jira/jira-client";
import { env } from "../config/env";
import { getSystemPrompt } from "../agent/prompts";
import { providerSettings } from "../agent/provider-settings";
import type { ChatMessage } from "../agent/providers/types";
import type {
  AssembleContextParams,
  ContextPacket,
  ContextSection,
  ClaimKitContextSection,
  ScoredDocument,
  PreferredSource,
  RoutingTier,
  RoutingStrategy,
  GroundingHandle,
} from "./types";
import { claimKitAdapter } from "./adapters/claimkit-adapter";
import { ingestScoredDocumentsForQuery } from "./claimkit-ingestion";
import { saveLiveComparison } from "../comparison-runs/auto-capture";
import type { CkStatus } from "../comparison-runs/types";
import { createBudget, estimateTokens, enforceBudget } from "./budget";
import { compressDocuments } from "./compressor";
import { rerank } from "./reranker";
import { scoreMessages, deduplicateByJaccard, selectMessages } from "./memory-decay";
import type { ClaimKitQueryResult } from "./adapters/claimkit-adapter";
import { agentMemory } from "../memory/agent-memory";
import { soulManager } from "../memory/soul-manager";
import { skillManager } from "../skills/skill-manager";
import { reflectionEngine } from "../agent/reflection-engine";
import { conversationManager } from "../memory/conversation-manager";
import { buildEntityClaimsSection, extractEntityIds } from "./entity-claims-injector";
import { entityMemory } from "../memory/entity-memory";
import { entityMarkdown } from "../memory/entity-markdown";
import type { MemoryEntity } from "../memory/entity-types";

export interface RoutingDecision {
  tier: RoutingTier;
  preferredSource: PreferredSource;
  overallWinner: "rag" | "claimkit" | "tie";
  routingReason: string;
}

// Most-recently-observed RAG retrieval latency (ms). Used to estimate the
// time saved when a high-confidence ClaimKit probe lets us skip RAG (issue
// #229). Seeded to 0 so the first-ever skip reports no estimated savings
// rather than a fabricated number.
let recentRagRetrievalMs = 0;

const INSUFFICIENT_EVIDENCE_PATTERNS = [
  "insufficient evidence to answer this question",
  "the available evidence is insufficient",
  "not enough evidence",
  "no evidence available",
  "evidence is insufficient",
];

function isInsufficientEvidenceAnswer(answer: string | undefined | null): boolean {
  if (typeof answer !== "string") return false;
  const normalized = answer.toLowerCase().trim();
  return INSUFFICIENT_EVIDENCE_PATTERNS.some((p) => normalized.includes(p));
}

export function determineRoutingTier(ckResult: ClaimKitQueryResult | null, ckUnavailableReason?: string): RoutingDecision {
  if (!ckResult) {
    // CK did not produce an answer — routing falls back to RAG but this is NOT a quality win for RAG.
    return { tier: "rag_primary", preferredSource: "rag", overallWinner: "tie", routingReason: ckUnavailableReason ?? "ck_unavailable" };
  }

  const { confidence, answerability, answer } = ckResult;

  // If CK returned a fallback "Insufficient evidence" string, it did not actually answer.
  // Regardless of the retrieval-phase scores, route to RAG.
  if (isInsufficientEvidenceAnswer(answer)) {
    return { tier: "rag_primary", preferredSource: "rag", overallWinner: "rag", routingReason: "ck_no_answer" };
  }

  const highThreshold = env.CLAIMKIT_ROUTE_HIGH_CONFIDENCE;
  const lowThreshold = env.CLAIMKIT_ROUTE_LOW_CONFIDENCE;
  const isAnswerable = answerability === "answerable" || answerability === "partially-answerable";
  const isNotAnswerable = answerability === "not_answerable" || answerability === undefined;

  // CK wins above high threshold with real evidence; RAG wins below low
  // threshold or when not answerable; blended in between.
  if (confidence > highThreshold && isAnswerable) {
    return { tier: "ck_primary", preferredSource: "claimkit", overallWinner: "claimkit", routingReason: "high_confidence" };
  }

  if (confidence < lowThreshold || isNotAnswerable) {
    return {
      tier: "rag_primary",
      preferredSource: "rag",
      overallWinner: "rag",
      routingReason: isNotAnswerable ? "not_answerable" : "low_confidence",
    };
  }

  return { tier: "blended", preferredSource: "blended", overallWinner: "tie", routingReason: "uncertain" };
}

/**
 * Decide the ClaimKit-first routing strategy from a pre-flight probe (issue
 * #229). Confidence drives the choice; a non-answerable probe always falls
 * back to full RAG regardless of confidence so a confidently-wrong "I can't
 * answer" never skips retrieval.
 *
 * - Routing disabled / no probe → "rag_first" (legacy order).
 * - not_answerable → "claimkit_first_fallback".
 * - confidence ≥ HIGH threshold → "claimkit_first_skip_rag".
 * - confidence ≥ LOW threshold → "claimkit_first_parallel".
 * - otherwise → "claimkit_first_fallback".
 */
export function determineRoutingStrategy(
  ckProbe: ClaimKitQueryResult | null,
): RoutingStrategy {
  if (!env.CLAIMKIT_FIRST_ROUTING) return "rag_first";
  if (!ckProbe) return "rag_first";

  const answerable =
    ckProbe.answerability === "answerable" ||
    ckProbe.answerability === "partially-answerable";
  if (!answerable) return "claimkit_first_fallback";

  if (ckProbe.confidence >= env.CLAIMKIT_HIGH_CONFIDENCE_THRESHOLD) {
    return "claimkit_first_skip_rag";
  }
  if (ckProbe.confidence >= env.CLAIMKIT_LOW_CONFIDENCE_THRESHOLD) {
    return "claimkit_first_parallel";
  }
  return "claimkit_first_fallback";
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutValue: T,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(timeoutValue), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Race an abortable async task against a timeout. If the timeout wins, the
 * controller is aborted so the losing task can stop holding provider slots
 * or CPU. The caller must pass the signal down to the async work.
 */
export async function withAbortableTimeout<T>(
  makePromise: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutValue: T,
): Promise<T> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      makePromise(controller.signal),
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve(timeoutValue);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function assembleContextPacket(
  params: AssembleContextParams,
): Promise<ContextPacket> {
  const {
    mode,
    query,
    sessionMessages,
    providerMaxTokens,
    toolTokens,
    onProgress,
  } = params;

  const budget = createBudget(env.CONTEXT_PACKET_V2_BUDGET, providerMaxTokens, toolTokens);
  const stageTimings: Record<string, number> = {};
  const timeStage = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      stageTimings[name] = Date.now() - start;
    }
  };

  const systemSlot = budget.slots.find((s) => s.name === "system")!;
  const historySlot = budget.slots.find((s) => s.name === "history")!;
  const documentsSlot = budget.slots.find((s) => s.name === "documents")!;
  const graphSlot = budget.slots.find((s) => s.name === "graph")!;

  // Load agent memory snapshots (MEMORY.md + USER.md) — slot #1, before system prompt
  // Sanitize to reduce prompt injection risk from persisted markdown content
  const sanitizeForPrompt = (s: string) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  // SOUL.md — absolute first section (slot #1), before everything else
  let soulContent: string;
  try {
    soulContent = sanitizeForPrompt(soulManager.load());
  } catch (err) {
    console.warn("[ContextPacket] Failed to load SOUL.md, falling back to empty:", err);
    soulContent = "";
  }
  const soulSection: ContextSection = { name: "soul", content: soulContent, tokens: estimateTokens(soulContent) };
  const soulTokens = soulSection.tokens;

  const memorySnapshot = sanitizeForPrompt(agentMemory.getMemorySnapshot());
  const userSnapshot = sanitizeForPrompt(agentMemory.getUserSnapshot());
  const memorySection: ContextSection | null = memorySnapshot
    ? { name: "agent_memory", content: memorySnapshot, tokens: estimateTokens(memorySnapshot) }
    : null;
  const userProfileSection: ContextSection | null = userSnapshot
    ? { name: "user_profile", content: userSnapshot, tokens: estimateTokens(userSnapshot) }
    : null;
  const memoryTokens = (memorySection?.tokens ?? 0) + (userProfileSection?.tokens ?? 0);

  // Recent reflections — after memory/user, before skills
  // Budget ~300 tokens for the last 3 reflection entries
  const MAX_REFLECTION_TOKENS = 300;
  const rawReflections = sanitizeForPrompt(reflectionEngine.getRecentReflections(3, MAX_REFLECTION_TOKENS));
  const reflectionsSection: ContextSection | null = rawReflections
    ? { name: "recent_reflections", content: rawReflections, tokens: estimateTokens(rawReflections) }
    : null;
  const reflectionsTokens = reflectionsSection?.tokens ?? 0;

  // Load skill summaries — after memory/user, before system prompt
  // Cap at ~500 tokens to prevent context bloat from large skill lists
  const MAX_SKILL_TOKENS = 500;
  const rawSkillsText = skillManager.getSummariesText();
  let skillsText = rawSkillsText;
  if (rawSkillsText) {
    const estimatedTokens = estimateTokens(rawSkillsText);
    if (estimatedTokens > MAX_SKILL_TOKENS) {
      const maxChars = MAX_SKILL_TOKENS * 4; // ~4 chars/token
      const truncated = rawSkillsText.substring(0, maxChars);
      const lastNewline = truncated.lastIndexOf("\n");
      skillsText = lastNewline > 0 ? truncated.substring(0, lastNewline) + "\n...(truncated)" : truncated + "\n...(truncated)";
      console.warn(
        `[ContextPacket] Skill summaries truncated: ${estimatedTokens} tokens exceeded ${MAX_SKILL_TOKENS} cap. ` +
        `Some skills may be omitted from context.`,
      );
    }
  }
  const skillsSection: ContextSection | null = skillsText
    ? { name: "skills", content: skillsText, tokens: estimateTokens(skillsText) }
    : null;
  const skillsTokens = skillsSection?.tokens ?? 0;

  // Fast path: server startup already initialized ClaimKit — skip the async probe.
  // Only run the async init when the startup init hasn't landed yet (first request race)
  // or when CLAIMKIT_ENABLED but init was never attempted (e.g. tests).
  const claimKitAvailable = claimKitAdapter.isAvailable()
    || (env.CLAIMKIT_ENABLED
      ? await timeStage("claimkitInitializeMs", () => withTimeout(claimKitAdapter.initialize(), env.CLAIMKIT_INIT_TIMEOUT_MS, false))
      : false);
  if (!claimKitAvailable && env.CLAIMKIT_ENABLED && claimKitAdapter.getInitError()) {
    console.warn(`[ClaimKit] Skipped — ${claimKitAdapter.getInitError()}`);
  }

  // ── ClaimKit-first pre-flight probe (issue #229) ─────────────────────
  // Query ClaimKit BEFORE running RAG. A high-confidence probe lets us skip
  // RAG entirely; medium confidence runs both in parallel; low confidence /
  // not-answerable falls back to full RAG. The probe is hard-capped so a slow
  // ClaimKit degrades into "rag_first" rather than adding latency. Any error
  // also degrades to "rag_first".
  let routingStrategy: RoutingStrategy = "rag_first";
  let ckProbe: ClaimKitQueryResult | null = null;
  let probeLatencyMs = 0;
  if (env.CLAIMKIT_FIRST_ROUTING && env.CLAIMKIT_ENABLED && claimKitAvailable) {
    onProgress?.("Probing structured claims...");
    const probeStart = Date.now();
    try {
      ckProbe = await withAbortableTimeout(
        (signal) => claimKitAdapter.query(query, { signal }),
        env.CLAIMKIT_FIRST_PROBE_TIMEOUT_MS,
        null,
      );
    } catch (err) {
      ckProbe = null;
      console.warn("[ContextPacket] ClaimKit-first probe failed:", err instanceof Error ? err.message : err);
    }
    probeLatencyMs = Date.now() - probeStart;
    stageTimings.claimkitProbeMs = probeLatencyMs;
    routingStrategy = determineRoutingStrategy(ckProbe);
    console.log(
      `[ContextPacket] ${routingStrategy} | probe_confidence=${ckProbe ? (ckProbe.confidence * 100).toFixed(0) + "%" : "—"} | ` +
      `probe_answerability=${ckProbe?.answerability ?? "—"} | probe=${probeLatencyMs}ms`,
    );
  }
  const ragSkipped = routingStrategy === "claimkit_first_skip_rag";

  const baseSystemPrompt = getSystemPrompt(mode, query, "engine");
  const systemTokens = estimateTokens(baseSystemPrompt);
  // Pre-V2 only: memory/skills/soul/reflections were not budgeted, so the code
  // inflated the system slot to absorb their cost. In V2 these sections have
  // their own slots, so we leave systemSlot unchanged.
  if (!env.CONTEXT_PACKET_V2_BUDGET) {
    systemSlot.allocatedTokens = Math.max(
      systemSlot.allocatedTokens,
      systemTokens + memoryTokens + skillsTokens + soulTokens + reflectionsTokens,
    );
  }

  onProgress?.("Retrieving knowledge sources...");
  const ragStart = Date.now();

  const [docs, selectedMessages] = await Promise.all([
    // ClaimKit-first skip: the high-confidence probe already answered, so we
    // pay none of the RAG retrieval cost (embedding lookup, keyword search,
    // graph traversal).
    ragSkipped
      ? Promise.resolve([] as ScoredDocument[])
      : timeStage("retrieveStoresMs", () => retrieveAllStores(query)),
    Promise.resolve().then(() => {
      const scored = scoreMessages(sessionMessages, query);
      const deduped = deduplicateByJaccard(scored);
      return selectMessages(deduped, historySlot.allocatedTokens);
    }),
  ]);

  // Estimate the latency change vs. the old RAG-first path (negative = faster).
  // When RAG was skipped, the savings is the most-recently-observed RAG
  // retrieval cost; when RAG ran, the probe added its own latency on top.
  const ragRetrievalMs = stageTimings.retrieveStoresMs ?? 0;
  if (!ragSkipped) recentRagRetrievalMs = ragRetrievalMs;
  const latencyDeltaMs = ragSkipped ? -recentRagRetrievalMs : probeLatencyMs;

  const historyTokens = selectedMessages.reduce((sum, s) => sum + s.tokens, 0);

  // Start independent async/sync work in parallel with ClaimKit query.
  // These do not depend on ClaimKit result and can overlap with its latency.
  const graphPromise = Promise.resolve().then(() => retrieveGraphContext(query));
  const sessionsPromise = Promise.resolve().then(() => {
    try {
      return conversationManager.searchSessions(query, 3);
    } catch {
      return [] as ReturnType<typeof conversationManager.searchSessions>;
    }
  });
  const healthPromise = withTimeout(buildHealthStatus(), 2000, null);

  // Start document ranking and compression immediately — only depends on docs, not ClaimKit.
  const docsCompressPromise = Promise.resolve().then(() => {
    const reranked = rerank(docs, query);
    return compressDocuments(
      reranked.slice(0, 10),
      query,
      documentsSlot.allocatedTokens,
    );
  });

  let claimKitResult: Awaited<ReturnType<typeof claimKitAdapter.query>> | null = null;
  let ckMs = 0;
  let ckStatus: CkStatus | null = null;
  let routing: RoutingDecision | undefined;
  let groundingHandle: GroundingHandle | undefined = undefined;
  // Collaboration trackers — recorded on the comparison_cases row so the
  // dashboard can show how often each new feature actually fired.
  let citationBoostCount = 0;
  let gapFillDocsAdded = 0;
  let entityClaimsInjectedCount = 0;
  let contradictionsFlaggedCount = 0;
  let contradictionDetails: string[] = [];
  if (!env.CLAIMKIT_ENABLED) {
    ckStatus = "disabled";
  } else if (!claimKitAvailable) {
    ckStatus = "disabled";
    console.warn("[ClaimKit] Skipped — not initialized (run `claimkit ingest` to populate stores)");
  } else if (ragSkipped) {
    // ClaimKit-first skip path: the high-confidence pre-flight probe already
    // answered. Reuse it directly — no document seeding (we have no RAG docs)
    // and no second ClaimKit query.
    claimKitResult = ckProbe;
    ckMs = probeLatencyMs;
    stageTimings.claimkitQueryMs = ckMs;
    ckStatus = claimKitResult
      ? (claimKitResult.metadata.claimCount === 0 ? "no_claims" : "answered")
      : "timeout";
    if (claimKitResult) {
      const symbol = claimKitResult.answerability === "answerable" ? "✅" : claimKitResult.answerability === "partially-answerable" ? "⚠️" : "❌";
      console.log(
        `[ClaimKit] ${symbol} ${claimKitResult.answerability} | confidence=${(claimKitResult.confidence * 100).toFixed(0)}% | claims=${claimKitResult.metadata.claimCount} | sources=${claimKitResult.metadata.sourceIds.length} | score=${claimKitResult.metadata.retrievalScore.toFixed(2)} | ${ckMs}ms (probe, RAG skipped)`,
      );
    }
  } else {
    onProgress?.("Extracting knowledge claims...");
    const seedStart = Date.now();
    const seedTimeoutMs = env.CLAIMKIT_SEED_TIMEOUT_MS;
    const seedPromise = withAbortableTimeout(
      (signal) => ingestScoredDocumentsForQuery(docs, query, env.CLAIMKIT_QUERY_SEED_LIMIT, signal)
        .catch((err) => { console.warn("[ClaimKit] Query seed failed:", err); })
        .then(() => true as const),
      seedTimeoutMs,
      false as const,
    );
    if (env.CLAIMKIT_AWAIT_SEED) {
      // Hard cap the seed wait. Without this, a slow LLM extractor on 15
      // seeded docs could take 56+ minutes (real production observation,
      // run 8b58e79d) before the outer 500s query timeout even fires.
      // Cap is intentionally smaller than CLAIMKIT_QUERY_TIMEOUT_MS so a
      // slow seed degrades gracefully into "continue without these claims"
      // rather than poisoning the whole context assembly. The abortable
      // timeout cancels pending ingest work when the cap is hit.
      const seedFinished = await seedPromise;
      if (!seedFinished) {
        console.warn(
          `[ClaimKit] Seed wait timed out after ${seedTimeoutMs}ms — ` +
          `continuing query without freshly seeded claims. Reduce ` +
          `CLAIMKIT_QUERY_SEED_LIMIT or set CLAIMKIT_AWAIT_SEED=false if this recurs.`,
        );
        stageTimings.claimkitSeedTimedOutMs = seedTimeoutMs;
      }
    }
    stageTimings.claimkitSeedMs = Date.now() - seedStart;
    onProgress?.("Querying knowledge graph...");
    const ckStart = Date.now();
    try {
      claimKitResult = await withAbortableTimeout(
        (signal) => claimKitAdapter.query(query, { signal }),
        env.CLAIMKIT_QUERY_TIMEOUT_MS,
        null,
      );
      ckMs = Date.now() - ckStart;
      stageTimings.claimkitQueryMs = ckMs;
      if (!claimKitResult) {
        ckStatus = "timeout";
        console.warn(`[ClaimKit] Query timed out after ${ckMs}ms (limit: ${env.CLAIMKIT_QUERY_TIMEOUT_MS}ms)`);
      } else {
        ckStatus = claimKitResult.metadata.claimCount === 0 ? "no_claims" : "answered";
        const symbol = claimKitResult.answerability === "answerable" ? "✅" : claimKitResult.answerability === "partially-answerable" ? "⚠️" : "❌";
        console.log(
          `[ClaimKit] ${symbol} ${claimKitResult.answerability} | confidence=${(claimKitResult.confidence * 100).toFixed(0)}% | claims=${claimKitResult.metadata.claimCount} | sources=${claimKitResult.metadata.sourceIds.length} | score=${claimKitResult.metadata.retrievalScore.toFixed(2)} | ${ckMs}ms`,
        );
        if (claimKitResult.confidence < 0.1) {
          console.log(
            `[ClaimKit:DEBUG] query="${query.substring(0, 120)}" | ` +
            `sources=${claimKitResult.metadata.sourceIds.length} | ` +
            `retrievalScore=${claimKitResult.metadata.retrievalScore.toFixed(3)} | ` +
            `answer=${claimKitResult.answer.substring(0, 200)} | ` +
            `missingEvidence=[${claimKitResult.missingEvidence.slice(0, 5).join(", ")}] | ` +
            `citations=[${claimKitResult.citations.slice(0, 3).map(c => c.sourceId).join(", ")}]`,
          );
        }
      }
    } catch (err) {
      ckMs = Date.now() - ckStart;
      ckStatus = "error";
      stageTimings.claimkitQueryMs = ckMs;
      console.warn("[ClaimKit] Query failed:", err);
    }
  }

  let compressedDocs = await docsCompressPromise;

  // Entity claims section (Idea 2): build BEFORE the comparison save so the
  // collaboration counters (entityClaimsInjectedCount, contradictionsFlaggedCount)
  // are populated. The section is consumed further down when assembling
  // `sections[]`.
  const MAX_ENTITY_CLAIMS_TOKENS = 600;
  let entityClaimsSection: ContextSection | null = null;
  try {
    const ecResult = buildEntityClaimsSection(query);
    if (ecResult.content) {
      const ecTokens = estimateTokens(ecResult.content);
      const ecTrimmed =
        ecTokens > MAX_ENTITY_CLAIMS_TOKENS
          ? ecResult.content.substring(0, MAX_ENTITY_CLAIMS_TOKENS * 4)
          : ecResult.content;
      entityClaimsSection = {
        name: "entity_claims",
        content: ecTrimmed,
        tokens: Math.min(ecTokens, MAX_ENTITY_CLAIMS_TOKENS),
        sourceCount: ecResult.entityCount,
      };
      entityClaimsInjectedCount = ecResult.claimCount;
      contradictionsFlaggedCount = ecResult.contradictionCount;
      contradictionDetails = ecResult.contradictions;
      console.log(
        `[EntityClaims] injected ${ecResult.claimCount} claim(s) across ${ecResult.entityCount} entit${ecResult.entityCount === 1 ? "y" : "ies"}` +
        (ecResult.entitiesWithHistory > 0
          ? ` (${ecResult.entitiesWithHistory} with supersession history)`
          : "") +
        (ecResult.contradictionCount > 0
          ? ` | ⚠️ ${ecResult.contradictionCount} recent cross-source contradiction${ecResult.contradictionCount === 1 ? "" : "s"} flagged`
          : ""),
      );
    }
  } catch (err) {
    console.warn("[EntityClaims] section build failed:", err instanceof Error ? err.message : err);
  }

  // Relationship context (ENTITY.md): human-readable per-person profiles for
  // entities referenced in the query. Sits alongside structured claims and
  // gives the agent "relationship memory" (e.g. boss prefers Slack, client EST).
  const entityProfilesSection = buildEntityMarkdownSection(query);

  // ── ClaimKit citation boost (Idea 5: collaborative scoring) ──────────
  // After both retrieval paths have completed, push docs that ClaimKit's
  // claims cite to the top of the compressed set. This is the join point
  // between RAG and ClaimKit — docs ClaimKit found useful get surfaced
  // first in the model's context window, rather than being randomly
  // ordered by their pre-CK embedding score.
  if (claimKitResult && claimKitResult.citations.length > 0 && compressedDocs.length > 1) {
    const citationTexts = claimKitResult.citations
      .map((c) => c.text.toLowerCase())
      .filter((t) => t.length > 20);

    const ckConfidence = Math.max(0, Math.min(1, claimKitResult.confidence));

    let boostedCount = 0;
    const withBoost = compressedDocs.map((doc) => {
      const haystack = (doc.title + " " + doc.content).toLowerCase();
      // Boost when a citation's first 80 chars (the most distinctive prefix)
      // appears in the doc — a cheap proxy for "ClaimKit cited this doc."
      const cited = citationTexts.some((c) => {
        const probe = c.substring(0, Math.min(80, c.length));
        return haystack.includes(probe);
      });
      if (!cited) return doc;
      boostedCount++;
      const boost = ckConfidence;
      return {
        ...doc,
        claimKitBoost: boost,
        score: doc.score + boost * 0.4,
      };
    });

    if (boostedCount > 0) {
      withBoost.sort((a, b) => b.score - a.score);
      compressedDocs = withBoost;
      citationBoostCount = boostedCount;
      console.log(
        `[ContextPacket] ClaimKit citation boost applied to ${boostedCount}/${compressedDocs.length} docs ` +
        `(ck_confidence=${ckConfidence.toFixed(2)})`,
      );
    }
  }

  // ── Gap-fill cascade (Idea 4) ────────────────────────────────────────
  // When ClaimKit's pass came back with low confidence AND it told us
  // explicitly what evidence it was missing, run a targeted second-pass
  // RAG retrieval against each missing-evidence item. This makes
  // ClaimKit the gap detector for RAG — its "I can't answer because I
  // don't know X" becomes "go fetch X."
  if (
    claimKitResult &&
    claimKitResult.confidence < env.CLAIMKIT_GAP_FILL_THRESHOLD &&
    claimKitResult.missingEvidence.length > 0 &&
    env.CLAIMKIT_GAP_FILL_THRESHOLD > 0
  ) {
    const gapStart = Date.now();
    const probes = claimKitResult.missingEvidence
      .filter((m) => typeof m === "string" && m.trim().length > 0)
      .slice(0, env.CLAIMKIT_GAP_FILL_MAX_QUERIES);

    const existingIds = new Set(compressedDocs.map((d) => d.id));
    const fillerDocs: ScoredDocument[] = [];

    for (const probe of probes) {
      try {
        const hits = knowledgeStore.search(probe, { limit: 2 });
        for (const hit of hits) {
          if (existingIds.has(hit.entry.id)) continue;
          existingIds.add(hit.entry.id);
          fillerDocs.push({
            id: hit.entry.id,
            source: "knowledge",
            content: hit.entry.content,
            title: hit.entry.title,
            score: hit.score,
            baseScore: hit.score,
            importanceScore: 0,
            recencyScore: 0,
            trustScore: 0,
            // Mark these as cascade-derived so the rerank-boost weight
            // recognizes them — ClaimKit literally asked for them.
            claimKitBoost: 1,
            tokens: Math.ceil(hit.entry.content.length / 1.8),
            metadata: {
              matchType: hit.matchType,
              source: hit.entry.source,
              tags: hit.entry.tags,
              createdAt: hit.entry.createdAt,
              gapFillProbe: probe.substring(0, 120),
            },
          });
        }
      } catch (err) {
        console.warn(`[GapFill] probe "${probe.substring(0, 40)}..." failed:`, err instanceof Error ? err.message : err);
      }
    }

    if (fillerDocs.length > 0) {
      // Rerank the augmented set so cascade results are properly scored
      // alongside the original docs, then trim back to the same budget.
      const ranked = rerank([...compressedDocs, ...fillerDocs], query);
      const targetCount = Math.max(compressedDocs.length, ranked.length);
      compressedDocs = ranked.slice(0, targetCount);
      stageTimings.gapFillMs = Date.now() - gapStart;
      gapFillDocsAdded = fillerDocs.length;
      console.log(
        `[GapFill] CK confidence=${claimKitResult.confidence.toFixed(2)} ` +
        `triggered ${probes.length} cascade probe(s), added ${fillerDocs.length} new doc(s) ` +
        `(took ${stageTimings.gapFillMs}ms)`,
      );
    }
  }

  if (env.CLAIMKIT_ENABLED) {
    const ragTokens = compressedDocs.reduce((s, d) => s + d.tokens, 0);
    const ckWins = claimKitResult &&
      !isInsufficientEvidenceAnswer(claimKitResult.answer) &&
      claimKitResult.confidence > 0.15 &&
      (claimKitResult.answerability === "answerable" || claimKitResult.answerability === "partially-answerable");
    const winner = claimKitResult
      ? (ckWins ? "ClaimKit ✅" : claimKitResult.answerability === "not_answerable" ? "RAG (CK n/a)" : "RAG (CK low confidence)")
      : "RAG (CK unavailable)";
    console.log(
      `[Comparison] RAG: ${compressedDocs.length} docs, ${ragTokens} tokens | ` +
      `CK: confidence=${claimKitResult ? (claimKitResult.confidence * 100).toFixed(0) + "%" : "—"}, ` +
      `claims=${claimKitResult?.metadata.claimCount ?? "—"} | ` +
      `winner=${winner}`,
    );
    console.log(
      `[Comparison:Retrieval] RAG docs: [${docs.slice(0, 10).map(d => `${d.source}:${d.title?.substring(0, 40) ?? "—"}`).join(", ")}]`,
    );
    if (claimKitResult) {
      console.log(
        `[Comparison:Retrieval] CK sources: [${claimKitResult.metadata.sourceIds.slice(0, 10).join(", ")}] | score=${claimKitResult.metadata.retrievalScore.toFixed(3)}`,
      );
    }

    // Compute routing once inside the ClaimKit-enabled block so it captures
    // the final ckStatus (timeout/error/disabled/answered).
    const unavailableReason = ckStatus === "timeout" ? "ck_timeout"
      : ckStatus === "error" ? "ck_error"
      : ckStatus === "disabled" ? "ck_disabled"
      : undefined;
    routing = determineRoutingTier(claimKitResult, unavailableReason);

    const ragMs = Date.now() - ragStart;
    const ckIncludedInContext = claimKitResult != null;

    // Estimate the tokens the claimkit_evidence section will consume in
    // the prompt. The section is built further down, but the cost-savings
    // story requires this number on the comparison_cases row at save
    // time. We replicate the section build verbatim (same headers, same
    // citation truncation) so the count matches what actually ends up in
    // the prompt rather than relying on a synthetic-string approximation.
    let ckSectionTokensEstimate: number | null = null;
    if (claimKitResult && ckIncludedInContext) {
      const previewLines: string[] = [];
      // Header — one of three labels depending on routing tier.
      if (routing.preferredSource === "claimkit") {
        previewLines.push("=== PRIMARY ANSWER (ClaimKit — high confidence) ===");
      } else if (routing.preferredSource === "rag") {
        previewLines.push("=== SUPPLEMENTARY ANALYSIS (ClaimKit) ===");
      } else {
        previewLines.push("=== VERIFIED EVIDENCE (ClaimKit) ===");
      }
      previewLines.push(`Answerability: ${claimKitResult.answerability}`);
      previewLines.push(`Confidence: ${(claimKitResult.confidence * 100).toFixed(1)}%`);
      previewLines.push(`Claims found: ${claimKitResult.metadata.claimCount}`);
      previewLines.push("");
      previewLines.push("--- Evidence ---");
      previewLines.push(claimKitResult.answer);
      if (claimKitResult.citations.length > 0) {
        previewLines.push("");
        previewLines.push("--- Citations ---");
        for (const cite of claimKitResult.citations.slice(0, 10)) {
          previewLines.push(`[${cite.claimId}] ${cite.text.substring(0, 200)}`);
        }
      }
      const previewContent = previewLines.join("\n");
      ckSectionTokensEstimate = estimateTokens(previewContent);
    }

    const saved = saveLiveComparison({
      query,
      ragTokens,
      ragSections: compressedDocs.length,
      ragTimeMs: ragMs,
      ragHallucinationRate: null,
      ragGrounded: null,
      ckConfidence: claimKitResult?.confidence ?? null,
      ckAnswerability: claimKitResult?.answerability ?? null,
      ckClaimCount: claimKitResult?.metadata.claimCount ?? null,
      ckTimeMs: ckMs > 0 ? ckMs : null,
      ckContradictions: claimKitResult?.contradictions.length ?? null,
      ckAnswer: claimKitResult?.answer ?? null,
      ckRetrievalScore: claimKitResult?.metadata.retrievalScore ?? null,
      ckSourceCount: claimKitResult?.metadata.sourceIds.length ?? null,
      ckMissingEvidence: claimKitResult?.missingEvidence?.join(", ") ?? null,
      overallWinner: routing.overallWinner,
      winnerReason: routing.routingReason,
      ckStatus,
      ckIncludedInContext,
      ckSectionTokens: ckSectionTokensEstimate,
      // Phase 1: persist the per-stage confidence trace so the dashboard
      // can show which stage drove the score, not just the final number.
      confidenceTrace: claimKitResult?.confidenceTrace,
      citationBoostApplied: citationBoostCount,
      gapFillDocsAdded,
      entityClaimsInjected: entityClaimsInjectedCount,
      contradictionsFlagged: contradictionsFlaggedCount,
      // ClaimKit-first routing strategy (issue #229) so the dashboard can
      // measure RAG-skip rate and latency delta vs. the old RAG-first path.
      routingStrategy,
    });

    // Stash the case ID + compressed RAG evidence so chat.ts can run live
    // shadow grounding on the agent's actual response after it completes.
    // Sampled by CLAIMKIT_LIVE_GROUNDING_RATE — set to 0 to disable.
    if (
      saved &&
      env.CLAIMKIT_LIVE_GROUNDING_RATE > 0 &&
      Math.random() < env.CLAIMKIT_LIVE_GROUNDING_RATE &&
      compressedDocs.length > 0
    ) {
      groundingHandle = {
        caseId: saved.caseId,
        ragEvidence: compressedDocs.slice(0, 12).map((d) => ({
          title: d.title || d.id,
          content: d.content,
        })),
      };
    }
  }

  onProgress?.("Building context packet...");
  // Await parallel work started before ClaimKit query
  const healthStart = Date.now();
  const [graphContext, sessionResults, healthText] = await Promise.all([
    graphPromise,
    sessionsPromise,
    healthPromise,
  ]);
  stageTimings.healthStatusMs = Date.now() - healthStart;
  if (!healthText) {
    console.warn(`[ContextPacket] Health status skipped after ${stageTimings.healthStatusMs}ms`);
  }

  const graphTokens = estimateTokens(graphContext);
  const trimmedGraph =
    graphTokens <= graphSlot.allocatedTokens
      ? graphContext
      : graphContext.substring(0, Math.floor(graphSlot.allocatedTokens * 1.8));

  const knowledgeSection = formatDocumentsSection(compressedDocs);
  const graphSection = trimmedGraph;

  // If ClaimKit is disabled, compute a default routing here. When enabled,
  // routing was already computed inside the block so it captured ckStatus.
  if (!routing) {
    routing = determineRoutingTier(claimKitResult, ckStatus === "disabled" ? "ck_disabled" : undefined);
  }
  console.log(
    `[ROUTING DECISION] winner=${routing.overallWinner.toUpperCase()} | tier=${routing.tier} | reason=${routing.routingReason}` +
    (claimKitResult
      ? ` | ck_confidence=${(claimKitResult.confidence * 100).toFixed(1)}% | ck_claims=${claimKitResult.metadata.claimCount} | ck_answerability=${claimKitResult.answerability}`
      : ` | ck_available=${claimKitAvailable} | ck_status=${ckStatus}`),
  );

  let claimKitSection: ClaimKitContextSection | null = null;
  if (claimKitResult) {
    const evidenceLines: string[] = [];
    if (routing.tier === "ck_primary") {
      evidenceLines.push("=== PRIMARY ANSWER (ClaimKit — high confidence) ===");
    } else if (routing.tier === "rag_primary") {
      evidenceLines.push("=== SUPPLEMENTARY ANALYSIS (ClaimKit) ===");
    } else {
      evidenceLines.push("=== VERIFIED EVIDENCE (ClaimKit) ===");
    }
    evidenceLines.push(`Answerability: ${claimKitResult.answerability}`);
    evidenceLines.push(`Confidence: ${(claimKitResult.confidence * 100).toFixed(1)}%`);
    evidenceLines.push(`Claims found: ${claimKitResult.metadata.claimCount}`);
    evidenceLines.push("");
    evidenceLines.push("--- Evidence ---");
    evidenceLines.push(claimKitResult.answer);
    if (claimKitResult.citations.length > 0) {
      evidenceLines.push("");
      evidenceLines.push("--- Citations ---");
      for (const cite of claimKitResult.citations.slice(0, 10)) {
        evidenceLines.push(`[${cite.claimId}] ${cite.text.substring(0, 200)}`);
      }
    }
    const content = evidenceLines.join("\n");
    claimKitSection = {
      name: "claimkit_evidence",
      content,
      tokens: estimateTokens(content),
      answerability: claimKitResult.answerability,
      contradictions: claimKitResult.contradictions,
      claimCount: claimKitResult.metadata.claimCount,
      confidence: claimKitResult.confidence,
    };
  }

  // Entity claims section was built earlier (before saveLiveComparison) so
  // collaboration counters are recorded. The same `entityClaimsSection` is
  // used below when assembling the final section list — no rebuild needed.

  // Session search — find past conversations relevant to current query
  const MAX_SESSION_SEARCH_TOKENS = 400;
  let sessionSearchSection: ContextSection | null = null;
  if (sessionResults.length > 0) {
    const lines = sessionResults.map((r) => {
      const topics = r.keyTopics.length > 0 ? ` | topics: ${r.keyTopics.join(", ")}` : "";
      return `- [${r.title}]${topics}\n  ${r.summary.substring(0, 200)}`;
    });
    const content = `=== PAST SESSIONS ===\n${lines.join("\n")}`;
    const tokens = estimateTokens(content);
    sessionSearchSection = {
      name: "recent_sessions",
      content: tokens > MAX_SESSION_SEARCH_TOKENS
        ? content.substring(0, MAX_SESSION_SEARCH_TOKENS * 4)
        : content,
      tokens: Math.min(tokens, MAX_SESSION_SEARCH_TOKENS),
    };
  }

  const healthSection: ContextSection | null = healthText
    ? { name: "health", content: healthText, tokens: estimateTokens(healthText) }
    : null;

  const sections: ContextSection[] = [];

  // SOUL.md — absolute first section (slot #0, before everything)
  sections.push(soulSection);

  // Slot #1: Agent memory + user profile + skills (before system prompt)
  if (memorySection) {
    sections.push(memorySection);
  }
  if (userProfileSection) {
    sections.push(userProfileSection);
  }
  if (reflectionsSection) {
    sections.push(reflectionsSection);
  }
  if (skillsSection) {
    sections.push(skillsSection);
  }

  sections.push(
    { name: "system", content: baseSystemPrompt, tokens: systemTokens },
    { name: "history", content: "", tokens: historyTokens },
    { name: "documents", content: knowledgeSection, tokens: estimateTokens(knowledgeSection), sourceCount: compressedDocs.length },
    { name: "graph", content: graphSection, tokens: estimateTokens(graphSection) },
  );

  // Entity claims sit between RAG documents and ClaimKit evidence:
  // they're structured facts the agent should prefer over fuzzy retrieval
  // when the user is asking about a specific entity by ID.
  if (entityClaimsSection) {
    sections.push(entityClaimsSection);
  }

  if (entityProfilesSection) {
    sections.push(entityProfilesSection);
  }

  if (claimKitSection) {
    sections.push(claimKitSection);
  }

  if (sessionSearchSection) {
    sections.push(sessionSearchSection);
  }

  if (healthSection) {
    sections.push(healthSection);
  }

  const enforced = enforceBudget(sections, budget);

  // Inject agent memory + user profile as the first system messages (slot #1)
  const memoryEnforced = enforced.find((s) => s.name === "agent_memory");
  const userProfileEnforced = enforced.find((s) => s.name === "user_profile");
  const systemEnforced = enforced.find((s) => s.name === "system");

  const messages: ChatMessage[] = [];

  const soulEnforced = enforced.find((s) => s.name === "soul");
  if (soulEnforced?.content.trim()) {
    const personalityTag = soulManager.getActivePersonality()
      ? ` [personality: ${soulManager.getActivePersonality()}]`
      : "";
    messages.push({ role: "system", content: `=== IDENTITY${personalityTag} ===\n${soulEnforced.content}` });
  }

  if (memoryEnforced?.content.trim()) {
    messages.push({ role: "system", content: `=== AGENT MEMORY ===\n${memoryEnforced.content}` });
  }
  if (userProfileEnforced?.content.trim()) {
    messages.push({ role: "system", content: `=== USER PROFILE ===\n${userProfileEnforced.content}` });
  }

  const reflectionsEnforced = enforced.find((s) => s.name === "recent_reflections");
  if (reflectionsEnforced?.content.trim()) {
    messages.push({ role: "system", content: `=== RECENT REFLECTIONS ===\n${reflectionsEnforced.content}` });
  }

  const skillsEnforced = enforced.find((s) => s.name === "skills");
  if (skillsEnforced?.content.trim()) {
    messages.push({ role: "system", content: skillsEnforced.content });
  }

  if (systemEnforced) {
    messages.push({ role: "system", content: systemEnforced.content });
  }

  const claimKitEnforced = enforced.find((s) => s.name === "claimkit_evidence");
  const docEnforced = enforced.find((s) => s.name === "documents");
  const entityClaimsEnforced = enforced.find((s) => s.name === "entity_claims");

  // Entity claims go FIRST in the evidence chain when the query mentions
  // known entities — these are exact, time-stamped, and supersede whatever
  // fading embedding match RAG might surface for the same query.
  if (entityClaimsEnforced?.content.trim()) {
    messages.push({ role: "system", content: entityClaimsEnforced.content });
  }

  const entityProfilesEnforced = enforced.find((s) => s.name === "entity_profiles");
  if (entityProfilesEnforced?.content.trim()) {
    messages.push({ role: "system", content: entityProfilesEnforced.content });
  }

  if (routing.tier === "ck_primary" && claimKitEnforced?.content.trim()) {
    // CK primary: show ClaimKit answer first with full detail
    messages.push({ role: "system", content: claimKitEnforced.content });
    if (docEnforced?.content.trim()) {
      messages.push({
        role: "system",
        content: `=== SUPPLEMENTARY CONTEXT ===\n${docEnforced.content}`,
      });
    }
  } else if (routing.tier === "rag_primary" && claimKitEnforced?.content.trim()) {
    // RAG primary: show RAG first, CK as supplementary
    if (docEnforced?.content.trim()) {
      messages.push({
        role: "system",
        content: `=== RELEVANT CONTEXT ===\n${docEnforced.content}`,
      });
    }
    messages.push({ role: "system", content: claimKitEnforced.content });
  } else {
    // Blended or CK unavailable: current behavior — RAG then CK equally
    if (docEnforced?.content.trim()) {
      messages.push({
        role: "system",
        content: `=== RELEVANT CONTEXT ===\n${docEnforced.content}`,
      });
    }
    if (claimKitEnforced?.content.trim()) {
      messages.push({ role: "system", content: claimKitEnforced.content });
    }
  }

  const graphEnforced = enforced.find((s) => s.name === "graph");
  if (graphEnforced?.content.trim()) {
    messages.push({
      role: "system",
      content: `=== KNOWLEDGE GRAPH ===\n${graphEnforced.content}`,
    });
  }

  const sessionsEnforced = enforced.find((s) => s.name === "recent_sessions");
  if (sessionsEnforced?.content.trim()) {
    messages.push({ role: "system", content: sessionsEnforced.content });
  }

  const healthEnforced = enforced.find((s) => s.name === "health");
  if (healthEnforced && healthEnforced.content.trim()) {
    messages.push({
      role: "system",
      content: healthEnforced.content,
    });
  }

  for (const sm of selectedMessages) {
    messages.push(sm.message);
  }

  // ── Final chain validity sweep ────────────────────────────────────────
  // selectMessages selects high-scoring messages independently, so it can
  // pick an assistant + tool_calls + tool results group AND a later
  // standalone assistant while dropping the user message that started the
  // later turn. The result is two adjacent assistant messages — which
  // Z.ai's payload validator rejects with "consecutive assistant
  // messages at index N and N+1".
  //
  // This sweep walks the final chain and surgically drops the earlier of
  // any consecutive same-role pair (other than system/tool, where stacks
  // are legal). The later message is the higher-scored one and represents
  // more recent context; dropping the earlier one preserves conversation
  // flow and lets the validator pass.
  //
  // Also drops orphaned tool messages that follow a dropped assistant —
  // a tool result with no parent assistant is also invalid.
  const cleaned: ChatMessage[] = [];
  const droppedToolCallIds = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const prev = cleaned[cleaned.length - 1];

    // Drop orphaned tool results whose parent assistant we dropped.
    if (msg.role === "tool" && msg.tool_call_id && droppedToolCallIds.has(msg.tool_call_id)) {
      continue;
    }

    // Detect consecutive same-role pair (assistant->assistant or user->user).
    // System and tool messages legitimately stack and are allowed.
    if (
      prev &&
      prev.role === msg.role &&
      msg.role !== "system" &&
      msg.role !== "tool"
    ) {
      if (msg.role === "user") {
        // Two consecutive user messages — the earlier one is the goal anchor
        // (e.g., the original question) and the later is a follow-up like
        // "keep going" after a transient error. Dropping the earlier one
        // would strand the LLM with no goal. Instead, inject a stub
        // assistant turn so the LLM sees the canonical alternating pattern
        // and treats both user messages as meaningful.
        cleaned.push({
          role: "assistant",
          content:
            "[Prior request was interrupted by a transient error before completing. Continuing from the original goal above.]",
        });
        console.warn(
          `[ContextPacket] Injected stub assistant between consecutive user messages at packet position ${cleaned.length - 1} to preserve goal anchor`,
        );
      } else {
        // assistant->assistant: drop the EARLIER message. Track its
        // tool_call_ids so the orphan sweep above can remove now-unparented
        // tool results.
        if (prev.role === "assistant" && prev.tool_calls?.length) {
          for (const tc of prev.tool_calls) {
            if (tc.id) droppedToolCallIds.add(tc.id);
          }
        }
        console.warn(
          `[ContextPacket] Dropped consecutive ${msg.role} message at packet position ${cleaned.length - 1} to keep chain valid`,
        );
        cleaned.pop();
      }
    }

    cleaned.push(msg);
  }

  // Tool-result truncation: oversized tool payloads dominate the conversation
  // budget after a few tool loops (e.g. tenable.list_assets returns 3000+
  // items, ~30k tokens). Stringification already caps at 25k chars per call,
  // but several such results compound. Cap them at TOOL_RESULT_TRUNCATION_CHARS
  // for retained history so the LLM gets enough shape to reason without
  // re-paying the full payload cost. The model can re-call the tool with a
  // narrower scope if it needs detail.
  const TOOL_RESULT_TRUNCATION_CHARS = 4000;
  const TOOL_RESULT_HEAD_CHARS = 1200;
  for (let i = 0; i < cleaned.length; i++) {
    const m = cleaned[i];
    if (m.role === "tool" && m.content && m.content.length > TOOL_RESULT_TRUNCATION_CHARS) {
      // Never truncate a cache-ref stub: the model needs the full pointer
      // (ref + instructions) to call tools.fetch_cached and retrieve the
      // actual payload. The ref is small, so keeping it doesn't blow the budget.
      if (m.content.includes('"_cached_ref"')) continue;
      const originalChars = m.content.length;
      const head = m.content.substring(0, TOOL_RESULT_HEAD_CHARS);
      cleaned[i] = {
        ...m,
        content:
          head +
          `\n…[Tool result truncated for retained context (${originalChars.toLocaleString()} chars total). Re-call the tool with a narrower query if more detail is needed.]`,
      };
      console.warn(
        `[ContextPacket] Truncated retained tool result from ${originalChars} → ${cleaned[i].content!.length} chars`,
      );
    }
  }
  messages.length = 0;
  messages.push(...cleaned);

  // Final safety: the packet handed to chat.ts must never start with a tool
  // or assistant message, even after message pruning and merging.
  const firstNonSystemIdx = messages.findIndex((m) => m.role !== "system");
  if (
    firstNonSystemIdx !== -1 &&
    messages[firstNonSystemIdx].role !== "user"
  ) {
    messages.splice(firstNonSystemIdx, 0, {
      role: "user",
      content: "[conversation continues]",
    });
  }

  const totalTokens = messages.reduce(
    (sum, m) => sum + estimateTokens(m.content || ""),
    0,
  );

  const budgetUtilization: Record<string, number> = {};
  for (const slot of budget.slots) {
    const section = enforced.find((s) => s.name === slot.name);
    const used = section ? section.tokens : 0;
    budgetUtilization[slot.name] =
      slot.allocatedTokens > 0
        ? Math.round((used / slot.allocatedTokens) * 100)
        : 0;
  }

  const totalOriginalDocTokens = docs.reduce(
    (sum, d) => sum + estimateTokens(d.content),
    0,
  );
  const totalCompressedDocTokens = compressedDocs.reduce(
    (sum, d) => sum + d.tokens,
    0,
  );

  return {
    sections: enforced,
    messages,
    totalTokens,
    preferredSource: routing.preferredSource,
    routingReason: routing.routingReason,
    budgetBreakdown: budget.slots,
    groundingHandle,
    contradictions: contradictionDetails.length > 0 ? contradictionDetails : undefined,
    diagnostics: {
      mode: "engine",
      originalMessageCount: sessionMessages.length,
      finalMessageCount: messages.length,
      documentsRetrieved: docs.length,
      documentsCompressed: compressedDocs.length,
      compressionRatio:
        totalOriginalDocTokens > 0
          ? totalOriginalDocTokens / Math.max(totalCompressedDocTokens, 1)
          : 1,
      budgetUtilization,
      stageTimings,
      claimkitFirstMetrics: {
        strategy: routingStrategy,
        probeLatencyMs,
        ragSkipped,
        latencyDeltaMs,
      },
      claimkit: {
        enabled: env.CLAIMKIT_ENABLED,
        available: claimKitAvailable,
        used: claimKitResult !== null,
        timedOut: ckStatus === "timeout",
        includedInMessages: Boolean(claimKitEnforced?.content.trim()),
        preferredSource: routing.preferredSource,
        routingReason: routing.routingReason,
        confidence: claimKitResult?.confidence ?? null,
        answerability: claimKitResult?.answerability ?? null,
        claimCount: claimKitResult?.metadata.claimCount ?? null,
        sourceCount: claimKitResult?.metadata.sourceIds.length ?? null,
        retrievalScore: claimKitResult?.metadata.retrievalScore ?? null,
      },
      createdAt: new Date(),
    },
  };
}

const graphContextCache = new Map<string, { result: string; expires: number }>();

function normalizeGraphQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function isToolOrFollowUpQuery(query: string): boolean {
  // Very short queries and explicit slash commands are unlikely to benefit
  // from graph context on every turn.
  const trimmed = query.trim();
  if (trimmed.startsWith("/")) return true;
  const words = trimmed.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length < 3;
}

async function retrieveAllStores(query: string): Promise<ScoredDocument[]> {
  const docs: ScoredDocument[] = [];

  // Safeguard against indexing this assistant's own source folder when
  // running locally. See RAG_INCLUDE_LOCAL_SOURCES in env.ts.
  const includeLocal = env.RAG_INCLUDE_LOCAL_SOURCES;
  const graphQueryEnabled = env.KNOWLEDGE_GRAPH_QUERY_ENABLED;

  const [
    knowledgeResultsRaw = [],
    codebaseResults = [],
    graphResults = [],
  ] = await Promise.all([
    Promise.resolve().then(() => knowledgeStore.search(query, { limit: 10 })).catch(() => [] as ReturnType<typeof knowledgeStore.search>),
    includeLocal
      ? Promise.resolve().then(() => codebaseIndexer.search(query, { limit: 10 })).catch(() => [] as ReturnType<typeof codebaseIndexer.search>)
      : Promise.resolve([] as ReturnType<typeof codebaseIndexer.search>),
    graphQueryEnabled
      ? Promise.resolve().then(() => knowledgeGraph.queryNodes({ search: query, limit: env.KNOWLEDGE_GRAPH_DOC_LIMIT })).catch(() => [] as ReturnType<typeof knowledgeGraph.queryNodes>)
      : Promise.resolve([] as ReturnType<typeof knowledgeGraph.queryNodes>),
  ]);

  // Strip file_read knowledge entries when local sources are excluded.
  // Other knowledge sources (web_search, web_page, conversation, manual,
  // tool results) are user-data and remain available.
  const knowledgeResults = includeLocal
    ? knowledgeResultsRaw
    : knowledgeResultsRaw.filter((r) => r.entry.source !== "file_read");

  for (const r of knowledgeResults) {
    docs.push({
      id: r.entry.id,
      source: "knowledge",
      content: r.entry.content,
      title: r.entry.title,
      score: r.score,
      baseScore: r.score,
      importanceScore: 0,
      recencyScore: 0,
      trustScore: 0,
      claimKitBoost: 0,
      tokens: Math.ceil(r.entry.content.length / 1.8),
      metadata: {
        matchType: r.matchType,
        source: r.entry.source,
        tags: r.entry.tags,
        createdAt: r.entry.createdAt,
      },
    });
  }

  for (const r of codebaseResults) {
    docs.push({
      id: `code-${r.filePath}:${r.startLine}`,
      source: "codebase",
      content: r.content,
      title: r.filePath,
      score: r.score,
      baseScore: r.score,
      importanceScore: 0,
      recencyScore: 0,
      trustScore: 0,
      claimKitBoost: 0,
      tokens: Math.ceil(r.content.length / 1.8),
      metadata: {
        language: r.language,
        filePath: r.filePath,
        startLine: r.startLine,
        endLine: r.endLine,
        matchType: r.matchType,
      },
    });
  }

  for (const node of graphResults) {
    docs.push({
      id: node.id,
      source: "graph",
      content: node.content,
      title: node.title,
      score: 1,
      baseScore: 1,
      importanceScore: 0,
      recencyScore: 0,
      trustScore: 0,
      claimKitBoost: 0,
      tokens: Math.ceil(node.content.length / 1.8),
      metadata: { type: node.type, status: node.status, tags: node.tags },
    });
  }

  return docs;
}

function retrieveGraphContext(query: string): string {
  if (!env.KNOWLEDGE_GRAPH_QUERY_ENABLED || isToolOrFollowUpQuery(query)) {
    return "";
  }

  const key = normalizeGraphQuery(query);
  const cached = graphContextCache.get(key);
  if (cached && Date.now() < cached.expires) {
    return cached.result;
  }

  try {
    const start = Date.now();
    const parts: string[] = [];

    const nodes = knowledgeGraph.queryNodes({ search: query, limit: 5 });
    if (nodes.length > 0) {
      const nodeIds = nodes.map((n) => n.id);
      parts.push(knowledgeGraph.exportForContext(nodeIds));
    }

    // For broad/thematic queries, include community summaries
    const communitySummaries = knowledgeGraph.retrieveCommunitySummaries(
      query,
      env.KNOWLEDGE_GRAPH_COMMUNITY_LIMIT,
    );
    if (communitySummaries.length > 0) {
      parts.push("\n=== COMMUNITY SUMMARIES ===");
      for (const summary of communitySummaries) {
        parts.push(`- ${summary}`);
      }
    }

    const result = parts.join("\n");
    graphContextCache.set(key, {
      result,
      expires: Date.now() + env.KNOWLEDGE_GRAPH_CACHE_TTL_MS,
    });
    if (Date.now() - start > 50) {
      console.log(`[ContextPacket] Graph context assembled in ${Date.now() - start}ms`);
    }
    return result;
  } catch (err) {
    console.warn("[ContextPacket] Graph context retrieval failed:", err instanceof Error ? err.message : err);
    return "";
  }
}

/**
 * Build the relationship-context section from per-entity ENTITY.md files.
 * Resolves entities referenced in the query (explicit IDs first, then known
 * person/org names that appear verbatim) and loads their markdown profile.
 * Budget: ~200 tokens per entity, at most 2 entities per packet.
 */
function buildEntityMarkdownSection(query: string): ContextSection | null {
  try {
    const PER_ENTITY_TOKENS = 200;
    const MAX_ENTITIES = 2;
    const stripControl = (s: string) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

    const resolved = new Map<string, MemoryEntity>();

    const ids = extractEntityIds(query);
    if (ids.length > 0) {
      for (const e of entityMemory.getEntitiesByNormalizedNames(ids)) {
        resolved.set(e.id, e);
      }
    }

    // Name-based resolution: surface known relationships (people, customers,
    // companies, vendors) whose name appears in the query.
    const lowerQ = query.toLowerCase();
    const relationshipTypes = new Set(["person", "customer", "company", "vendor"]);
    for (const e of entityMemory.listRecentEntities(50)) {
      if (!relationshipTypes.has(e.type)) continue;
      if (e.normalizedName.length >= 3 && lowerQ.includes(e.normalizedName)) {
        resolved.set(e.id, e);
      }
    }

    const blocks: string[] = [];
    for (const entity of resolved.values()) {
      if (blocks.length >= MAX_ENTITIES) break;
      const raw = entityMarkdown.readRaw(entity.id);
      if (!raw || !raw.trim()) continue;
      const clean = stripControl(raw).trim();
      const trimmed =
        estimateTokens(clean) > PER_ENTITY_TOKENS
          ? clean.substring(0, PER_ENTITY_TOKENS * 4) + "\n…(truncated)"
          : clean;
      blocks.push(trimmed);
    }

    if (blocks.length === 0) return null;
    const content = "=== RELATIONSHIP CONTEXT (ENTITY.md) ===\n\n" + blocks.join("\n\n---\n\n");
    return { name: "entity_profiles", content, tokens: estimateTokens(content) };
  } catch (err) {
    console.warn(
      "[ContextPacket] entity markdown section build failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function formatDocumentsSection(docs: ScoredDocument[]): string {
  if (docs.length === 0) return "";

  const bySource: Record<string, ScoredDocument[]> = {};
  for (const doc of docs) {
    const key = doc.source;
    if (!bySource[key]) bySource[key] = [];
    bySource[key].push(doc);
  }

  const parts: string[] = [];

  if (bySource.knowledge) {
    parts.push("--- Knowledge from previous sessions ---");
    for (const doc of bySource.knowledge) {
      parts.push(`[${doc.title}] ${doc.content.substring(0, 500)}`);
    }
  }

  if (bySource.codebase) {
    parts.push("--- Relevant code ---");
    for (const doc of bySource.codebase) {
      const filePath = doc.metadata.filePath as string;
      const startLine = doc.metadata.startLine as number;
      parts.push(`[${filePath}:${startLine}] ${doc.content.substring(0, 400)}`);
    }
  }

  if (bySource.graph) {
    parts.push("--- Knowledge graph ---");
    for (const doc of bySource.graph) {
      parts.push(`[${doc.title}] (${doc.metadata.type}) ${doc.content.substring(0, 400)}`);
    }
  }

  return parts.join("\n\n");
}

// Health status is cached with a 30-second TTL to avoid repeated external API validation calls.
let _cachedHealthStatus: string | null = null;
let _healthStatusCachedAt = 0;
const HEALTH_STATUS_TTL_MS = 30_000;

async function buildHealthStatus(): Promise<string | null> {
  try {
    const now = Date.now();
    if (_cachedHealthStatus !== null && now - _healthStatusCachedAt < HEALTH_STATUS_TTL_MS) {
      return _cachedHealthStatus;
    }

    const providerConfigured = aiClient.isConfigured();
    const providerValid = providerConfigured
      ? await aiClient.validateConfig().catch(() => false)
      : false;

    const [githubConfigured, gitlabConfigured, jiraConfigured] =
      await Promise.all([
        githubClient.isConfigured(),
        gitlabClient.isConfigured(),
        jiraClient.isConfigured(),
      ]);

    const [githubValid, gitlabValid, jiraValid] = await Promise.all([
      githubConfigured ? githubClient.validateConfig().catch(() => false) : false,
      gitlabConfigured ? gitlabClient.validateConfig().catch(() => false) : false,
      jiraConfigured ? jiraClient.validateConfig().catch(() => false) : false,
    ]);

    const lines: string[] = ["CURRENT SYSTEM HEALTH:"];

    const providerIcon = providerValid ? "OK" : providerConfigured ? "INVALID" : "NOT CONFIGURED";
    lines.push(`- AI Provider: ${providerSettings.getCurrent().provider} (${providerIcon})`);

    const integrations: Array<{ name: string; configured: boolean; valid: boolean }> = [
      { name: "GitHub", configured: githubConfigured, valid: githubValid },
      { name: "GitLab", configured: gitlabConfigured, valid: gitlabValid },
      { name: "Jira", configured: jiraConfigured, valid: jiraValid },
    ];

    for (const intg of integrations) {
      const icon = intg.valid ? "OK" : intg.configured ? "INVALID" : "NOT CONFIGURED";
      lines.push(`- ${intg.name}: ${icon}`);
    }

    const result = lines.join("\n");
    _cachedHealthStatus = result;
    _healthStatusCachedAt = now;
    return result;
  } catch {
    return null;
  }
}
