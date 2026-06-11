import { assembleContextPacket } from "../../context-engine/context-packet";
import { claimKitAdapter } from "../../context-engine/adapters/claimkit-adapter";
import { aiClient } from "../../agent/opencode-client";
import { calibrationDatabase } from "./database";
import type { EvalCase, EvalRun } from "./database";

/**
 * Phase 2 eval runner. Given a curated case, runs BOTH the RAG-only
 * pipeline AND the ClaimKit pipeline, captures answers + confidence +
 * confidence trace, persists to eval_runs.
 *
 * Skips a (case × system) combo if a run for it already exists — the
 * runner is idempotent at the (case, system) granularity. Re-running
 * requires explicitly deleting the prior run, on purpose: we don't want
 * to silently overwrite measurements.
 *
 * The RAG answer is generated through the same code path as the eval
 * harness in claimkit-comparison.ts so the apples-to-apples comparison
 * with the existing batch eval framework holds.
 */

const RAG_SYSTEM_PROMPT =
  "You are a helpful assistant. Answer the user's question using ONLY the provided context. " +
  "If the context does not contain enough information, say so explicitly. Do not make up facts.";

export interface RunCaseResult {
  caseId: string;
  ragRun: EvalRun | null;
  claimkitRun: EvalRun | null;
  skippedRag: boolean;
  skippedClaimkit: boolean;
}

async function runRagOnly(c: EvalCase): Promise<{
  answer: string | null;
  contextTokens: number;
  processingTimeMs: number;
  errorMessage: string | null;
}> {
  const start = Date.now();
  try {
    const packet = await assembleContextPacket({
      mode: "engineering",
      query: c.query,
      sessionMessages: [],
      sessionId: `eval-${c.id}`,
      includeMemory: false,
      toolInventory: "",
      providerMaxTokens: 8192,
      toolTokens: 0,
      userId: "eval",
    });
    if (!aiClient.isConfigured()) {
      return {
        answer: null,
        contextTokens: packet.totalTokens,
        processingTimeMs: Date.now() - start,
        errorMessage: "aiClient not configured — RAG answer skipped",
      };
    }
    const contextText = packet.sections
      .map((s) => `## ${s.name}\n${s.content}`)
      .join("\n\n");
    const response = await aiClient.chat({
      messages: [
        { role: "system", content: RAG_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Context:\n${contextText}\n\nQuestion: ${c.query}\n\nAnswer:`,
        },
      ],
      temperature: 0.3,
      maxTokens: 2048,
    });
    return {
      answer: response.content ?? "",
      contextTokens: packet.totalTokens,
      processingTimeMs: Date.now() - start,
      errorMessage: null,
    };
  } catch (err) {
    return {
      answer: null,
      contextTokens: 0,
      processingTimeMs: Date.now() - start,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runClaimKit(c: EvalCase): Promise<{
  answer: string | null;
  confidence: number | null;
  confidenceTrace: unknown;
  processingTimeMs: number;
  errorMessage: string | null;
}> {
  const start = Date.now();
  try {
    if (!claimKitAdapter.isAvailable()) {
      return {
        answer: null,
        confidence: null,
        confidenceTrace: null,
        processingTimeMs: Date.now() - start,
        errorMessage: "ClaimKit adapter not available",
      };
    }
    const ck = await claimKitAdapter.query(c.query);
    return {
      answer: ck.answer,
      confidence: ck.confidence,
      confidenceTrace: ck.confidenceTrace ?? null,
      processingTimeMs: Date.now() - start,
      errorMessage: null,
    };
  } catch (err) {
    return {
      answer: null,
      confidence: null,
      confidenceTrace: null,
      processingTimeMs: Date.now() - start,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Optionally ground the RAG answer against the RAG context using
 * claimKitAdapter.ground() so hallucination rate and grounded flag get
 * persisted alongside the answer. Skips silently if grounding fails or
 * ClaimKit is unavailable — calibration analysis still works without it.
 */
async function groundRagAnswer(
  query: string,
  ragAnswer: string,
): Promise<{ hallucinationRate: number | null; grounded: boolean | null }> {
  try {
    if (!claimKitAdapter.isAvailable() || !ragAnswer.trim()) {
      return { hallucinationRate: null, grounded: null };
    }
    const packet = await assembleContextPacket({
      mode: "engineering",
      query,
      sessionMessages: [],
      sessionId: `eval-ground`,
      includeMemory: false,
      toolInventory: "",
      providerMaxTokens: 8192,
      toolTokens: 0,
      userId: "eval",
    });
    const r = await claimKitAdapter.ground({
      text: ragAnswer,
      evidence: packet.sections.map((s) => ({ title: s.name, content: s.content })),
    });
    return { hallucinationRate: r.hallucinationRate, grounded: r.grounded };
  } catch {
    return { hallucinationRate: null, grounded: null };
  }
}

/**
 * Run a single eval case. Idempotent at the (case, system) level — if a
 * run already exists for that system, this returns the existing run and
 * marks the corresponding `skipped*` flag.
 */
export async function runEvalCase(caseId: string): Promise<RunCaseResult> {
  const c = calibrationDatabase.getCase(caseId);
  if (!c) {
    return {
      caseId,
      ragRun: null,
      claimkitRun: null,
      skippedRag: false,
      skippedClaimkit: false,
    };
  }

  const existing = calibrationDatabase.getRunsForCase(caseId);
  const existingRag = existing.find((r) => r.system === "rag") ?? null;
  const existingCk = existing.find((r) => r.system === "claimkit") ?? null;

  let ragRun = existingRag;
  let claimkitRun = existingCk;

  if (!existingRag) {
    const ragResult = await runRagOnly(c);
    const ground = ragResult.answer
      ? await groundRagAnswer(c.query, ragResult.answer)
      : { hallucinationRate: null, grounded: null };
    ragRun = calibrationDatabase.addRun({
      caseId,
      system: "rag",
      answer: ragResult.answer,
      // RAG doesn't self-report a confidence value through this code
      // path; the chat LLM produces free text. We leave confidence null
      // so it doesn't pollute the calibration curve.
      confidence: null,
      confidenceTrace: null,
      hallucinationRate: ground.hallucinationRate,
      grounded: ground.grounded,
      contextTokens: ragResult.contextTokens,
      processingTimeMs: ragResult.processingTimeMs,
      errorMessage: ragResult.errorMessage,
    });
  }

  if (!existingCk) {
    const ckResult = await runClaimKit(c);
    claimkitRun = calibrationDatabase.addRun({
      caseId,
      system: "claimkit",
      answer: ckResult.answer,
      confidence: ckResult.confidence,
      confidenceTrace: ckResult.confidenceTrace,
      hallucinationRate: null,
      grounded: null,
      contextTokens: null,
      processingTimeMs: ckResult.processingTimeMs,
      errorMessage: ckResult.errorMessage,
    });
  }

  return {
    caseId,
    ragRun,
    claimkitRun,
    skippedRag: existingRag != null,
    skippedClaimkit: existingCk != null,
  };
}

/**
 * Run every case that's missing at least one system's run.
 * Sequential — not parallel, because we don't want to thrash the LLM
 * provider with parallel calls when we're trying to measure confidence
 * stability.
 */
export async function runAllUnrunCases(): Promise<{
  attempted: number;
  succeeded: number;
  errored: number;
  results: RunCaseResult[];
}> {
  const unrun = calibrationDatabase.listUnrunCases();
  const results: RunCaseResult[] = [];
  let errored = 0;
  for (const c of unrun) {
    try {
      const r = await runEvalCase(c.id);
      results.push(r);
    } catch (err) {
      errored++;
      console.error(`[EvalRunner] case ${c.id} failed:`, err);
    }
  }
  return {
    attempted: unrun.length,
    succeeded: results.length,
    errored,
    results,
  };
}
