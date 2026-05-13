import { describe, it, expect } from "vitest";
import {
  detectFailurePatterns,
  generatePrompt,
  selectStrategy,
  type PromptContext,
  type PromptStrategy,
} from "../src/autonomous-loop/prompt-strategies";

const baseContext: PromptContext = {
  issueKey: "IR-99",
  issueTitle: "Fix auth token validation",
  issueDescription: "Token comparison must be timing-safe.",
  codingPrompt: "File: src/auth.ts line 42\nReplace === with timingSafeEqual.",
  affectedFiles: ["src/auth.ts"],
  previousAttempts: 0,
  previousFailures: [],
  reviewerFindings: [],
};

function context(overrides: Partial<PromptContext>): PromptContext {
  return { ...baseContext, ...overrides };
}

describe("selectStrategy", () => {
  it("uses standard for the first attempt", () => {
    expect(selectStrategy(context({ previousAttempts: 0 }))).toBe("standard");
  });

  it("uses rework_with_feedback for the first rework", () => {
    expect(selectStrategy(context({ previousAttempts: 1 }))).toBe("rework_with_feedback");
  });

  it("switches empty PR failures to file_focused", () => {
    expect(selectStrategy(context({ previousAttempts: 2, previousFailures: ["EMPTY_PR"] }))).toBe("file_focused");
  });

  it("switches failing tests to test_first", () => {
    expect(selectStrategy(context({ previousAttempts: 2, previousFailures: ["TESTS_FAILING"] }))).toBe("test_first");
  });

  it("switches generic feedback to simplified", () => {
    expect(selectStrategy(context({ previousAttempts: 2, previousFailures: ["GENERIC_REVIEW_FEEDBACK"] }))).toBe("simplified");
  });

  it("uses incremental after repeated non-identical failures", () => {
    expect(selectStrategy(context({ previousAttempts: 3, previousFailures: ["REVIEW_REJECTED", "NO_PROGRESS", "UNKNOWN_FAILURE"] }))).toBe("incremental");
  });

  it("escalates after repeated identical failures", () => {
    expect(selectStrategy(context({ previousAttempts: 3, previousFailures: ["EMPTY_PR", "EMPTY_PR", "EMPTY_PR"] }))).toBe("escalate_human");
  });

  it("avoids repeating strategies that have already been tried", () => {
    expect(selectStrategy(context({
      previousAttempts: 2,
      previousFailures: ["EMPTY_PR"],
      strategiesTried: ["file_focused"],
    }))).toBe("test_first");
  });
});

describe("generatePrompt", () => {
  const strategies: PromptStrategy[] = [
    "standard",
    "rework_with_feedback",
    "simplified",
    "file_focused",
    "test_first",
    "incremental",
    "escalate_human",
  ];

  it.each(strategies)("generates a non-empty %s prompt", (strategy) => {
    const prompt = generatePrompt(strategy, context({
      previousFailures: ["EMPTY_PR"],
      reviewerFindings: [{
        severity: "critical",
        category: "security",
        file: "src/auth.ts",
        line: 42,
        message: "Token comparison is still not timing-safe.",
      }],
      testOutput: "expected true to be false",
    }));

    expect(prompt.length).toBeGreaterThan(20);
    expect(prompt).toContain("IR-99");
  });

  it("includes reviewer findings in rework prompts", () => {
    const prompt = generatePrompt("rework_with_feedback", context({
      previousAttempts: 1,
      reviewerFindings: [{
        severity: "high",
        category: "correctness",
        file: "src/auth.ts",
        message: "Missing timing safe comparison.",
      }],
    }));

    expect(prompt).toContain("The following issues were found");
    expect(prompt).toContain("Missing timing safe comparison");
  });

  it("makes file_focused prompts point at exact file and line", () => {
    const prompt = generatePrompt("file_focused", context({
      reviewerFindings: [{
        severity: "critical",
        category: "security",
        file: "src/auth.ts",
        line: 42,
        message: "Fix token comparison.",
      }],
    }));

    expect(prompt).toContain("Open src/auth.ts");
    expect(prompt).toContain("line 42");
  });

  it("makes test_first prompts start with a test", () => {
    const prompt = generatePrompt("test_first", context({ testOutput: "unit test failed" }));

    expect(prompt).toContain("First, write a test");
    expect(prompt).toContain("unit test failed");
  });
});

describe("detectFailurePatterns", () => {
  it("detects empty PR, tests failing, and generic review feedback", () => {
    const failures = detectFailurePatterns({
      prHadChanges: false,
      testOutput: "Tests failed",
      reworkPrompt: "Security-related files detected",
    });

    expect(failures).toEqual(expect.arrayContaining([
      "EMPTY_PR",
      "TESTS_FAILING",
      "GENERIC_REVIEW_FEEDBACK",
    ]));
  });
});
