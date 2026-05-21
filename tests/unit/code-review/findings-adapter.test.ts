import { describe, it, expect } from "vitest";
import { findingFromText, codeReviewToFindings, type ReviewFinding } from "../../../src/code-review/findings-adapter";

// ── findingFromText ────────────────────────────────────────────────────────────

describe("findingFromText", () => {
  // Pattern 1: explicit filename:line — description
  describe("Pattern 1 — filename:line separator", () => {
    it("extracts file and line from 'file.ts:42 — description'", () => {
      const result = findingFromText("src/auth.ts:42 — Race condition in token refresh", "critical", "security");
      expect(result).toEqual({
        severity: "critical",
        category: "security",
        file: "src/auth.ts",
        line: 42,
        message: "src/auth.ts:42 — Race condition in token refresh",
        suggestion: "See the full review comment on the PR.",
      });
    });

    it("extracts file and line with regular dash separator", () => {
      const result = findingFromText("utils.js:10 - Missing null check", "medium", "quality");
      expect(result.file).toBe("utils.js");
      expect(result.line).toBe(10);
    });

    it("extracts file and line with en-dash separator", () => {
      const result = findingFromText("config.ts:5 – Typo in variable name", "low", "quality");
      expect(result.file).toBe("config.ts");
      expect(result.line).toBe(5);
    });

    it("handles comma-separated file references, extracting only the first", () => {
      const result = findingFromText("file1.js:10, file2.js:20 — Multiple issues", "high", "qa");
      expect(result.file).toBe("file1.js");
      expect(result.line).toBe(10);
    });

    it("handles paths with dots in directory names", () => {
      const result = findingFromText("src/app.controller.ts:99 — Missing error handler", "medium", "quality");
      expect(result.file).toBe("src/app.controller.ts");
      expect(result.line).toBe(99);
    });

    it("handles files with hyphens in the name", () => {
      const result = findingFromText("my-component.tsx:15 — Unused import", "low", "quality");
      expect(result.file).toBe("my-component.tsx");
      expect(result.line).toBe(15);
    });

    it("handles kebab-case directory paths", () => {
      const result = findingFromText("src/code-review/parser.ts:8 — Bad parse", "high", "quality");
      expect(result.file).toBe("src/code-review/parser.ts");
      expect(result.line).toBe(8);
    });
  });

  // Pattern 2: filename — description (no line number)
  describe("Pattern 2 — filename without line number", () => {
    it("extracts file without line from 'file.ts — description'", () => {
      const result = findingFromText("README.md — Missing setup instructions", "medium", "quality");
      expect(result).toEqual({
        severity: "medium",
        category: "quality",
        file: "README.md",
        line: undefined,
        message: "README.md — Missing setup instructions",
        suggestion: "See the full review comment on the PR.",
      });
    });

    it("extracts file with regular dash separator", () => {
      const result = findingFromText("index.ts - Needs refactoring", "low", "quality");
      expect(result.file).toBe("index.ts");
      expect(result.line).toBeUndefined();
    });

    it("extracts file with en-dash separator", () => {
      const result = findingFromText("app.tsx – Component too large", "medium", "quality");
      expect(result.file).toBe("app.tsx");
    });
  });

  // Pattern 3: fallback
  describe("Pattern 3 — fallback (loose match)", () => {
    it("falls back to loose filename match before the separator", () => {
      const result = findingFromText("Consider fixing auth.ts — it has issues", "medium", "quality");
      expect(result.file).toBe("auth.ts");
      expect(result.line).toBeUndefined();
    });

    it("falls back to 'unknown' when no filename is found", () => {
      const result = findingFromText("This is a general finding with no file reference", "low", "quality");
      expect(result.file).toBe("unknown");
      expect(result.line).toBeUndefined();
    });

    it("falls back to loose match with line number", () => {
      const result = findingFromText("Check utils.js:30 — something", "high", "security");
      expect(result.file).toBe("utils.js");
      expect(result.line).toBe(30);
    });

    it("does not pick up filenames that appear only after the separator", () => {
      const result = findingFromText("Refactor needed — use validators.js instead", "medium", "quality");
      // The part before the separator is "Refactor needed", which has no file match
      expect(result.file).toBe("unknown");
    });
  });
});

// ── codeReviewToFindings ───────────────────────────────────────────────────────

describe("codeReviewToFindings", () => {
  it("maps mustFix items as critical quality findings", () => {
    const findings = codeReviewToFindings({
      mustFix: ["auth.ts:10 — Critical bug"],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].category).toBe("quality");
  });

  it("maps securityConcerns as high security findings", () => {
    const findings = codeReviewToFindings({
      securityConcerns: ["auth.ts — SQL injection risk"],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("high");
    expect(findings[0].category).toBe("security");
  });

  it("maps migrationRisks as high quality findings", () => {
    const findings = codeReviewToFindings({
      migrationRisks: ["db.ts:50 — Breaking schema change"],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("high");
    expect(findings[0].category).toBe("quality");
  });

  it("maps shouldFix items as medium quality findings", () => {
    const findings = codeReviewToFindings({
      shouldFix: ["utils.ts — Missing error handling"],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("medium");
    expect(findings[0].category).toBe("quality");
  });

  it("maps testGaps as medium qa findings", () => {
    const findings = codeReviewToFindings({
      testGaps: ["auth.test.ts — No test for token refresh"],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("medium");
    expect(findings[0].category).toBe("qa");
  });

  it("maps observabilityConcerns as medium quality findings", () => {
    const findings = codeReviewToFindings({
      observabilityConcerns: ["api.ts — Missing metrics"],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("medium");
    expect(findings[0].category).toBe("quality");
  });

  it("maps operationalItems as low quality findings", () => {
    const findings = codeReviewToFindings({
      operationalItems: ["Rotate credentials — due soon"],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("low");
    expect(findings[0].category).toBe("quality");
  });

  it("returns empty array when review has no fields", () => {
    const findings = codeReviewToFindings({});
    expect(findings).toEqual([]);
  });

  it("returns empty array when all fields are empty arrays", () => {
    const findings = codeReviewToFindings({
      mustFix: [],
      securityConcerns: [],
      migrationRisks: [],
      shouldFix: [],
      testGaps: [],
      observabilityConcerns: [],
      operationalItems: [],
    });
    expect(findings).toEqual([]);
  });

  it("handles undefined fields by treating them as empty", () => {
    const findings = codeReviewToFindings({
      mustFix: undefined,
      securityConcerns: undefined,
    });
    expect(findings).toEqual([]);
  });

  it("aggregates findings from multiple categories in order", () => {
    const findings = codeReviewToFindings({
      mustFix: ["a.ts — Must fix"],
      securityConcerns: ["b.ts — Security"],
      shouldFix: ["c.ts — Should fix"],
    });
    expect(findings).toHaveLength(3);
    expect(findings[0].severity).toBe("critical");
    expect(findings[1].severity).toBe("high");
    expect(findings[2].severity).toBe("medium");
  });

  it("handles multiple items within the same category", () => {
    const findings = codeReviewToFindings({
      mustFix: ["file1.ts:1 — Bug A", "file2.ts:2 — Bug B", "file3.ts:3 — Bug C"],
    });
    expect(findings).toHaveLength(3);
    expect(findings.every((f) => f.severity === "critical")).toBe(true);
  });
});
