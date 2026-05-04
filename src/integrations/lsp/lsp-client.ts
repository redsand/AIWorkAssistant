import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";

interface LSPRequest {
  id: number;
  method: string;
  params: unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface DiagnosticItem {
  uri: string;
  severity: "error" | "warning" | "information" | "hint";
  message: string;
  line: number;
  col: number;
  endLine?: number;
  endCol?: number;
  source: string;
  code?: string | number;
  filePath: string;
}

export interface LSPPosition {
  line: number;
  character: number;
}

export interface LSPRange {
  start: LSPPosition;
  end: LSPPosition;
}

export interface HoverResult {
  contents: string;
  range?: LSPRange;
}

export interface DefinitionResult {
  uri: string;
  filePath: string;
  range: LSPRange;
}

export interface ReferenceResult {
  uri: string;
  filePath: string;
  range: LSPRange;
}

export interface WorkspaceSymbol {
  name: string;
  kind: number;
  uri: string;
  filePath: string;
  range: LSPRange;
  containerName?: string;
}

export interface LSPServerConfig {
  command: string;
  args: string[];
  languageId: string;
  extensions: string[];
}

const SERVER_CONFIGS: LSPServerConfig[] = [
  {
    command: "typescript-language-server",
    args: ["--stdio"],
    languageId: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
  },
  {
    command: "pyright-langserver",
    args: ["--stdio"],
    languageId: "python",
    extensions: [".py", ".pyi", ".pyw"],
  },
  {
    command: "gopls",
    args: ["mode", "stdio"],
    languageId: "go",
    extensions: [".go"],
  },
  {
    command: "rust-analyzer",
    args: [],
    languageId: "rust",
    extensions: [".rs"],
  },
  {
    command: "jdtls",
    args: [],
    languageId: "java",
    extensions: [".java"],
  },
  {
    command: "clangd",
    args: [],
    languageId: "c",
    extensions: [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx"],
  },
];

export { SERVER_CONFIGS };

export function severityToString(severity: number): DiagnosticItem["severity"] {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "information";
    case 4:
      return "hint";
    default:
      return "information";
  }
}

export function uriToFilePath(uri: string): string {
  if (uri.startsWith("file:///")) {
    return decodeURIComponent(uri.slice(7)).replace(/^\/([A-Z]:)/, "$1");
  }
  if (uri.startsWith("file://")) {
    return decodeURIComponent(uri.slice(6)).replace(/^\/([A-Z]:)/, "$1");
  }
  return uri;
}

function filePathToUri(filePath: string): string {
  return "file:///" + filePath.replace(/\\/g, "/").replace(/^\/?/, "");
}

export class LSPClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, LSPRequest>();
  private buffer = "";
  private initialized = false;
  private rootUri: string;
  private config: LSPServerConfig;
  private diagnostics = new Map<string, DiagnosticItem[]>();
  private shuttingDown = false;
  private documentVersions = new Map<string, number>();
  private restartAttempts = 0;
  private maxRestartAttempts = 3;
  private restartDelay = 5000;

  constructor(rootPath: string, config: LSPServerConfig) {
    super();
    this.rootUri =
      "file:///" + rootPath.replace(/\\/g, "/").replace(/^\/?/, "");
    if (!this.rootUri.endsWith("/")) this.rootUri += "/";
    this.config = config;
  }

  private backoffDelay(): number {
    return this.restartDelay * Math.pow(2, this.restartAttempts - 1);
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(this.config.command, this.config.args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        });

        if (!this.process.stdout || !this.process.stdin) {
          reject(new Error("Failed to create LSP process streams"));
          return;
        }

        this.process.stdout.on("data", (data: Buffer) => {
          this.handleData(data.toString("utf-8"));
        });

        this.process.stderr?.on("data", () => {});

        this.process.on("error", (err) => {
          this.emit("error", err);
          reject(err);
        });

        this.process.on("exit", () => {
          if (!this.shuttingDown) {
            this.initialized = false;
            if (this.restartAttempts < this.maxRestartAttempts) {
              this.restartAttempts++;
              const delay = this.backoffDelay();
              console.log(
                `[LSP] ${this.config.languageId} server crashed, restarting (attempt ${this.restartAttempts}/${this.maxRestartAttempts})...`,
              );
              setTimeout(async () => {
                try {
                  await this.start();
                  this.restartAttempts = 0;
                } catch {
                  if (this.restartAttempts >= this.maxRestartAttempts) {
                    console.error(
                      `[LSP] ${this.config.languageId} server crashed too many times, giving up`,
                    );
                    this.emit("stopped");
                  }
                }
              }, delay);
            } else {
              console.error(
                `[LSP] ${this.config.languageId} server crashed too many times, giving up`,
              );
              this.emit("stopped");
            }
          }
        });

        this.initialize()
          .then(() => resolve())
          .catch(reject);
      } catch (err) {
        reject(err);
      }
    });
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error("LSP process not running"));
        return;
      }

      const id = ++this.requestId;
      const message = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });

      const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;

      this.pendingRequests.set(id, {
        id,
        method,
        params,
        resolve,
        reject,
      });

      this.process.stdin.write(header + message);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.process?.stdin) return;

    const message = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    });

    const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;
    this.process.stdin.write(header + message);
  }

  private handleData(data: string): void {
    this.buffer += data;

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.substring(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) break;

      const contentLength = parseInt(match[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      if (this.buffer.length < messageEnd) break;

      const messageStr = this.buffer.substring(messageStart, messageEnd);
      this.buffer = this.buffer.substring(messageEnd);

      try {
        const message = JSON.parse(messageStr);
        this.handleMessage(message);
      } catch {}
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (message.id && message.result !== undefined) {
      const request = this.pendingRequests.get(message.id as number);
      if (request) {
        this.pendingRequests.delete(message.id as number);
        request.resolve(message.result);
      }
    } else if (message.id && message.error) {
      const request = this.pendingRequests.get(message.id as number);
      if (request) {
        this.pendingRequests.delete(message.id as number);
        request.reject(
          new Error(
            ((message.error as Record<string, unknown>)?.message as string) ||
              "LSP error",
          ),
        );
      }
    } else if (message.method) {
      if (message.method === "textDocument/publishDiagnostics") {
        this.handleDiagnostics(message.params as Record<string, unknown>);
      }
    }
  }

  private handleDiagnostics(params: Record<string, unknown>): void {
    const uri = params.uri as string;
    const items = (params.diagnostics as Array<Record<string, unknown>>) || [];
    const filePath = uriToFilePath(uri);

    const diagnostics: DiagnosticItem[] = items.map((d) => {
      const range = d.range as Record<string, Record<string, number>>;
      return {
        uri,
        severity: severityToString((d.severity as number) || 3),
        message: d.message as string,
        line: (range?.start?.line ?? 0) + 1,
        col: (range?.start?.character ?? 0) + 1,
        endLine: range?.end ? range.end.line + 1 : undefined,
        endCol: range?.end ? range.end.character + 1 : undefined,
        source: (d.source as string) || this.config.languageId,
        code: d.code as string | number | undefined,
        filePath,
      };
    });

    this.diagnostics.set(filePath, diagnostics);
    this.emit("diagnostics", { filePath, diagnostics });
  }

  private async initialize(): Promise<void> {
    await this.sendRequest("initialize", {
      processId: process.pid,
      rootUri: this.rootUri,
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: true },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          references: {},
          completion: {
            completionItem: { snippetSupport: false },
          },
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
          },
          synchronization: {
            dynamicRegistration: false,
            willSave: false,
            willSaveWaitUntil: false,
            didSave: true,
          },
        },
        workspace: {
          symbol: {},
        },
      },
    });

    this.sendNotification("initialized", {});
    this.initialized = true;
    this.emit("initialized");
  }

  async openFile(filePath: string, content: string): Promise<void> {
    if (!this.initialized) return;
    const absPath = path.resolve(filePath);
    const uri = filePathToUri(absPath);
    this.documentVersions.set(absPath, 1);
    this.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: this.config.languageId,
        version: 1,
        text: content,
      },
    });
  }

  async changeFile(filePath: string, content: string): Promise<void> {
    if (!this.initialized) return;
    const absPath = path.resolve(filePath);
    const uri = filePathToUri(absPath);
    const currentVersion = this.documentVersions.get(absPath) || 1;
    const nextVersion = currentVersion + 1;
    this.documentVersions.set(absPath, nextVersion);
    this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: nextVersion },
      contentChanges: [{ text: content }],
    });
  }

  async closeFile(filePath: string): Promise<void> {
    if (!this.initialized) return;
    const absPath = path.resolve(filePath);
    const uri = filePathToUri(absPath);
    this.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
    this.diagnostics.delete(absPath);
    this.documentVersions.delete(absPath);
  }

  async getDiagnostics(filePath?: string): Promise<DiagnosticItem[]> {
    if (filePath) {
      const absPath = path.resolve(filePath);
      return this.diagnostics.get(absPath) || [];
    }
    const all: DiagnosticItem[] = [];
    for (const items of this.diagnostics.values()) {
      all.push(...items);
    }
    return all;
  }

  async hover(
    filePath: string,
    line: number,
    character: number,
  ): Promise<HoverResult | null> {
    if (!this.initialized) return null;
    const uri = filePathToUri(path.resolve(filePath));
    try {
      const result = (await this.sendRequest("textDocument/hover", {
        textDocument: { uri },
        position: { line: line - 1, character: character - 1 },
      })) as Record<string, unknown> | null;

      if (!result) return null;

      const contents = result.contents;
      if (typeof contents === "string") {
        return { contents };
      }
      if (typeof contents === "object" && contents !== null) {
        const c = contents as Record<string, unknown>;
        if (c.kind === "markdown" && typeof c.value === "string") {
          return { contents: c.value };
        }
        if (typeof c.value === "string") {
          return { contents: c.value };
        }
      }
      return { contents: String(contents) };
    } catch {
      return null;
    }
  }

  async gotoDefinition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<DefinitionResult[]> {
    if (!this.initialized) return [];
    const uri = filePathToUri(path.resolve(filePath));
    try {
      const result = await this.sendRequest("textDocument/definition", {
        textDocument: { uri },
        position: { line: line - 1, character: character - 1 },
      });

      if (!result) return [];

      const locations = Array.isArray(result)
        ? result
        : (result as Record<string, unknown>)?.items
          ? ((result as Record<string, unknown>).items as unknown[])
          : [result];

      return locations
        .filter((loc): loc is Record<string, unknown> => !!loc)
        .map((loc) => {
          const range = loc.range as Record<string, Record<string, number>>;
          return {
            uri: loc.uri as string,
            filePath: uriToFilePath(loc.uri as string),
            range: {
              start: {
                line: (range?.start?.line ?? 0) + 1,
                character: (range?.start?.character ?? 0) + 1,
              },
              end: {
                line: (range?.end?.line ?? 0) + 1,
                character: (range?.end?.character ?? 0) + 1,
              },
            },
          };
        });
    } catch {
      return [];
    }
  }

  async references(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration = true,
  ): Promise<ReferenceResult[]> {
    if (!this.initialized) return [];
    const uri = filePathToUri(path.resolve(filePath));
    try {
      const result = (await this.sendRequest("textDocument/references", {
        textDocument: { uri },
        position: { line: line - 1, character: character - 1 },
        context: { includeDeclaration },
      })) as Array<Record<string, unknown>> | null;

      if (!result || !Array.isArray(result)) return [];

      return result.map((loc) => {
        const range = loc.range as Record<string, Record<string, number>>;
        return {
          uri: loc.uri as string,
          filePath: uriToFilePath(loc.uri as string),
          range: {
            start: {
              line: (range?.start?.line ?? 0) + 1,
              character: (range?.start?.character ?? 0) + 1,
            },
            end: {
              line: (range?.end?.line ?? 0) + 1,
              character: (range?.end?.character ?? 0) + 1,
            },
          },
        };
      });
    } catch {
      return [];
    }
  }

  async workspaceSymbols(query?: string): Promise<WorkspaceSymbol[]> {
    if (!this.initialized) return [];
    try {
      const result = (await this.sendRequest("workspace/symbol", {
        query: query || "",
      })) as Array<Record<string, unknown>> | null;

      if (!result || !Array.isArray(result)) return [];

      return result.map((sym) => {
        const loc = sym.location as Record<string, unknown>;
        const range = loc.range as Record<string, Record<string, number>>;
        return {
          name: sym.name as string,
          kind: sym.kind as number,
          uri: loc.uri as string,
          filePath: uriToFilePath(loc.uri as string),
          range: {
            start: {
              line: (range?.start?.line ?? 0) + 1,
              character: (range?.start?.character ?? 0) + 1,
            },
            end: {
              line: (range?.end?.line ?? 0) + 1,
              character: (range?.end?.character ?? 0) + 1,
            },
          },
          containerName: sym.containerName as string | undefined,
        };
      });
    } catch {
      return [];
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.restartAttempts = this.maxRestartAttempts; // prevent auto-restart during intentional shutdown
    if (this.process) {
      try {
        await this.sendRequest("shutdown", null);
      } catch {}
      this.sendNotification("exit", {});
      this.process.kill();
      this.process = null;
    }
    this.initialized = false;
  }

  isReady(): boolean {
    return this.initialized;
  }

  getLanguageId(): string {
    return this.config.languageId;
  }

  getExtensions(): string[] {
    return this.config.extensions;
  }

  getDocumentVersion(filePath: string): number | undefined {
    return this.documentVersions.get(path.resolve(filePath));
  }
}

export class LSPManager extends EventEmitter {
  private clients = new Map<string, LSPClient>();
  private rootPath: string;
  private allDiagnostics = new Map<string, DiagnosticItem[]>();

  constructor(rootPath?: string) {
    super();
    this.rootPath = rootPath || process.cwd();
  }

  async initialize(customConfigs?: LSPServerConfig[]): Promise<void> {
    const configs = [...SERVER_CONFIGS, ...(customConfigs || [])];

    // Deduplicate by languageId — custom configs take precedence
    const seen = new Set<string>();
    const deduped = configs
      .filter((c) => {
        if (seen.has(c.languageId)) return false;
        seen.add(c.languageId);
        return true;
      })
      .reverse() // reverse so custom (appended) configs override built-in
      .filter((c, i, arr) => arr.findIndex((x) => x.languageId === c.languageId) === i)
      .reverse(); // restore original order

    for (const config of deduped) {
      const command = config.command;
      const available = await this.isCommandAvailable(command);
      if (!available) {
        console.log(
          `[LSP] ${command} not found — skipping ${config.languageId}`,
        );
        continue;
      }

      try {
        const client = new LSPClient(this.rootPath, config);
        client.on("diagnostics", ({ filePath, diagnostics }) => {
          this.allDiagnostics.set(filePath, diagnostics);
          this.emit("diagnostics", { filePath, diagnostics });
        });

        await client.start();
        this.clients.set(config.languageId, client);
        console.log(
          `[LSP] ${config.languageId} language server started (${command})`,
        );
      } catch (err) {
        console.error(
          `[LSP] Failed to start ${config.languageId} server:`,
          err,
        );
      }
    }
  }

  private isCommandAvailable(command: string): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(
        process.platform === "win32" ? "where" : "which",
        [command],
        { stdio: "ignore" },
      );
      proc.on("exit", (code) => resolve(code === 0));
      proc.on("error", () => resolve(false));
    });
  }

  getClient(languageId: string): LSPClient | undefined {
    return this.clients.get(languageId);
  }

  getClientForFile(filePath: string): LSPClient | undefined {
    const ext = path.extname(filePath).toLowerCase();
    for (const client of this.clients.values()) {
      if (client.getExtensions().includes(ext)) {
        return client;
      }
    }
    return undefined;
  }

  async openFile(filePath: string, content?: string): Promise<void> {
    const client = this.getClientForFile(filePath);
    if (!client) return;

    const absPath = path.resolve(filePath);
    const fileContent = content || fs.readFileSync(absPath, "utf-8");
    await client.openFile(absPath, fileContent);
  }

  async changeFile(filePath: string, content: string): Promise<void> {
    const client = this.getClientForFile(filePath);
    if (!client) return;
    await client.changeFile(path.resolve(filePath), content);
  }

  async closeFile(filePath: string): Promise<void> {
    const client = this.getClientForFile(filePath);
    if (!client) return;
    await client.closeFile(path.resolve(filePath));
  }

  async restart(languageId: string): Promise<boolean> {
    const client = this.clients.get(languageId);
    if (!client) return false;

    const config = {
      command: client.getLanguageId() === "typescript" ? "typescript-language-server" : client.getLanguageId(),
      args: [],
      languageId: client.getLanguageId(),
      extensions: client.getExtensions(),
    };

    // Get actual config from SERVER_CONFIGS
    const serverConfig = SERVER_CONFIGS.find((c) => c.languageId === languageId);
    if (serverConfig) {
      config.command = serverConfig.command;
      config.args = serverConfig.args;
    }

    await client.shutdown();

    const newClient = new LSPClient(this.rootPath, config);
    newClient.on("diagnostics", ({ filePath, diagnostics }) => {
      this.allDiagnostics.set(filePath, diagnostics);
      this.emit("diagnostics", { filePath, diagnostics });
    });

    try {
      await newClient.start();
      this.clients.set(languageId, newClient);
      return true;
    } catch {
      return false;
    }
  }

  getDiagnostics(
    filePath?: string,
    severity?: DiagnosticItem["severity"],
  ): DiagnosticItem[] {
    let all: DiagnosticItem[];
    if (filePath) {
      const absPath = path.resolve(filePath);
      all = this.allDiagnostics.get(absPath) || [];
    } else {
      all = [];
      for (const items of this.allDiagnostics.values()) {
        all.push(...items);
      }
    }

    if (severity) {
      return all.filter((d) => d.severity === severity);
    }
    return all;
  }

  getDiagnosticSummary(): {
    errors: number;
    warnings: number;
    total: number;
    files: number;
    items: DiagnosticItem[];
  } {
    const all = this.getDiagnostics();
    return {
      errors: all.filter((d) => d.severity === "error").length,
      warnings: all.filter((d) => d.severity === "warning").length,
      total: all.length,
      files: new Set(all.map((d) => d.filePath)).size,
      items: all,
    };
  }

  async shutdown(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.shutdown();
    }
    this.clients.clear();
  }

  isReady(languageId?: string): boolean {
    if (languageId) {
      const client = this.clients.get(languageId);
      return client?.isReady() || false;
    }
    for (const client of this.clients.values()) {
      if (client.isReady()) return true;
    }
    return false;
  }
}

export const lspManager = new LSPManager();