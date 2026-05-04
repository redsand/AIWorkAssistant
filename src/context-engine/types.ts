import type { ChatMessage } from "../agent/providers/types";

export type ContextMode = "rag" | "engine";

export interface BudgetSlotDefinition {
  name: string;
  priority: number;
  fraction: number;
  overflowTarget: string | null;
}

export interface BudgetSlot {
  name: string;
  priority: number;
  maxTokens: number;
  allocatedTokens: number;
  overflowTarget: string | null;
}

export interface AllocatedBudget {
  totalBudget: number;
  safetyMargin: number;
  slots: BudgetSlot[];
  remainingTokens: number;
}

export interface ScoredDocument {
  id: string;
  source: "knowledge" | "codebase" | "graph" | "memory";
  content: string;
  title: string;
  score: number;
  baseScore: number;
  importanceScore: number;
  recencyScore: number;
  tokens: number;
  metadata: Record<string, unknown>;
}

export interface ScoredMessage {
  index: number;
  message: ChatMessage;
  importanceScore: number;
  recencyScore: number;
  freshnessScore: number;
  queryRelevance: number;
  effectiveWeight: number;
  tokens: number;
}

export interface ContextSection {
  name: string;
  content: string;
  tokens: number;
  compressionRatio?: number;
  sourceCount?: number;
}

export interface ContextPacket {
  sections: ContextSection[];
  messages: ChatMessage[];
  totalTokens: number;
  budgetBreakdown: BudgetSlot[];
  diagnostics: {
    mode: ContextMode;
    originalMessageCount: number;
    finalMessageCount: number;
    documentsRetrieved: number;
    documentsCompressed: number;
    compressionRatio: number;
    budgetUtilization: Record<string, number>;
    createdAt: Date;
  };
}

export interface AssembleContextParams {
  mode: "productivity" | "engineering";
  query: string;
  sessionMessages: ChatMessage[];
  sessionId: string;
  includeMemory: boolean;
  toolInventory: string;
  providerMaxTokens: number;
  toolTokens: number;
  userId: string;
}

export interface RerankOptions {
  baseScoreWeight: number;
  importanceWeight: number;
  queryRelevanceWeight: number;
  diversityPenalty: number;
}

export const DEFAULT_RERANK_OPTIONS: RerankOptions = {
  baseScoreWeight: 0.4,
  importanceWeight: 0.3,
  queryRelevanceWeight: 0.3,
  diversityPenalty: 0.1,
};

export const DEFAULT_SLOT_DEFINITIONS: BudgetSlotDefinition[] = [
  { name: "system", priority: 100, fraction: 0.3, overflowTarget: "history" },
  { name: "history", priority: 80, fraction: 0.4, overflowTarget: "documents" },
  { name: "documents", priority: 60, fraction: 0.2, overflowTarget: "graph" },
  { name: "graph", priority: 40, fraction: 0.1, overflowTarget: null },
];

export const CHARS_PER_TOKEN = 1.8;