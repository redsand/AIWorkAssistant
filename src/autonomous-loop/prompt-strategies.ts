import type { SemanticFinding } from "./semantic-review";

export type PromptStrategy =
  | "standard"
  | "rework_with_feedback"
  | "simplified"
  | "file_focused"
  | "test_first"
  | "incremental"
  | "escalate_human";

export interface PromptContext {
  issueKey: string;
  issueTitle: string;
  issueDescription: string;
  codingPrompt: string;
  affectedFiles: string[];
  previousAttempts: number;
  previousFailures: string[];
  reviewerFindings: SemanticFinding[];
  diffFromLastAttempt?: string;
  testOutput?: string;
  strategiesTried?: PromptStrategy[];
}

const STRATEGY_ORDER: PromptStrategy[] = [
  "standard",
  "rework_with_feedback",
  "file_focused",
  "test_first",
  "simplified",
  "incremental",
  "escalate_human",
];

export function selectStrategy(context: PromptContext): PromptStrategy {
  const preferred = selectPreferredStrategy(context);
  return firstUntried(preferred, context.strategiesTried ?? []);
}

export function generatePrompt(strategy: PromptStrategy, context: PromptContext): string {
  switch (strategy) {
    case "standard":
      return standardPrompt(context);
    case "rework_with_feedback":
      return reworkPrompt(context);
    case "simplified":
      return simplifiedPrompt(context);
    case "file_focused":
      return fileFocusedPrompt(context);
    case "test_first":
      return testFirstPrompt(context);
    case "incremental":
      return incrementalPrompt(context);
    case "escalate_human":
      return escalateHumanPrompt(context);
  }
}

export function detectFailurePatterns(input: {
  reworkPrompt?: string;
  testOutput?: string;
  prHadChanges?: boolean;
  reviewerFindings?: SemanticFinding[];
}): string[] {
  const failures = new Set<string>();
  const text = [input.reworkPrompt ?? "", input.testOutput ?? ""].join("\n").toLowerCase();

  if (input.prHadChanges === false || text.includes("empty pr") || text.includes("no meaningful changes") || text.includes("no changes")) {
    failures.add("EMPTY_PR");
  }

  if (input.testOutput || text.includes("test failed") || text.includes("tests failed") || text.includes("failing tests")) {
    failures.add("TESTS_FAILING");
  }

  const findings = input.reviewerFindings ?? [];
  const genericFindings = findings.filter((finding) => isGenericFinding(finding.message));
  if (
    genericFindings.length > 0 ||
    text.includes("security-related files detected") ||
    text.includes("review findings need attention")
  ) {
    failures.add("GENERIC_REVIEW_FEEDBACK");
  }

  if (text.includes("cannot find") || text.includes("could not find") || text.includes("target files")) {
    failures.add("TARGET_FILES_NOT_FOUND");
  }

  return [...failures];
}

function selectPreferredStrategy(context: PromptContext): PromptStrategy {
  if (hasConsecutiveFailures(context, 3) || context.previousAttempts >= 5) return "escalate_human";
  if (context.previousAttempts === 0) return "standard";
  if (context.previousAttempts === 1) return "rework_with_feedback";
  if (hasFailure(context, "EMPTY_PR") || hasFailure(context, "TARGET_FILES_NOT_FOUND")) return "file_focused";
  if (hasFailure(context, "TESTS_FAILING")) return "test_first";
  if (hasFailure(context, "GENERIC_REVIEW_FEEDBACK")) return "simplified";
  if (context.previousAttempts >= 3) return "incremental";
  return "rework_with_feedback";
}

function firstUntried(preferred: PromptStrategy, tried: PromptStrategy[]): PromptStrategy {
  if (preferred === "escalate_human" || !tried.includes(preferred)) return preferred;
  const preferredIndex = STRATEGY_ORDER.indexOf(preferred);
  const candidates = STRATEGY_ORDER.slice(Math.max(preferredIndex, 0)).filter((strategy) => strategy !== "standard");
  return candidates.find((strategy) => !tried.includes(strategy)) ?? "escalate_human";
}

function standardPrompt(context: PromptContext): string {
  return [
    `Issue ${context.issueKey}: ${context.issueTitle}`,
    "",
    context.issueDescription,
    "",
    context.codingPrompt,
  ].filter(Boolean).join("\n");
}

function reworkPrompt(context: PromptContext): string {
  return [
    standardPrompt(context),
    "",
    "The following issues were found:",
    formatFindings(context.reviewerFindings),
    formatFailures(context.previousFailures),
    context.diffFromLastAttempt ? `Diff from last attempt:\n${context.diffFromLastAttempt}` : "",
  ].filter(Boolean).join("\n\n");
}

function simplifiedPrompt(context: PromptContext): string {
  const file = primaryFile(context);
  const issue = primaryIssue(context);
  return [
    `Issue ${context.issueKey}: ${context.issueTitle}`,
    "",
    `Change ONLY ${file}.`,
    issue,
    "",
    "Do not refactor unrelated code. Do not add placeholder tests. Make one concrete change and stop.",
  ].join("\n");
}

function fileFocusedPrompt(context: PromptContext): string {
  const file = primaryFile(context);
  const line = primaryLine(context);
  return [
    `Issue ${context.issueKey}: ${context.issueTitle}`,
    "",
    `Open ${file}.`,
    line ? `At or near line ${line}, make the requested correction.` : "Use the file paths and line references in the coding prompt to make the requested correction.",
    "",
    "Relevant coding prompt:",
    context.codingPrompt || context.issueDescription,
    "",
    "Do not return an empty PR. If the target file is missing, inspect the repository for the renamed equivalent and change that file.",
  ].join("\n");
}

function testFirstPrompt(context: PromptContext): string {
  const issue = primaryIssue(context);
  return [
    `Issue ${context.issueKey}: ${context.issueTitle}`,
    "",
    `First, write a test that verifies: ${issue}`,
    "Run the focused test and confirm it fails for the current behavior.",
    "Then implement the smallest code change that makes the test pass.",
    "",
    context.testOutput ? `Current failing test output:\n${context.testOutput}` : "",
    context.codingPrompt,
  ].filter(Boolean).join("\n\n");
}

function incrementalPrompt(context: PromptContext): string {
  return [
    `Issue ${context.issueKey}: ${context.issueTitle}`,
    "",
    `Make the SMALLEST possible change that fixes this specific issue: ${primaryIssue(context)}`,
    `Touch only: ${filesList(context)}`,
    "",
    "After the change, run only the most relevant focused test or type-check command.",
  ].join("\n");
}

function escalateHumanPrompt(context: PromptContext): string {
  return [
    `This issue requires human intervention: ${context.issueKey} ${context.issueTitle}`,
    "",
    "Reasons:",
    formatFailures(context.previousFailures) || "- Repeated autonomous attempts did not converge.",
    "",
    "Reviewer findings:",
    formatFindings(context.reviewerFindings),
  ].join("\n");
}

function formatFindings(findings: SemanticFinding[]): string {
  if (findings.length === 0) return "- No structured reviewer findings were available.";
  return findings.map((finding) => {
    const location = `${finding.file}${finding.line ? `:${finding.line}` : ""}`;
    return `- ${finding.severity.toUpperCase()} ${finding.category} ${location}: ${finding.message}`;
  }).join("\n");
}

function formatFailures(failures: string[]): string {
  if (failures.length === 0) return "";
  return failures.map((failure) => `- ${failure}`).join("\n");
}

function primaryFile(context: PromptContext): string {
  return context.reviewerFindings.find((finding) => finding.file)?.file
    ?? context.affectedFiles[0]
    ?? extractFileFromPrompt(context.codingPrompt)
    ?? "the primary affected file";
}

function primaryLine(context: PromptContext): number | undefined {
  return context.reviewerFindings.find((finding) => finding.line)?.line;
}

function primaryIssue(context: PromptContext): string {
  return context.reviewerFindings[0]?.message
    ?? firstMeaningfulLine(context.codingPrompt)
    ?? firstMeaningfulLine(context.issueDescription)
    ?? context.issueTitle;
}

function filesList(context: PromptContext): string {
  const files = context.affectedFiles.length > 0 ? context.affectedFiles : [primaryFile(context)];
  return files.join(", ");
}

function firstMeaningfulLine(value: string): string | undefined {
  return value.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
}

function extractFileFromPrompt(prompt: string): string | undefined {
  return prompt.match(/[\w./-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|rb|yml|yaml|json|md)\b/)?.[0];
}

function hasFailure(context: PromptContext, failure: string): boolean {
  return context.previousFailures.includes(failure);
}

function hasConsecutiveFailures(context: PromptContext, count: number): boolean {
  if (context.previousFailures.length < count) return false;
  const recent = context.previousFailures.slice(-count);
  return recent.every((failure) => failure === recent[0]);
}

function isGenericFinding(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("security-related files detected")
    || normalized.includes("needs review")
    || normalized.includes("review required")
    || normalized.length < 25;
}
