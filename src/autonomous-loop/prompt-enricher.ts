/**
 * Prompt enricher — injects project-specific context into agent prompts.
 *
 * Two enrichment layers, always appended after the original prompt:
 *
 * 1. Shell capabilities — always injected. Tells the agent it has full shell
 *    access, what the working directory is, and that it must use the shell
 *    proactively to complete the task without asking for permission.
 *
 * 2. Test context — injected when the prompt mentions tests/coverage.
 *    Detects the test runner, finds existing test files, and shows an excerpt
 *    of an existing test so the agent follows the right style.
 */

import * as fs from "fs";
import * as path from "path";
import { getProjectConfig } from "./project-detect";

// ── Pattern sets ──────────────────────────────────────────────────────────────

const TEST_KEYWORDS = /\btest(s|ing|ed)?\b|coverage|\bspec\b|unit test|missing test|add test|write test/i;

// ── Test file detection ───────────────────────────────────────────────────────

const TEST_FILE_PATTERNS: Record<string, RegExp[]> = {
  node: [/\.(test|spec)\.(js|ts|mjs|cjs)$/i],
  python: [/_test\.py$|^test_.*\.py$/i],
  rust: [/tests?\/.*\.rs$/i],
  go: [/_test\.go$/i],
  make: [/\.(test|spec)\.(js|ts)$|_test\.(py|go)$/i],
  unknown: [/\.(test|spec)\.(js|ts)$|_test\.(py|go)$/i],
};

function findTestFiles(workspace: string, patterns: RegExp[], maxFiles = 5): string[] {
  const results: string[] = [];
  function walk(dir: string, depth: number) {
    if (depth > 5 || results.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= maxFiles) break;
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist" || e.name === "build" || e.name === ".git") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (patterns.some((p) => p.test(e.name))) results.push(full);
    }
  }
  walk(workspace, 0);
  return results;
}

function readExcerpt(filePath: string, maxLines = 40): string {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const excerpt = lines.slice(0, maxLines).join("\n");
    return lines.length > maxLines ? excerpt + "\n// ... (truncated)" : excerpt;
  } catch { return ""; }
}

function formatCmd(cmd: string[]): string {
  return cmd.length > 0 ? `\`${cmd.join(" ")}\`` : "none detected";
}

// ── Section builders ──────────────────────────────────────────────────────────

function buildCapabilitiesSection(workspace: string): string {
  return `### Shell Access

Working directory: \`${workspace}\`

You have full access to run any shell command (bash, cmd, PowerShell) in this workspace.
Use the shell freely to read files, run tools, install packages, execute git operations,
or perform any system task required to complete the work.

Do not ask for permission before running commands. If a command fails, read the error and try a different approach.`;
}

async function buildTestSection(workspace: string, prompt: string): Promise<string | null> {
  if (!TEST_KEYWORDS.test(prompt)) return null;

  let config;
  try { config = getProjectConfig(workspace); } catch { return null; }

  const patterns = TEST_FILE_PATTERNS[config.type] ?? TEST_FILE_PATTERNS.unknown;
  const testFiles = findTestFiles(workspace, patterns);

  if (testFiles.length === 0 && !config.hasTests) {
    const conventions: Record<string, string> = {
      node: "Create test files using `filename.test.js` alongside source files, or in a `test/` directory.",
      python: "Create test files using `test_filename.py` in a `tests/` directory.",
      rust: "Add `#[cfg(test)]` modules at the bottom of source files, or create files in `tests/`.",
      go: "Create `filename_test.go` alongside the source file.",
    };
    const convention = conventions[config.type] ?? "Create a `test/` directory with test files appropriate for this project type.";
    return `### Project Test Context\n\n- **Test command**: ${formatCmd(config.testCommand)}\n- **No existing test files found** — ${convention}`;
  }

  const lines: string[] = ["### Project Test Context", ""];
  lines.push(`- **Test runner**: ${formatCmd(config.testCommand)}`);

  if (testFiles.length > 0) {
    const relPaths = testFiles.map((f) => path.relative(workspace, f).replace(/\\/g, "/"));
    lines.push(`- **Existing test files**: ${relPaths.slice(0, 3).join(", ")}${relPaths.length > 3 ? ` (+${relPaths.length - 3} more)` : ""}`);
    lines.push(`- **Test directory**: \`${path.dirname(relPaths[0])}\``);
    lines.push(`- **Naming convention**: \`${path.basename(testFiles[0])}\``);
    lines.push("");
    lines.push("**Follow this exact style for new test files:**");
    lines.push(`\`\`\`\n// ${relPaths[0]}\n${readExcerpt(testFiles[0])}\n\`\`\``);
  }

  return lines.join("\n");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Enrich a coding prompt with shell capabilities, recovery commands, and test
 * context. Safe to call on every prompt — always returns a valid prompt string.
 * Enrichment failures are swallowed so they never block agent execution.
 */
export async function enrichPrompt(prompt: string, workspace: string): Promise<string> {
  try {
    const sections: string[] = [prompt, "", buildCapabilitiesSection(workspace)];

    const testCtx = await buildTestSection(workspace, prompt);
    if (testCtx) sections.push("", testCtx);

    return sections.join("\n");
  } catch {
    return prompt;
  }
}

export { buildTestSection, buildCapabilitiesSection };
