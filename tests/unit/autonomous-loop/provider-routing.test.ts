import { describe, it, expect } from "vitest";
import {
  applyProviderRouting,
  hasSecret,
  type ProviderRoutingOptions,
} from "../../../src/autonomous-loop/provider-routing";

// ── hasSecret ──────────────────────────────────────────────────────────────────

describe("hasSecret", () => {
  it('returns "present" for a non-empty string', () => {
    expect(hasSecret("sk-abc123")).toBe("present");
  });

  it('returns "missing" for an empty string', () => {
    expect(hasSecret("")).toBe("missing");
  });

  it('returns "missing" for undefined', () => {
    expect(hasSecret(undefined)).toBe("missing");
  });
});

// ── applyProviderRouting — OpenCode ────────────────────────────────────────────

describe("applyProviderRouting — OpenCode", () => {
  it("uses default base URL when no env vars are set", () => {
    const env: NodeJS.ProcessEnv = {};
    const result = applyProviderRouting({
      apiProvider: "opencode",
      agent: "codex",
      model: "gpt-4",
      env,
    });

    expect(result?.base).toBe("https://opencode.ai/zen/go/v1");
    expect(result?.keyPresent).toBe(false);
    expect(env.OPENAI_BASE_URL).toBe("https://opencode.ai/zen/go/v1");
    expect(env.OPENCODE_API_URL).toBe("https://opencode.ai/zen/go/v1");
    expect(env.OPENCODE_BASE_URL).toBe("https://opencode.ai/zen/go/v1");
  });

  it("prefers OPENCODE_API_URL over default", () => {
    const env: NodeJS.ProcessEnv = {
      OPENCODE_API_URL: "https://custom.opencode.io/v1",
    };
    const result = applyProviderRouting({
      apiProvider: "opencode",
      agent: "codex",
      model: "gpt-4",
      env,
    });

    expect(result?.base).toBe("https://custom.opencode.io/v1");
  });

  it("falls back to OPENCODE_BASE_URL when OPENCODE_API_URL is missing", () => {
    const env: NodeJS.ProcessEnv = {
      OPENCODE_BASE_URL: "https://fallback.opencode.io/v1",
    };
    const result = applyProviderRouting({
      apiProvider: "opencode",
      agent: "codex",
      model: "gpt-4",
      env,
    });

    expect(result?.base).toBe("https://fallback.opencode.io/v1");
  });

  it("sets API keys when OPENCODE_API_KEY is present", () => {
    const env: NodeJS.ProcessEnv = {
      OPENCODE_API_KEY: "sk-opencode-key",
    };
    const result = applyProviderRouting({
      apiProvider: "opencode",
      agent: "codex",
      model: "gpt-4",
      env,
    });

    expect(result?.keyPresent).toBe(true);
    expect(result?.codexKeyPresent).toBe(true);
    expect(env.OPENAI_API_KEY).toBe("sk-opencode-key");
    expect(env.CODEX_API_KEY).toBe("sk-opencode-key");
    expect(env.OPENCODE_API_KEY).toBe("sk-opencode-key");
  });

  it("does not set OPENAI_API_KEY when key is empty", () => {
    const env: NodeJS.ProcessEnv = {
      OPENCODE_API_KEY: "",
    };
    const result = applyProviderRouting({
      apiProvider: "opencode",
      agent: "codex",
      model: "gpt-4",
      env,
    });

    expect(result?.keyPresent).toBe(false);
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("sets the OPENCODE_MODEL env var", () => {
    const env: NodeJS.ProcessEnv = {};
    applyProviderRouting({
      apiProvider: "opencode",
      agent: "codex",
      model: "my-custom-model",
      env,
    });

    expect(env.OPENCODE_MODEL).toBe("my-custom-model");
  });

  it("sets Anthropic env vars for claude agent", () => {
    const env: NodeJS.ProcessEnv = {
      OPENCODE_API_KEY: "sk-key",
      OPENCODE_ANTHROPIC_BASE_URL: "https://anthropic.custom.io",
    };
    const result = applyProviderRouting({
      apiProvider: "opencode",
      agent: "claude",
      model: "claude-sonnet-4",
      env,
    });

    expect(result?.anthropicBase).toBe("https://anthropic.custom.io");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://anthropic.custom.io");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-key");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-key");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-sonnet-4");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-4");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-sonnet-4");
  });

  it("strips /v1 from base URL for anthropicBase when no OPENCODE_ANTHROPIC_BASE_URL", () => {
    const env: NodeJS.ProcessEnv = {
      OPENCODE_API_URL: "https://api.opencode.io/v1/",
    };
    const result = applyProviderRouting({
      apiProvider: "opencode",
      agent: "claude",
      model: "claude-sonnet-4",
      env,
    });

    expect(result?.anthropicBase).toBe("https://api.opencode.io");
  });

  it("does not set Anthropic env vars for codex agent", () => {
    const env: NodeJS.ProcessEnv = {
      OPENCODE_API_KEY: "sk-key",
    };
    applyProviderRouting({
      apiProvider: "opencode",
      agent: "codex",
      model: "gpt-4",
      env,
    });

    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("does not set ANTHROPIC_API_KEY for claude agent when key is empty", () => {
    const env: NodeJS.ProcessEnv = {};
    applyProviderRouting({
      apiProvider: "opencode",
      agent: "claude",
      model: "claude-sonnet-4",
      env,
    });

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    // Model env vars should still be set
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-sonnet-4");
  });
});

// ── applyProviderRouting — Z.ai ────────────────────────────────────────────────

describe("applyProviderRouting — Z.ai", () => {
  it("uses default Z.ai base URL when no env vars are set", () => {
    const env: NodeJS.ProcessEnv = {};
    const result = applyProviderRouting({
      apiProvider: "zai",
      agent: "codex",
      model: "GLM-5",
      env,
    });

    expect(result?.base).toBe("https://api.z.ai/api/coding/paas/v4");
    expect(result?.anthropicBase).toBe("https://api.z.ai/api/anthropic");
  });

  it("prefers ZAI_API_URL over default", () => {
    const env: NodeJS.ProcessEnv = {
      ZAI_API_URL: "https://custom.z.ai/v4",
    };
    const result = applyProviderRouting({
      apiProvider: "zai",
      agent: "codex",
      model: "GLM-5",
      env,
    });

    expect(result?.base).toBe("https://custom.z.ai/v4");
  });

  it("falls back to ZAI_BASE_URL when ZAI_API_URL is missing", () => {
    const env: NodeJS.ProcessEnv = {
      ZAI_BASE_URL: "https://fallback.z.ai/v4",
    };
    const result = applyProviderRouting({
      apiProvider: "zai",
      agent: "codex",
      model: "GLM-5",
      env,
    });

    expect(result?.base).toBe("https://fallback.z.ai/v4");
  });

  it("sets all required env vars when ZAI_API_KEY is present", () => {
    const env: NodeJS.ProcessEnv = {
      ZAI_API_KEY: "zai-key-123",
    };
    const result = applyProviderRouting({
      apiProvider: "zai",
      agent: "codex",
      model: "GLM-5",
      env,
    });

    expect(result?.keyPresent).toBe(true);
    expect(result?.codexKeyPresent).toBe(true);
    expect(env.OPENAI_BASE_URL).toBe("https://api.z.ai/api/coding/paas/v4");
    expect(env.OPENAI_API_KEY).toBe("zai-key-123");
    expect(env.CODEX_API_KEY).toBe("zai-key-123");
    expect(env.ZAI_API_KEY).toBe("zai-key-123");
    expect(env.Z_AI_API_KEY).toBe("zai-key-123");
  });

  it("sets ZAI_MODEL", () => {
    const env: NodeJS.ProcessEnv = {};
    applyProviderRouting({
      apiProvider: "zai",
      agent: "codex",
      model: "GLM-5.1",
      env,
    });

    expect(env.ZAI_MODEL).toBe("GLM-5.1");
  });

  it("sets Anthropic env vars for claude agent on Z.ai", () => {
    const env: NodeJS.ProcessEnv = {
      ZAI_API_KEY: "zai-key",
      ZAI_ANTHROPIC_BASE_URL: "https://zai.anthropic.proxy",
    };
    const result = applyProviderRouting({
      apiProvider: "zai",
      agent: "claude",
      model: "GLM-5",
      env,
    });

    expect(result?.anthropicBase).toBe("https://zai.anthropic.proxy");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://zai.anthropic.proxy");
    expect(env.ANTHROPIC_API_KEY).toBe("zai-key");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("zai-key");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("GLM-5");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("GLM-5");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("GLM-5");
  });

  it("does not set Anthropic keys for claude agent when key is empty", () => {
    const env: NodeJS.ProcessEnv = {};
    applyProviderRouting({
      apiProvider: "zai",
      agent: "claude",
      model: "GLM-5",
      env,
    });

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    // But model env vars and base URL should still be set
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("GLM-5");
  });

  it("does not set Anthropic env vars for codex agent", () => {
    const env: NodeJS.ProcessEnv = {
      ZAI_API_KEY: "zai-key",
    };
    applyProviderRouting({
      apiProvider: "zai",
      agent: "codex",
      model: "GLM-5",
      env,
    });

    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

// ── applyProviderRouting — null provider ────────────────────────────────────────

describe("applyProviderRouting — unknown/null provider", () => {
  it("returns null when apiProvider is null", () => {
    const env: NodeJS.ProcessEnv = {};
    const result = applyProviderRouting({
      apiProvider: null,
      agent: "codex",
      model: "gpt-4",
      env,
    });

    expect(result).toBeNull();
    // Should not set any env vars
    expect(Object.keys(env)).toHaveLength(0);
  });
});

// ── stripTrailingV1 (indirect via anthropicBase) ───────────────────────────────

describe("stripTrailingV1 (internal)", () => {
  it("strips /v1 from end of URL", () => {
    const env: NodeJS.ProcessEnv = {
      OPENCODE_API_URL: "https://api.example.com/v1",
    };
    const result = applyProviderRouting({
      apiProvider: "opencode",
      agent: "claude",
      model: "m1",
      env,
    });
    expect(result?.anthropicBase).toBe("https://api.example.com");
  });

  it("strips /v1/ (with trailing slash) from end of URL", () => {
    const env: NodeJS.ProcessEnv = {
      OPENCODE_API_URL: "https://api.example.com/v1/",
    };
    const result = applyProviderRouting({
      apiProvider: "opencode",
      agent: "claude",
      model: "m1",
      env,
    });
    expect(result?.anthropicBase).toBe("https://api.example.com");
  });

  it("does not strip /v1 from the middle of a URL", () => {
    const env: NodeJS.ProcessEnv = {
      OPENCODE_API_URL: "https://api.example.com/v1proxy",
    };
    const result = applyProviderRouting({
      apiProvider: "opencode",
      agent: "claude",
      model: "m1",
      env,
    });
    expect(result?.anthropicBase).toBe("https://api.example.com/v1proxy");
  });
});
