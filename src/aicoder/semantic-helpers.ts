/**
 * Pure helpers for parsing semantic-finding payloads from the reviewer's
 * structured output. Extracted from src/aicoder.ts (2026-06-25).
 *
 * Tolerant of legacy severity/category names — older reviewers used
 * "blocker/major/minor/info" before the schema normalized to
 * critical/high/medium/low. Maps unknowns to safe defaults rather than
 * dropping the finding entirely.
 */
import type { SemanticFinding } from "../autonomous-loop/semantic-review";
import type { PromptStrategy } from "../autonomous-loop/prompt-strategies";

const PROMPT_STRATEGIES: PromptStrategy[] = [
  "standard",
  "rework_with_feedback",
  "simplified",
  "file_focused",
  "test_first",
  "incremental",
  "escalate_human",
];

export function isPromptStrategy(value: string): value is PromptStrategy {
  return PROMPT_STRATEGIES.includes(value as PromptStrategy);
}

export function normalizeSemanticSeverity(
  value: string | undefined,
): SemanticFinding["severity"] {
  switch (value) {
    case "critical":
    case "high":
    case "medium":
    case "low":
      return value;
    case "blocker":
      return "critical";
    case "major":
      return "high";
    case "minor":
    case "info":
      return "low";
    default:
      return "high";
  }
}

export function normalizeSemanticCategory(
  value: string | undefined,
): SemanticFinding["category"] {
  switch (value) {
    case "security":
    case "correctness":
    case "testing":
    case "performance":
    case "style":
      return value;
    case "qa":
      return "testing";
    default:
      return "correctness";
  }
}

/**
 * Extract source-file paths mentioned in arbitrary text. Used by the
 * coverage/test-failure heuristics to figure out which files changed
 * (or which files the failing test mentions). Matches known code-file
 * extensions only; deliberately conservative to avoid pulling in
 * coincidental dotted strings.
 */
export function extractFilesFromText(text: string): string[] {
  const files = new Set<string>();
  const fileRegex =
    /(?:^|\s|`)([\w./-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|rb|yml|yaml|json|md))\b/gim;
  let match: RegExpExecArray | null;
  while ((match = fileRegex.exec(text)) !== null) {
    files.add(match[1]);
  }
  return [...files];
}
