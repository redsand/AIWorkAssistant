import { assembleContextPacket } from "../../context-engine/context-packet";
import { claimKitAdapter } from "../../context-engine/adapters/claimkit-adapter";
import { aiClient } from "../../agent/opencode-client";
import type { ComparisonRunResult, ComparisonCase } from "./reportTypes";
import type { ComparisonEvalCategory } from "../types";
import { evaluateThresholds, DEFAULT_THRESHOLDS } from "./thresholds";
import { saveBatchComparison } from "../../comparison-runs/auto-capture";

export interface ComparisonConfig {
  queries: string[];
  categories: ComparisonEvalCategory[];
  thresholds?: typeof DEFAULT_THRESHOLDS;
  generateRagAnswers?: boolean;
}

export async function runClaimKitComparison(
  config: ComparisonConfig,
): Promise<ComparisonRunResult> {
  const ckAvailable = await claimKitAdapter.initialize();
  const cases: ComparisonCase[] = [];

  for (const query of config.queries) {
    // Run existing RAG pipeline (context assembly)
    const ragStart = Date.now();
    const ragPacket = await assembleContextPacket({
      mode: "engineering",
      query,
      sessionMessages: [],
      sessionId: "eval",
      includeMemory: false,
      toolInventory: "",
      providerMaxTokens: 8192,
      toolTokens: 0,
      userId: "eval",
    });
    const ragMs = Date.now() - ragStart;

    // Optionally generate a real RAG answer so we can measure hallucination via ClaimKit ground()
    let ragAnswer: string | null = null;
    let ragHallucinationRate: number | null = null;
    let ragGrounded: boolean | null = null;

    if (config.generateRagAnswers !== false && aiClient.isConfigured()) {
      try {
        ragAnswer = await generateRagAnswer(query, ragPacket);
      } catch (err) {
        console.warn(`[ClaimKit Comparison] RAG answer generation failed: ${query}`, err);
      }
    }

    if (ragAnswer && ckAvailable) {
      try {
        const groundResult = await claimKitAdapter.ground({
          text: ragAnswer,
          evidence: ragPacket.sections.map((s) => ({
            title: s.name,
            content: s.content,
          })),
        });
        ragHallucinationRate = groundResult.hallucinationRate;
        ragGrounded = groundResult.grounded;
      } catch (err) {
        console.warn(`[ClaimKit Comparison] Grounding failed: ${query}`, err);
      }
    }

    // Run ClaimKit pipeline
    let ckResult = null;
    let ckMs = 0;
    if (ckAvailable) {
      const ckStart = Date.now();
      try {
        ckResult = await claimKitAdapter.query(query);
        ckMs = Date.now() - ckStart;
      } catch (err) {
        console.warn(`[ClaimKit Comparison] Query failed: ${query}`, err);
      }
    }

    // Truthfulness-first winner determination
    const overallWinner = determineOverallWinner(ckResult, ragHallucinationRate, ragGrounded);

    cases.push({
      query,
      category: categorizeQuery(query, config.categories),
      overallWinner,
      rag: {
        contextTokens: ragPacket.totalTokens,
        sections: ragPacket.sections.length,
        processingTimeMs: ragMs,
        hallucinationRate: ragHallucinationRate,
        grounded: ragGrounded,
      },
      claimkit: ckResult
        ? {
            confidence: ckResult.confidence,
            answerability: ckResult.answerability,
            claimCount: ckResult.metadata.claimCount,
            processingTimeMs: ckMs,
            contradictions: ckResult.contradictions.length,
          }
        : null,
    });
  }

  // Aggregate results
  const totalCases = cases.length;
  const claimKitWins = cases.filter((c) => c.overallWinner === "claimkit").length;
  const ragWins = cases.filter((c) => c.overallWinner === "rag").length;
  const ties = cases.filter((c) => c.overallWinner === "tie").length;

  const result: ComparisonRunResult = {
    totalCases,
    cases,
    aggregate: {
      wins: { claimkit: claimKitWins, rag: ragWins, tie: ties },
      claimkit: {
        mean: aggregateClaimKitStats(cases),
      },
      rag: {
        mean: aggregateRagStats(cases),
      },
    },
  };

  result.thresholdEvaluation = evaluateThresholds(
    result,
    config.thresholds ?? DEFAULT_THRESHOLDS,
  );

  saveBatchComparison(result, `Batch comparison: ${config.queries.length} queries`);

  return result;
}

// ── RAG answer generation ─────────────────────────────────────────────────

async function generateRagAnswer(query: string, packet: Awaited<ReturnType<typeof assembleContextPacket>>): Promise<string> {
  const contextText = packet.sections.map((s) => `## ${s.name}\n${s.content}`).join("\n\n");
  const messages = [
    {
      role: "system" as const,
      content:
        "You are a helpful assistant. Answer the user's question using ONLY the provided context. If the context does not contain enough information, say so explicitly. Do not make up facts.",
    },
    {
      role: "user" as const,
      content: `Context:\n${contextText}\n\nQuestion: ${query}\n\nAnswer:`,
    },
  ];
  const response = await aiClient.chat({ messages, temperature: 0.3, maxTokens: 2048 });
  return response.content ?? "";
}

// ── Truthfulness-first winner determination ───────────────────────────────

function determineOverallWinner(
  ck: Awaited<ReturnType<typeof claimKitAdapter.query>> | null,
  ragHallucinationRate: number | null,
  ragGrounded: boolean | null,
): "rag" | "claimkit" | "tie" {
  // RAG hallucinated? ClaimKit wins by default — honest abstention beats fabrication.
  if (ragHallucinationRate !== null && ragHallucinationRate > 0) return "claimkit";

  // ClaimKit unavailable but RAG fully grounded
  if (!ck && ragGrounded === true) return "rag";
  if (!ck) return "tie";

  // ClaimKit has strong, grounded confidence
  if (ck.confidence > 0.5 && (ck.answerability === "answerable" || ck.answerability === "partially-answerable")) return "claimkit";

  // ClaimKit abstains honestly, RAG is fully grounded
  if (ck.answerability === "not_answerable" && ragGrounded === true) return "tie";

  // ClaimKit abstains, RAG hallucinated or we don't know
  if (ck.answerability === "not_answerable" && (ragGrounded === false || ragGrounded === null)) return "claimkit";

  // Low-confidence ClaimKit vs grounded RAG: tie (RAG did its job, CK was uncertain)
  if (ck.confidence < 0.3 && ragGrounded === true) return "tie";

  return "tie";
}

function categorizeQuery(
  query: string,
  categories: ComparisonEvalCategory[],
): ComparisonEvalCategory {
  const lower = query.toLowerCase();
  const determined = ((): ComparisonEvalCategory => {
    if (lower.includes("build") || lower.includes("process") || lower.includes("plan") || lower.includes("workflow") || lower.includes("methodology") || lower.includes("assessment") || lower.includes("calculate") || lower.includes("determine") || lower.includes("create") || lower.includes("design") || lower.includes("feasibility") || lower.includes("evaluate") || lower.includes("measure") || lower.includes("framework") || lower.includes("roadmap") || lower.includes("strategy")) return "planning_synthesis";
    if (lower.includes("code") || lower.includes("file") || lower.includes("function")) return "code_retrieval";
    if (lower.includes("who") || lower.includes("person") || lower.includes("owner")) return "entity_linking";
    if (lower.includes("when") || lower.includes("date") || lower.includes("last")) return "staleness";
    if (lower.includes("cite") || lower.includes("source") || lower.includes("reference")) return "citation_laundering";
    return "direct_fact";
  })();
  return categories.includes(determined) ? determined : (categories[0] ?? determined);
}

function aggregateClaimKitStats(cases: ComparisonCase[]) {
  const withCk = cases.filter((c) => c.claimkit !== null);
  if (withCk.length === 0) return { confidence: 0, answerabilityRate: 0, avgClaims: 0, avgTimeMs: 0 };
  return {
    confidence: withCk.reduce((s, c) => s + (c.claimkit?.confidence ?? 0), 0) / withCk.length,
    answerabilityRate:
      withCk.filter((c) => c.claimkit?.answerability === "answerable").length / withCk.length,
    avgClaims: withCk.reduce((s, c) => s + (c.claimkit?.claimCount ?? 0), 0) / withCk.length,
    avgTimeMs: withCk.reduce((s, c) => s + (c.claimkit?.processingTimeMs ?? 0), 0) / withCk.length,
  };
}

function aggregateRagStats(cases: ComparisonCase[]) {
  if (cases.length === 0) return { avgTokens: 0, avgSections: 0, avgTimeMs: 0, hallucinationRate: 0, groundedRate: 0 };
  const withH = cases.filter((c) => c.rag.hallucinationRate !== null);
  return {
    avgTokens: cases.reduce((s, c) => s + c.rag.contextTokens, 0) / cases.length,
    avgSections: cases.reduce((s, c) => s + c.rag.sections, 0) / cases.length,
    avgTimeMs: cases.reduce((s, c) => s + c.rag.processingTimeMs, 0) / cases.length,
    hallucinationRate: withH.length > 0 ? withH.reduce((s, c) => s + (c.rag.hallucinationRate ?? 0), 0) / withH.length : 0,
    groundedRate: withH.length > 0 ? withH.filter((c) => c.rag.grounded).length / withH.length : 0,
  };
}
