import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  TARGETED_PROMPT_RULES,
  ensureAgentsMdRules,
  hasTargetedPromptRules,
} from "../../../src/autonomous-loop/agents-md";

describe("TARGETED_PROMPT_RULES", () => {
  it("contains all 12 rules", () => {
    const ruleMatches = TARGETED_PROMPT_RULES.match(/## Rule \d+/g);
    expect(ruleMatches).not.toBeNull();
    expect(ruleMatches!.length).toBe(12);
  });

  it("contains the header section", () => {
    expect(TARGETED_PROMPT_RULES).toContain("## Targeted Prompt Rules (Error Reduction)");
    expect(TARGETED_PROMPT_RULES).toContain("Bias: caution over speed on non-trivial work.");
  });

  it("contains key phrases from each rule", () => {
    expect(TARGETED_PROMPT_RULES).toContain("Think Before Coding");
    expect(TARGETED_PROMPT_RULES).toContain("Simplicity First");
    expect(TARGETED_PROMPT_RULES).toContain("Surgical Changes");
    expect(TARGETED_PROMPT_RULES).toContain("Goal-Driven Execution");
    expect(TARGETED_PROMPT_RULES).toContain("Use the model only for judgment calls");
    expect(TARGETED_PROMPT_RULES).toContain("Token budgets are not advisory");
    expect(TARGETED_PROMPT_RULES).toContain("Surface conflicts, don't average them");
    expect(TARGETED_PROMPT_RULES).toContain("Read before you write");
    expect(TARGETED_PROMPT_RULES).toContain("Tests verify intent, not just behavior");
    expect(TARGETED_PROMPT_RULES).toContain("Checkpoint after every significant step");
    expect(TARGETED_PROMPT_RULES).toContain("Match the codebase's conventions");
    expect(TARGETED_PROMPT_RULES).toContain("Fail loud");
  });
});

describe("hasTargetedPromptRules", () => {
  it("returns true when rules are present", () => {
    const content = "# Some header\n\n## Targeted Prompt Rules (Error Reduction)\n\n## Rule 1 — Think Before Coding\nState assumptions explicitly.";
    expect(hasTargetedPromptRules(content)).toBe(true);
  });

  it("returns false when rules section is missing", () => {
    const content = "# Just a regular AGENTS.md\n\nSome guidelines here.";
    expect(hasTargetedPromptRules(content)).toBe(false);
  });

  it("returns false for empty content", () => {
    expect(hasTargetedPromptRules("")).toBe(false);
  });

  it("returns false when only partial header exists without Rule 1", () => {
    const content = "## Targeted Prompt Rules (Error Reduction)\n\nBut no actual rules follow.";
    expect(hasTargetedPromptRules(content)).toBe(false);
  });
});

describe("ensureAgentsMdRules", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-md-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates AGENTS.md with rules when it does not exist", () => {
    const agentsPath = path.join(tmpDir, "AGENTS.md");
    expect(fs.existsSync(agentsPath)).toBe(false);

    const result = ensureAgentsMdRules(tmpDir);

    expect(result).toBe(true);
    expect(fs.existsSync(agentsPath)).toBe(true);
    const content = fs.readFileSync(agentsPath, "utf-8");
    expect(content).toContain("## Targeted Prompt Rules (Error Reduction)");
    expect(content).toContain("## Rule 1 — Think Before Coding");
    expect(content).toContain("## Rule 12 — Fail loud");
  });

  it("appends rules to existing AGENTS.md that lacks them", () => {
    const existingContent = "# My Project\n\n## Build Commands\n\n```bash\nnpm test\n```\n";
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), existingContent, "utf-8");

    const result = ensureAgentsMdRules(tmpDir);

    expect(result).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf-8");
    expect(content).toContain(existingContent.trim());
    expect(content).toContain("## Targeted Prompt Rules (Error Reduction)");
    expect(content).toContain("## Rule 1 — Think Before Coding");
  });

  it("does not modify AGENTS.md that already has rules", () => {
    const existingContent = "# My Project\n\n## Targeted Prompt Rules (Error Reduction)\n\n## Rule 1 — Think Before Coding\nState assumptions explicitly.\n";
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), existingContent, "utf-8");

    const result = ensureAgentsMdRules(tmpDir);

    expect(result).toBe(false);
    const content = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf-8");
    expect(content).toBe(existingContent);
  });

  it("returns false for non-existent directory", () => {
    const result = ensureAgentsMdRules(path.join(tmpDir, "nonexistent"));
    expect(result).toBe(false);
  });

  it("handles AGENTS.md with only whitespace", () => {
    fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "   \n  \n  ", "utf-8");

    const result = ensureAgentsMdRules(tmpDir);

    expect(result).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf-8");
    expect(content).toContain("## Targeted Prompt Rules (Error Reduction)");
  });

  it("writes CODEX.md style file when only CODEX.md exists", () => {
    // Some repos use CODEX.md instead of AGENTS.md
    const codexContent = "# Codex Implementation Context\n";
    fs.writeFileSync(path.join(tmpDir, "CODEX.md"), codexContent, "utf-8");

    // ensureAgentsMdRules targets AGENTS.md specifically
    const result = ensureAgentsMdRules(tmpDir);
    expect(result).toBe(true);

    // AGENTS.md should be created fresh
    const agentsContent = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf-8");
    expect(agentsContent).toContain("## Targeted Prompt Rules (Error Reduction)");
    // CODEX.md should be unchanged
    expect(fs.readFileSync(path.join(tmpDir, "CODEX.md"), "utf-8")).toBe(codexContent);
  });
});
