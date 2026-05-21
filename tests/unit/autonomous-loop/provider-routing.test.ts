import { describe, expect, it } from "vitest";
import { applyProviderRouting } from "../../../src/autonomous-loop/provider-routing";

describe("applyProviderRouting — Z.ai", () => {
  it("sets Codex-compatible OpenAI env vars for Z.ai", () => {
    const env: NodeJS.ProcessEnv = {
      ZAI_API_URL: "https://api.z.ai/api/coding/paas/v4",
      ZAI_API_KEY: "zai-test-key",
    };

    const result = applyProviderRouting({
      apiProvider: "zai",
      agent: "codex",
      model: "GLM-5.1",
      env,
    });

    expect(result?.base).toBe("https://api.z.ai/api/coding/paas/v4");
    expect(result?.keyPresent).toBe(true);
    expect(result?.codexKeyPresent).toBe(true);
    expect(env.OPENAI_BASE_URL).toBe("https://api.z.ai/api/coding/paas/v4");
    expect(env.OPENAI_API_KEY).toBe("zai-test-key");
    expect(env.CODEX_API_KEY).toBe("zai-test-key");
    expect(env.ZAI_API_KEY).toBe("zai-test-key");
    expect(env.Z_AI_API_KEY).toBe("zai-test-key");
    expect(env.ZAI_MODEL).toBe("GLM-5.1");
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
  });

  it("sets Anthropic-compatible env vars for Claude on Z.ai", () => {
    const env: NodeJS.ProcessEnv = {
      ZAI_BASE_URL: "https://zai-openai.example/v1",
      ZAI_ANTHROPIC_BASE_URL: "https://zai-anthropic.example",
      ZAI_API_KEY: "zai-test-key",
    };

    const result = applyProviderRouting({
      apiProvider: "zai",
      agent: "claude",
      model: "GLM-5.1",
      env,
    });

    expect(result?.base).toBe("https://zai-openai.example/v1");
    expect(result?.anthropicBase).toBe("https://zai-anthropic.example");
    expect(env.OPENAI_BASE_URL).toBe("https://zai-openai.example/v1");
    expect(env.CODEX_API_KEY).toBe("zai-test-key");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://zai-anthropic.example");
    expect(env.ANTHROPIC_API_KEY).toBe("zai-test-key");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("zai-test-key");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("GLM-5.1");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("GLM-5.1");
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("GLM-5.1");
  });
});
