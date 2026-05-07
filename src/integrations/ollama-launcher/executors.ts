import type { ProviderExecutor, LaunchOptions, ProviderType } from "./types";

export class CodexExecutor implements ProviderExecutor {
  readonly providerName: ProviderType = "codex";

  buildCommand(
    options: LaunchOptions,
    cliPath: string,
    defaultModel: string,
  ): { command: string; args: string[] } {
    const model = options.model || defaultModel;
    const approvalMode = options.codexApprovalMode || "full-auto";
    return {
      command: cliPath,
      args: [
        "--model",
        model,
        "--approval-mode",
        approvalMode,
        "-q",
      ],
    };
  }

  buildEnv(
    _options: LaunchOptions,
    ollamaUrl: string,
  ): Record<string, string> {
    return {
      OPENAI_BASE_URL: `${ollamaUrl}/v1`,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || "ollama",
    };
  }
}

export class ClaudeExecutor implements ProviderExecutor {
  readonly providerName: ProviderType = "claude";

  buildCommand(
    options: LaunchOptions,
    cliPath: string,
    defaultModel: string,
  ): { command: string; args: string[] } {
    const args = [
      "-p",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--dangerously-skip-permissions",
    ];
    // When --ollama is active, skip --model since Ollama model names
    // aren't valid Anthropic model names. The Ollama proxy handles routing.
    // Without --ollama, pass the model through normally.
    if (!options.ollamaUrl) {
      const model = options.model || defaultModel;
      if (model) {
        args.push("--model", model);
      }
    }
    return { command: cliPath, args };
  }

  buildEnv(
    options: LaunchOptions,
    ollamaUrl: string,
  ): Record<string, string> {
    // When --ollama is active, route Claude Code's Anthropic SDK to Ollama's
    // Anthropic-compatible endpoint. ANTHROPIC_BASE_URL is what the SDK reads;
    // OPENAI_BASE_URL is ignored by the Claude CLI process.
    if (options.ollamaUrl) {
      return {
        ANTHROPIC_BASE_URL: ollamaUrl,
        OPENAI_BASE_URL: `${ollamaUrl}/v1`,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || "ollama",
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "ollama",
      };
    }
    // Otherwise use the native Anthropic API
    const env: Record<string, string> = {};
    if (process.env.ANTHROPIC_API_KEY) {
      env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    }
    return env;
  }
}

export class OpenCodeExecutor implements ProviderExecutor {
  readonly providerName: ProviderType = "opencode";

  buildCommand(
    _options: LaunchOptions,
    cliPath: string,
    _defaultModel: string,
  ): { command: string; args: string[] } {
    return {
      command: cliPath,
      args: [],
    };
  }

  buildEnv(
    options: LaunchOptions,
    ollamaUrl: string,
  ): Record<string, string> {
    // When ollamaUrl is provided and different from default, route through Ollama
    if (options.ollamaUrl) {
      return {
        OPENCODE_API_URL: `${ollamaUrl}/v1`,
        OPENCODE_API_KEY: process.env.OPENCODE_API_KEY || "ollama",
      };
    }
    // Otherwise use the existing OPENCODE_API_URL from env
    const env: Record<string, string> = {};
    if (process.env.OPENCODE_API_KEY) {
      env.OPENCODE_API_KEY = process.env.OPENCODE_API_KEY;
    }
    return env;
  }
}

export function resolveExecutor(provider: ProviderType): ProviderExecutor {
  switch (provider) {
    case "codex":
      return new CodexExecutor();
    case "claude":
      return new ClaudeExecutor();
    case "opencode":
      return new OpenCodeExecutor();
  }
}