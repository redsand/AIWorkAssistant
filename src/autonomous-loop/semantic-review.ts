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
  severity: "critical" | "high" | "medium" | "low";
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

export function defaultSemanticReviewConfig(): SemanticReviewConfig {
  return {
    model: "glm-5",
    maxTokens: 16000,
    timeoutMs: 120000,
    includeDiff: true,
    includeIssueContext: true,
  };
}

const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const CATEGORIES = new Set(["security", "correctness", "testing", "performance", "style"]);
const RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);
const RECOMMENDATIONS = new Set(["approve", "request_changes", "reject"]);

const DEFAULT_RESULT: SemanticReviewResult = {
  findings: [],
  summary: "No semantic issues found.",
  riskLevel: "low",
  recommendation: "approve",
};

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

  return parseSemanticReviewResponse(response.content);
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
