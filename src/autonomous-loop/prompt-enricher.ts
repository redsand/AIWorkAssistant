/**
 * Prompt enricher — injects project-specific context into agent prompts.
 *
 * When a coding prompt mentions tests or coverage, this module inspects the
 * workspace to find: the test runner command, where tests live, what naming
 * convention they use, and a short excerpt from an existing test file so the
 * agent knows the exact style to follow. Works generically across Node, Python,
 * Rust, Go, and Make projects without any per-project configuration.
 */

import * as fs from "fs";
import * as path from "path";
import { getProjectConfig } from "./project-detect";

const TEST_KEYWORDS = /\btest(s|ing|ed)?\b|coverage|\bspec\b|unit test|missing test|add test|write test/i;

// Glob patterns for test files by project type
const TEST_FILE_PATTERNS: Record<string, RegExp[]> = {
  node: [/\.(test|spec)\.(js|ts|mjs|cjs)$/i],
  python: [/_test\.py$|test_.*\.py$/i],
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
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= maxFiles) break;
      const skip = e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist" || e.name === "build" || e.name === ".git";
      if (skip) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (patterns.some((p) => p.test(e.name))) {
        results.push(full);
      }
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
  } catch {
    return "";
  }
}

function formatTestCommand(cmd: string[]): string {
  return cmd.length > 0 ? `\`${cmd.join(" ")}\`` : "no test command detected";
}

/**
 * Inspect the workspace and return a markdown section describing the test
 * infrastructure. Returns null if the project has no detectable test setup
 * or if the prompt does not mention tests.
 */
export async function buildTestContext(workspace: string, prompt: string): Promise<string | null> {
  if (!TEST_KEYWORDS.test(prompt)) return null;

  let config;
  try {
    config = getProjectConfig(workspace);
  } catch {
    return null;
  }

  const patterns = TEST_FILE_PATTERNS[config.type] ?? TEST_FILE_PATTERNS.unknown;
  const testFiles = findTestFiles(workspace, patterns);

  if (testFiles.length === 0 && !config.hasTests) {
    // No existing tests — tell the agent where to create them based on project type
    const conventions: Record<string, string> = {
      node: "Create test files alongside source files using the pattern `filename.test.js` or in a `test/` directory.",
      python: "Create test files using the pattern `test_filename.py` in a `tests/` directory.",
      rust: "Add `#[cfg(test)]` modules at the bottom of the source file, or create files in a `tests/` directory.",
      go: "Create `filename_test.go` files alongside the source files.",
    };
    const convention = conventions[config.type] ?? "Create a `test/` directory and add test files appropriate for this project type.";
    return `### Project Test Context\n\n- **Test command**: ${formatTestCommand(config.testCommand)}\n- **No existing test files found** — ${convention}\n- Run tests with: ${formatTestCommand(config.testCommand)}`;
  }

  const lines: string[] = ["### Project Test Context", ""];
  lines.push(`- **Test runner**: ${formatTestCommand(config.testCommand)}`);

  if (testFiles.length > 0) {
    const relPaths = testFiles.map((f) => path.relative(workspace, f).replace(/\\/g, "/"));
    lines.push(`- **Existing test files**: ${relPaths.slice(0, 3).join(", ")}${relPaths.length > 3 ? ` (+${relPaths.length - 3} more)` : ""}`);
    lines.push(`- **Test directory**: \`${path.dirname(relPaths[0])}\``);
    lines.push(`- **Naming convention**: \`${path.basename(testFiles[0])}\``);
    lines.push("");
    lines.push("**Example test file** (follow this style exactly):");
    lines.push(`\`\`\`\n// ${relPaths[0]}\n${readExcerpt(testFiles[0])}\n\`\`\``);
  }

  return lines.join("\n");
}

/**
 * Enrich a coding prompt with project test context when the prompt involves
 * testing. Safe to call on every prompt — returns the original if no
 * enrichment is applicable.
 */
export async function enrichPrompt(prompt: string, workspace: string): Promise<string> {
  try {
    const testContext = await buildTestContext(workspace, prompt);
    if (!testContext) return prompt;
    return `${prompt}\n\n${testContext}`;
  } catch {
    // Enrichment is best-effort — never block agent execution
    return prompt;
  }
}
