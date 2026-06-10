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
  source: "knowledge" | "codebase" | "graph" | "memory" | "claimkit";
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

export interface ClaimKitContextSection {
  name: "claimkit_evidence";
  content: string;
  tokens: number;
  answerability: import("./adapters/claimkit-adapter").AnswerabilityStatus;
  contradictions: Array<{ claimA: string; claimB: string; reason: string }>;
  claimCount: number;
  confidence: number;
}

export type PreferredSource = "claimkit" | "rag" | "blended";
export type RoutingTier = "ck_primary" | "rag_primary" | "blended";

export interface ContextPacket {
  sections: ContextSection[];
  messages: ChatMessage[];
  totalTokens: number;
  claimkitSection?: ClaimKitContextSection;
  preferredSource?: PreferredSource;
  routingReason?: string;
  budgetBreakdown: BudgetSlot[];
  diagnostics: {
    mode: ContextMode;
    originalMessageCount: number;
    finalMessageCount: number;
    documentsRetrieved: number;
    documentsCompressed: number;
    compressionRatio: number;
    budgetUtilization: Record<string, number>;
    stageTimings: Record<string, number>;
    claimkit: {
      enabled: boolean;
      available: boolean;
      used: boolean;
      timedOut: boolean;
      includedInMessages: boolean;
      preferredSource: PreferredSource;
      routingReason: string;
      confidence: number | null;
      answerability: string | null;
      claimCount: number | null;
      sourceCount: number | null;
      retrievalScore: number | null;
    };
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
  onProgress?: (message: string) => void;
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
  { name: "history", priority: 80, fraction: 0.35, overflowTarget: "documents" },
  { name: "documents", priority: 60, fraction: 0.2, overflowTarget: "graph" },
  { name: "graph", priority: 40, fraction: 0.1, overflowTarget: "health" },
  { name: "claimkit_evidence", priority: 55, fraction: 0.15, overflowTarget: "documents" },
  { name: "health", priority: 20, fraction: 0.05, overflowTarget: null },
];

export const CHARS_PER_TOKEN = 1.8;
