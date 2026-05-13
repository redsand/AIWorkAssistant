/**
 * Review findings parser — converts reviewer output into structured
 * ReviewGateFinding[] objects that the review gate and convergence
 * modules can consume.
 *
 * Handles three sources of findings:
 *  1. Structured ReviewFinding[] from the reviewer (already has severity, category, etc.)
 *  2. Free-form LLM review text with severity markers (e.g. "CRITICAL: [file] message")
 *  3. Built-in check results (non-empty, no-placeholders, structure)
 */

import { type ReviewGateFinding } from "./review-gate";

// ── Built-in check flags ─────────────────────────────────────────────────────

export interface BuiltInCheckResults {
  nonEmpty: boolean;
  noPlaceholders: boolean;
  structure: boolean;
}

// ── Severity pattern for free-form LLM text ───────────────────────────────────

const SEVERITY_PATTERN = /\b(CRITICAL|HIGH|MEDIUM|LOW)\s*:\s*\[([^\]]+)\]\s*(.+)/gi;

// ── Structured finding conversion ─────────────────────────────────────────────

/**
 * Convert a ReviewFinding (from the reviewer) into a ReviewGateFinding,
 * dropping fields (line, suggestion) that the gate doesn't use.
 */
function toGateFinding(f: {
  severity: string;
  category: string;
  file: string;
  message: string;
}): ReviewGateFinding {
  const severity = normalizeSeverity(f.severity);
  return {
    severity,
    category: f.category || "quality",
    file: f.file || "unknown",
    message: f.message,
  };
}

function normalizeSeverity(s: string): ReviewGateFinding["severity"] {
  const lower = s.toLowerCase();
  if (lower === "critical") return "critical";
  if (lower === "high") return "high";
  if (lower === "medium") return "medium";
  return "low";
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse review output into structured ReviewGateFinding[] objects.
 *
 * @param reviewOutput  Free-form LLM review text (may contain severity markers)
 * @param structuredFindings  Already-parsed ReviewFinding[] from the reviewer
 * @param builtInChecks  Results of built-in validation checks (optional)
 */
export function parseReviewFindings(
  reviewOutput: string,
  structuredFindings?: Array<{ severity: string; category: string; file: string; message: string }>,
  builtInChecks?: BuiltInCheckResults,
): ReviewGateFinding[] {
  const findings: ReviewGateFinding[] = [];

  // 1. Built-in check failures
  if (builtInChecks) {
    if (!builtInChecks.nonEmpty) {
      findings.push({ severity: "critical", category: "correctness", file: "unknown", message: "PR content is empty or too short" });
    }
    if (!builtInChecks.noPlaceholders) {
      findings.push({ severity: "high", category: "correctness", file: "unknown", message: "PR contains placeholder content (TODO/FIXME/PLACEHOLDER)" });
    }
    if (!builtInChecks.structure) {
      findings.push({ severity: "medium", category: "quality", file: "unknown", message: "PR content lacks proper structure" });
    }
  }

  // 2. Structured findings from the reviewer (primary source)
  if (structuredFindings && structuredFindings.length > 0) {
    for (const f of structuredFindings) {
      findings.push(toGateFinding(f));
    }
  }

  // 3. Free-form LLM review output with severity markers
  if (reviewOutput) {
    SEVERITY_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SEVERITY_PATTERN.exec(reviewOutput)) !== null) {
      const severity = normalizeSeverity(match[1]);
      const file = match[2].trim();
      const message = match[3].trim();
      // Deduplicate against structured findings
      const isDuplicate = findings.some(
        (f) => f.severity === severity && f.file === file && f.message === message,
      );
      if (!isDuplicate) {
        findings.push({
          severity,
          category: "correctness",
          file,
          message,
        });
      }
    }
  }

  return findings;
}