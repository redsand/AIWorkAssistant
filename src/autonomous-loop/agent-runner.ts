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

export function buildAgentArgs(agent: string, resumeSessionId?: string): string[] {
  switch (agent) {
    case "codex":
      return [
        "exec",
        "--model",
        process.env.CODEX_MODEL || "o4-mini",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
      ];
    case "opencode":
      return [];
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
): Promise<RunResult> {
  return new Promise((resolve) => {
    if (resumeSessionId) {
      logger.logConfig(`Resuming Claude session ${resumeSessionId.slice(0, 8)}`);
    }
    logger.logAgent(`Starting ${cfg.agent}`);

    const finToken = cfg.finToken ?? (process.env.FIN_SIGNAL || "FIN");
    const { finRegex, finLineRegex } = buildFinRegexes(finToken);

    const agentArgs = buildAgentArgs(cfg.agent, resumeSessionId);
    const child = spawn(cfg.agent, agentArgs, {
      cwd: cfg.workspace,
      stdio: ["pipe", "pipe", "inherit"],
      shell: process.platform === "win32",
    });
    onChildReady?.(child);

    let finDetected = false;
    let outputBuf = "";
    let capturedSessionId: string | undefined;
    const formatter = createStreamFormatter(cfg.agent, cfg.workspace, {
      debug: cfg.debug ?? false,
      workspace: cfg.workspace,
      onSessionId: (sid) => { capturedSessionId = sid; },
    });

    child.stdin?.write(prompt);
    child.stdin?.end();

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      const formatted = formatter.push(text);
      if (formatted) process.stdout.write(formatted);
      outputBuf += text;

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

/** Route to launcher or direct execution based on config. */
export async function runAgent(
  prompt: string,
  cfg: AgentConfig,
  launcher: OllamaLauncher | null,
  resumeSessionId?: string,
  logger: PipelineLogger = noop,
  onChildReady?: (child: ChildProcess) => void,
): Promise<RunResult> {
  if (launcher) {
    return runAgentViaLauncher(prompt, cfg, launcher, resumeSessionId, logger, onChildReady);
  }
  return runAgentDirect(prompt, cfg, resumeSessionId, logger, onChildReady);
}
