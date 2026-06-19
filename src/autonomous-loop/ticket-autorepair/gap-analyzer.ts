/**
 * Gap analyzer — diagnoses WHY the aicoder ↔ reviewer loop is stuck.
 *
 * Input: original ticket + last N review findings + last N coder diffs +
 * convergence summary + prompt strategies already tried.
 * Output: structured RepairDiagnosis identifying the root cause and
 * pointing the rewriter at the specific changes that will unblock the
 * loop.
 *
 * This is a single LLM call (no tools) because we want a deterministic
 * artifact, not a multi-step investigation. The diagnosis JSON is also
 * persisted for the audit trail.
 */

import { aiClient } from "../../agent/opencode-client";
import type { ChatMessage } from "../../agent/opencode-client";
import { env } from "../../config/env";

export interface ReviewerFindingSummary {
  roundNumber: number;
  file?: string;
  severity?: string;
  category?: string;
  message?: string;
}

export interface CoderRoundSummary {
  roundNumber: number;
  /** Changed files, e.g. ["src/foo.ts", "src/bar.ts"]. */
  changedFiles: string[];
  /** Brief commit-message-style description of what the coder did. */
  diffStat?: string;
  /** True when this round produced no actual code changes. */
  empty: boolean;
}

export interface GapAnalysisInput {
  issueKey: string;
  /** The full original ticket body the agents have been working from. */
  originalTicketText: string;
  /** Optional title separate from the body. */
  originalTitle?: string;
  reviewerFindings: ReviewerFindingSummary[];
  coderRounds: CoderRoundSummary[];
  /** The convergence stop reason that triggered this autorepair. */
  convergenceReason: string;
  /** Human-readable summary from formatConvergenceReport(). */
  convergenceSummary?: string;
  /** Prompt strategies the orchestrator has already tried. */
  promptStrategiesTried: string[];
  /** Which autorepair attempt this is (1-indexed). */
  attemptNumber: number;
}

/** The structured diagnosis output the rewriter consumes. */
export interface RepairDiagnosis {
  /** One-sentence root cause statement. */
  rootCause: string;
  /** "scope_mismatch" | "missing_constraints" | "ambiguous_requirement" |
   * "conflicting_findings" | "unreachable_acceptance" | "tooling_gap" | "other"
   */
  category: string;
  /** What the reviewer keeps asking for. */
  reviewerExpectation: string;
  /** What the coder keeps producing. */
  coderInterpretation: string;
  /** Where they're talking past each other in plain language. */
  conflictDescription: string;
  /** Specific information missing from the ticket the coder needed. */
  missingInformation: string[];
  /** Hidden assumptions the original ticket made. */
  hiddenAssumptions: string[];
  /** Concrete acceptance criteria the rewriter should add (3-7 bullets). */
  suggestedAcceptanceCriteria: string[];
  /** Things the rewriter must explicitly mark as out-of-scope. */
  outOfScope: string[];
  /** Confidence in this diagnosis: "low" | "medium" | "high". */
  confidence: string;
  /** Free-form notes for the audit trail. */
  notes?: string;
}

function clampList<T>(list: T[], max: number): T[] {
  if (list.length <= max) return list;
  return list.slice(-max);
}

function buildSystemPrompt(): string {
  return [
    "You are the IR (incident response) lead for an autonomous coding pipeline.",
    "The aicoder agent makes code changes; the reviewer agent grades them. They",
    "have been bouncing the same ticket between each other without convergence.",
    "Your job is to identify WHY the loop is stuck.",
    "",
    "You are NOT asked to fix the code yourself. You produce a structured",
    "diagnosis that another agent will use to rewrite the ticket.",
    "",
    "Apply strict evidence discipline:",
    "- Every claim about reviewer/coder behaviour must reference the inputs.",
    "- Do NOT invent missing information that is actually in the ticket.",
    "- If the ticket is well-specified and the gap is purely an agent capability",
    "  issue, say so honestly — your confidence MUST be 'low' in that case.",
    "",
    "Respond with ONE JSON object, no prose, no markdown fences. Schema:",
    "{",
    '  "rootCause": string,                       // single sentence',
    '  "category": "scope_mismatch" | "missing_constraints" | "ambiguous_requirement" | "conflicting_findings" | "unreachable_acceptance" | "tooling_gap" | "other",',
    '  "reviewerExpectation": string,',
    '  "coderInterpretation": string,',
    '  "conflictDescription": string,',
    '  "missingInformation": string[],',
    '  "hiddenAssumptions": string[],',
    '  "suggestedAcceptanceCriteria": string[],   // 3-7 testable bullets',
    '  "outOfScope": string[],',
    '  "confidence": "low" | "medium" | "high",',
    '  "notes": string',
    "}",
  ].join("\n");
}

function buildUserPrompt(input: GapAnalysisInput): string {
  // Cap inputs so we never blow the context window on huge tickets / round
  // counts. Most-recent rounds carry the most diagnostic value.
  const findings = clampList(input.reviewerFindings, 40);
  const rounds = clampList(input.coderRounds, 12);
  const stratList = input.promptStrategiesTried.length
    ? input.promptStrategiesTried.join(", ")
    : "(none recorded)";

  return [
    `# Issue under autorepair: ${input.issueKey}`,
    `# Autorepair attempt: #${input.attemptNumber}`,
    "",
    "## Original ticket",
    input.originalTitle ? `**Title:** ${input.originalTitle}` : "",
    "**Body:**",
    "```",
    input.originalTicketText.trim() || "(empty)",
    "```",
    "",
    "## Convergence trigger",
    `**Stop reason:** ${input.convergenceReason}`,
    input.convergenceSummary ? "" : "",
    input.convergenceSummary ? input.convergenceSummary.trim() : "",
    "",
    "## Reviewer findings across rounds (most recent first)",
    ...findings.reverse().map((f, i) =>
      `${i + 1}. round=${f.roundNumber} severity=${f.severity ?? "?"} category=${f.category ?? "?"} file=${f.file ?? "?"}: ${f.message ?? ""}`,
    ),
    "",
    "## Coder rounds (most recent first)",
    ...rounds.reverse().map((r) =>
      `- round=${r.roundNumber} empty=${r.empty} files=[${r.changedFiles.slice(0, 8).join(", ")}${r.changedFiles.length > 8 ? ", …" : ""}] diff=${r.diffStat ?? "?"}`,
    ),
    "",
    "## Prompt strategies already tried",
    stratList,
    "",
    "Now produce the diagnosis JSON.",
  ].filter((s) => s !== "").join("\n");
}

function parseDiagnosis(raw: string): RepairDiagnosis {
  // Strip common code-fence wrappers reasoning models sometimes emit even
  // when told not to. Tolerate ```json fences and trailing prose.
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```[a-zA-Z0-9]*\n?/, "").replace(/```\s*$/, "");
  }
  // Pull the first { ... } block.
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  const parsed = JSON.parse(cleaned) as Partial<RepairDiagnosis>;
  // Coerce to known shape with defaults so downstream rewriter never crashes
  // on a missing field.
  return {
    rootCause: String(parsed.rootCause ?? "unspecified").trim(),
    category: String(parsed.category ?? "other").trim(),
    reviewerExpectation: String(parsed.reviewerExpectation ?? "").trim(),
    coderInterpretation: String(parsed.coderInterpretation ?? "").trim(),
    conflictDescription: String(parsed.conflictDescription ?? "").trim(),
    missingInformation: Array.isArray(parsed.missingInformation)
      ? parsed.missingInformation.map((s) => String(s).trim()).filter(Boolean)
      : [],
    hiddenAssumptions: Array.isArray(parsed.hiddenAssumptions)
      ? parsed.hiddenAssumptions.map((s) => String(s).trim()).filter(Boolean)
      : [],
    suggestedAcceptanceCriteria: Array.isArray(parsed.suggestedAcceptanceCriteria)
      ? parsed.suggestedAcceptanceCriteria.map((s) => String(s).trim()).filter(Boolean)
      : [],
    outOfScope: Array.isArray(parsed.outOfScope)
      ? parsed.outOfScope.map((s) => String(s).trim()).filter(Boolean)
      : [],
    confidence: ["low", "medium", "high"].includes(String(parsed.confidence))
      ? String(parsed.confidence)
      : "low",
    notes: parsed.notes ? String(parsed.notes).trim() : undefined,
  };
}

/**
 * Run the gap-analysis LLM call. Throws on unrecoverable failure (no
 * silent fallback — the orchestrator escalates instead of pretending).
 */
export async function analyzeGap(input: GapAnalysisInput): Promise<RepairDiagnosis> {
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
      temperature: 0.1,
      top_p: 0.9,
      model,
      signal: controller.signal,
    });
    const content = (resp.content ?? "").trim();
    if (!content) {
      throw new Error("Gap analyzer returned empty response");
    }
    return parseDiagnosis(content);
  } finally {
    clearTimeout(timer);
  }
}
