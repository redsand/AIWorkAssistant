/**
 * Agent process execution.
 *
 * Spawns the coding agent (claude, codex, opencode), streams its output,
 * detects the FIN completion token, and returns a typed RunResult.
 * No process.exit() calls — errors surface as RunResult with exitCode -1.
 */

import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import type { RunResult, PipelineLogger } from "./types";
import type { ProviderType } from "../integrations/ollama-launcher";
import { OllamaLauncher } from "../integrations/ollama-launcher";
import { createStreamFormatter } from "../integrations/ollama-launcher/stream-formatter";

const noop: PipelineLogger = {
  logGit: () => {},
  logError: () => {},
  logConfig: () => {},
  logWork: () => {},
  logAgent: () => {},
};

export interface AgentConfig {
  agent: ProviderType;
  workspace: string;
  model?: string;
  apiProvider?: "opencode" | "zai" | null;
  debug?: boolean;
  ollamaUrl?: string;
  finToken?: string;
  finRegex?: RegExp;
  finLineRegex?: RegExp;
}

function buildFinRegexes(token: string): { finRegex: RegExp; finLineRegex: RegExp } {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    finRegex: new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`),
    finLineRegex: new RegExp(`^${escaped}$`, "m"),
  };
}

function isClaudeModel(model: string): boolean {
  return model === "opus" || model === "sonnet" || model === "haiku" || model.startsWith("claude-");
}

function quoteWindowsShellArg(arg: string): string {
  if (!/[\s"]/u.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function prepareSpawnArgs(args: string[]): string[] {
  return process.platform === "win32" ? args.map(quoteWindowsShellArg) : args;
}

const OPENCODE_GO_MODEL_IDS: Record<string, string> = {
  "glm-5": "opencode-go/glm-5",
  "glm-5.1": "opencode-go/glm-5.1",
  "kimi k2.5": "opencode-go/kimi-k2.5",
  "kimi k2.6": "opencode-go/kimi-k2.6",
  "deepseek v4 pro": "opencode-go/deepseek-v4-pro",
  "deepseek v4 flash": "opencode-go/deepseek-v4-flash",
  "mimo-v2.5": "opencode-go/mimo-v2.5",
  "mimo-v2.5-pro": "opencode-go/mimo-v2.5-pro",
  "minimax m2.7": "opencode-go/minimax-m2.7",
  "minimax m2.5": "opencode-go/minimax-m2.5",
  "qwen3.6 plus": "opencode-go/qwen3.6-plus",
  "qwen3.5 plus": "opencode-go/qwen3.5-plus",
};

function normalizeOpenCodeModel(model: string): string {
  if (model.includes("/")) return model;
  const key = model.trim().toLowerCase();
  return OPENCODE_GO_MODEL_IDS[key] || model;
}

function getOpenCodeCodexResponsesBase(): string | null {
  return process.env.OPENCODE_CODEX_API_URL || process.env.OPENCODE_RESPONSES_API_URL || null;
}

function getCodexOpenCodeGoError(): string {
  const base = process.env.OPENCODE_API_URL || "https://opencode.ai/zen/go/v1";
  return `Codex CLI cannot use OpenCode Go directly: ${base} exposes /chat/completions, while this Codex CLI provider path requires a Responses-compatible endpoint. Use --agent opencode for OpenCode Go, or set OPENCODE_CODEX_API_URL/OPENCODE_RESPONSES_API_URL to a Responses-compatible endpoint.`;
}

export function buildAgentArgs(
  agent: string,
  resumeSessionId?: string,
  model?: string,
  apiProvider?: "opencode" | "zai" | null,
): string[] {
  switch (agent) {
    case "codex": {
      const codexModel = model || process.env.CODEX_MODEL || "gpt-5.5";
      const args = [
        "exec",
        "--model",
        codexModel,
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
      ];
      if (apiProvider === "opencode") {
        const base = getOpenCodeCodexResponsesBase();
        if (base) {
          args.splice(1, 0,
            "-c", "model_provider=\"opencode\"",
            "-c", "model_providers.opencode.name=\"OpenCode\"",
            "-c", `model_providers.opencode.base_url="${base}"`,
            "-c", "model_providers.opencode.env_key=\"OPENCODE_API_KEY\"",
            "-c", "model_providers.opencode.wire_api=\"responses\"",
            "-c", "model_providers.opencode.requires_openai_auth=false",
            "-c", "forced_login_method=\"api\"",
          );
        }
      } else if (apiProvider === "zai") {
        const base = process.env.ZAI_CODEX_API_URL
          || process.env.ZAI_RESPONSES_API_URL
          || process.env.ZAI_API_URL
          || process.env.OPENAI_BASE_URL
          || "https://api.z.ai/api/coding/paas/v4";
        args.splice(1, 0,
          "-c", "model_provider=\"z_ai\"",
          "-c", "model_providers.z_ai.name=\"z.ai - GLM Coding Plan\"",
          "-c", `model_providers.z_ai.base_url="${base}"`,
          "-c", "model_providers.z_ai.env_key=\"ZAI_API_KEY\"",
          "-c", "model_providers.z_ai.wire_api=\"chat\"",
          "-c", "model_providers.z_ai.requires_openai_auth=false",
          "-c", "forced_login_method=\"api\"",
        );
      }
      return args;
    }
    case "opencode": {
      const args = ["run", "--format", "json", "--dangerously-skip-permissions"];
      if (model) args.push("-m", normalizeOpenCodeModel(model));
      return args;
    }
    case "claude": {
      const args = [
        "-p",
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ];
      if (resumeSessionId) args.push("--resume", resumeSessionId);
      if (apiProvider && model) {
        if (isClaudeModel(model)) {
          args.push("--model", model);
        } else {
          args.push("--model", "opus");
        }
      } else if (model && isClaudeModel(model)) {
        args.push("--model", model);
      }
      return args;
    }
    default:
      return [];
  }
}

export async function runAgentDirect(
  prompt: string,
  cfg: AgentConfig,
  resumeSessionId?: string,
  logger: PipelineLogger = noop,
  onChildReady?: (child: ChildProcess) => void,
  onStep?: (info: StepInfo) => void,
): Promise<RunResult> {
  return new Promise((resolve) => {
    if (resumeSessionId) {
      logger.logConfig(`Resuming Claude session ${resumeSessionId.slice(0, 8)}`);
    }
    logger.logAgent(`Starting ${cfg.agent}`);

    const finToken = cfg.finToken ?? (process.env.FIN_SIGNAL || "FIN");
    const { finRegex, finLineRegex } = buildFinRegexes(finToken);

    if (cfg.agent === "codex" && cfg.apiProvider === "opencode" && !getOpenCodeCodexResponsesBase()) {
      const message = getCodexOpenCodeGoError();
      logger.logError(message);
      resolve({ finDetected: false, exitCode: -1, ranTests: false, stderr: message });
      return;
    }

    const agentArgs = buildAgentArgs(cfg.agent, resumeSessionId, cfg.model, cfg.apiProvider);
    const child = spawn(cfg.agent, prepareSpawnArgs(agentArgs), {
      cwd: cfg.workspace,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    onChildReady?.(child);

    let finDetected = false;
    let outputBuf = "";
    let stderrBuf = "";
    let capturedSessionId: string | undefined;
    const formatter = createStreamFormatter(cfg.agent, cfg.workspace, {
      debug: cfg.debug ?? false,
      workspace: cfg.workspace,
      onSessionId: (sid) => { capturedSessionId = sid; },
    });

    child.stdin?.write(prompt);
    child.stdin?.end();

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      const formatted = formatter.push(text);
      if (formatted) process.stdout.write(formatted);
      outputBuf += text;
      onStep?.({ output: text });

      if (!finDetected && (finLineRegex.test(outputBuf) || finRegex.test(outputBuf))) {
        finDetected = true;
        const idx = outputBuf.lastIndexOf(finToken);
        logger.logAgent(
          `FIN signal detected near: ...${outputBuf.slice(Math.max(0, idx - 40), idx + finToken.length + 40)}...`,
        );
        child.kill("SIGTERM");
      }
    });

    child.on("close", (code) => {
      const remaining = formatter.flush();
      if (remaining) process.stdout.write(remaining);
      const stderr = stderrBuf.trim();
      if (stderr && code !== 0) {
        // Truncate to last 2KB — the actionable part of API errors is at the end
        const tail = stderr.length > 2048 ? "…\n" + stderr.slice(-2048) : stderr;
        process.stderr.write(tail + "\n");
      }
      resolve({ finDetected, exitCode: code, ranTests: formatter.ranTests, sessionId: capturedSessionId, stderr });
    });

    child.on("error", (err) => {
      logger.logError(`Failed to start ${cfg.agent}: ${err.message}`);
      resolve({ finDetected: false, exitCode: -1 });
    });
  });
}

export async function runAgentViaLauncher(
  prompt: string,
  cfg: AgentConfig,
  launcher: OllamaLauncher,
  resumeSessionId?: string,
  logger: PipelineLogger = noop,
  onChildReady?: (child: ChildProcess) => void,
  onStep?: (info: StepInfo) => void,
): Promise<RunResult> {
  if (!prompt) {
    logger.logError("No prompt provided to agent — skipping");
    return { finDetected: false, exitCode: -1 };
  }
  return new Promise((resolve) => {
    if (resumeSessionId) {
      logger.logConfig(`Resuming Claude session ${resumeSessionId.slice(0, 8)}`);
    }
    logger.logAgent(`Starting ${cfg.agent} via Ollama launcher`);

    const finToken = cfg.finToken ?? (process.env.FIN_SIGNAL || "FIN");
    const { finRegex, finLineRegex } = buildFinRegexes(finToken);
    let capturedSessionId: string | undefined;

    launcher
      .launchStream({
        provider: cfg.agent,
        prompt,
        cwd: cfg.workspace,
        ollamaUrl: cfg.ollamaUrl ?? "http://localhost:11434",
        model: cfg.model || undefined,
        resumeSessionId,
      })
      .then((child) => {
        onChildReady?.(child);
        let finDetected = false;
        let outputBuf = "";
        const formatter = createStreamFormatter(cfg.agent, cfg.workspace, {
          debug: cfg.debug ?? false,
          workspace: cfg.workspace,
          onSessionId: (sid) => { capturedSessionId = sid; },
        });

        child.stdout?.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          const formatted = formatter.push(text);
          if (formatted) process.stdout.write(formatted);
          outputBuf += text;
          onStep?.({ output: text });

          if (!finDetected && (finLineRegex.test(outputBuf) || finRegex.test(outputBuf))) {
            finDetected = true;
            const idx = outputBuf.lastIndexOf(finToken);
            logger.logAgent(
              `FIN signal detected near: ...${outputBuf.slice(Math.max(0, idx - 40), idx + finToken.length + 40)}...`,
            );
            child.kill("SIGTERM");
          }
        });

        child.on("close", (code) => {
          const remaining = formatter.flush();
          if (remaining) process.stdout.write(remaining);
          resolve({ finDetected, exitCode: code, ranTests: formatter.ranTests, sessionId: capturedSessionId });
        });

        child.on("error", (err) => {
          logger.logError(`Launcher failed: ${err.message}`);
          resolve({ finDetected: false, exitCode: -1 });
        });
      })
      .catch((err) => {
        logger.logError(`Failed to start ${cfg.agent} via launcher: ${err.message}`);
        resolve({ finDetected: false, exitCode: -1 });
      });
  });
}

export interface StepInfo {
  output: string;
}

/** Route to launcher or direct execution based on config. */
export async function runAgent(
  prompt: string,
  cfg: AgentConfig,
  launcher: OllamaLauncher | null,
  resumeSessionId?: string,
  logger: PipelineLogger = noop,
  onChildReady?: (child: ChildProcess) => void,
  onStep?: (info: StepInfo) => void,
): Promise<RunResult> {
  if (launcher) {
    return runAgentViaLauncher(prompt, cfg, launcher, resumeSessionId, logger, onChildReady, onStep);
  }
  return runAgentDirect(prompt, cfg, resumeSessionId, logger, onChildReady, onStep);
}
