import type { ComparisonEvalCategory } from "../types";

export interface ThresholdEvaluation {
  passed: boolean;
  failures: string[];
}

export interface ComparisonCaseRag {
  contextTokens: number;
  sections: number;
  processingTimeMs: number;
}

export interface ComparisonCaseClaimKit {
  confidence: number;
  answerability: "answerable" | "partially_answerable" | "not_answerable";
  claimCount: number;
  processingTimeMs: number;
  contradictions: number;
}

export interface ComparisonCase {
  query: string;
  category: ComparisonEvalCategory;
  overallWinner: "rag" | "claimkit" | "tie";
  rag: ComparisonCaseRag;
  claimkit: ComparisonCaseClaimKit | null;
}

export interface ComparisonRunResult {
  totalCases: number;
  cases: ComparisonCase[];
  aggregate: {
    wins: { claimkit: number; rag: number; tie: number };
    claimkit: {
      mean: {
        confidence: number;
        answerabilityRate: number;
        avgClaims: number;
        avgTimeMs: number;
      };
    };
    rag: {
      mean: {
        avgTokens: number;
        avgSections: number;
        avgTimeMs: number;
      };
    };
  };
  thresholdEvaluation?: ThresholdEvaluation;
}
