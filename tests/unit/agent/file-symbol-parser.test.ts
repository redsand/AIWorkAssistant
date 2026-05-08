import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  parseFileSymbols,
  parseImports,
  getFileSummary,
  readFileSection,
  getFileChunks,
  type FileSymbol,
} from "../../../src/agent/file-symbol-parser";

describe("file-symbol-parser", () => {
  const tmpDir = path.join(os.tmpdir(), `file-symbol-parser-test-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTmpFile(name: string, content: string): string {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  describe("parseFileSymbols", () => {
    it("parses TypeScript functions and classes", () => {
      const content = `
import { foo } from "bar";

export function hello(): string {
  return "world";
}

export class MyService {
  doThing(): void {}
}

export type Result = string | number;
export interface Config {
  name: string;
}
export const MAX_RETRIES = 3;
export enum Status { Active, Inactive }
`;
      const symbols = parseFileSymbols(content, "typescript");
      const names = symbols.map((s) => s.name);
      expect(names).toContain("hello");
      expect(names).toContain("MyService");
      expect(names).toContain("Result");
      expect(names).toContain("Config");
      expect(names).toContain("MAX_RETRIES");
      expect(names).toContain("Status");
    });

    it("parses Python defs and classes", () => {
      const content = `
import os

def greet(name):
    pass

class User:
    def __init__(self, name):
        self.name = name

async def fetch_data(url):
    pass
`;
      const symbols = parseFileSymbols(content, "python");
      const names = symbols.map((s) => s.name);
      expect(names).toContain("greet");
      expect(names).toContain("User");
      expect(names).toContain("fetch_data");
    });

    it("parses Go funcs and structs", () => {
      const content = `
package main

func Hello() string {
    return "world"
}

func (s *Server) HandleRequest() {
}

type Server struct {
    Port int
}

type Handler interface {
    Serve() error
}
`;
      const symbols = parseFileSymbols(content, "go");
      const names = symbols.map((s) => s.name);
      expect(names).toContain("Hello");
      expect(names).toContain("HandleRequest");
      expect(names).toContain("Server");
      expect(names).toContain("Handler");
    });

    it("parses Rust fns, structs, and traits", () => {
      const content = `
pub fn main() {}

pub struct Config {
    name: String,
}

pub trait Handler {
    fn handle(&self);
}

pub enum Status {
    Active,
}
`;
      const symbols = parseFileSymbols(content, "rust");
      const names = symbols.map((s) => s.name);
      expect(names).toContain("main");
      expect(names).toContain("Config");
      expect(names).toContain("Handler");
      expect(names).toContain("Status");
    });

    it("falls back to generic parsing for unknown languages", () => {
      const content = `
function alpha() {}
class Beta {}
def gamma(): pass
`;
      const symbols = parseFileSymbols(content, "brainfuck");
      const names = symbols.map((s) => s.name);
      expect(names).toContain("alpha");
      expect(names).toContain("Beta");
      expect(names).toContain("gamma");
    });

    it("sets endLine to next symbol start minus 1", () => {
      const content = `
function first() {}
function second() {}
function third() {}
`;
      const symbols = parseFileSymbols(content, "javascript");
      expect(symbols[0].name).toBe("first");
      expect(symbols[0].endLine).toBe(symbols[1].line - 1);
      expect(symbols[1].name).toBe("second");
      expect(symbols[1].endLine).toBe(symbols[2].line - 1);
      expect(symbols[2].name).toBe("third");
      expect(symbols[2].endLine).toBe(-1);
    });

    it("returns empty array for empty content", () => {
      const symbols = parseFileSymbols("", "typescript");
      expect(symbols).toEqual([]);
    });
  });

  describe("parseImports", () => {
    it("parses TypeScript import statements", () => {
      const content = `
import { foo } from "bar";
import * as path from "path";
import "./local-module";
`;
      const imports = parseImports(content);
      expect(imports).toContain("bar");
      expect(imports).toContain("path");
      expect(imports).toContain("./local-module");
    });

    it("parses Python import statements", () => {
      const content = `
import os
from collections import defaultdict
`;
      const imports = parseImports(content);
      expect(imports).toContain("os");
      expect(imports).toContain("collections");
    });

    it("limits imports to 30", () => {
      const lines = Array.from({ length: 50 }, (_, i) => `import { mod${i} } from "pkg${i}";`);
      const imports = parseImports(lines.join("\n"));
      expect(imports.length).toBe(30);
    });
  });

  describe("getFileSummary", () => {
    it("returns summary for a TypeScript file", () => {
      const filePath = writeTmpFile("test.ts", `
import { foo } from "bar";

export function greet(name: string): string {
  return "hello " + name;
}

export class Server {
  start(): void {}
}
`);
      const result = getFileSummary("test.ts", tmpDir);
      if ("error" in result) {
        throw new Error(`Unexpected error: ${result.error}`);
      }
      expect(result.path).toBe("test.ts");
      expect(result.language).toBe("typescript");
      expect(result.totalLines).toBeGreaterThan(0);
      expect(result.sizeKB).toBeGreaterThanOrEqual(0);
      expect(result.symbols.length).toBeGreaterThanOrEqual(2);
      const names = result.symbols.map((s) => s.name);
      expect(names).toContain("greet");
      expect(names).toContain("Server");
    });

    it("returns error for missing file", () => {
      const result = getFileSummary("nonexistent.ts", tmpDir);
      expect("error" in result).toBe(true);
    });

    it("returns error for directory path", () => {
      const dirPath = path.join(tmpDir, "subdir");
      fs.mkdirSync(dirPath, { recursive: true });
      const result = getFileSummary("subdir", tmpDir);
      expect("error" in result).toBe(true);
    });

    it("detects language from file extension", () => {
      const pyFile = writeTmpFile("script.py", "def hello():\n    pass\n");
      const result = getFileSummary("script.py", tmpDir);
      if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);
      expect(result.language).toBe("python");
    });

    it("rejects paths outside project root", () => {
      const result = getFileSummary("../../etc/passwd", tmpDir);
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("Access denied");
      }
    });
  });

  describe("readFileSection", () => {
    it("reads a section by symbol name", () => {
      writeTmpFile("section-test.ts", `
import { foo } from "bar";

export function targetFunc(): void {
  console.log("target");
}

export function otherFunc(): void {
  console.log("other");
}
`);
      const result = readFileSection("section-test.ts", tmpDir, { symbol: "targetFunc" });
      if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);
      expect(result.content).toContain("targetFunc");
      expect(result.symbol).toBe("targetFunc");
      expect(result.totalLines).toBeGreaterThan(0);
    });

    it("reads a section by startLine and endLine", () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
      writeTmpFile("lines-test.ts", lines.join("\n"));
      const result = readFileSection("lines-test.ts", tmpDir, { startLine: 10, endLine: 20 });
      if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);
      expect(result.startLine).toBe(10);
      expect(result.endLine).toBe(20);
      expect(result.content).toContain("10: line 10");
      expect(result.content).toContain("20: line 20");
    });

    it("defaults to 200 lines when startLine given without endLine", () => {
      const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);
      writeTmpFile("long-test.ts", lines.join("\n"));
      const result = readFileSection("long-test.ts", tmpDir, { startLine: 1 });
      if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);
      expect(result.endLine).toBe(200);
    });

    it("caps at 500 lines max", () => {
      const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`);
      writeTmpFile("cap-test.ts", lines.join("\n"));
      const result = readFileSection("cap-test.ts", tmpDir, { startLine: 1, endLine: 1000 });
      if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);
      expect(result.endLine).toBeLessThanOrEqual(500);
    });

    it("returns error for missing symbol", () => {
      writeTmpFile("missing-symbol.ts", "function foo() {}\n");
      const result = readFileSection("missing-symbol.ts", tmpDir, { symbol: "nonExistent" });
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("not found");
        expect(result.error).toContain("Available symbols");
      }
    });

    it("returns error when neither symbol nor startLine provided", () => {
      writeTmpFile("no-params.ts", "function foo() {}\n");
      const result = readFileSection("no-params.ts", tmpDir, {});
      expect("error" in result).toBe(true);
      expect(result.error).toContain("Provide either 'symbol' or 'startLine'");
    });

    it("is case-insensitive for symbol names", () => {
      writeTmpFile("case-test.ts", "export function MyFunction(): void {}\n");
      const result = readFileSection("case-test.ts", tmpDir, { symbol: "myfunction" });
      if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);
      expect(result.symbol).toBe("MyFunction");
    });
  });

  describe("getFileChunks", () => {
    it("returns chunk manifest when no chunkId", () => {
      const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);
      writeTmpFile("chunks-test.ts", lines.join("\n"));
      const result = getFileChunks("chunks-test.ts", tmpDir, 200);
      if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);
      if (!("chunks" in result)) throw new Error("Expected chunks array");
      expect(result.totalLines).toBe(500);
      expect(result.chunkSize).toBe(200);
      expect(result.chunks!.length).toBe(3);
      expect(result.chunks![0]).toEqual({
        id: 1,
        lines: "1-200",
        preview: "line 1",
      });
      expect(result.chunks![2]).toEqual({
        id: 3,
        lines: "401-500",
        preview: "line 401",
      });
    });

    it("returns specific chunk content when chunkId provided", () => {
      const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);
      writeTmpFile("chunk-content-test.ts", lines.join("\n"));
      const result = getFileChunks("chunk-content-test.ts", tmpDir, 200, 2);
      if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);
      if (!("content" in result)) throw new Error("Expected content");
      expect(result.content).toContain("201: line 201");
      expect(result.content).toContain("400: line 400");
      expect(result.content).not.toContain("200: line 200");
    });

    it("clamps chunkSize between 50 and 500", () => {
      const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
      writeTmpFile("clamp-test.ts", lines.join("\n"));
      const result = getFileChunks("clamp-test.ts", tmpDir, 1000);
      if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);
      expect(result.chunkSize).toBe(500);
    });

    it("returns error for non-existent chunkId", () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
      writeTmpFile("bad-chunk-test.ts", lines.join("\n"));
      const result = getFileChunks("bad-chunk-test.ts", tmpDir, 200, 99);
      expect("error" in result).toBe(true);
    });

    it("returns error for missing file", () => {
      const result = getFileChunks("nonexistent.ts", tmpDir, 200);
      expect("error" in result).toBe(true);
    });

    it("returns error for directory", () => {
      fs.mkdirSync(path.join(tmpDir, "dir-test"), { recursive: true });
      const result = getFileChunks("dir-test", tmpDir, 200);
      expect("error" in result).toBe(true);
    });
  });
});