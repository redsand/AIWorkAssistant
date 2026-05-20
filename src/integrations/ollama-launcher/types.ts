export type ProviderType = "codex" | "claude" | "opencode";

export interface LaunchOptions {
  provider: ProviderType;
  prompt: string;
  model?: string;
  cwd?: string;
  ollamaUrl?: string;
  codexApprovalMode?: "suggest" | "auto-edit" | "full-auto";
  resumeSessionId?: string;
}

export interface LaunchResult {
  success: boolean;
  exitCode: number | null;
  duration: number;
  provider: ProviderType;
  command: string;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface ProviderExecutor {
  readonly providerName: ProviderType;
  buildCommand(
    options: LaunchOptions,
    cliPath: string,
    defaultModel: string,
  ): { command: string; args: string[] };
  buildEnv(
    options: LaunchOptions,
    ollamaUrl: string,
  ): Record<string, string>;
}

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}

export interface OllamaTagsResponse {
  models: OllamaModel[];
}