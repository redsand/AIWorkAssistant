/**
 * Ticket rewriter — turns a RepairDiagnosis into a replacement ticket body.
 *
 * The rewriter NEVER discards the user-original content silently. It
 * produces a new body that preserves the original problem statement
 * verbatim inside a quoted block, then adds:
 *   - Clarified problem statement (rewriter's interpretation)
 *   - Acceptance criteria (testable bullets from the diagnosis)
 *   - Out-of-scope section (so the coder doesn't drift)
 *   - "Previously attempted (do not repeat)" with strategies + finding
 *     summaries from the convergence trail
 *   - Audit footer with autorepair version + diagnosis confidence
 *
 * The model is constrained to faithful rewriting only — no new
 * requirements, no fabricated context, no speculative TODOs.
 */

import { createHash } from "crypto";
import { aiClient } from "../../agent/opencode-client";
import type { ChatMessage } from "../../agent/opencode-client";
import { env } from "../../config/env";
import type { RepairDiagnosis } from "./gap-analyzer";

export interface TicketRewriteInput {
  issueKey: string;
  originalTitle?: string;
  originalBody: string;
  diagnosis: RepairDiagnosis;
  /** Which autorepair attempt this is (1-indexed). */
  attemptNumber: number;
  /** Strategies the previous rounds already tried (informs "do not repeat"). */
  promptStrategiesTried: string[];
  /** Optional list of reviewer-finding bullets to surface in "do not repeat". */
  recurringFindings: string[];
}

export interface RewrittenTicket {
  /** New body to post to the source system. */
  body: string;
  /** Optional new title (only set when materially clearer). */
  title?: string;
  /** Hash of the original body for revert / change-detection. */
  originalBodyHash: string;
  /** One-line summary suitable for a comment on the ticket. */
  changeSummary: string;
  /** Markers we tag in the body so we can recognize autorepair output later. */
  marker: string;
}

export const AUTOREPAIR_BODY_MARKER = "<!-- AUTOREPAIR-V1 -->";
export const AUTOREPAIR_ORIGINAL_MARKER = "<!-- AUTOREPAIR-V1-ORIGINAL-START -->";
export const AUTOREPAIR_ORIGINAL_END_MARKER = "<!-- AUTOREPAIR-V1-ORIGINAL-END -->";

function hashBody(body: string): string {
  return createHash("sha1").update(body).digest("hex").slice(0, 16);
}

function buildSystemPrompt(): string {
  return [
    "You are a senior technical writer cleaning up an ambiguous ticket for an",
    "autonomous coding pipeline. Two agents (coder + reviewer) have been stuck",
    "in a loop on this ticket. A separate analyzer has produced a diagnosis.",
    "",
    "Your job: rewrite ONLY the clarified problem statement. Do not invent new",
    "requirements. Do not add features. Stay faithful to what the original",
    "ticket asked for, surfacing the diagnosis's recommendations explicitly.",
    "",
    "Hard rules:",
    "1. Output PLAIN MARKDOWN — no JSON, no YAML, no code fences around the",
    "   whole response.",
    "2. Start with a one-line summary describing the bug or feature.",
    "3. Use these section headers verbatim, in order:",
    "   ## Problem statement",
    "   ## Acceptance criteria",
    "   ## Out of scope",
    "   ## Constraints and conventions",
    "4. Acceptance criteria must be testable bullets (numbered).",
    "5. Out of scope must be explicit so the coder cannot drift.",
    "6. Do NOT include the original ticket body, the 'previously attempted'",
    "   section, or any audit footer — the orchestrator appends those.",
    "7. Keep it under 800 words. Brevity > thoroughness.",
  ].join("\n");
}

function buildUserPrompt(input: TicketRewriteInput): string {
  const d = input.diagnosis;
  const parts = [
    `# Ticket to rewrite: ${input.issueKey}`,
    input.originalTitle ? `**Original title:** ${input.originalTitle}` : "",
    "",
    "## Original body (for reference — do NOT copy verbatim, but stay faithful)",
    "```",
    input.originalBody.trim() || "(empty)",
    "```",
    "",
    "## Diagnosis from gap-analyzer",
    `- Root cause: ${d.rootCause}`,
    `- Category: ${d.category}`,
    `- Reviewer expectation: ${d.reviewerExpectation}`,
    `- Coder interpretation: ${d.coderInterpretation}`,
    `- Conflict: ${d.conflictDescription}`,
    `- Missing information identified: ${d.missingInformation.join("; ") || "(none)"}`,
    `- Hidden assumptions identified: ${d.hiddenAssumptions.join("; ") || "(none)"}`,
    `- Suggested acceptance criteria (use these as the starting set, refine as needed):`,
    ...d.suggestedAcceptanceCriteria.map((c, i) => `   ${i + 1}. ${c}`),
    `- Out-of-scope items the rewriter MUST mark:`,
    ...d.outOfScope.map((c) => `   - ${c}`),
    `- Diagnosis confidence: ${d.confidence}`,
    "",
    "Now produce the clarified ticket using the structure in the system prompt.",
  ];
  return parts.filter((s) => s !== "").join("\n");
}

function buildFinalBody(
  input: TicketRewriteInput,
  modelOutput: string,
): RewrittenTicket {
  const originalHash = hashBody(input.originalBody);
  // Strip leading fences / code blocks the model may have wrapped anyway.
  let main = modelOutput.trim();
  if (main.startsWith("```")) {
    main = main.replace(/^```[a-zA-Z0-9]*\n?/, "").replace(/```\s*$/, "");
  }

  const previouslyAttempted: string[] = [];
  if (input.promptStrategiesTried.length) {
    previouslyAttempted.push(
      "Prompt strategies already tried (do not re-issue the same approach):",
    );
    for (const s of input.promptStrategiesTried) {
      previouslyAttempted.push(`- ${s}`);
    }
  }
  if (input.recurringFindings.length) {
    if (previouslyAttempted.length) previouslyAttempted.push("");
    previouslyAttempted.push(
      "Reviewer findings that recurred across rounds (treat these as the gap to close):",
    );
    for (const f of input.recurringFindings.slice(0, 10)) {
      previouslyAttempted.push(`- ${f}`);
    }
  }

  const audit = [
    "",
    "---",
    `*Autorepaired by ai-assist-tim · attempt #${input.attemptNumber} · diagnosis confidence: ${input.diagnosis.confidence} · category: ${input.diagnosis.category}*`,
    `*Original body preserved below (do not edit) — to revert, restore the section between the AUTOREPAIR-V1-ORIGINAL markers.*`,
    "",
    AUTOREPAIR_ORIGINAL_MARKER,
    "<details><summary>Original ticket body</summary>",
    "",
    "```",
    input.originalBody.trim() || "(empty)",
    "```",
    "",
    "</details>",
    AUTOREPAIR_ORIGINAL_END_MARKER,
  ].join("\n");

  const sections = [
    AUTOREPAIR_BODY_MARKER,
    main,
  ];
  if (previouslyAttempted.length) {
    sections.push("", "## Previously attempted (do not repeat)", ...previouslyAttempted);
  }
  sections.push(audit);

  const body = sections.join("\n");
  const changeSummary =
    `Autorepair v1 attempt #${input.attemptNumber}: ${input.diagnosis.rootCause}`.slice(0, 240);

  return {
    body,
    title: undefined,
    originalBodyHash: originalHash,
    changeSummary,
    marker: AUTOREPAIR_BODY_MARKER,
  };
}

/** True when the given body has already been autorepaired (so we don't
 *  treat the rewritten body as the "original" on the next attempt). */
export function isAutorepairedBody(body: string): boolean {
  return body.includes(AUTOREPAIR_BODY_MARKER);
}

/** Extract the original-body slice from a previously autorepaired ticket so
 *  the next attempt has the user's words, not the rewritten version. */
export function extractOriginalBody(body: string): string | undefined {
  const start = body.indexOf(AUTOREPAIR_ORIGINAL_MARKER);
  const end = body.indexOf(AUTOREPAIR_ORIGINAL_END_MARKER);
  if (start < 0 || end < 0 || end <= start) return undefined;
  const slice = body.slice(start + AUTOREPAIR_ORIGINAL_MARKER.length, end);
  // The slice is wrapped in a <details>...```...```...</details>. Pull the
  // inner code block.
  const codeBlock = slice.match(/```\s*\n([\s\S]*?)\n```/);
  return codeBlock ? codeBlock[1].trim() : slice.trim();
}

export async function rewriteTicket(input: TicketRewriteInput): Promise<RewrittenTicket> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: buildUserPrompt(input) },
  ];
  const model = env.AUTOREPAIR_MODEL || env.AICODER_MODEL || undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.AUTOREPAIR_TIMEOUT_MS);
  try {
    const resp = await aiClient.chat({
      messages,
      temperature: 0.2,
      top_p: 0.9,
      model,
      signal: controller.signal,
    });
    const content = (resp.content ?? "").trim();
    if (!content) {
      throw new Error("Ticket rewriter returned empty response");
    }
    return buildFinalBody(input, content);
  } finally {
    clearTimeout(timer);
  }
}
