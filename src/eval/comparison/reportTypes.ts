import type { ComparisonEvalCategory } from "../types";
import type { CkStatus } from "../../comparison-runs/types";

export interface ThresholdEvaluation {
  passed: boolean;
  failures: string[];
}

export interface ComparisonCaseRag {
  contextTokens: number;
  sections: number;
  processingTimeMs: number;
  hallucinationRate: number | null;
  grounded: boolean | null;
}

import type { AnswerabilityStatus } from "../../context-engine/adapters/claimkit-adapter";

export interface ComparisonCaseClaimKit {
  confidence: number;
  answerability: AnswerabilityStatus;
  claimCount: number;
  processingTimeMs: number;
  contradictions: number;
}

export interface ComparisonCase {
  query: string;
  category: ComparisonEvalCategory;
  overallWinner: "rag" | "claimkit" | "tie";
  winnerReason?: string;
  rag: ComparisonCaseRag;
  claimkit: ComparisonCaseClaimKit | null;
  ckStatus?: CkStatus | null;
  ckIncludedInContext?: boolean | null;
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
        hallucinationRate: number;
        groundedRate: number;
      };
    };
  };
  thresholdEvaluation?: ThresholdEvaluation;
}
