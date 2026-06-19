// Verifies codebaseIndexer.addFile() produces structure-aware chunks (issue
// #228): stored chunk content carries a structural context header, and the
// header's symbol context flows into the searchable keyword set.
import { describe, it, expect, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { codebaseIndexer } from "../codebase-indexer";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cbi-test-"));

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

function writeFile(name: string, content: string): string {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

describe("codebaseIndexer.addFile — structure-aware chunking", () => {
  it("stores a single function file with a structural context header", () => {
    const file = writeFile(
      "single.ts",
      [
        "export function computeTotal(items: number[]): number {",
        "  return items.reduce((a, b) => a + b, 0);",
        "}",
      ].join("\n"),
    );

    const result = codebaseIndexer.addFile(file, tmpRoot);
    expect(result).not.toBeNull();
    expect(result!.path).toBe("single.ts");

    const hits = codebaseIndexer.search("computeTotal", {
      filePath: "single.ts",
    });
    expect(hits.length).toBeGreaterThan(0);
    // Stored content includes the prepended context header comment.
    expect(hits[0].content).toContain("File: single.ts");
    expect(hits[0].content).toContain("function computeTotal");
    expect(hits[0].content).toContain("items.reduce");
  });

  it("splits a multi-class file so each class is independently retrievable", () => {
    const file = writeFile(
      "shapes.ts",
      [
        "export class Circle {",
        "  area(r: number) { return 3.14 * r * r; }",
        "}",
        "",
        "export class Square {",
        "  area(s: number) { return s * s; }",
        "}",
      ].join("\n"),
    );

    codebaseIndexer.addFile(file, tmpRoot);

    const circle = codebaseIndexer.search("Circle", { filePath: "shapes.ts" });
    const square = codebaseIndexer.search("Square", { filePath: "shapes.ts" });
    // Both classes remain retrievable after structure-aware indexing.
    expect(circle.length).toBeGreaterThan(0);
    expect(square.length).toBeGreaterThan(0);
    expect(circle[0].content).toContain("class Circle");
    expect(square[0].content).toContain("class Square");
  });

  it("keeps each function body intact in a multi-function file (no mid-body split)", () => {
    const file = writeFile(
      "multi.ts",
      [
        "export function alpha(x: number): number {",
        "  const alphaMarker = x * 2;",
        "  return alphaMarker + 1;",
        "}",
        "",
        "export function beta(y: number): number {",
        "  const betaMarker = y * 3;",
        "  return betaMarker + 2;",
        "}",
        "",
        "export function gamma(z: number): number {",
        "  const gammaMarker = z * 4;",
        "  return gammaMarker + 3;",
        "}",
      ].join("\n"),
    );

    codebaseIndexer.addFile(file, tmpRoot);

    // For each function, the chunk holding its signature must also hold its
    // body marker. If the chunker had sliced mid-body, the marker would land in
    // a different chunk than the signature.
    const fns: Array<[string, string]> = [
      ["function alpha", "alphaMarker"],
      ["function beta", "betaMarker"],
      ["function gamma", "gammaMarker"],
    ];
    for (const [sig, marker] of fns) {
      const hits = codebaseIndexer.search(marker, { filePath: "multi.ts" });
      expect(hits.length).toBeGreaterThan(0);
      const chunk = hits.find((h) => h.content.includes(sig));
      expect(chunk).toBeDefined();
      expect(chunk!.content).toContain(marker);
    }
  });

  it("returns valid 1-based line ranges for chunks", () => {
    const file = writeFile(
      "lines.ts",
      [
        "export function first() {",
        "  return 1;",
        "}",
        "",
        "export function second() {",
        "  return 2;",
        "}",
      ].join("\n"),
    );

    codebaseIndexer.addFile(file, tmpRoot);
    const hits = codebaseIndexer.search("second", { filePath: "lines.ts" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].startLine).toBeGreaterThanOrEqual(1);
    expect(hits[0].endLine).toBeGreaterThanOrEqual(hits[0].startLine);
  });
});
