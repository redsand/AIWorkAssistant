#!/usr/bin/env tsx
/**
 * review-agent — the per-category code-review sub-agent the reviewer shells
 * out to (see SECURITY_AGENT_CMD / QA_AGENT_CMD / QUALITY_AGENT_CMD /
 * REGRESSION_AGENT_CMD in src/config/env.ts and runAgentReview() in
 * src/reviewer.ts).
 *
 * Contract (must match runAgentReview):
 *   stdin       : the PR/MR unified diff
 *   argv        : --category <security|qa|quality|regression>
 *   stdout      : a JSON array of ReviewFinding objects, nothing else
 *   exit 0      : always (a review sub-agent that errors must not block a PR)
 *
 * FAIL-OPEN: on any error — missing claude CLI, timeout, unparseable model
 * output — we print `[]` and exit 0. runAgentReview() treats a thrown/parse
 * error as a fabricated CRITICAL finding that bounces the PR to rework, so a
 * broken agent would block every PR. Emitting an empty finding set instead
 * means a degraded reviewer is simply silent, never a false blocker. Real
 * findings still come through when the model responds normally.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

type Category = "security" | "qa" | "quality" | "regression";

interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  category: Category;
  file: string;
  line?: number;
  message: string;
  suggestion: string;
}

function getCategory(): Category {
  const i = process.argv.indexOf("--category");
  const raw = i >= 0 ? process.argv[i + 1] : "";
  if (raw === "security" || raw === "qa" || raw === "quality" || raw === "regression") {
    return raw;
  }
  return "quality";
}

const CATEGORY_FOCUS: Record<Category, string> = {
  security:
    "security vulnerabilities only: injection, auth/authz gaps, secret leakage, unsafe deserialization, SSRF, path traversal, missing input validation, insecure crypto. Ignore style and non-security bugs.",
  qa:
    "correctness and functional bugs only: logic errors, unhandled edge cases, off-by-one, null/undefined derefs, broken error handling, race conditions, and missing or wrong test coverage. Ignore style and security.",
  quality:
    "maintainability only: dead code, needless duplication, unclear naming, overly complex control flow, and violations of the surrounding code's conventions. Do NOT report bugs or security issues here. Be conservative — only flag things clearly worth changing.",
  regression:
    "regression risk only: behavior changes to existing public functions/APIs, removed or altered validation, changed defaults, and anything that could break current callers. Ignore purely additive code with no call-site impact.",
};

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

/** Extract the first top-level JSON array from arbitrary model text. */
function extractJsonArray(text: string): unknown[] | null {
  const start = text.indexOf("[");
  if (start === -1) return null;
  // Walk bracket depth so a JSON array containing nested arrays/objects
  // (and brackets inside strings) is captured whole.
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          const parsed = JSON.parse(slice);
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function sanitize(raw: unknown[], category: Category): ReviewFinding[] {
  const sevs = new Set(["critical", "high", "medium", "low"]);
  const out: ReviewFinding[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    const severity = sevs.has(String(f.severity)) ? (f.severity as ReviewFinding["severity"]) : "medium";
    const message = typeof f.message === "string" ? f.message.trim() : "";
    if (!message) continue; // a finding with no message is noise
    out.push({
      severity,
      category,
      file: typeof f.file === "string" && f.file.trim() ? f.file.trim() : "*",
      ...(typeof f.line === "number" ? { line: f.line } : {}),
      message,
      suggestion: typeof f.suggestion === "string" ? f.suggestion.trim() : "",
    });
  }
  return out;
}

function main(): void {
  const category = getCategory();
  const diff = readStdin();

  // Nothing to review → no findings.
  if (!diff.trim()) {
    process.stdout.write("[]");
    return;
  }

  const claudeBin =
    process.env.OLLAMA_LAUNCHER_CLAUDE_CLI_PATH || process.env.CLAUDE_CLI_PATH || "claude";
  const model = process.env.REVIEW_MODEL || process.env.AICODER_MODEL || "claude-opus-4-8";

  const prompt =
    `You are a senior code reviewer. Review the unified diff below, focusing EXCLUSIVELY on ${CATEGORY_FOCUS[category]}\n\n` +
    `Respond with ONLY a JSON array (no prose, no code fences) of findings. Each finding is an object:\n` +
    `{"severity":"critical|high|medium|low","file":"<path>","line":<number optional>,"message":"<what is wrong>","suggestion":"<how to fix>"}\n` +
    `Report ONLY issues introduced or worsened by this diff. If there are none, respond with exactly []. Do not invent issues to appear thorough.\n\n` +
    `=== DIFF ===\n${diff}\n=== END DIFF ===`;

  const timeoutMs = parseInt(process.env.REVIEW_AGENT_TIMEOUT_MS || "300000", 10);
  const res = spawnSync(
    claudeBin,
    ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions", "--model", model],
    {
      input: prompt,
      encoding: "utf-8",
      timeout: timeoutMs,
      shell: process.platform === "win32",
      maxBuffer: 64 * 1024 * 1024,
    },
  );

  if (res.status !== 0 || !res.stdout) {
    // Fail-open — a review sub-agent must never be the reason a PR is blocked.
    process.stderr.write(
      `[review-agent] ${category} degraded (exit ${res.status}${res.error ? `: ${res.error.message}` : ""}); emitting no findings.\n`,
    );
    process.stdout.write("[]");
    return;
  }

  // `claude --output-format json` wraps the reply as {"result":"...", ...}.
  // Fall back to treating stdout as raw text if that envelope isn't present.
  let modelText = res.stdout;
  try {
    const env = JSON.parse(res.stdout);
    if (env && typeof env.result === "string") modelText = env.result;
  } catch {
    /* not the JSON envelope — use stdout as-is */
  }

  const arr = extractJsonArray(modelText);
  if (!arr) {
    process.stderr.write(`[review-agent] ${category}: could not parse findings; emitting none.\n`);
    process.stdout.write("[]");
    return;
  }
  process.stdout.write(JSON.stringify(sanitize(arr, category)));
}

main();
