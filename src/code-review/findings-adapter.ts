/**
 * Converts AI CodeReview output into structured ReviewFinding objects.
 *
 * Shared by reviewer.ts (local streaming path) and routes/reviewer-config.ts
 * (server SSE path) so both produce identical findings.
 */

export interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  category: "security" | "qa" | "quality";
  file: string;
  line?: number;
  message: string;
  suggestion: string;
}

/**
 * Extract the primary file reference from a finding text string.
 *
 * The model is instructed to write "filename.ext:line_number — description".
 * Some findings reference multiple files ("file1.js:10, file2.js:20 — desc") —
 * we extract just the first one since that is the primary location.
 */
export function findingFromText(
  text: string,
  severity: ReviewFinding["severity"],
  category: ReviewFinding["category"],
): ReviewFinding {
  // Pattern 1: "filename.ext:line — description" (may have comma-separated extras after line)
  const explicitMatch = text.match(/^([\w./\-]+\.\w{1,10})\s*:\s*(\d+)\s*[,\s]*[—\-–]/);
  if (explicitMatch) {
    return {
      severity,
      category,
      file: explicitMatch[1],
      line: parseInt(explicitMatch[2], 10),
      message: text,
      suggestion: "See the full review comment on the PR.",
    };
  }

  // Pattern 2: "filename.ext — description" (file without line number)
  const fileOnlyMatch = text.match(/^([\w./\-]+\.\w{1,10})\s*[—\-–]/);
  if (fileOnlyMatch) {
    return {
      severity,
      category,
      file: fileOnlyMatch[1],
      message: text,
      suggestion: "See the full review comment on the PR.",
    };
  }

  // Pattern 3: fallback — first filename before the " — " separator only, to avoid
  // picking up filenames that appear in the description (e.g. "use validators.js instead").
  const beforeDash = text.split(/\s+[—\-–]\s+/)[0];
  const looseMatch = beforeDash.match(/\b([\w./\-]+\.\w{1,10})(?::(\d+))?/);
  return {
    severity,
    category,
    file: looseMatch?.[1] ?? "unknown",
    line: looseMatch?.[2] ? parseInt(looseMatch[2], 10) : undefined,
    message: text,
    suggestion: "See the full review comment on the PR.",
  };
}

export function codeReviewToFindings(review: {
  mustFix?: string[];
  securityConcerns?: string[];
  migrationRisks?: string[];
  shouldFix?: string[];
  testGaps?: string[];
  observabilityConcerns?: string[];
  operationalItems?: string[];
}): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  const add = (items: string[], severity: ReviewFinding["severity"], category: ReviewFinding["category"]) => {
    for (const text of items) {
      findings.push(findingFromText(text, severity, category));
    }
  };

  add(review.mustFix ?? [], "critical", "quality");
  add(review.securityConcerns ?? [], "high", "security");
  add(review.migrationRisks ?? [], "high", "quality");
  add(review.shouldFix ?? [], "medium", "quality");
  add(review.testGaps ?? [], "medium", "qa");
  add(review.observabilityConcerns ?? [], "low", "quality");
  // Operational items (credential rotation, external system changes) are advisory only —
  // posted as comments but never block merge.
  add(review.operationalItems ?? [], "low", "quality");

  return findings;
}
