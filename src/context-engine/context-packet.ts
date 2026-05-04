import { knowledgeStore } from "../agent/knowledge-store";
import { codebaseIndexer } from "../agent/codebase-indexer";
import { knowledgeGraph } from "../agent/knowledge-graph";
import { getSystemPrompt } from "../agent/prompts";
import type { ChatMessage } from "../agent/providers/types";
import type {
  AssembleContextParams,
  ContextPacket,
  ContextSection,
  ScoredDocument,
} from "./types";
import { createBudget, estimateTokens, enforceBudget } from "./budget";
import { compressDocuments } from "./compressor";
import { rerank } from "./reranker";
import { scoreMessages, deduplicateByJaccard, selectMessages } from "./memory-decay";

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

  const baseSystemPrompt = getSystemPrompt(mode, undefined, "engine");
  const systemTokens = estimateTokens(baseSystemPrompt);
  systemSlot.allocatedTokens = Math.max(systemSlot.allocatedTokens, systemTokens);

  const scored = scoreMessages(sessionMessages, query);
  const deduped = deduplicateByJaccard(scored);
  const selectedMessages = selectMessages(deduped, historySlot.allocatedTokens);
  const historyTokens = selectedMessages.reduce((sum, s) => sum + s.tokens, 0);

  const docs = await retrieveAllStores(query);
  const rerankedDocs = rerank(docs, query);
  const compressedDocs = compressDocuments(
    rerankedDocs.slice(0, 10),
    query,
    documentsSlot.allocatedTokens,
  );

  const graphContext = retrieveGraphContext(query);
  const graphTokens = estimateTokens(graphContext);
  const trimmedGraph =
    graphTokens <= graphSlot.allocatedTokens
      ? graphContext
      : graphContext.substring(0, Math.floor(graphSlot.allocatedTokens * 1.8));

  const knowledgeSection = formatDocumentsSection(compressedDocs);
  const graphSection = trimmedGraph;

  const sections: ContextSection[] = [
    { name: "system", content: baseSystemPrompt, tokens: systemTokens },
    { name: "history", content: "", tokens: historyTokens },
    { name: "documents", content: knowledgeSection, tokens: estimateTokens(knowledgeSection), sourceCount: compressedDocs.length },
    { name: "graph", content: graphSection, tokens: estimateTokens(graphSection) },
  ];

  const enforced = enforceBudget(sections, budget);

  const messages: ChatMessage[] = [
    { role: "system", content: enforced[0].content },
  ];

  if (enforced[2].content.trim()) {
    messages.push({
      role: "system",
      content: `=== RELEVANT CONTEXT ===\n${enforced[2].content}`,
    });
  }

  if (enforced[3].content.trim()) {
    messages.push({
      role: "system",
      content: `=== KNOWLEDGE GRAPH ===\n${enforced[3].content}`,
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