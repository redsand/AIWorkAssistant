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
    const model = options.model || defaultModel;
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
    if (model) {
      args.push("--model", model);
    }
    return { command: cliPath, args };
  }

  buildEnv(
    _options: LaunchOptions,
    _ollamaUrl: string,
  ): Record<string, string> {
    // Claude CLI uses Anthropic API, not Ollama's OpenAI-compatible endpoint.
    // Pass through the existing ANTHROPIC_API_KEY if set.
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