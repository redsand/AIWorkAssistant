import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process before importing
vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({
    stdin: { write: vi.fn() },
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  })),
}));

// Mock fs
vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

// Mock path
vi.mock("path", () => {
  const realPath = require("path");
  return {
    ...realPath,
    resolve: vi.fn((...args: string[]) => realPath.resolve(...args)),
    extname: vi.fn((p: string) => realPath.extname(p)),
  };
});

import {
  LSPClient,
  LSPManager,
  severityToString,
  uriToFilePath,
} from "../../../src/integrations/lsp/lsp-client.js";

describe("severityToString", () => {
  it("maps 1 to error", () => {
    expect(severityToString(1)).toBe("error");
  });

  it("maps 2 to warning", () => {
    expect(severityToString(2)).toBe("warning");
  });

  it("maps 3 to information", () => {
    expect(severityToString(3)).toBe("information");
  });

  it("maps 4 to hint", () => {
    expect(severityToString(4)).toBe("hint");
  });

  it("maps unknown values to information", () => {
    expect(severityToString(0)).toBe("information");
    expect(severityToString(5)).toBe("information");
    expect(severityToString(99)).toBe("information");
  });
});

describe("uriToFilePath", () => {
  it("converts file:/// URI to file path", () => {
    expect(uriToFilePath("file:///path/to/file.ts")).toBe("/path/to/file.ts");
  });

  it("converts file:/// URI with Windows-style path", () => {
    expect(uriToFilePath("file:///C:/Users/test/project/src/index.ts")).toBe(
      "C:/Users/test/project/src/index.ts",
    );
  });

  it("converts file:// URI (two slashes) to file path", () => {
    expect(uriToFilePath("file://path/to/file.ts")).toBe("/path/to/file.ts");
  });

  it("returns URI as-is if not a file URI", () => {
    expect(uriToFilePath("https://example.com")).toBe("https://example.com");
  });

  it("decodes percent-encoded characters", () => {
    expect(uriToFilePath("file:///path%20to/file.ts")).toBe("/path to/file.ts");
  });
});

describe("LSPClient", () => {
  it("sets rootUri and config correctly", () => {
    const config = {
      command: "typescript-language-server",
      args: ["--stdio"],
      languageId: "typescript",
      extensions: [".ts", ".tsx"],
    };
    const client = new LSPClient("/project/root", config);

    expect(client.getLanguageId()).toBe("typescript");
    expect(client.getExtensions()).toEqual([".ts", ".tsx"]);
    expect(client.isReady()).toBe(false);
  });

  it("starts with isReady false before initialization", () => {
    const config = {
      command: "typescript-language-server",
      args: ["--stdio"],
      languageId: "typescript",
      extensions: [".ts"],
    };
    const client = new LSPClient("/project", config);
    expect(client.isReady()).toBe(false);
  });
});

describe("LSPManager", () => {
  let manager: LSPManager;

  beforeEach(() => {
    manager = new LSPManager("/test/project");
  });

  it("returns undefined for non-existent language ID", () => {
    expect(manager.getClient("python")).toBeUndefined();
  });

  it("returns undefined for getClientForFile with unknown extension", () => {
    expect(manager.getClientForFile("test.py")).toBeUndefined();
    expect(manager.getClientForFile("unknown.xyz")).toBeUndefined();
  });

  it("returns false for isReady when no clients are initialized", () => {
    expect(manager.isReady()).toBe(false);
  });

  it("returns false for isReady with specific language ID when not initialized", () => {
    expect(manager.isReady("typescript")).toBe(false);
  });

  it("returns empty diagnostics summary when no clients initialized", () => {
    const summary = manager.getDiagnosticSummary();
    expect(summary.errors).toBe(0);
    expect(summary.warnings).toBe(0);
    expect(summary.total).toBe(0);
    expect(summary.files).toBe(0);
    expect(summary.items).toEqual([]);
  });

  it("returns empty diagnostics array for unknown file", () => {
    const diags = manager.getDiagnostics("/unknown/file.ts");
    expect(diags).toEqual([]);
  });

  it("returns empty diagnostics with severity filter for unknown file", () => {
    const diags = manager.getDiagnostics("/unknown/file.ts", "error");
    expect(diags).toEqual([]);
  });
});