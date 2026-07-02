// Cost-aware retrieval cascade (issue #245).
//
// The context packet historically had a binary fallback: a ClaimKit-first
// probe answered directly when confident, otherwise it paid the full cost of
// RAG retrieval. U-Mem (arXiv:2602.22406, §3.2) shows agents save 40%+ of
// expensive retrieval calls by escalating through cheaper verification steps
// first. This module implements that escalation as four ordered levels:
//
//   Level 0 CLAIMKIT       — the pre-flight probe (already run by the caller).
//   Level 1 TEACHER_VERIFY — ask a higher-tier model to confirm the ClaimKit
//                            answer (~1k tokens).
//   Level 2 TOOL_RESEARCH  — corroborate the answer with web_search (~2k tokens).
//   Level 3 FULL_RAG       — the existing, most expensive fallback.
//
// The cascade stops as soon as a level resolves the query with confidence at
// or above the stop threshold, or when the remaining token budget can't afford
// the next step (in which case it falls back to full RAG). The class itself is
// pure orchestration: the teacher verifier and tool researcher are injected so
// the escalation logic is testable without live providers.

import { env } from "../config/env";
import { aiClient } from "../agent/opencode-client";
import { webSearchClient } from "../integrations/web/search-client";
import { estimateTokens } from "./budget";

export enum CascadeLevel {
  CLAIMKIT = "claimkit",
  TEACHER_VERIFY = "teacher_verify",
  TOOL_RESEARCH = "tool_research",
  FULL_RAG = "full_rag",
}

export type CascadeOutcome =
  | "ck_high_confidence"
  | "teacher_confirmed"
  | "tool_confirmed"
  | "budget_exhausted"
  | "fell_back_to_rag";

/** The terminal result of one cascade run — also the shape logged for debug. */
export interface CascadeResolution {
  level: CascadeLevel;
  tokensUsed: number;
  confidence: number;
  outcome: CascadeOutcome;
  /**
   * The actual resolved text this cascade run produced — what should be
   * persisted as a durable knowledge claim (issue #247). This is NOT the raw
   * low-confidence ClaimKit probe answer that triggered escalation:
   *
   *   - ck_high_confidence : the probe answer (already confident enough).
   *   - teacher_confirmed  : the candidate answer the teacher endorsed. The
   *                          teacher verifier returns only confirm/reject, so
   *                          the durable text is the candidate it validated —
   *                          but now carries the teacher's high confidence.
   *   - tool_confirmed     : the web evidence that corroborated the answer —
   *                          new external knowledge acquired by the tool step.
   *   - budget_exhausted /
   *     fell_back_to_rag   : empty. Nothing cheaper resolved the query, so
   *                          there is no verified resolution worth persisting;
   *                          full RAG owns the answer.
   */
  resolution: string;
}

export interface CascadeInput {
  /** The (rewritten) retrieval query. */
  query: string;
  /** The candidate answer produced by the ClaimKit probe. */
  claimKitAnswer: string;
  /** ClaimKit probe confidence in [0, 1]. */
  confidence: number;
  signal?: AbortSignal;
}

export interface TeacherVerdict {
  confirmed: boolean;
  /** The teacher's own confidence in the candidate answer, in [0, 1]. */
  confidence: number;
  tokensUsed: number;
}

export interface ToolResearchResult {
  resolved: boolean;
  /** How strongly the retrieved evidence supports the candidate answer. */
  confidence: number;
  evidence: string;
  tokensUsed: number;
}

export interface TeacherVerifier {
  verify(input: CascadeInput): Promise<TeacherVerdict>;
}

export interface ToolResearcher {
  research(input: CascadeInput): Promise<ToolResearchResult>;
}

export interface RetrievalCascadeConfig {
  /** Total token budget across all escalation steps. */
  budgetTokens: number;
  /** Confidence at/above which the cascade stops and skips full RAG. */
  stopConfidence: number;
  /** Lower bound of the "medium confidence" band that triggers TEACHER_VERIFY. */
  lowThreshold: number;
  /** Estimated cost of the teacher step, charged against the budget. */
  teacherCostTokens: number;
  /** Estimated cost of the tool-research step, charged against the budget. */
  toolCostTokens: number;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export class RetrievalCascade {
  constructor(
    private readonly teacher: TeacherVerifier,
    private readonly researcher: ToolResearcher,
    private readonly config: RetrievalCascadeConfig,
  ) {}

  /**
   * Escalate from the ClaimKit probe result through teacher verification and
   * tool research, stopping at the first level that resolves the query with
   * sufficient confidence (or when the budget can't afford the next step).
   */
  async run(input: CascadeInput): Promise<CascadeResolution> {
    const conf = clamp01(input.confidence);
    let tokensUsed = 0;

    // Level 0 — the ClaimKit probe already answered. High confidence resolves
    // immediately; no escalation cost.
    if (conf >= this.config.stopConfidence) {
      return {
        level: CascadeLevel.CLAIMKIT,
        tokensUsed,
        confidence: conf,
        outcome: "ck_high_confidence",
        resolution: input.claimKitAnswer,
      };
    }

    const isMedium = conf >= this.config.lowThreshold;

    // Level 1 — TEACHER_VERIFY. Only attempted for medium-confidence probes:
    // a confident-enough answer that just needs a second opinion. Below the
    // medium band the answer is too weak to be worth a teacher pass, so we go
    // straight to tool research.
    if (isMedium) {
      if (tokensUsed + this.config.teacherCostTokens > this.config.budgetTokens) {
        return {
          level: CascadeLevel.FULL_RAG,
          tokensUsed,
          confidence: conf,
          outcome: "budget_exhausted",
          resolution: "",
        };
      }
      const verdict = await this.teacher.verify(input);
      tokensUsed += Math.max(0, verdict.tokensUsed);
      if (verdict.confirmed && clamp01(verdict.confidence) >= this.config.stopConfidence) {
        return {
          level: CascadeLevel.TEACHER_VERIFY,
          tokensUsed,
          confidence: clamp01(verdict.confidence),
          outcome: "teacher_confirmed",
          // The teacher endorsed this exact candidate answer; it is now a
          // teacher-verified resolution, not the low-confidence probe.
          resolution: input.claimKitAnswer,
        };
      }
      // Teacher rejected (or wasn't confident enough) → escalate to research.
    }

    // Level 2 — TOOL_RESEARCH. Reached when the teacher rejected the answer or
    // the probe was below the medium band.
    if (tokensUsed + this.config.toolCostTokens > this.config.budgetTokens) {
      return {
        level: CascadeLevel.FULL_RAG,
        tokensUsed,
        confidence: conf,
        outcome: "budget_exhausted",
        resolution: "",
      };
    }
    const research = await this.researcher.research(input);
    tokensUsed += Math.max(0, research.tokensUsed);
    if (research.resolved && clamp01(research.confidence) >= this.config.stopConfidence) {
      return {
        level: CascadeLevel.TOOL_RESEARCH,
        tokensUsed,
        confidence: clamp01(research.confidence),
        outcome: "tool_confirmed",
        // The corroborating web evidence is the knowledge the tool step
        // actually acquired — persist it, not the pre-cascade probe answer.
        resolution: research.evidence,
      };
    }

    // Level 3 — FULL_RAG fallback. Nothing cheaper resolved the query, so
    // there is no verified resolution to persist; full RAG owns the answer.
    return {
      level: CascadeLevel.FULL_RAG,
      tokensUsed,
      confidence: Math.max(conf, clamp01(research.confidence)),
      outcome: "fell_back_to_rag",
      resolution: "",
    };
  }
}

/** Tokens worth corroborating: drop stopwords/short noise. */
function keywordTokens(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9_\s-]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 3),
    ),
  ];
}

/** Parse the teacher model's verdict, tolerating prose around the JSON. */
export function parseTeacherVerdict(raw: string): { confirmed: boolean; confidence: number } {
  if (!raw) return { confirmed: false, confidence: 0 };
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]) as { verdict?: unknown; confidence?: unknown };
      const verdict = String(obj.verdict ?? "").toLowerCase();
      const confidence = clamp01(Number(obj.confidence));
      if (verdict === "confirm") return { confirmed: true, confidence };
      if (verdict === "reject") return { confirmed: false, confidence };
    } catch {
      // fall through to the keyword heuristic
    }
  }
  const lowered = raw.toLowerCase();
  if (lowered.includes("confirm")) return { confirmed: true, confidence: 0.8 };
  return { confirmed: false, confidence: 0 };
}

/**
 * Score how strongly web evidence corroborates the candidate answer by keyword
 * overlap. When there is no candidate answer to corroborate, fall back to a
 * coverage signal based on how many results came back.
 */
export function scoreEvidenceSupport(
  answer: string,
  evidence: string,
  resultCount: number,
): number {
  if (!evidence) return 0;
  const answerTokens = keywordTokens(answer);
  if (answerTokens.length === 0) {
    return resultCount > 0 ? Math.min(0.8, 0.4 + resultCount * 0.1) : 0;
  }
  const lowered = evidence.toLowerCase();
  const matched = answerTokens.filter((t) => lowered.includes(t)).length;
  return clamp01(matched / answerTokens.length);
}

/** Default teacher verifier — a single JSON-mode chat call to a higher tier. */
export function createDefaultTeacherVerifier(): TeacherVerifier {
  return {
    async verify({ query, claimKitAnswer, signal }) {
      const messages = [
        {
          role: "system" as const,
          content:
            "You are a strict fact-checker. Decide whether the candidate answer " +
            "correctly and sufficiently answers the question. Respond ONLY with " +
            'compact JSON: {"verdict":"confirm"|"reject","confidence":<0..1>}.',
        },
        {
          role: "user" as const,
          content:
            `Question:\n${query}\n\n` +
            `Candidate answer:\n${claimKitAnswer || "(no answer provided)"}\n\n` +
            "Does the candidate answer correctly and sufficiently answer the question?",
        },
      ];
      try {
        const resp = await aiClient.chat({
          messages,
          model: env.CASCADE_TEACHER_MODEL || undefined,
          temperature: 0,
          jsonMode: true,
          signal,
        });
        const parsed = parseTeacherVerdict(resp.content);
        const tokensUsed =
          resp.usage?.totalTokens ??
          estimateTokens(messages.map((m) => m.content).join("\n")) +
            estimateTokens(resp.content || "");
        return { confirmed: parsed.confirmed, confidence: parsed.confidence, tokensUsed };
      } catch (err) {
        console.warn(
          "[ContextPacket] cascade teacher verify failed:",
          err instanceof Error ? err.message : err,
        );
        return { confirmed: false, confidence: 0, tokensUsed: 0 };
      }
    },
  };
}

/** Default tool researcher — corroborates the answer via web_search. */
export function createDefaultToolResearcher(): ToolResearcher {
  return {
    async research({ query, claimKitAnswer }) {
      if (!webSearchClient.isConfigured()) {
        return { resolved: false, confidence: 0, evidence: "", tokensUsed: 0 };
      }
      try {
        const res = await webSearchClient.search(query, 5, {
          includeAnswer: true,
          searchDepth: "basic",
        });
        const evidenceParts = [res.answer ?? "", ...res.results.map((r) => r.snippet)].filter(
          Boolean,
        );
        const evidence = evidenceParts.join("\n");
        const confidence = scoreEvidenceSupport(claimKitAnswer, evidence, res.results.length);
        return {
          resolved: confidence > 0,
          confidence,
          evidence: evidence.slice(0, 4000),
          tokensUsed: estimateTokens(evidence),
        };
      } catch (err) {
        console.warn(
          "[ContextPacket] cascade tool research failed:",
          err instanceof Error ? err.message : err,
        );
        return { resolved: false, confidence: 0, evidence: "", tokensUsed: 0 };
      }
    },
  };
}

/** Build a cascade wired to the real teacher/researcher, configured from env. */
export function createDefaultCascade(
  overrides?: Partial<RetrievalCascadeConfig>,
): RetrievalCascade {
  const config: RetrievalCascadeConfig = {
    budgetTokens: env.CASCADE_BUDGET_TOKENS,
    stopConfidence: env.CASCADE_STOP_CONFIDENCE,
    lowThreshold: env.CLAIMKIT_LOW_CONFIDENCE_THRESHOLD,
    teacherCostTokens: env.CASCADE_TEACHER_COST_TOKENS,
    toolCostTokens: env.CASCADE_TOOL_COST_TOKENS,
    ...overrides,
  };
  return new RetrievalCascade(
    createDefaultTeacherVerifier(),
    createDefaultToolResearcher(),
    config,
  );
}
