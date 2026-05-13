import { describe, it, expect } from "vitest";
import {
  parseReviewFindings,
  type BuiltInCheckResults,
} from "../../../src/autonomous-loop/review-findings-parser";
import type { ReviewGateFinding } from "../../../src/autonomous-loop/review-gate";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const criticalFinding = {
  severity: "critical" as const,
  category: "security",
  file: "src/auth.ts",
  message: "Auth bypass in token validation",
  suggestion: "Add token expiry check",
};

const highFinding = {
  severity: "high" as const,
  category: "qa",
  file: "src/circuit-breaker.ts",
  message: "Empty test file — no assertions",
  suggestion: "Add at least one assertion per test",
};

const mediumFinding = {
  severity: "medium" as const,
  category: "quality",
  file: "src/utils.ts",
  message: "Missing error handling in retry logic",
  suggestion: "Wrap in try/catch",
};

// ── Empty review ──────────────────────────────────────────────────────────────

describe("parseReviewFindings", () => {
  describe("empty review", () => {
    it("returns empty findings when no input is provided", () => {
      const findings = parseReviewFindings("");
      expect(findings).toEqual([]);
    });

    it("returns empty findings when all sources are empty", () => {
      const findings = parseReviewFindings("", [], undefined);
      expect(findings).toEqual([]);
    });

    it("returns empty findings when structured array is empty and text has no markers", () => {
      const findings = parseReviewFindings("Some plain text without severity markers", []);
      expect(findings).toEqual([]);
    });
  });

  // ── Built-in check failures ────────────────────────────────────────────────

  describe("built-in check failures", () => {
    it("produces critical finding for empty PR", () => {
      const checks: BuiltInCheckResults = { nonEmpty: false, noPlaceholders: true, structure: true };
      const findings = parseReviewFindings("", undefined, checks);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe("critical");
      expect(findings[0].category).toBe("correctness");
      expect(findings[0].message).toContain("empty");
    });

    it("produces high finding for placeholders", () => {
      const checks: BuiltInCheckResults = { nonEmpty: true, noPlaceholders: false, structure: true };
      const findings = parseReviewFindings("", undefined, checks);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe("high");
      expect(findings[0].category).toBe("correctness");
      expect(findings[0].message).toContain("placeholder");
    });

    it("produces medium finding for bad structure", () => {
      const checks: BuiltInCheckResults = { nonEmpty: true, noPlaceholders: true, structure: false };
      const findings = parseReviewFindings("", undefined, checks);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe("medium");
      expect(findings[0].category).toBe("quality");
      expect(findings[0].message).toContain("structure");
    });

    it("produces multiple findings for multiple check failures", () => {
      const checks: BuiltInCheckResults = { nonEmpty: false, noPlaceholders: false, structure: false };
      const findings = parseReviewFindings("", undefined, checks);
      expect(findings).toHaveLength(3);
      expect(findings.map((f) => f.severity)).toEqual(["critical", "high", "medium"]);
    });
  });

  // ── Structured findings ────────────────────────────────────────────────────

  describe("structured findings", () => {
    it("converts ReviewFinding[] to ReviewGateFinding[]", () => {
      const findings = parseReviewFindings("", [criticalFinding, highFinding]);
      expect(findings).toHaveLength(2);
      expect(findings[0]).toEqual({
        severity: "critical",
        category: "security",
        file: "src/auth.ts",
        message: "Auth bypass in token validation",
      });
      expect(findings[1]).toEqual({
        severity: "high",
        category: "qa",
        file: "src/circuit-breaker.ts",
        message: "Empty test file — no assertions",
      });
    });

    it("drops line and suggestion from ReviewFinding", () => {
      const input = { ...criticalFinding, line: 42 };
      const findings = parseReviewFindings("", [input]);
      expect(findings[0]).not.toHaveProperty("line");
      expect(findings[0]).not.toHaveProperty("suggestion");
    });

    it("normalizes severity to lowercase", () => {
      const input = { severity: "CRITICAL", category: "security", file: "a.ts", message: "bad" };
      const findings = parseReviewFindings("", [input]);
      expect(findings[0].severity).toBe("critical");
    });

    it("defaults category to quality when empty", () => {
      const input = { severity: "high", category: "", file: "b.ts", message: "issue" };
      const findings = parseReviewFindings("", [input]);
      expect(findings[0].category).toBe("quality");
    });

    it("defaults file to unknown when empty", () => {
      const input = { severity: "medium", category: "qa", file: "", message: "issue" };
      const findings = parseReviewFindings("", [input]);
      expect(findings[0].file).toBe("unknown");
    });
  });

  // ── LLM severity markers ──────────────────────────────────────────────────

  describe("LLM review text with severity markers", () => {
    it("parses CRITICAL: [file] message pattern", () => {
      const text = "CRITICAL: [src/auth.ts] Authentication bypass in token validation";
      const findings = parseReviewFindings(text);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe("critical");
      expect(findings[0].file).toBe("src/auth.ts");
      expect(findings[0].message).toBe("Authentication bypass in token validation");
      expect(findings[0].category).toBe("correctness");
    });

    it("parses HIGH: [file] message pattern", () => {
      const text = "HIGH: [src/api.ts] Missing rate limiting on public endpoint";
      const findings = parseReviewFindings(text);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe("high");
    });

    it("parses MEDIUM and LOW patterns", () => {
      const text = "MEDIUM: [a.ts] Something\nLOW: [b.ts] Minor issue";
      const findings = parseReviewFindings(text);
      expect(findings).toHaveLength(2);
      expect(findings[0].severity).toBe("medium");
      expect(findings[1].severity).toBe("low");
    });

    it("parses multiple findings from multi-line review output", () => {
      const text = [
        "CRITICAL: [src/auth.ts] Auth bypass",
        "HIGH: [src/api.ts] Missing rate limit",
        "MEDIUM: [src/utils.ts] Unused import",
      ].join("\n");
      const findings = parseReviewFindings(text);
      expect(findings).toHaveLength(3);
      expect(findings[0].file).toBe("src/auth.ts");
      expect(findings[1].file).toBe("src/api.ts");
      expect(findings[2].file).toBe("src/utils.ts");
    });
  });

  // ── Deduplication ──────────────────────────────────────────────────────────

  describe("deduplication", () => {
    it("deduplicates text findings against structured findings", () => {
      const text = "CRITICAL: [src/auth.ts] Auth bypass in token validation";
      const findings = parseReviewFindings(text, [criticalFinding]);
      // The structured finding already covers this — text finding should be skipped
      expect(findings).toHaveLength(1);
      expect(findings[0].category).toBe("security"); // from structured, not "correctness"
    });

    it("keeps text findings that are not in structured findings", () => {
      const text = "CRITICAL: [src/other.ts] Different issue entirely";
      const findings = parseReviewFindings(text, [criticalFinding]);
      expect(findings).toHaveLength(2);
    });
  });

  // ── Mixed output ──────────────────────────────────────────────────────────

  describe("mixed output (all sources)", () => {
    it("combines built-in checks, structured findings, and text findings", () => {
      const checks: BuiltInCheckResults = { nonEmpty: false, noPlaceholders: true, structure: true };
      const text = "MEDIUM: [src/config.ts] Missing env validation";
      const findings = parseReviewFindings(text, [criticalFinding, mediumFinding], checks);
      // 1 built-in (empty) + 2 structured + 1 text = 4
      expect(findings).toHaveLength(4);
      expect(findings[0].category).toBe("correctness"); // built-in
      expect(findings[1].category).toBe("security"); // structured critical
      expect(findings[2].category).toBe("quality"); // structured medium
      expect(findings[3].category).toBe("correctness"); // text parsed
    });

    it("handles checks + structured only (no text)", () => {
      const checks: BuiltInCheckResults = { nonEmpty: true, noPlaceholders: false, structure: true };
      const findings = parseReviewFindings("", [highFinding], checks);
      expect(findings).toHaveLength(2); // 1 built-in + 1 structured
    });

    it("handles all checks passing + structured findings", () => {
      const checks: BuiltInCheckResults = { nonEmpty: true, noPlaceholders: true, structure: true };
      const findings = parseReviewFindings("", [criticalFinding], checks);
      expect(findings).toHaveLength(1); // only structured
    });
  });
});