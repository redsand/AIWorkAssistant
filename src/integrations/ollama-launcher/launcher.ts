import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import axios from "axios";
import type {
  ProviderType,
  LaunchOptions,
  LaunchResult,
  OllamaModel,
  OllamaTagsResponse,
} from "./types";
import { resolveExecutor } from "./executors";

export class OllamaLauncher {
  private defaultModel: string;
  private codexCliPath: string;
  private claudeCliPath: string;
  private opencodeCliPath: string;
  private ollamaUrl: string;

  constructor(config?: {
    defaultModel?: string;
    codexCliPath?: string;
    claudeCliPath?: string;
    opencodeCliPath?: string;
    ollamaUrl?: string;
  }) {
    this.defaultModel =
      config?.defaultModel ||
      process.env.OLLAMA_LAUNCHER_DEFAULT_MODEL ||
      process.env.OLLAMA_MODEL ||
      "glm-5.1:cloud";
    this.codexCliPath =
      config?.codexCliPath ||
      process.env.OLLAMA_LAUNCHER_CODEX_CLI_PATH ||
      process.env.CODEX_CLI_PATH ||
      "codex";
    this.claudeCliPath =
      config?.claudeCliPath ||
      process.env.OLLAMA_LAUNCHER_CLAUDE_CLI_PATH ||
      "claude";
    this.opencodeCliPath =
      config?.opencodeCliPath ||
      process.env.OLLAMA_LAUNCHER_OPENCODE_CLI_PATH ||
      "opencode";
    this.ollamaUrl =
      config?.ollamaUrl ||
      process.env.OLLAMA_API_URL ||
      "http://localhost:11434";
  }

  private getCliPath(provider: ProviderType): string {
    switch (provider) {
      case "codex":
        return this.codexCliPath;
      case "claude":
        return this.claudeCliPath;
      case "opencode":
        return this.opencodeCliPath;
    }
  }

  async checkOllama(): Promise<{
    reachable: boolean;
    models: OllamaModel[];
    error?: string;
  }> {
    try {
      const response = await axios.get(`${this.ollamaUrl}/api/tags`, {
        timeout: 3000,
      });
      const data = response.data as OllamaTagsResponse;
      return { reachable: true, models: data.models || [] };
    } catch (err: any) {
      return {
        reachable: false,
        models: [],
        error: err.code || err.message || "Cannot connect to Ollama",
      };
    }
  }

  async checkCliInstalled(provider: ProviderType): Promise<boolean> {
    const cliPath = this.getCliPath(provider);
    const checkCmd = process.platform === "win32" ? "where" : "which";
    return new Promise((resolve) => {
      const proc = spawn(checkCmd, [cliPath], {
        shell: true,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      proc.on("close", (code) => resolve(code === 0));
      proc.on("error", () => resolve(false));
    });
  }

  async launchStream(options: LaunchOptions): Promise<ChildProcess> {
    const executor = resolveExecutor(options.provider);
    const cliPath = this.getCliPath(options.provider);
    const { command, args } = executor.buildCommand(
      options,
      cliPath,
      this.defaultModel,
    );
    const extraEnv = executor.buildEnv(options, this.ollamaUrl);

    const childEnv = {
      ...process.env,
      ...extraEnv,
    };

    // Write prompt to temp file to avoid command-line length limits on Windows
    const promptContent = options.prompt || "";
    if (!promptContent) {
      throw new Error("No prompt provided to Ollama launcher — cannot start agent");
    }
    const promptFile = path.join(os.tmpdir(), `aicoder-prompt-${Date.now()}.md`);
    fs.writeFileSync(promptFile, promptContent, "utf-8");

    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: childEnv,
      stdio: ["pipe", "pipe", "inherit"],
      shell: process.platform === "win32",
      windowsHide: true,
    });

    // Pipe prompt via stdin instead of embedding in args
    child.stdin?.write(promptContent);
    child.stdin?.end();

    // Propagate SIGINT to child
    const onSigInt = () => {
      child.kill("SIGINT");
    };
    process.on("SIGINT", onSigInt);
    child.on("close", () => {
      process.removeListener("SIGINT", onSigInt);
      try { fs.unlinkSync(promptFile); } catch {}
    });

    return child;
  }

  async launch(options: LaunchOptions): Promise<LaunchResult> {
    const executor = resolveExecutor(options.provider);
    const cliPath = this.getCliPath(options.provider);
    const { command, args } = executor.buildCommand(
      options,
      cliPath,
      this.defaultModel,
    );
    const extraEnv = executor.buildEnv(options, this.ollamaUrl);

    const childEnv = {
      ...process.env,
      ...extraEnv,
    };

    // Write prompt to temp file to avoid command-line length limits on Windows
    const promptContent = options.prompt || "";
    if (!promptContent) {
      throw new Error("No prompt provided to Ollama launcher — cannot start agent");
    }
    const promptFile = path.join(os.tmpdir(), `aicoder-prompt-${Date.now()}.md`);
    fs.writeFileSync(promptFile, promptContent, "utf-8");

    const startTime = Date.now();
    const cmdStr = `${command} ${args.join(" ")}`;

    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: options.cwd || process.cwd(),
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      // Pipe prompt via stdin instead of embedding in args
      child.stdin?.write(promptContent);
      child.stdin?.end();

      child.on("close", (code) => {
        try { fs.unlinkSync(promptFile); } catch {}
        resolve({
          success: code === 0,
          exitCode: code,
          duration: Date.now() - startTime,
          provider: options.provider,
          command: cmdStr,
          stdout: stdout.substring(0, 50000),
          stderr: stderr.substring(0, 10000),
        });
      });

      child.on("error", (err) => {
        try { fs.unlinkSync(promptFile); } catch {}
        resolve({
          success: false,
          exitCode: -1,
          duration: Date.now() - startTime,
          provider: options.provider,
          command: cmdStr,
          error: err.message,
        });
      });

      // Propagate SIGINT
      const onSigInt = () => {
        child.kill("SIGINT");
      };
      process.on("SIGINT", onSigInt);
      child.on("close", () => {
        process.removeListener("SIGINT", onSigInt);
      });
    });
  }

  async waitForExit(child: ChildProcess): Promise<number | null> {
    return new Promise((resolve) => {
      child.on("close", (code) => resolve(code));
      child.on("error", () => resolve(-1));
    });
  }
}