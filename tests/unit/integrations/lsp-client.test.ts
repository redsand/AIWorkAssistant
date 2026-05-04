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

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock("path", async () => {
  const realPath = await vi.importActual<typeof import("path")>("path");
  return {
    ...realPath,
    resolve: vi.fn((...args: string[]) => realPath.resolve(...args)),
    extname: vi.fn((p: string) => realPath.extname(p)),
  };
});

import * as fs from "fs";
import * as path from "path";
import {
  LSPClient,
  LSPManager,
  SERVER_CONFIGS,
  severityToString,
  uriToFilePath,
} from "../../../src/integrations/lsp/lsp-client.js";
import { loadProjectConfig } from "../../../src/integrations/lsp/lsp-config.js";

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

describe("SERVER_CONFIGS", () => {
  it("includes TypeScript config", () => {
    const ts = SERVER_CONFIGS.find((c) => c.languageId === "typescript");
    expect(ts).toBeDefined();
    expect(ts!.command).toBe("typescript-language-server");
    expect(ts!.args).toEqual(["--stdio"]);
    expect(ts!.extensions).toContain(".ts");
  });

  it("includes Python config", () => {
    const py = SERVER_CONFIGS.find((c) => c.languageId === "python");
    expect(py).toBeDefined();
    expect(py!.command).toBe("pyright-langserver");
    expect(py!.extensions).toContain(".py");
  });

  it("includes Go config", () => {
    const go = SERVER_CONFIGS.find((c) => c.languageId === "go");
    expect(go).toBeDefined();
    expect(go!.command).toBe("gopls");
    expect(go!.extensions).toContain(".go");
  });

  it("includes Rust config", () => {
    const rs = SERVER_CONFIGS.find((c) => c.languageId === "rust");
    expect(rs).toBeDefined();
    expect(rs!.command).toBe("rust-analyzer");
    expect(rs!.extensions).toContain(".rs");
  });

  it("includes Java config", () => {
    const java = SERVER_CONFIGS.find((c) => c.languageId === "java");
    expect(java).toBeDefined();
    expect(java!.command).toBe("jdtls");
    expect(java!.extensions).toContain(".java");
  });

  it("includes C/C++ config", () => {
    const c = SERVER_CONFIGS.find((c) => c.languageId === "c");
    expect(c).toBeDefined();
    expect(c!.command).toBe("clangd");
    expect(c!.extensions).toContain(".cpp");
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

  describe("changeFile", () => {
    it("exists as a method", () => {
      const config = {
        command: "typescript-language-server",
        args: ["--stdio"],
        languageId: "typescript",
        extensions: [".ts"],
      };
      const client = new LSPClient("/project", config);
      expect(typeof client.changeFile).toBe("function");
    });

    it("increments document version on changeFile", async () => {
      const config = {
        command: "typescript-language-server",
        args: ["--stdio"],
        languageId: "typescript",
        extensions: [".ts"],
      };
      const client = new LSPClient("/project", config);
      // Mark as initialized so openFile/changeFile don't bail early
      (client as any).initialized = true;
      // openFile sets version to 1
      await client.openFile("/project/test.ts", "const x = 1;");
      expect(client.getDocumentVersion("/project/test.ts")).toBe(1);

      // changeFile increments version
      await client.changeFile("/project/test.ts", "const x = 2;");
      expect(client.getDocumentVersion("/project/test.ts")).toBe(2);

      // another changeFile
      await client.changeFile("/project/test.ts", "const x = 3;");
      expect(client.getDocumentVersion("/project/test.ts")).toBe(3);
    });
  });

  describe("closeFile", () => {
    it("exists as a method", () => {
      const config = {
        command: "typescript-language-server",
        args: ["--stdio"],
        languageId: "typescript",
        extensions: [".ts"],
      };
      const client = new LSPClient("/project", config);
      expect(typeof client.closeFile).toBe("function");
    });

    it("no-ops when not initialized", async () => {
      const config = {
        command: "typescript-language-server",
        args: ["--stdio"],
        languageId: "typescript",
        extensions: [".ts"],
      };
      const client = new LSPClient("/project", config);
      // Should not throw
      await client.closeFile("/project/test.ts");
    });

    it("clears diagnostics for the closed file", async () => {
      const config = {
        command: "typescript-language-server",
        args: ["--stdio"],
        languageId: "typescript",
        extensions: [".ts"],
      };
      const client = new LSPClient("/project", config);
      // Manually add diagnostics to simulate receiving them
      client["diagnostics"].set("/project/test.ts", [
        {
          uri: "file:///project/test.ts",
          severity: "error",
          message: "test error",
          line: 1,
          col: 1,
          source: "typescript",
          filePath: "/project/test.ts",
        },
      ]);

      // closeFile should clear diagnostics (even though not initialized, it clears the map)
      await client.closeFile("/project/test.ts");
      const diags = await client.getDiagnostics("/project/test.ts");
      expect(diags).toEqual([]);
    });

    it("removes document version on closeFile", async () => {
      const config = {
        command: "typescript-language-server",
        args: ["--stdio"],
        languageId: "typescript",
        extensions: [".ts"],
      };
      const client = new LSPClient("/project", config);
      (client as any).initialized = true;
      await client.openFile("/project/test.ts", "const x = 1;");
      await client.closeFile("/project/test.ts");
      expect(client.getDocumentVersion("/project/test.ts")).toBeUndefined();
    });
  });

  it("has hover method", () => {
    const config = {
      command: "typescript-language-server",
      args: ["--stdio"],
      languageId: "typescript",
      extensions: [".ts", ".tsx"],
    };
    const client = new LSPClient("/project", config);
    expect(typeof client.hover).toBe("function");
  });

  it("has gotoDefinition method", () => {
    const config = {
      command: "typescript-language-server",
      args: ["--stdio"],
      languageId: "typescript",
      extensions: [".ts", ".tsx"],
    };
    const client = new LSPClient("/project", config);
    expect(typeof client.gotoDefinition).toBe("function");
  });

  it("has references method", () => {
    const config = {
      command: "typescript-language-server",
      args: ["--stdio"],
      languageId: "typescript",
      extensions: [".ts", ".tsx"],
    };
    const client = new LSPClient("/project", config);
    expect(typeof client.references).toBe("function");
  });

  it("has workspaceSymbols method", () => {
    const config = {
      command: "typescript-language-server",
      args: ["--stdio"],
      languageId: "typescript",
      extensions: [".ts", ".tsx"],
    };
    const client = new LSPClient("/project", config);
    expect(typeof client.workspaceSymbols).toBe("function");
  });

  it("has shutdown method", () => {
    const config = {
      command: "typescript-language-server",
      args: ["--stdio"],
      languageId: "typescript",
      extensions: [".ts", ".tsx"],
    };
    const client = new LSPClient("/project", config);
    expect(typeof client.shutdown).toBe("function");
  });

  it("has restart method on LSPManager", () => {
    const manager = new LSPManager("/test/project");
    expect(typeof manager.restart).toBe("function");
  });
});

describe("Auto-recovery", () => {
  it("has backoffDelay that increases exponentially", () => {
    const config = {
      command: "typescript-language-server",
      args: ["--stdio"],
      languageId: "typescript",
      extensions: [".ts"],
    };
    const client = new LSPClient("/project", config);
    // Access private method via any for testing
    const backoff = (client as any).backoffDelay.bind(client);

    // restartAttempts starts at 0, so first backoff would be delay * 2^0 = 5000
    (client as any).restartAttempts = 1;
    expect(backoff()).toBe(5000);

    (client as any).restartAttempts = 2;
    expect(backoff()).toBe(10000);

    (client as any).restartAttempts = 3;
    expect(backoff()).toBe(20000);
  });

  it("maxRestartAttempts defaults to 3", () => {
    const config = {
      command: "typescript-language-server",
      args: ["--stdio"],
      languageId: "typescript",
      extensions: [".ts"],
    };
    const client = new LSPClient("/project", config);
    expect((client as any).maxRestartAttempts).toBe(3);
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

  it("getClient returns undefined for unconfigured language", () => {
    expect(manager.getClient("typescript")).toBeUndefined();
    expect(manager.getClient("python")).toBeUndefined();
  });

  it("shutdown succeeds even with no clients", async () => {
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });

  it("getClientForFile routes .py to python client extension match", () => {
    // With no clients initialized, should return undefined
    expect(manager.getClientForFile("test.py")).toBeUndefined();
  });
});

describe("LSPManager edge cases", () => {
  it("handles files with no extension", () => {
    const manager = new LSPManager("/test/project");
    expect(manager.getClientForFile("Makefile")).toBeUndefined();
    expect(manager.getClientForFile("README")).toBeUndefined();
  });

  it("handles dotfiles correctly", () => {
    const manager = new LSPManager("/test/project");
    expect(manager.getClientForFile(".eslintrc.js")).toBeUndefined();
    expect(manager.getClientForFile(".gitignore")).toBeUndefined();
  });

  it("getDiagnostics returns empty array for non-ts file", () => {
    const manager = new LSPManager("/test/project");
    const diags = manager.getDiagnostics("/test/project/src/main.py");
    expect(diags).toEqual([]);
  });

  it("changeFile and closeFile exist on LSPManager", () => {
    const manager = new LSPManager("/test/project");
    expect(typeof manager.changeFile).toBe("function");
    expect(typeof manager.closeFile).toBe("function");
  });
});

describe("loadProjectConfig", () => {
  it("returns null for missing file", () => {
    const result = loadProjectConfig("/nonexistent/path");
    expect(result).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not json");
    const result = loadProjectConfig("/test");
    expect(result).toBeNull();
    vi.restoreAllMocks();
  });

  it("returns null for config missing command", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        servers: [{ languageId: "mylang", args: [], extensions: [".myl"] }],
      }),
    );
    const result = loadProjectConfig("/test");
    expect(result).toBeNull();
    vi.restoreAllMocks();
  });

  it("returns null for config missing languageId", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        servers: [{ command: "my-lsp", args: [], extensions: [".myl"] }],
      }),
    );
    const result = loadProjectConfig("/test");
    expect(result).toBeNull();
    vi.restoreAllMocks();
  });

  it("returns config for valid .lspconfig.json", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        servers: [
          {
            command: "my-custom-lsp",
            args: ["--stdio"],
            languageId: "mylang",
            extensions: [".myl"],
          },
        ],
      }),
    );
    const result = loadProjectConfig("/test");
    expect(result).not.toBeNull();
    expect(result!.servers).toHaveLength(1);
    expect(result!.servers[0].command).toBe("my-custom-lsp");
    expect(result!.servers[0].languageId).toBe("mylang");
    vi.restoreAllMocks();
  });
});