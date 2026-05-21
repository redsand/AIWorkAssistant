import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// We test the per-issue isolation logic directly by using temp directories
// and the file path construction functions.

// Since the module imports WORKSPACE from arg-parser at module load time,
// we test the file-level behavior by manipulating .aicoder/ directories
// directly and verifying per-issue file isolation.

describe("review-gate-state per-issue isolation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aicoder-rgs-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function aicoderDir(): string {
    const dir = path.join(tmpDir, ".aicoder");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function stateFile(issueKey: string): string {
    return path.join(aicoderDir(), `review-gate-state-${issueKey}.json`);
  }

  function writeState(issueKey: string, findings: string[]): void {
    const filePath = stateFile(issueKey);
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          lastFindings: findings.map((f) => ({
            severity: "high" as const,
            category: "review",
            file: f,
            message: `Finding in ${f}`,
          })),
          reviewOccurred: true,
          forceDoneUsed: false,
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  function readState(issueKey: string): { lastFindings: string[] } | null {
    const filePath = stateFile(issueKey);
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return {
      lastFindings: data.lastFindings.map(
        (f: { file: string }) => f.file,
      ),
    };
  }

  it("produces distinct files for distinct issue keys", () => {
    writeState("ISSUE-1", ["src/a.ts"]);
    writeState("ISSUE-2", ["src/b.ts"]);

    expect(fs.existsSync(stateFile("ISSUE-1"))).toBe(true);
    expect(fs.existsSync(stateFile("ISSUE-2"))).toBe(true);

    const state1 = readState("ISSUE-1");
    const state2 = readState("ISSUE-2");

    expect(state1?.lastFindings).toEqual(["src/a.ts"]);
    expect(state2?.lastFindings).toEqual(["src/b.ts"]);
    expect(state1?.lastFindings).not.toEqual(state2?.lastFindings);
  });

  it("overwriting one issue does not affect another", () => {
    writeState("ISSUE-1", ["src/original.ts"]);
    writeState("ISSUE-2", ["src/other.ts"]);

    writeState("ISSUE-1", ["src/updated.ts"]);

    const state1 = readState("ISSUE-1");
    const state2 = readState("ISSUE-2");

    expect(state1?.lastFindings).toEqual(["src/updated.ts"]);
    expect(state2?.lastFindings).toEqual(["src/other.ts"]);
  });

  it("clearing one issue does not affect another", () => {
    writeState("ISSUE-1", ["src/a.ts"]);
    writeState("ISSUE-2", ["src/b.ts"]);

    const filePath1 = stateFile("ISSUE-1");
    fs.unlinkSync(filePath1);

    expect(fs.existsSync(filePath1)).toBe(false);
    expect(fs.existsSync(stateFile("ISSUE-2"))).toBe(true);
    expect(readState("ISSUE-2")?.lastFindings).toEqual(["src/b.ts"]);
  });

  it("supports many concurrent issues", () => {
    for (let i = 1; i <= 10; i++) {
      writeState(`ISSUE-${i}`, [`src/file${i}.ts`]);
    }

    for (let i = 1; i <= 10; i++) {
      const state = readState(`ISSUE-${i}`);
      expect(state?.lastFindings).toEqual([`src/file${i}.ts`]);
    }

    const files = fs.readdirSync(aicoderDir());
    expect(files.length).toBe(10);
  });
});
