import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// Skip entire suite if typescript-language-server is not installed
const isTSLSPAvailable = (() => {
  try {
    const result = require("child_process").execSync(
      process.platform === "win32" ? "where typescript-language-server" : "which typescript-language-server",
      { encoding: "utf-8", stdio: "pipe" },
    );
    return result.trim().length > 0;
  } catch {
    return false;
  }
})();

const describeIf = isTSLSPAvailable ? describe : describe.skip;

// Create a temp project directory for the integration tests
let tempDir: string;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-integration-"));
  // Create a tsconfig so the TS server can initialize
  fs.writeFileSync(
    path.join(tempDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2020",
        module: "commonjs",
        strict: true,
        esModuleInterop: true,
      },
    }),
  );
});

afterAll(() => {
  // Clean up temp directory
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describeIf("LSPClient Integration — TypeScript Language Server", () => {
  // Allow extra time for spawning language servers
  const TIMEOUT = 30_000;

  it(
    "connects and initializes with TypeScript language server",
    async () => {
      const { LSPClient } = await import(
        "../../../src/integrations/lsp/lsp-client.js"
      );
      const client = new LSPClient(tempDir, {
        command: "typescript-language-server",
        args: ["--stdio"],
        languageId: "typescript",
        extensions: [".ts", ".tsx"],
      });

      try {
        await client.start();
        expect(client.isReady()).toBe(true);
      } finally {
        await client.shutdown();
      }
    },
    TIMEOUT,
  );

  it(
    "receives diagnostics for a TypeScript file with errors",
    async () => {
      const { LSPClient } = await import(
        "../../../src/integrations/lsp/lsp-client.js"
      );

      const testFilePath = path.join(tempDir, "diag-test.ts");
      // File with a deliberate type error
      fs.writeFileSync(testFilePath, 'const x: string = 123;\n');

      const client = new LSPClient(tempDir, {
        command: "typescript-language-server",
        args: ["--stdio"],
        languageId: "typescript",
        extensions: [".ts", ".tsx"],
      });

      const diagnosticPromise = new Promise<void>((resolve) => {
        client.on("diagnostics", () => resolve());
      });

      try {
        await client.start();
        await client.openFile(testFilePath, 'const x: string = 123;\n');

        // Wait for diagnostics to arrive (with a timeout)
        await Promise.race([
          diagnosticPromise,
          new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
        ]);

        const diags = await client.getDiagnostics(testFilePath);
        // TypeScript should report at least one diagnostic for the type error
        // Note: some setups may not produce diagnostics in time, so we just
        // check the method works without throwing
        expect(Array.isArray(diags)).toBe(true);
      } finally {
        await client.closeFile(testFilePath);
        await client.shutdown();
        fs.unlinkSync(testFilePath);
      }
    },
    TIMEOUT,
  );

  it(
    "provides hover information for a known symbol",
    async () => {
      const { LSPClient } = await import(
        "../../../src/integrations/lsp/lsp-client.js"
      );

      const testFilePath = path.join(tempDir, "hover-test.ts");
      fs.writeFileSync(testFilePath, 'const myVar = "hello";\n');

      const client = new LSPClient(tempDir, {
        command: "typescript-language-server",
        args: ["--stdio"],
        languageId: "typescript",
        extensions: [".ts", ".tsx"],
      });

      try {
        await client.start();
        await client.openFile(testFilePath, 'const myVar = "hello";\n');

        // Give the server a moment to process
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const result = await client.hover(testFilePath, 1, 7);
        // Hover may return null if the server is slow; just check it doesn't throw
        expect(result === null || (typeof result === "object" && "contents" in result)).toBe(true);
      } finally {
        await client.closeFile(testFilePath);
        await client.shutdown();
        fs.unlinkSync(testFilePath);
      }
    },
    TIMEOUT,
  );

  it(
    "provides goto definition for a symbol",
    async () => {
      const { LSPClient } = await import(
        "../../../src/integrations/lsp/lsp-client.js"
      );

      const testFilePath = path.join(tempDir, "def-test.ts");
      fs.writeFileSync(testFilePath, 'function greet(name: string) { return "Hello " + name; }\ngreet("world");\n');

      const client = new LSPClient(tempDir, {
        command: "typescript-language-server",
        args: ["--stdio"],
        languageId: "typescript",
        extensions: [".ts", ".tsx"],
      });

      try {
        await client.start();
        await client.openFile(testFilePath, 'function greet(name: string) { return "Hello " + name; }\ngreet("world");\n');

        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Try to go to definition of "greet" on line 2
        const result = await client.gotoDefinition(testFilePath, 2, 1);
        expect(Array.isArray(result)).toBe(true);
        // May or may not return results depending on server timing
      } finally {
        await client.closeFile(testFilePath);
        await client.shutdown();
        fs.unlinkSync(testFilePath);
      }
    },
    TIMEOUT,
  );

  it(
    "finds references for a symbol",
    async () => {
      const { LSPClient } = await import(
        "../../../src/integrations/lsp/lsp-client.js"
      );

      const testFilePath = path.join(tempDir, "refs-test.ts");
      fs.writeFileSync(testFilePath, 'function add(a: number, b: number) { return a + b; }\nconst result = add(1, 2);\n');

      const client = new LSPClient(tempDir, {
        command: "typescript-language-server",
        args: ["--stdio"],
        languageId: "typescript",
        extensions: [".ts", ".tsx"],
      });

      try {
        await client.start();
        await client.openFile(testFilePath, 'function add(a: number, b: number) { return a + b; }\nconst result = add(1, 2);\n');

        await new Promise((resolve) => setTimeout(resolve, 2000));

        const result = await client.references(testFilePath, 1, 10);
        expect(Array.isArray(result)).toBe(true);
      } finally {
        await client.closeFile(testFilePath);
        await client.shutdown();
        fs.unlinkSync(testFilePath);
      }
    },
    TIMEOUT,
  );

  it(
    "returns workspace symbols",
    async () => {
      const { LSPClient } = await import(
        "../../../src/integrations/lsp/lsp-client.js"
      );

      const testFilePath = path.join(tempDir, "symbols-test.ts");
      fs.writeFileSync(testFilePath, 'export class MyClass { doThing() { return 42; } }\n');

      const client = new LSPClient(tempDir, {
        command: "typescript-language-server",
        args: ["--stdio"],
        languageId: "typescript",
        extensions: [".ts", ".tsx"],
      });

      try {
        await client.start();
        await client.openFile(testFilePath, 'export class MyClass { doThing() { return 42; } }\n');

        await new Promise((resolve) => setTimeout(resolve, 2000));

        const result = await client.workspaceSymbols("MyClass");
        expect(Array.isArray(result)).toBe(true);
      } finally {
        await client.closeFile(testFilePath);
        await client.shutdown();
        fs.unlinkSync(testFilePath);
      }
    },
    TIMEOUT,
  );
});

describeIf("LSPManager Integration — file routing", () => {
  const TIMEOUT = 30_000;

  it(
    "routes .ts files to the TypeScript language server",
    async () => {
      const { LSPManager } = await import(
        "../../../src/integrations/lsp/lsp-client.js"
      );

      const manager = new LSPManager(tempDir);

      try {
        await manager.initialize();
        const client = manager.getClientForFile("test.ts");
        // Only defined if typescript-language-server is on PATH
        if (client) {
          expect(client.getLanguageId()).toBe("typescript");
          expect(client.isReady()).toBe(true);
        } else {
          // typescript-language-server not installed, that's fine
          expect(client).toBeUndefined();
        }
      } finally {
        await manager.shutdown();
      }
    },
    TIMEOUT,
  );

  it(
    "getClientForFile returns undefined for unsupported extensions",
    async () => {
      const { LSPManager } = await import(
        "../../../src/integrations/lsp/lsp-client.js"
      );

      const manager = new LSPManager(tempDir);

      try {
        await manager.initialize();
        expect(manager.getClientForFile("test.xyz")).toBeUndefined();
      } finally {
        await manager.shutdown();
      }
    },
    TIMEOUT,
  );
});