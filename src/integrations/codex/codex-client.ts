import { spawn } from "child_process";

interface CodexResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  duration: number;
}

class CodexClient {
  private codexPath: string;

  constructor() {
    this.codexPath = process.env.CODEX_CLI_PATH || "codex";
  }

  isConfigured(): boolean {
    return !!(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY);
  }

  async runPrompt(
    prompt: string,
    options: {
      cwd?: string;
      model?: string;
      approvalMode?: "suggest" | "auto-edit" | "full-auto";
      maxTokens?: number;
    } = {},
  ): Promise<CodexResult> {
    const cwd = options.cwd || process.cwd();
    const model = options.model || process.env.CODEX_MODEL || "o4-mini";
    const approvalMode = options.approvalMode || "suggest";

    const args: string[] = [];

    args.push("--model", model);
    args.push("--approval-mode", approvalMode);

    if (options.maxTokens) {
      args.push("--max-tokens", String(options.maxTokens));
    }

    args.push("-q", prompt);

    const startTime = Date.now();

    return new Promise((resolve) => {
      const proc = spawn(this.codexPath, args, {
        cwd,
        env: {
          ...process.env,
          OPENAI_API_KEY:
            process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || "",
        },
        stdio: ["pipe", "pipe", "pipe"],
        shell: true,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        resolve({
          success: code === 0,
          exitCode: code,
          stdout: stdout.substring(0, 50000),
          stderr: stderr.substring(0, 10000),
          duration: Date.now() - startTime,
        });
      });

      proc.on("error", (err) => {
        resolve({
          success: false,
          exitCode: -1,
          stdout: "",
          stderr: err.message,
          duration: Date.now() - startTime,
        });
      });

      proc.stdin.end();
    });
  }
}

export const codexClient = new CodexClient();
