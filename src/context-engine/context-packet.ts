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

export interface RoutingDecision {
  tier: RoutingTier;
  preferredSource: PreferredSource;
  overallWinner: "rag" | "claimkit" | "tie";
  routingReason: string;
}

export function determineRoutingTier(ckResult: ClaimKitQueryResult | null, ckUnavailableReason?: string): RoutingDecision {
  if (!ckResult) {
    // CK did not produce an answer — routing falls back to RAG but this is NOT a quality win for RAG.
    return { tier: "rag_primary", preferredSource: "rag", overallWinner: "tie", routingReason: ckUnavailableReason ?? "ck_unavailable" };
  }

  const { confidence, answerability } = ckResult;

  // CK wins when it has real confidence. Scoring is multiplicative without LLM verifiers,
  // so 0.15 is the practical achievable bar. Accept partially-answerable — it still provides
  // useful evidence even when the full query can't be answered.
  if (confidence > 0.15 && (answerability === "answerable" || answerability === "partially-answerable")) {
    return { tier: "ck_primary", preferredSource: "claimkit", overallWinner: "claimkit", routingReason: "high_confidence" };
  }

  if (confidence < 0.05 || answerability === "not_answerable") {
    return {
      tier: "rag_primary",
      preferredSource: "rag",
      overallWinner: "rag",
      routingReason: answerability === "not_answerable" ? "not_answerable" : "low_confidence",
    };
  }

  return { tier: "blended", preferredSource: "blended", overallWinner: "tie", routingReason: "uncertain" };
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

export async function assembleContextPacket(
  params: AssembleContextParams,
): Promise<ContextPacket> {
  const {
    mode,
    query,
    sessionMessages,
    providerMaxTokens,
    toolTokens,
  } = params;

  const budget = createBudget(undefined, providerMaxTokens, toolTokens);
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

  const baseSystemPrompt = getSystemPrompt(mode, query, "engine");
  const systemTokens = estimateTokens(baseSystemPrompt);
  systemSlot.allocatedTokens = Math.max(systemSlot.allocatedTokens, systemTokens + memoryTokens + skillsTokens + soulTokens + reflectionsTokens);

  const scored = scoreMessages(sessionMessages, query);
  const deduped = deduplicateByJaccard(scored);
  const selectedMessages = selectMessages(deduped, historySlot.allocatedTokens);
  const historyTokens = selectedMessages.reduce((sum, s) => sum + s.tokens, 0);

  const ragStart = Date.now();
  const docs = await timeStage("retrieveStoresMs", () => retrieveAllStores(query));

  let claimKitResult: Awaited<ReturnType<typeof claimKitAdapter.query>> | null = null;
  let ckMs = 0;
  let ckStatus: CkStatus | null = null;
  if (!env.CLAIMKIT_ENABLED) {
    ckStatus = "disabled";
  } else if (!claimKitAvailable) {
    ckStatus = "disabled";
    console.warn("[ClaimKit] Skipped — not initialized (run `claimkit ingest` to populate stores)");
  } else {
    const seedStart = Date.now();
    // Always await seed — CK must see the current request's docs before querying.
    // Fire-and-forget causes a race where CK queries an empty store and returns confidence=0.
    await ingestScoredDocumentsForQuery(docs, query, env.CLAIMKIT_QUERY_SEED_LIMIT)
      .catch((err) => { console.warn("[ClaimKit] Query seed failed:", err); });
    stageTimings.claimkitSeedMs = Date.now() - seedStart;
    const ckStart = Date.now();
    try {
      claimKitResult = await withTimeout(
        claimKitAdapter.query(query),
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

  const rerankedDocs = rerank(docs, query);
  const compressedDocs = compressDocuments(
    rerankedDocs.slice(0, 10),
    query,
    documentsSlot.allocatedTokens,
  );

  if (env.CLAIMKIT_ENABLED) {
    const ragTokens = compressedDocs.reduce((s, d) => s + d.tokens, 0);
    const ckWins = claimKitResult &&
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

    // Auto-save comparison data for dashboard — use routing decision
    const unavailableReason = ckStatus === "timeout" ? "ck_timeout"
      : ckStatus === "error" ? "ck_error"
      : ckStatus === "disabled" ? "ck_disabled"
      : undefined;
    const comparisonRouting = determineRoutingTier(claimKitResult, unavailableReason);
    const ragMs = Date.now() - ragStart;
    const ckIncludedInContext = claimKitResult != null;
    saveLiveComparison({
      query,
      ragTokens,
      ragSections: compressedDocs.length,
      ragTimeMs: ragMs,
      ckConfidence: claimKitResult?.confidence ?? null,
      ckAnswerability: claimKitResult?.answerability ?? null,
      ckClaimCount: claimKitResult?.metadata.claimCount ?? null,
      ckTimeMs: ckMs > 0 ? ckMs : null,
      ckContradictions: claimKitResult?.contradictions.length ?? null,
      ckAnswer: claimKitResult?.answer ?? null,
      ckRetrievalScore: claimKitResult?.metadata.retrievalScore ?? null,
      ckSourceCount: claimKitResult?.metadata.sourceIds.length ?? null,
      ckMissingEvidence: claimKitResult?.missingEvidence?.join(", ") ?? null,
      overallWinner: comparisonRouting.overallWinner,
      winnerReason: comparisonRouting.routingReason,
      ckStatus,
      ckIncludedInContext,
    });
  }

  const graphContext = retrieveGraphContext(query);
  const graphTokens = estimateTokens(graphContext);
  const trimmedGraph =
    graphTokens <= graphSlot.allocatedTokens
      ? graphContext
      : graphContext.substring(0, Math.floor(graphSlot.allocatedTokens * 1.8));

  const knowledgeSection = formatDocumentsSection(compressedDocs);
  const graphSection = trimmedGraph;

  const routing = determineRoutingTier(claimKitResult);
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

  // Session search — find past conversations relevant to current query
  const MAX_SESSION_SEARCH_TOKENS = 400;
  let sessionSearchSection: ContextSection | null = null;
  try {
    const sessionResults = conversationManager.searchSessions(query, 3);
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
  } catch {}

  const healthStart = Date.now();
  const healthText = await withTimeout(buildHealthStatus(), 2000, null);
  stageTimings.healthStatusMs = Date.now() - healthStart;
  if (!healthText) {
    console.warn(`[ContextPacket] Health status skipped after ${stageTimings.healthStatusMs}ms`);
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

async function retrieveAllStores(query: string): Promise<ScoredDocument[]> {
  const docs: ScoredDocument[] = [];

  try {
    const knowledgeResults = knowledgeStore.search(query, { limit: 10 });
    for (const r of knowledgeResults) {
      docs.push({
        id: r.entry.id,
        source: "knowledge",
        content: r.entry.content,
        title: r.entry.title,
        score: r.score,
        baseScore: r.score,
        importanceScore: 0,
        recencyScore: 1,
        tokens: Math.ceil(r.entry.content.length / 1.8),
        metadata: { matchType: r.matchType, source: r.entry.source, tags: r.entry.tags },
      });
    }
  } catch {}

  try {
    const codebaseResults = codebaseIndexer.search(query, { limit: 10 });
    for (const r of codebaseResults) {
      docs.push({
        id: `code-${r.filePath}:${r.startLine}`,
        source: "codebase",
        content: r.content,
        title: r.filePath,
        score: r.score,
        baseScore: r.score,
        importanceScore: 0,
        recencyScore: 1,
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
  } catch {}

  try {
    const graphResults = knowledgeGraph.queryNodes({ search: query, limit: 10 });
    for (const node of graphResults) {
      docs.push({
        id: node.id,
        source: "graph",
        content: node.content,
        title: node.title,
        score: 1,
        baseScore: 1,
        importanceScore: 0,
        recencyScore: 1,
        tokens: Math.ceil(node.content.length / 1.8),
        metadata: { type: node.type, status: node.status, tags: node.tags },
      });
    }
  } catch {}

  return docs;
}

function retrieveGraphContext(query: string): string {
  try {
    const nodes = knowledgeGraph.queryNodes({ search: query, limit: 5 });
    if (nodes.length === 0) return "";

    const nodeIds = nodes.map((n) => n.id);
    return knowledgeGraph.exportForContext(nodeIds);
  } catch {
    return "";
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

async function buildHealthStatus(): Promise<string | null> {
  try {
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

    return lines.join("\n");
  } catch {
    return null;
  }
}
