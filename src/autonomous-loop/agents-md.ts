import * as fs from "fs";
import * as path from "path";

export const TARGETED_PROMPT_RULES = `
## Targeted Prompt Rules (Error Reduction)

These rules apply to every task in this project unless explicitly overridden.
Bias: caution over speed on non-trivial work.

## Rule 1 — Think Before Coding
State assumptions explicitly. Ask rather than guess.
Push back when a simpler approach exists. Stop when confused.

## Rule 2 — Simplicity First
Minimum code that solves the problem. Nothing speculative.
No abstractions for single-use code.

## Rule 3 — Surgical Changes
Touch only what you must. Don't improve adjacent code.
Match existing style. Don't refactor what isn't broken.

## Rule 4 — Goal-Driven Execution
Define success criteria. Loop until verified.
Strong success criteria let Claude loop independently.

## Rule 5 — Use the model only for judgment calls
Use for: classification, drafting, summarization, extraction.
Do NOT use for: routing, retries, deterministic transforms.
If code can answer, code answers.

## Rule 6 — Token budgets are not advisory
Per-task: 4,000 tokens. Per-session: 30,000 tokens.
If approaching budget, summarize and start fresh.
Surface the breach. Do not silently overrun.

## Rule 7 — Surface conflicts, don't average them
If two patterns contradict, pick one (more recent / more tested).
Explain why. Flag the other for cleanup.

## Rule 8 — Read before you write
Before adding code, read exports, immediate callers, shared utilities.
If unsure why existing code is structured a certain way, ask.

## Rule 9 — Tests verify intent, not just behavior
Tests must encode WHY behavior matters, not just WHAT it does.
A test that can't fail when business logic changes is wrong.

## Rule 10 — Checkpoint after every significant step
Summarize what was done, what's verified, what's left.
Don't continue from a state you can't describe back.

## Rule 11 — Match the codebase's conventions, even if you disagree
Conformance > taste inside the codebase.
If you think a convention is harmful, surface it. Don't fork silently.

## Rule 12 — Fail loud
"Completed" is wrong if anything was skipped silently.
"Tests pass" is wrong if any were skipped.
Default to surfacing uncertainty, not hiding it.
`;

const RULES_HEADER = "## Targeted Prompt Rules (Error Reduction)";

/**
 * Check whether the given AGENTS.md content already contains the targeted prompt rules.
 */
export function hasTargetedPromptRules(content: string): boolean {
  return content.includes(RULES_HEADER) && content.includes("## Rule 1 — Think Before Coding");
}

/**
 * Ensure the workspace's AGENTS.md contains the targeted prompt rules.
 *
 * - If AGENTS.md does not exist, creates it with the rules.
 * - If AGENTS.md exists but lacks the rules section, appends the rules.
 * - If AGENTS.md already contains the rules, does nothing.
 *
 * Returns true if the file was created or modified, false otherwise.
 */
export function ensureAgentsMdRules(workspace: string): boolean {
  const agentsPath = path.join(workspace, "AGENTS.md");

  if (fs.existsSync(agentsPath)) {
    let content: string;
    try {
      content = fs.readFileSync(agentsPath, "utf-8");
    } catch {
      return false;
    }

    if (hasTargetedPromptRules(content)) {
      return false;
    }

    const trimmed = content.trimEnd();
    const separator = trimmed.length > 0 ? "\n\n" : "";
    try {
      fs.writeFileSync(agentsPath, trimmed + separator + TARGETED_PROMPT_RULES.trimStart() + "\n", "utf-8");
    } catch {
      return false;
    }
    return true;
  }

  try {
    fs.writeFileSync(agentsPath, TARGETED_PROMPT_RULES.trimStart() + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}
