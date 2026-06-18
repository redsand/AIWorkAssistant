import { describe, it, expect } from "vitest";
import {
  chunkContent,
  structuralCodeChunk,
  markdownChunk,
  fallbackChunk,
} from "../chunker";
import { estimateTokens } from "../budget";
import type { ChunkOptions } from "../types";

const opts = (over: Partial<ChunkOptions> = {}): ChunkOptions => ({
  strategy: "structural",
  maxTokens: 120,
  minTokens: 20,
  overlapTokens: 10,
  ...over,
});

describe("structuralCodeChunk — TypeScript/JavaScript", () => {
  it("keeps a single small function whole in one chunk", () => {
    const code = [
      "import { foo } from './foo';",
      "",
      "export function greet(name: string): string {",
      "  const greeting = `hello ${name}`;",
      "  return greeting;",
      "}",
    ].join("\n");

    const chunks = structuralCodeChunk(code, "typescript", 500, 50, "greet.ts");
    // Whole function body must live in one chunk (not split mid-body).
    const fnChunk = chunks.find((c) => c.content.includes("function greet"));
    expect(fnChunk).toBeDefined();
    expect(fnChunk!.content).toContain("return greeting;");
    expect(fnChunk!.contextHeader).toContain("greet.ts");
    expect(fnChunk!.contextHeader).toContain("function greet");
  });

  it("splits a multi-class file on class boundaries", () => {
    const code = [
      "export class Alpha {",
      "  a() { return 1; }",
      "}",
      "",
      "export class Beta {",
      "  b() { return 2; }",
      "}",
      "",
      "export class Gamma {",
      "  c() { return 3; }",
      "}",
    ].join("\n");

    const chunks = structuralCodeChunk(code, "typescript", 30, 1, "shapes.ts");
    const headers = chunks.map((c) => c.contextHeader).join("\n");
    expect(headers).toContain("class Alpha");
    expect(headers).toContain("class Beta");
    expect(headers).toContain("class Gamma");
    // No chunk should contain two different class declarations.
    for (const c of chunks) {
      const classCount = (c.content.match(/class \w+/g) || []).length;
      expect(classCount).toBeLessThanOrEqual(1);
    }
  });

  it("breaks an oversized class into method-level chunks with the class breadcrumb", () => {
    const body = Array.from({ length: 8 }, (_, i) => `    const v${i} = ${i};`).join(
      "\n",
    );
    const code = [
      "export class BigService {",
      `  methodOne() {`,
      body,
      "    return 1;",
      "  }",
      `  methodTwo() {`,
      body,
      "    return 2;",
      "  }",
      "}",
    ].join("\n");

    const chunks = structuralCodeChunk(code, "typescript", 40, 5, "svc.ts");
    const methodChunk = chunks.find((c) => c.content.includes("methodTwo"));
    expect(methodChunk).toBeDefined();
    // Method chunk keeps its parent class in the breadcrumb.
    expect(methodChunk!.contextHeader).toContain("class BigService");
    expect(methodChunk!.contextHeader).toContain("method methodTwo");
  });

  it("emits a module-scope chunk for the import preamble", () => {
    const code = [
      "import a from 'a';",
      "import b from 'b';",
      "",
      "export function run() { return a + b; }",
    ].join("\n");
    const chunks = structuralCodeChunk(code, "typescript", 20, 1, "m.ts");
    const preamble = chunks.find((c) => c.content.includes("import a"));
    expect(preamble).toBeDefined();
    expect(preamble!.contextHeader).toContain("module scope");
  });

  it("reports 1-based start/end lines that map to the source", () => {
    const code = [
      "function first() {",
      "  return 1;",
      "}",
      "function second() {",
      "  return 2;",
      "}",
    ].join("\n");
    const chunks = structuralCodeChunk(code, "typescript", 15, 1);
    const second = chunks.find((c) => c.content.includes("second"));
    expect(second!.startLine).toBe(4);
    expect(second!.endLine).toBe(6);
  });
});

describe("structuralCodeChunk — Python", () => {
  it("splits on def/class boundaries", () => {
    const code = [
      "import os",
      "",
      "def alpha():",
      "    return 1",
      "",
      "class Beta:",
      "    def gamma(self):",
      "        return 2",
    ].join("\n");
    const chunks = structuralCodeChunk(code, "python", 20, 1, "mod.py");
    const headers = chunks.map((c) => c.contextHeader).join("\n");
    expect(headers).toContain("function alpha");
    expect(headers).toContain("class Beta");
    // Python uses '#' comment headers.
    expect(chunks.every((c) => c.contextHeader === "" || c.contextHeader.startsWith("#"))).toBe(
      true,
    );
  });
});

describe("structuralCodeChunk — fallback for unstructured languages", () => {
  it("chunks JSON config on blank-line blocks", () => {
    const json = [
      "{",
      '  "name": "demo",',
      '  "version": "1.0.0"',
      "}",
    ].join("\n");
    const chunks = structuralCodeChunk(json, "json", 500, 1, "package.json");
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].content).toContain('"name"');
  });

  it("splits YAML into blank-line separated blocks", () => {
    const yaml = [
      "service:",
      "  name: api",
      "  port: 8080",
      "",
      "database:",
      "  host: localhost",
      "  port: 5432",
    ].join("\n");
    const chunks = structuralCodeChunk(yaml, "yaml", 10, 1, "conf.yaml");
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("returns no chunks for empty content", () => {
    expect(structuralCodeChunk("", "typescript", 100, 10)).toEqual([]);
    expect(structuralCodeChunk("   \n  \n", "typescript", 100, 10)).toEqual([]);
  });
});

describe("markdownChunk", () => {
  it("splits on heading boundaries and inherits parent headings", () => {
    const md = [
      "# Title",
      "Intro paragraph.",
      "## Section A",
      "Content A.",
      "### Sub A1",
      "Deep content.",
      "## Section B",
      "Content B.",
    ].join("\n");

    const chunks = markdownChunk(md, 30, 1, "doc.md");
    const sub = chunks.find((c) => c.content.includes("Deep content"));
    expect(sub).toBeDefined();
    // Nested heading inherits its ancestors as a breadcrumb prefix.
    expect(sub!.contextHeader).toContain("Title");
    expect(sub!.contextHeader).toContain("Section A");
    expect(sub!.contextHeader).toContain("Sub A1");

    const sectionB = chunks.find((c) => c.content.includes("Content B"));
    expect(sectionB!.contextHeader).toContain("Title");
    expect(sectionB!.contextHeader).toContain("Section B");
    // Section B is not nested under Section A.
    expect(sectionB!.contextHeader).not.toContain("Section A");
  });

  it("keeps preamble before the first heading as its own chunk", () => {
    const md = ["Some intro before headings.", "", "# Heading", "Body."].join("\n");
    const chunks = markdownChunk(md, 50, 1, "x.md");
    const pre = chunks.find((c) => c.content.includes("Some intro"));
    expect(pre).toBeDefined();
  });

  it("splits an oversized section while repeating the heading breadcrumb", () => {
    const big = Array.from({ length: 60 }, (_, i) => `line ${i} of the section body`).join(
      "\n",
    );
    const md = `## Large\n${big}`;
    const chunks = markdownChunk(md, 30, 1, "big.md");
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.contextHeader).toContain("Large");
    }
  });

  it("returns no chunks for empty content", () => {
    expect(markdownChunk("", 100, 10)).toEqual([]);
  });
});

describe("fallbackChunk", () => {
  it("produces token-aware chunks with overlap", () => {
    const content = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const chunks = fallbackChunk(content, 30, 5, "f.txt");
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk is within (a small margin of) the token budget.
    for (const c of chunks) {
      expect(estimateTokens(c.content)).toBeLessThanOrEqual(31);
    }
    expect(chunks[0].contextHeader).toContain("f.txt");
  });

  it("returns a single chunk when content fits the budget", () => {
    const chunks = fallbackChunk("short text here", 500, 50);
    expect(chunks.length).toBe(1);
    expect(chunks[0].startLine).toBe(1);
  });

  it("returns no chunks for empty content", () => {
    expect(fallbackChunk("", 100, 10)).toEqual([]);
  });
});

describe("chunkContent dispatcher", () => {
  it("routes 'fixed' strategy to the fallback chunker", () => {
    const content = Array.from({ length: 100 }, (_, i) => `tok${i}`).join(" ");
    const chunks = chunkContent(content, "typescript", opts({ strategy: "fixed", maxTokens: 20 }));
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("routes markdown language to the markdown chunker", () => {
    const md = "# A\nbody a\n## B\nbody b";
    const chunks = chunkContent(md, "markdown", opts({ maxTokens: 20, minTokens: 1 }));
    const headers = chunks.map((c) => c.contextHeader).join("\n");
    expect(headers).toContain("A");
    expect(headers).toContain("B");
  });

  it("routes code languages to the structural chunker", () => {
    const code = "export function f() { return 1; }\nexport function g() { return 2; }";
    const chunks = chunkContent(code, "typescript", opts({ maxTokens: 15, minTokens: 1 }));
    const headers = chunks.map((c) => c.contextHeader).join("\n");
    expect(headers).toContain("function f");
    expect(headers).toContain("function g");
  });

  it("returns no chunks for empty content", () => {
    expect(chunkContent("", "typescript", opts())).toEqual([]);
  });
});
