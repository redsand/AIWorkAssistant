import { knowledgeStore } from "../agent/knowledge-store";
import { codebaseIndexer } from "../agent/codebase-indexer";
import { knowledgeGraph } from "../agent/knowledge-graph";
import { aiClient } from "../agent/opencode-client";
import { githubClient } from "../integrations/github/github-client";
import { gitlabClient } from "../integrations/gitlab/gitlab-client";
import { jiraClient } from "../integrations/jira/jira-client";
import { env } from "../config/env";
import { getSystemPrompt } from "../agent/prompts";
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
import { createBudget, estimateTokens, enforceBudget } from "./budget";
import { compressDocuments } from "./compressor";
import { rerank } from "./reranker";
import { scoreMessages, deduplicateByJaccard, selectMessages } from "./memory-decay";
import type { ClaimKitQueryResult } from "./adapters/claimkit-adapter";

export interface RoutingDecision {
  tier: RoutingTier;
  preferredSource: PreferredSource;
  overallWinner: "rag" | "claimkit" | "tie";
  routingReason: string;
}

export function determineRoutingTier(ckResult: ClaimKitQueryResult | null): RoutingDecision {
  if (!ckResult) {
    return { tier: "rag_primary", preferredSource: "rag", overallWinner: "rag", routingReason: "ck_unavailable" };
  }

  const { confidence, answerability } = ckResult;

  // CK wins when it has real confidence. The scoring formula is multiplicative, so even with
  // good evidence the combined score rarely exceeds 0.5 — 0.3 is the practical achievable bar.
  if (confidence > 0.3 && answerability === "answerable") {
    return { tier: "ck_primary", preferredSource: "claimkit", overallWinner: "claimkit", routingReason: "high_confidence" };
  }

  if (confidence < 0.1 || answerability === "not_answerable") {
    return {
      tier: "rag_primary",
      preferredSource: "rag",
      overallWinner: "rag",
      routingReason: answerability === "not_answerable" ? "not_answerable" : "low_confidence",
    };
  }

  return { tier: "blended", preferredSource: "blended", overallWinner: "tie", routingReason: "uncertain" };
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

  const systemSlot = budget.slots.find((s) => s.name === "system")!;
  const historySlot = budget.slots.find((s) => s.name === "history")!;
  const documentsSlot = budget.slots.find((s) => s.name === "documents")!;
  const graphSlot = budget.slots.find((s) => s.name === "graph")!;

  const claimKitAvailable = await claimKitAdapter.initialize();

  const baseSystemPrompt = getSystemPrompt(mode, query, "engine");
  const systemTokens = estimateTokens(baseSystemPrompt);
  systemSlot.allocatedTokens = Math.max(systemSlot.allocatedTokens, systemTokens);

  const scored = scoreMessages(sessionMessages, query);
  const deduped = deduplicateByJaccard(scored);
  const selectedMessages = selectMessages(deduped, historySlot.allocatedTokens);
  const historyTokens = selectedMessages.reduce((sum, s) => sum + s.tokens, 0);

  const ragStart = Date.now();
  const docs = await retrieveAllStores(query);

  let claimKitResult: Awaited<ReturnType<typeof claimKitAdapter.query>> | null = null;
  let ckMs = 0;
  if (claimKitAvailable) {
    await ingestScoredDocumentsForQuery(docs, query, env.CLAIMKIT_QUERY_SEED_LIMIT);
    const ckStart = Date.now();
    try {
      claimKitResult = await claimKitAdapter.query(query);
      ckMs = Date.now() - ckStart;
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
    } catch (err) {
      console.warn("[ClaimKit] Query failed:", err);
    }
  } else if (env.CLAIMKIT_ENABLED) {
    console.warn("[ClaimKit] Skipped — not initialized (run `claimkit ingest` to populate stores)");
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
      claimKitResult.confidence > 0.3 &&
      claimKitResult.answerability === "answerable";
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
    const comparisonRouting = determineRoutingTier(claimKitResult);
    const ragMs = Date.now() - ragStart;
    saveLiveComparison({
      query,
      ragTokens,
      ragSections: compressedDocs.length,
      ragTimeMs: ragMs,
      ckConfidence: claimKitResult?.confidence ?? null,
      ckAnswerability: claimKitResult?.answerability ?? null,
      ckClaimCount: claimKitResult?.metadata.claimCount ?? null,
      ckTimeMs: claimKitResult ? ckMs : null,
      ckContradictions: claimKitResult?.contradictions.length ?? null,
      ckAnswer: claimKitResult?.answer ?? null,
      ckRetrievalScore: claimKitResult?.metadata.retrievalScore ?? null,
      ckSourceCount: claimKitResult?.metadata.sourceIds.length ?? null,
      ckMissingEvidence: claimKitResult?.missingEvidence?.join(", ") ?? null,
      overallWinner: comparisonRouting.overallWinner,
      winnerReason: comparisonRouting.routingReason,
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

  const healthText = await buildHealthStatus();
  const healthSection: ContextSection | null = healthText
    ? { name: "health", content: healthText, tokens: estimateTokens(healthText) }
    : null;

  const sections: ContextSection[] = [
    { name: "system", content: baseSystemPrompt, tokens: systemTokens },
    { name: "history", content: "", tokens: historyTokens },
    { name: "documents", content: knowledgeSection, tokens: estimateTokens(knowledgeSection), sourceCount: compressedDocs.length },
    { name: "graph", content: graphSection, tokens: estimateTokens(graphSection) },
  ];

  if (claimKitSection) {
    sections.push(claimKitSection);
  }

  if (healthSection) {
    sections.push(healthSection);
  }

  const enforced = enforceBudget(sections, budget);

  const messages: ChatMessage[] = [
    { role: "system", content: enforced[0].content },
  ];

  const claimKitEnforced = enforced.find((s) => s.name === "claimkit_evidence");
  const docEnforced = enforced[2];

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

  if (enforced[3].content.trim()) {
    messages.push({
      role: "system",
      content: `=== KNOWLEDGE GRAPH ===\n${enforced[3].content}`,
    });
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
    lines.push(`- AI Provider: ${env.AI_PROVIDER} (${providerIcon})`);

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
