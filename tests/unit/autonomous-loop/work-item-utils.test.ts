import { describe, it, expect } from "vitest";
import {
  hashUuidToNumber,
  parseWorkItemTagsJson,
  extractCodingPromptSection,
} from "../../../src/autonomous-loop/work-item-utils";

describe("hashUuidToNumber", () => {
  it("should produce a positive number for a valid UUID", () => {
    const result = hashUuidToNumber("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(100000);
    expect(Number.isInteger(result)).toBe(true);
  });

  it("should produce consistent hashes for the same input", () => {
    const a = hashUuidToNumber("11111111-1111-1111-1111-111111111111");
    const b = hashUuidToNumber("11111111-1111-1111-1111-111111111111");
    expect(a).toBe(b);
  });

  it("should produce different hashes for different inputs", () => {
    const a = hashUuidToNumber("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    const b = hashUuidToNumber("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    expect(a).not.toBe(b);
  });

  it("should handle empty string", () => {
    const result = hashUuidToNumber("");
    expect(result).toBe(0);
  });
});

describe("parseWorkItemTagsJson", () => {
  it("should parse a valid JSON array of strings", () => {
    const result = parseWorkItemTagsJson('["ready-for-agent", "enhancement"]');
    expect(result).toEqual(["ready-for-agent", "enhancement"]);
  });

  it("should return empty array for null", () => {
    expect(parseWorkItemTagsJson(null)).toEqual([]);
  });

  it("should return empty array for invalid JSON", () => {
    expect(parseWorkItemTagsJson("{not valid")).toEqual([]);
  });

  it("should return empty array for non-array JSON", () => {
    expect(parseWorkItemTagsJson('{"key": "value"}')).toEqual([]);
  });

  it("should convert non-string elements to strings", () => {
    const result = parseWorkItemTagsJson('[123, true, "label"]');
    expect(result).toEqual(["123", "true", "label"]);
  });

  it("should handle empty string input", () => {
    expect(parseWorkItemTagsJson("")).toEqual([]);
  });
});

describe("extractCodingPromptSection", () => {
  it("should extract a coding prompt section from markdown", () => {
    const body = `## Summary
Some text

## Coding Prompt

\`\`\`typescript
const x = 1;
\`\`\`

## Acceptance Criteria
- Item 1`;

    const result = extractCodingPromptSection(body);
    expect(result).toContain("```typescript");
    expect(result).toContain("const x = 1;");
    expect(result).not.toContain("Acceptance Criteria");
    expect(result).not.toContain("## Summary");
  });

  it('should handle "## Coding Prompt" at end of document', () => {
    const body = `## Coding Prompt

Fix the login bug by updating the auth middleware.`;

    const result = extractCodingPromptSection(body);
    expect(result).toBe("Fix the login bug by updating the auth middleware.");
  });

  it("should return null when no coding prompt section exists", () => {
    const body = `## Summary
Some text

## Description
More text`;

    expect(extractCodingPromptSection(body)).toBeNull();
  });

  it("should match case-insensitively", () => {
    const body = `## coding prompt

Do the thing.`;

    const result = extractCodingPromptSection(body);
    expect(result).toBe("Do the thing.");
  });

  it("should handle whitespace variations in heading", () => {
    const body = `##  Coding  Prompt

Here is the task.`;

    const result = extractCodingPromptSection(body);
    expect(result).toBe("Here is the task.");
  });

  it("should return null for empty body", () => {
    expect(extractCodingPromptSection("")).toBeNull();
  });

  it('should not match "## Coding PromptCheck" (prefix collision)', () => {
    const body = `## Coding PromptCheck

Not a real prompt.`;
    expect(extractCodingPromptSection(body)).toBeNull();
  });
});
