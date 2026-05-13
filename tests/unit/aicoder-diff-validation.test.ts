import { describe, it, expect } from "vitest";
import {
  EXIT_SUCCESS,
  EXIT_NO_CHANGES,
  EXIT_WHITESPACE_ONLY,
  EXIT_META_ONLY,
  validateDiffBeforePush,
} from "../../src/aicoder-pipeline";

// ── Fixtures ────────────────────────────────────────────────────────────────

const EMPTY_STAT = "";
const EMPTY_DIFF = "";

const REAL_STAT = " src/foo.ts | 20 +++++++----\n 1 file changed, 14 insertions(+), 6 deletions(-)";
const REAL_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
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

const WHITESPACE_STAT = " src/foo.ts | 4 ++++\n 1 file changed, 4 insertions(+)";
const WHITESPACE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,7 @@
+
+
+
+
 export function foo() {
   return null;
 }
`;

const META_ONLY_STAT = " .gitignore | 2 ++\n .eslintrc.json | 3 ++-\n 2 files changed, 4 insertions(+), 1 deletion(-)";
const META_ONLY_DIFF = `diff --git a/.gitignore b/.gitignore
--- a/.gitignore
+++ b/.gitignore
@@ -1,2 +1,4 @@
 node_modules/
 dist/
+coverage/
+.env.local
diff --git a/.eslintrc.json b/.eslintrc.json
--- a/.eslintrc.json
+++ b/.eslintrc.json
@@ -1,3 +1,3 @@
 {
-  "extends": "eslint:recommended"
+  "extends": ["eslint:recommended", "prettier"]
 }
`;

const MIXED_STAT = " src/foo.ts | 10 +++++++---\n .gitignore | 1 +\n 2 files changed, 8 insertions(+), 3 deletions(-)";
const MIXED_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,5 +1,10 @@
+import { bar } from './bar';
+
 export function foo() {
-  return null;
+  const result = bar();
+  return result;
 }
diff --git a/.gitignore b/.gitignore
--- a/.gitignore
+++ b/.gitignore
@@ -1,2 +1,3 @@
 node_modules/
 dist/
+coverage/
`;

const DELETIONS_ONLY_STAT = " src/foo.ts | 5 -------\n 1 file changed, 5 deletions(-)";
const DELETIONS_ONLY_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,5 +1,0 @@
-const old = 1;
-const older = 2;
-const oldest = 3;
-export { old };
-export { older };
`;

const MULTI_FILE_STAT = " src/foo.ts | 20 +++++++----\n src/bar.ts | 8 +++++++\n 2 files changed, 18 insertions(+), 6 deletions(-)";
const MULTI_FILE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
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
diff --git a/src/bar.ts b/src/bar.ts
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -0,0 +1,3 @@
+export function bar(): string {
+  return "hello";
+}
`;

// ── validateDiffBeforePush ────────────────────────────────────────────────────

describe("validateDiffBeforePush", () => {
  describe("NO_CHANGES (empty diff)", () => {
    it("rejects empty stat and diff", () => {
      const result = validateDiffBeforePush(EMPTY_STAT, EMPTY_DIFF);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("NO_CHANGES");
      expect(result.exitCode).toBe(EXIT_NO_CHANGES);
      expect(result.stats.filesChanged).toBe(0);
    });

    it("rejects whitespace-only stat", () => {
      const result = validateDiffBeforePush("   \n  ", EMPTY_DIFF);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("NO_CHANGES");
      expect(result.exitCode).toBe(EXIT_NO_CHANGES);
    });

    it("rejects stat with zero files changed", () => {
      const result = validateDiffBeforePush("0 files changed", REAL_DIFF);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("NO_CHANGES");
    });
  });

  describe("WHITESPACE_ONLY", () => {
    it("rejects diff with only whitespace additions", () => {
      const result = validateDiffBeforePush(WHITESPACE_STAT, WHITESPACE_DIFF);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("WHITESPACE_ONLY");
      expect(result.exitCode).toBe(EXIT_WHITESPACE_ONLY);
      expect(result.stats.filesChanged).toBe(1);
    });
  });

  describe("META_ONLY", () => {
    it("rejects diff where all changed files are meta/config files", () => {
      const result = validateDiffBeforePush(META_ONLY_STAT, META_ONLY_DIFF);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("META_ONLY");
      expect(result.exitCode).toBe(EXIT_META_ONLY);
      expect(result.stats.filesChanged).toBe(2);
    });

    it("rejects .gitignore-only change", () => {
      const stat = " .gitignore | 2 ++\n 1 file changed, 2 insertions(+)";
      const diff = `diff --git a/.gitignore b/.gitignore
--- a/.gitignore
+++ b/.gitignore
@@ -1,2 +1,4 @@
 node_modules/
 dist/
+coverage/
+.env.local
`;
      const result = validateDiffBeforePush(stat, diff);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("META_ONLY");
    });

    it("rejects package-lock.json-only change", () => {
      const stat = " package-lock.json | 120 ++++++++---\n 1 file changed, 80 insertions(+), 40 deletions(-)";
      const diff = `diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,5 @@
+{
+  "newdep": "1.0.0"
 }
`;
      const result = validateDiffBeforePush(stat, diff);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("META_ONLY");
    });
  });

  describe("valid diffs pass", () => {
    it("accepts a realistic diff with code changes", () => {
      const result = validateDiffBeforePush(REAL_STAT, REAL_DIFF);
      expect(result.valid).toBe(true);
      expect(result.exitCode).toBe(EXIT_SUCCESS);
      expect(result.stats.filesChanged).toBe(1);
      expect(result.stats.insertions).toBe(14);
      expect(result.stats.deletions).toBe(6);
    });

    it("accepts deletions-only diff", () => {
      const result = validateDiffBeforePush(DELETIONS_ONLY_STAT, DELETIONS_ONLY_DIFF);
      expect(result.valid).toBe(true);
      expect(result.exitCode).toBe(EXIT_SUCCESS);
    });

    it("accepts mixed real + meta files (not meta-only)", () => {
      const result = validateDiffBeforePush(MIXED_STAT, MIXED_DIFF);
      expect(result.valid).toBe(true);
      expect(result.exitCode).toBe(EXIT_SUCCESS);
    });

    it("accepts multi-file real changes", () => {
      const result = validateDiffBeforePush(MULTI_FILE_STAT, MULTI_FILE_DIFF);
      expect(result.valid).toBe(true);
      expect(result.exitCode).toBe(EXIT_SUCCESS);
      expect(result.stats.filesChanged).toBe(2);
    });
  });

  describe("edge cases", () => {
    it("handles stat with only insertions (no deletions)", () => {
      const stat = " src/new.ts | 5 ++++\n 1 file changed, 5 insertions(+)";
      const diff = `diff --git a/src/new.ts b/src/new.ts
--- a/src/new.ts
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+export function hello(): string {
+  return "world";
+}
`;
      const result = validateDiffBeforePush(stat, diff);
      expect(result.valid).toBe(true);
      expect(result.stats.insertions).toBe(5);
      expect(result.stats.deletions).toBe(0);
    });

    it("handles diff with inline comments that are NOT whitespace-only", () => {
      const stat = " src/foo.ts | 3 ++-\n 1 file changed, 2 insertions(+), 1 deletion(-)";
      const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 export function foo() {
-  return null;
+  // TODO: implement properly
+  return "placeholder";
 }
`;
      const result = validateDiffBeforePush(stat, diff);
      expect(result.valid).toBe(true); // Has real code, not whitespace-only
    });

    it("tsconfig.json alone is meta-only", () => {
      const stat = " tsconfig.json | 4 ++\n 1 file changed, 4 insertions(+)";
      const diff = `diff --git a/tsconfig.json b/tsconfig.json
--- a/tsconfig.json
+++ b/tsconfig.json
@@ -1,3 +1,7 @@
 {
   "compilerOptions": {
+    "strict": true,
+    "noImplicitAny": true,
+    "target": "ES2022",
+    "module": "NodeNext"
   }
 }
`;
      const result = validateDiffBeforePush(stat, diff);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("META_ONLY");
    });
  });
});

// ── Exit code constants ───────────────────────────────────────────────────────

describe("new exit code constants", () => {
  it("EXIT_WHITESPACE_ONLY is 8", () => expect(EXIT_WHITESPACE_ONLY).toBe(8));
  it("EXIT_META_ONLY is 9", () => expect(EXIT_META_ONLY).toBe(9));
  it("all codes are unique", () => {
    const codes = [EXIT_SUCCESS, EXIT_NO_CHANGES, EXIT_WHITESPACE_ONLY, EXIT_META_ONLY];
    expect(new Set(codes).size).toBe(codes.length);
  });
});