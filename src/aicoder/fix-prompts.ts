/**
 * Pure prompt-builders for the three "fix this, please" agent invocations
 * extracted from src/aicoder.ts (2026-06-25):
 *
 *   - buildBaselineFixPrompt — failing tests on a fresh branch
 *   - buildCoverageFixPrompt — coverage below threshold
 *   - buildConflictResolutionPrompt — merge conflicts during rebase
 *
 * All three accept their dependencies (test/coverage command, base branch,
 * workspace) as arguments so they're trivially unit-testable. The
 * workspace path is only used by the conflict builder to read conflict
 * marker contents from disk.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkItem } from "../autonomous-loop/types";

const MAX_OUTPUT_LEN = 8000;
const MAX_CONFLICT_FILE_LEN = 4000;
const MAX_CONFLICT_TOTAL_LEN = 12000;
const MAX_CONFLICT_FILES = 8;

function tailOutput(text: string): string {
  return text.length > MAX_OUTPUT_LEN ? text.slice(-MAX_OUTPUT_LEN) : text;
}

export function buildBaselineFixPrompt(
  testOutput: string,
  item: WorkItem,
  testCommand: string,
): string {
  const truncated = tailOutput(testOutput);
  const cmd = testCommand || "npm test";
  return `# URGENT: Fix Failing Baseline Tests

The existing test suite is currently failing on the branch for issue #${item.number}: ${item.title}.

Before implementing new work, the existing tests must pass. The test failure output is below.

## Test Failure Output

\`\`\`
${truncated}
\`\`\`

## Instructions

1. **Read the test failure output carefully.** Identify which test files and assertions are failing.
2. **Fix the root cause.** This is typically a missing import, a type error, a configuration issue, or a test that references code that was recently changed.
3. **Do NOT skip or delete failing tests.** Fix the underlying code or update tests only if they test incorrect/outdated behavior.
4. **Run \`${cmd}\` locally after each fix** to verify your changes resolve the failures.
5. **Commit your fix** with a descriptive message like "fix: resolve baseline test failure in X".

Focus ONLY on fixing the failing tests. Do not implement new features or make unrelated changes.`;
}

export function buildCoverageFixPrompt(
  coverageOutput: string,
  item: WorkItem,
  coverageCommand: string,
): string {
  const truncated = tailOutput(coverageOutput);
  const cmd = coverageCommand || "npm run coverage";
  return `# URGENT: Fix Test Coverage Gap

The test coverage is below the required threshold for the branch implementing issue #${item.number}: ${item.title}.

The agent must bring coverage above the threshold by adding unit tests for the changed code.

## Coverage Output

\`\`\`
${truncated}
\`\`\`

## Instructions

1. **Identify uncovered code.** Review the coverage output to find files and lines that lack test coverage — focus on the files YOU modified.
2. **Add unit tests** that exercise the uncovered paths. Cover edge cases, error paths, and happy paths.
3. **Do NOT modify production code.** Only add or update test files. Do not refactor, add features, or change existing behavior.
4. **Run \`${cmd}\` locally after adding tests** to verify the coverage threshold is now met.
5. **Commit your test additions** with a message like "test: add coverage for [file/feature]".

Focus ONLY on adding test coverage. Do not implement new features or make unrelated changes.`;
}

/**
 * Read each conflict file, slice out only the `<<<<<<<` / `=======` /
 * `>>>>>>>` blocks (so we don't dump entire files into the prompt), and
 * compose a fix instruction. File / total size budgets keep the prompt
 * tractable even on huge repos.
 */
export function buildConflictResolutionPrompt(
  conflictFiles: string[],
  branchName: string,
  workspace: string,
  baseBranch: string,
): string {
  const sections: string[] = [];
  let totalLen = 0;

  for (const file of conflictFiles.slice(0, MAX_CONFLICT_FILES)) {
    try {
      const filePath = path.isAbsolute(file) ? file : path.join(workspace, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const conflictBlocks: string[] = [];
      let inConflict = false;
      let blockLines: string[] = [];
      for (const line of content.split("\n")) {
        if (line.startsWith("<<<<<<<")) {
          inConflict = true;
          blockLines = [line];
        } else if (line.startsWith(">>>>>>>")) {
          blockLines.push(line);
          conflictBlocks.push(blockLines.join("\n"));
          blockLines = [];
          inConflict = false;
        } else if (inConflict) {
          blockLines.push(line);
        }
      }
      if (conflictBlocks.length > 0) {
        const section = `### ${file}\n\n${conflictBlocks.join("\n\n")}`;
        const truncated =
          section.length > MAX_CONFLICT_FILE_LEN
            ? section.slice(0, MAX_CONFLICT_FILE_LEN) + "\n...(truncated)"
            : section;
        sections.push(truncated);
        totalLen += truncated.length;
        if (totalLen > MAX_CONFLICT_TOTAL_LEN) break;
      }
    } catch {
      // File may have been deleted or be binary — skip it
    }
  }

  const conflictContent = sections.join("\n\n");

  return `# URGENT: Resolve Git Merge Conflicts

The branch \`${branchName}\` has merge conflicts when rebasing onto \`${baseBranch}\`.

You must resolve ALL conflict markers in the files listed below. The conflict markers look like:

\`\`\`
<<<<<<< HEAD (base branch changes)
... base branch version ...
=======
... feature branch (your) version ...
>>>>>>> ${branchName} (your changes)
\`\`\`

## Conflict Sections

${conflictContent || "(Could not read conflict files — resolve conflicts manually in the working directory)"}

## Instructions

1. **Read each conflict carefully.** Understand what the base branch changed and what your branch changed.
2. **Merge both sides intelligently.** Do NOT just pick one side. Preserve both changes where they don't directly conflict.
3. **Remove ALL conflict markers** (<<<<<<<, =======, >>>>>>>). Every single one must be gone.
4. **Preserve the intent of both branches.** The base branch changes may include important fixes or updates. Your changes implement the feature. Both should be preserved where possible.
5. **If changes truly conflict** (same function, same line), prefer the feature branch version but incorporate any base branch improvements that don't directly clash.
6. **Run the project tests after resolving** to verify your resolution doesn't break anything.

Focus ONLY on resolving the conflicts. Do not add new features or make unrelated changes.`;
}
