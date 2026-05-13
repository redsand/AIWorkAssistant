import { describe, it, expect } from "vitest";
import {
  EXIT_SUCCESS,
  EXIT_NO_CHANGES,
  EXIT_PLACEHOLDER_ONLY,
  EXIT_GIT_FAILURE,
  EXIT_TEST_FAILURE,
  EXIT_REVIEW_FAILED,
  EXIT_MAX_REWORK,
  validateOutputFromDiff,
} from "../../src/aicoder-pipeline";

// ── Constants ─────────────────────────────────────────────────────────────────

describe("exit code constants", () => {
  it("EXIT_SUCCESS is 0", () => expect(EXIT_SUCCESS).toBe(0));
  it("EXIT_NO_CHANGES is 2", () => expect(EXIT_NO_CHANGES).toBe(2));
  it("EXIT_PLACEHOLDER_ONLY is 3", () => expect(EXIT_PLACEHOLDER_ONLY).toBe(3));
  it("EXIT_GIT_FAILURE is 4", () => expect(EXIT_GIT_FAILURE).toBe(4));
  it("EXIT_TEST_FAILURE is 5", () => expect(EXIT_TEST_FAILURE).toBe(5));
  it("EXIT_REVIEW_FAILED is 6", () => expect(EXIT_REVIEW_FAILED).toBe(6));
  it("EXIT_MAX_REWORK is 7", () => expect(EXIT_MAX_REWORK).toBe(7));

  it("codes are unique", () => {
    const codes = [EXIT_SUCCESS, EXIT_NO_CHANGES, EXIT_PLACEHOLDER_ONLY, EXIT_GIT_FAILURE, EXIT_TEST_FAILURE, EXIT_REVIEW_FAILED, EXIT_MAX_REWORK];
    expect(new Set(codes).size).toBe(codes.length);
  });
});

// ── validateOutputFromDiff ────────────────────────────────────────────────────

// Build a minimal but realistic unified diff stat and content string.
const REAL_DIFF_STAT = " src/foo.ts | 20 +++++++----\n 1 file changed, 14 insertions(+), 6 deletions(-)";
const REAL_DIFF_CONTENT = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,5 +1,10 @@
+import { bar } from './bar';
+
 export function foo() {
-  return null;
+  const result = bar();
+  if (!result) throw new Error('bar failed');
+  return result;
 }
`;

describe("validateOutputFromDiff", () => {
  describe("skip-agent bypass", () => {
    it("returns valid regardless of empty diff when skipAgent=true", () => {
      const result = validateOutputFromDiff("", "", true);
      expect(result.valid).toBe(true);
      expect(result.exitCode).toBe(EXIT_SUCCESS);
    });

    it("returns valid regardless of placeholder-only diff when skipAgent=true", () => {
      const placeholderDiff = "+// TODO: implement this\n+// TODO: implement me\n+// TODO: implement\n+// TODO: implement\n+// TODO: implement";
      const result = validateOutputFromDiff("1 file changed", placeholderDiff, true);
      expect(result.valid).toBe(true);
      expect(result.exitCode).toBe(EXIT_SUCCESS);
    });
  });

  describe("EXIT_NO_CHANGES (code 2)", () => {
    it("returns EXIT_NO_CHANGES when diffStat is empty string", () => {
      const result = validateOutputFromDiff("", REAL_DIFF_CONTENT, false);
      expect(result.valid).toBe(false);
      expect(result.exitCode).toBe(EXIT_NO_CHANGES);
    });

    it("returns EXIT_NO_CHANGES when diffStat is only whitespace", () => {
      const result = validateOutputFromDiff("   \n  ", REAL_DIFF_CONTENT, false);
      expect(result.valid).toBe(false);
      expect(result.exitCode).toBe(EXIT_NO_CHANGES);
    });
  });

  describe("EXIT_PLACEHOLDER_ONLY (code 3)", () => {
    it("returns EXIT_PLACEHOLDER_ONLY when ≥80% of added lines are stubs and ≥5 lines", () => {
      // 7 stub lines, 0 real lines → 100%
      const stubDiff = [
        "+// TODO: implement this",
        "+// TODO: implement me",
        "+// TODO: implement",
        "+// TODO: implement here",
        "+// TODO: implement logic",
        "+// FIXME: implement",
        "+// PLACEHOLDER: implement",
      ].join("\n");
      const result = validateOutputFromDiff("1 file changed", stubDiff, false);
      expect(result.valid).toBe(false);
      expect(result.exitCode).toBe(EXIT_PLACEHOLDER_ONLY);
    });

    it("does NOT flag EXIT_PLACEHOLDER_ONLY when fewer than 5 stub lines regardless of ratio", () => {
      // 4 stubs, 0 real — ratio is 100% but below minimum line count
      const stubDiff = [
        "+// TODO: implement this",
        "+// TODO: implement me",
        "+// TODO: implement",
        "+// TODO: implement here",
      ].join("\n");
      const result = validateOutputFromDiff("1 file changed", stubDiff, false);
      // Below the threshold so it passes (suspicious but not blocked)
      expect(result.exitCode).not.toBe(EXIT_PLACEHOLDER_ONLY);
    });
  });

  describe("EXIT_SUCCESS (code 0)", () => {
    it("returns valid for a realistic non-empty diff", () => {
      const result = validateOutputFromDiff(REAL_DIFF_STAT, REAL_DIFF_CONTENT, false);
      expect(result.valid).toBe(true);
      expect(result.exitCode).toBe(EXIT_SUCCESS);
    });

    it("returns valid when diff is deletions only (no added lines)", () => {
      const deletionStat = "1 file changed, 5 deletions(-)";
      const deletionDiff = "-const old = 1;\n-const older = 2;\n-const oldest = 3;\n-export { old };\n-export { older };";
      const result = validateOutputFromDiff(deletionStat, deletionDiff, false);
      expect(result.valid).toBe(true);
      expect(result.exitCode).toBe(EXIT_SUCCESS);
    });

    it("returns valid when only some added lines are stubs (below 80% threshold)", () => {
      // 2 stubs out of 10 lines = 20%
      const mixedDiff = [
        "+import { bar } from './bar';",
        "+",
        "+export function foo() {",
        "+  const x = bar();",
        "+  // TODO: implement error handling",
        "+  if (!x) throw new Error('failed');",
        "+  return x;",
        "+}",
        "+",
        "+// TODO: implement cleanup",
      ].join("\n");
      const result = validateOutputFromDiff("1 file changed", mixedDiff, false);
      expect(result.valid).toBe(true);
      expect(result.exitCode).toBe(EXIT_SUCCESS);
    });

    it("returns valid for multi-file real changes", () => {
      const multiFileStat = "3 files changed, 45 insertions(+), 12 deletions(-)";
      const result = validateOutputFromDiff(multiFileStat, REAL_DIFF_CONTENT, false);
      expect(result.valid).toBe(true);
      expect(result.exitCode).toBe(EXIT_SUCCESS);
    });
  });

  describe("placeholder pattern matching", () => {
    it("does not flag a real TODO comment mixed into real code as a stub line", () => {
      // "// TODO: add boundary check" is in the middle of a function — not a stub
      const realCode = "+  if (value > 0) { // TODO: add boundary check\n+    return value;\n+  }\n+  return 0;\n";
      const result = validateOutputFromDiff("1 file changed", realCode, false);
      expect(result.valid).toBe(true);
    });

    it("does not count inline TODO comments as stubs (stub must begin the line)", () => {
      // Lines that start with real code and have a TODO comment at the end
      // are NOT stubs — only lines that BEGIN with `//` or `#` are stubs.
      const inlineComments = [
        "+  doSomething(); // TODO: optimize this later",
        "+  } // TODO: refactor",
        "+  return x; // TODO: clean up",
        "+  const y = 1; // FIXME: wrong value",
        "+  callFn(); // PLACEHOLDER: replace",
      ];
      // All 5 lines are inline comments → 0 stub lines → SKIP threshold → valid
      const result = validateOutputFromDiff("1 file changed", inlineComments.join("\n"), false);
      expect(result.valid).toBe(true);
      expect(result.exitCode).not.toBe(EXIT_PLACEHOLDER_ONLY);
    });
  });
});
