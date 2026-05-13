import { getProvider } from "../agent/providers/factory";
import type { ChatMessage } from "../agent/providers/types";

export interface SemanticReviewConfig {
  model: string;
  maxTokens: number;
  timeoutMs: number;
  includeDiff: boolean;
  includeIssueContext: boolean;
}

export interface SemanticFinding {
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: "security" | "correctness" | "testing" | "performance" | "style";
  file: string;
  line?: number;
  message: string;
  suggestedFix?: string;
}

export interface SemanticReviewResult {
  findings: SemanticFinding[];
  summary: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  recommendation: "approve" | "request_changes" | "reject";
}

export interface SpecificityValidationResult {
  valid: boolean;
  reason?: string;
}

export function defaultSemanticReviewConfig(): SemanticReviewConfig {
  return {
    model: "glm-5",
    maxTokens: 16000,
    timeoutMs: 120000,
    includeDiff: true,
    includeIssueContext: true,
  };
}

const SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);
const CATEGORIES = new Set(["security", "correctness", "testing", "performance", "style"]);
const RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);
const RECOMMENDATIONS = new Set(["approve", "request_changes", "reject"]);

const DEFAULT_RESULT: SemanticReviewResult = {
  findings: [],
  summary: "No semantic issues found.",
  riskLevel: "low",
  recommendation: "approve",
};

const CONCURRENCY_ANTI_PATTERNS: Array<{
  pattern: RegExp;
  description: string;
  severity: SemanticFinding["severity"];
}> = [
  { pattern: /self\.\w+\[/, description: "Dictionary access without visible lock", severity: "medium" },
  { pattern: /with self\._\w+lock/, description: "Lock usage — verify scope covers all shared state access", severity: "info" },
  { pattern: /async def.*self\./, description: "Async method accessing instance state — verify thread safety", severity: "medium" },
  { pattern: /global\s+\w+/, description: "Global state modification", severity: "high" },
];

export function hashFinding(finding: SemanticFinding): string {
  return [
    finding.severity.toLowerCase(),
    finding.category.toLowerCase(),
    finding.file.toLowerCase().trim(),
    normalizeMessage(finding.message),
  ].join(":");
}

export function validateSpecificity(finding: SemanticFinding): SpecificityValidationResult {
  if (!finding.file || finding.file === "unknown") {
    return { valid: false, reason: "Finding must specify a file" };
  }

  if (finding.severity === "critical" && !finding.message.toLowerCase().includes("line") && !finding.line) {
    return { valid: false, reason: "Critical findings must specify a line number or range" };
  }

  if (finding.message.length < 20) {
    return { valid: false, reason: "Finding message is too short to be actionable" };
  }

  const genericPatterns = [
    /security.related files detected/i,
    /review.*carefully/i,
    /general concern/i,
    /potential issue/i,
  ];

  for (const pattern of genericPatterns) {
    if (pattern.test(finding.message)) {
      return { valid: false, reason: "Finding is too generic — must be specific and actionable" };
    }
  }

  return { valid: true };
}

export function normalizeMessage(message: string): string {
  const dataRaceFile = message
    .toLowerCase()
    .match(/data race.*?([\w-]+\.(?:py|ts|js|tsx|jsx))/i)?.[1];
  if (dataRaceFile) {
    return `data_race_${dataRaceFile.replace(/\.(?:py|ts|js|tsx|jsx)$/i, "")}`;
  }

  const withoutVariables = message
    .toLowerCase()
    .replace(/\b[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\b/g, "")
    .replace(/\b[a-z_][a-z0-9_]*\b(?=\s+(?:is|are|was|were|outside|inside|under|without|with)\b)/g, "")
    .replace(/\bline\s+\d+\b/g, "line")
    .replace(/\d+/g, "")
    .replace(/[^a-z0-9./-]+/g, " ")
    .trim()
    .replace(/\s+/g, "_");

  return withoutVariables
    .replace(/data_race.*?([\w-]+\.(?:py|ts|js|tsx|jsx))/i, "data_race_$1")
    .replace(/\.(?:py|ts|js|tsx|jsx)\b/g, "");
}

export async function semanticReview(
  diff: string,
  issueContext: string,
  config: SemanticReviewConfig,
): Promise<SemanticReviewResult> {
  const provider = getProvider();
  const messages = buildMessages(diff, issueContext, config);
  const response = await withTimeout(
    provider.chat({
      model: config.model,
      temperature: 0,
      top_p: 0.1,
      messages,
    }),
    config.timeoutMs,
  );

  const parsed = parseSemanticReviewResponse(response.content);
  const staticFindings = analyzeThreadSafety(diff);
  const findings = dedupeFindings([...parsed.findings, ...staticFindings]);

  return {
    ...parsed,
    findings,
    riskLevel: inferRiskLevel(findings),
    recommendation: parsed.recommendation === "approve" ? inferRecommendation(findings) : parsed.recommendation,
  };
}

export function analyzeThreadSafety(diff: string): SemanticFinding[] {
  const findings: SemanticFinding[] = [];
  const files = parseDiffFiles(diff);

  for (const file of files) {
    if (!file.path.endsWith(".py")) continue;

    const addedLines = file.lines.filter((line) => line.added);
    const lockLines = addedLines.filter((line) => /with self\._\w*lock\b/.test(line.content));
    const hasVisibleLock = lockLines.length > 0;
    const touchesSharedState = addedLines.some((line) => /self\.\w+/.test(line.content));

    if (hasVisibleLock && touchesSharedState) {
      const lockLine = lockLines[0];
      findings.push({
        severity: "info",
        category: "correctness",
        file: file.path,
        line: lockLine.newLine,
        message: "Thread Safety: lock usage detected; verify the lock scope covers all shared state access.",
      });
    }

    const dualWriteLines = addedLines.filter((line) =>
      /legacy|run_state|case_context|context/i.test(line.content) &&
      /self\.\w+/.test(line.content) &&
      /=|\.update\(|\.setdefault\(|\.append\(/.test(line.content),
    );
    const hasLegacyWrite = dualWriteLines.some((line) => /legacy|run_state/i.test(line.content));
    const hasContextWrite = dualWriteLines.some((line) => /context|case_context/i.test(line.content));
    if (hasLegacyWrite && hasContextWrite) {
      const firstLine = dualWriteLines[0];
      findings.push({
        severity: "critical",
        category: "correctness",
        file: file.path,
        line: firstLine.newLine,
        message: `Thread Safety: dual-write pattern near line ${firstLine.newLine ?? "unknown"} updates legacy and context state; confirm both writes are atomic under the same lock.`,
        suggestedFix: "Move both writes under the same lock or replace the dual-write with a single authoritative state update.",
      });
      continue;
    }

    for (const line of addedLines) {
      for (const antiPattern of CONCURRENCY_ANTI_PATTERNS) {
        if (!antiPattern.pattern.test(line.content)) continue;
        if (antiPattern.severity === "info" && hasVisibleLock) continue;

        if (antiPattern.description === "Dictionary access without visible lock" && hasVisibleLock) {
          continue;
        }

        const severity = antiPattern.description === "Dictionary access without visible lock"
          ? "high"
          : antiPattern.severity;
        findings.push({
          severity,
          category: "correctness",
          file: file.path,
          line: line.newLine,
          message: `Thread Safety: ${antiPattern.description} at line ${line.newLine ?? "unknown"}; lock correctness cannot be confirmed from this diff.`,
          suggestedFix: severity === "high" ? "Guard the shared state access with the appropriate lock or make the operation atomic." : undefined,
        });
      }
    }
  }

  return dedupeFindings(findings);
}

export function parseSemanticReviewResponse(content: string): SemanticReviewResult {
  const parsed = parseJsonObject(content);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Semantic review response did not contain a JSON object");
  }

  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.map(normalizeFinding).filter((finding): finding is SemanticFinding => finding !== null)
    : [];

  const riskLevel = typeof parsed.riskLevel === "string" && RISK_LEVELS.has(parsed.riskLevel)
    ? parsed.riskLevel as SemanticReviewResult["riskLevel"]
    : inferRiskLevel(findings);

  const recommendation = typeof parsed.recommendation === "string" && RECOMMENDATIONS.has(parsed.recommendation)
    ? parsed.recommendation as SemanticReviewResult["recommendation"]
    : inferRecommendation(findings);

  return {
    findings,
    summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : DEFAULT_RESULT.summary,
    riskLevel,
    recommendation,
  };
}

function buildMessages(diff: string, issueContext: string, config: SemanticReviewConfig): ChatMessage[] {
  const budget = Math.max(config.maxTokens, 1000);
  const charBudget = Math.floor(budget * 2.5);
  const diffText = config.includeDiff ? truncate(diff, Math.floor(charBudget * 0.65)) : "[diff omitted by config]";
  const issueText = config.includeIssueContext
    ? truncate(issueContext, Math.floor(charBudget * 0.25))
    : "[issue context omitted by config]";

  return [
    {
      role: "system",
      content: [
        "You are a senior code reviewer for an autonomous coding loop.",
        "Return only valid JSON with keys: findings, summary, riskLevel, recommendation.",
        "Each finding must include severity, category, file, message, and may include line and suggestedFix.",
        "Use severities critical, high, medium, low.",
        "Use categories security, correctness, testing, performance, style.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Review the change against this rubric:",
        "- Security: Does this change introduce or fail to fix security vulnerabilities?",
        "- Correctness: Are there logic errors, data races, missing methods, off-by-one errors?",
        "- Testing: Are there tests for the changed behavior? Are they meaningful or empty stubs?",
        "- Completeness: Does the PR actually address all parts of the issue?",
        "- Thread Safety: If the code touches shared state, are locks used correctly?",
        "",
        "## Thread Safety Review",
        "If the diff touches any of the following, flag it for careful review:",
        "- Shared state variables (class attributes accessed from multiple methods)",
        "- Lock/mutex acquisition and release patterns",
        "- Dictionary or list mutations in multi-threaded contexts",
        "- Global state modifications",
        "- Async/await patterns with shared state",
        "",
        "For each thread-safety finding, verify:",
        "- Is shared state accessed under the appropriate lock?",
        "- Are there read-modify-write sequences that should be atomic?",
        "- Could a context switch between operations cause data corruption?",
        "- Are there dual-write patterns (writing to both old and new data structures)?",
        "If lock correctness cannot be confirmed, flag it as high severity.",
        "If a dual-write pattern can race or split state, flag it as critical.",
        "",
        "Issue context:",
        issueText,
        "",
        "Diff:",
        diffText,
        "",
        "Respond with JSON only in this shape:",
        JSON.stringify(DEFAULT_RESULT),
      ].join("\n"),
    },
  ];
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch?.[1]?.trim() ?? extractObject(trimmed);
  if (!candidate) return null;

  try {
    return JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractObject(content: string): string | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return content.slice(start, end + 1);
}

function normalizeFinding(value: unknown): SemanticFinding | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const severity = typeof input.severity === "string" ? input.severity.toLowerCase() : "";
  const category = typeof input.category === "string" ? input.category.toLowerCase() : "";
  const file = typeof input.file === "string" ? input.file.trim() : "";
  const message = typeof input.message === "string" ? input.message.trim() : "";

  if (!SEVERITIES.has(severity) || !CATEGORIES.has(category) || !file || !message) {
    return null;
  }

  const finding: SemanticFinding = {
    severity: severity as SemanticFinding["severity"],
    category: category as SemanticFinding["category"],
    file,
    message,
  };

  if (typeof input.line === "number" && Number.isInteger(input.line) && input.line > 0) {
    finding.line = input.line;
  }

  if (typeof input.suggestedFix === "string" && input.suggestedFix.trim()) {
    finding.suggestedFix = input.suggestedFix.trim();
  }

  return finding;
}

function inferRiskLevel(findings: SemanticFinding[]): SemanticReviewResult["riskLevel"] {
  if (findings.some((finding) => finding.severity === "critical")) return "critical";
  if (findings.some((finding) => finding.severity === "high")) return "high";
  if (findings.some((finding) => finding.severity === "medium")) return "medium";
  return "low";
}

function inferRecommendation(findings: SemanticFinding[]): SemanticReviewResult["recommendation"] {
  if (findings.some((finding) => finding.severity === "critical")) return "reject";
  if (findings.some((finding) => finding.severity === "high" || finding.severity === "medium")) return "request_changes";
  return "approve";
}

function dedupeFindings(findings: SemanticFinding[]): SemanticFinding[] {
  const seen = new Set<string>();
  const deduped: SemanticFinding[] = [];

  for (const finding of findings) {
    const hash = hashFinding(finding);
    if (seen.has(hash)) continue;
    seen.add(hash);
    deduped.push(finding);
  }

  return deduped;
}

function parseDiffFiles(diff: string): Array<{
  path: string;
  lines: Array<{ added: boolean; content: string; newLine?: number }>;
}> {
  const files: Array<{
    path: string;
    lines: Array<{ added: boolean; content: string; newLine?: number }>;
  }> = [];
  let current: { path: string; lines: Array<{ added: boolean; content: string; newLine?: number }> } | null = null;
  let newLine = 0;

  for (const rawLine of diff.split(/\r?\n/)) {
    const fileMatch = rawLine.match(/^diff --git a\/.+ b\/(.+)$/);
    if (fileMatch) {
      current = { path: fileMatch[1], lines: [] };
      files.push(current);
      newLine = 0;
      continue;
    }

    if (!current) continue;

    const hunkMatch = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      continue;
    }

    if (rawLine.startsWith("+++") || rawLine.startsWith("---")) continue;

    if (rawLine.startsWith("+")) {
      current.lines.push({ added: true, content: rawLine.slice(1), newLine });
      newLine++;
    } else if (rawLine.startsWith("-")) {
      continue;
    } else {
      if (newLine > 0) newLine++;
    }
  }

  return files;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[truncated]`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Semantic review timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
