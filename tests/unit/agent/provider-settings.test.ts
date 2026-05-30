import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  axiosGet: vi.fn(),
  refresh: vi.fn(),
  env: {
    AI_PROVIDER: "opencode",
    OPENCODE_API_KEY: "opencode-key",
    OPENCODE_API_URL: "https://opencode.test/v1",
    OPENCODE_MODEL: "opencode-default",
    ZAI_API_KEY: "zai-key",
    ZAI_API_URL: "https://zai.test/v4",
    ZAI_MODEL: "glm-default",
    OLLAMA_API_KEY: "ollama-key",
    OLLAMA_API_URL: "http://ollama.test",
    OLLAMA_MODEL: "llama-default",
    OPENAI_API_KEY: "openai-key",
    OPENAI_API_URL: "https://openai.test/v1",
    OPENAI_MODEL: "gpt-default",
  },
}));

vi.mock("axios", () => ({
  default: { get: mocks.axiosGet },
}));

vi.mock("../../../src/config/env", () => ({
  env: mocks.env,
}));

vi.mock("../../../src/agent/opencode-client", () => ({
  aiClient: { refresh: mocks.refresh },
}));

describe("providerSettings", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.AI_PROVIDER;
    delete process.env.OPENCODE_MODEL;
    delete process.env.ZAI_MODEL;
    delete process.env.OLLAMA_MODEL;
    delete process.env.OPENAI_MODEL;
  });

  it("discovers OpenAI-compatible models and reuses the 24-hour cache", async () => {
    mocks.axiosGet.mockResolvedValue({
      data: { data: [{ id: "gpt-z" }, { id: "gpt-a" }] },
    });
    const { providerSettings } =
      await import("../../../src/agent/provider-settings");

    const first = await providerSettings.getModels("openai");
    const second = await providerSettings.getModels("openai");

    expect(first.models).toEqual(["gpt-a", "gpt-z"]);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(mocks.axiosGet).toHaveBeenCalledTimes(1);
    expect(mocks.axiosGet).toHaveBeenCalledWith(
      "https://openai.test/v1/models",
      {
        headers: { Authorization: "Bearer openai-key" },
        timeout: 10000,
      },
    );
  });

  it("refreshes provider models after the 24-hour cache expires", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-30T00:00:00.000Z"));
      mocks.axiosGet
        .mockResolvedValueOnce({ data: { data: [{ id: "gpt-old" }] } })
        .mockResolvedValueOnce({ data: { data: [{ id: "gpt-new" }] } });
      const { providerSettings } =
        await import("../../../src/agent/provider-settings");

      await providerSettings.getModels("openai");
      vi.setSystemTime(new Date("2026-05-31T00:00:01.000Z"));
      const refreshed = await providerSettings.getModels("openai");

      expect(refreshed.models).toEqual(["gpt-new"]);
      expect(refreshed.cached).toBe(false);
      expect(mocks.axiosGet).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("force refresh bypasses cached provider models", async () => {
    mocks.axiosGet
      .mockResolvedValueOnce({ data: { data: [{ id: "gpt-old" }] } })
      .mockResolvedValueOnce({ data: { data: [{ id: "gpt-new" }] } });
    const { providerSettings } =
      await import("../../../src/agent/provider-settings");

    await providerSettings.getModels("openai");
    const refreshed = await providerSettings.getModels("openai", true);

    expect(refreshed.models).toEqual(["gpt-new"]);
    expect(refreshed.cached).toBe(false);
    expect(mocks.axiosGet).toHaveBeenCalledTimes(2);
  });

  it("falls back from Ollama native tags to OpenAI-compatible model discovery", async () => {
    mocks.axiosGet
      .mockRejectedValueOnce(new Error("/api/tags unavailable"))
      .mockResolvedValueOnce({ data: { data: [{ id: "llama-cloud" }] } });
    const { providerSettings } =
      await import("../../../src/agent/provider-settings");

    const models = await providerSettings.getModels("ollama");

    expect(models.models).toEqual(["llama-cloud"]);
    expect(mocks.axiosGet).toHaveBeenNthCalledWith(
      1,
      "http://ollama.test/api/tags",
      {
        headers: { Authorization: "Bearer ollama-key" },
        timeout: 10000,
      },
    );
    expect(mocks.axiosGet).toHaveBeenNthCalledWith(
      2,
      "http://ollama.test/v1/models",
      {
        headers: { Authorization: "Bearer ollama-key" },
        timeout: 10000,
      },
    );
  });

  it("returns the provider default model when discovery fails with no cache", async () => {
    mocks.axiosGet.mockRejectedValue(new Error("network down"));
    const { providerSettings } =
      await import("../../../src/agent/provider-settings");

    const models = await providerSettings.getModels("zai");

    expect(models.models).toEqual(["glm-default"]);
    expect(models.cached).toBe(false);
    expect(models.error).toContain("network down");
  });

  it("keeps stale cached models when refresh fails", async () => {
    mocks.axiosGet
      .mockResolvedValueOnce({ data: { data: [{ id: "gpt-cached" }] } })
      .mockRejectedValueOnce(new Error("refresh failed"));
    const { providerSettings } =
      await import("../../../src/agent/provider-settings");

    await providerSettings.getModels("openai");
    const models = await providerSettings.getModels("openai", true);

    expect(models.models).toEqual(["gpt-cached"]);
    expect(models.cached).toBe(true);
    expect(models.error).toContain("refresh failed");
  });

  it("updates runtime provider environment and refreshes the AI client", async () => {
    mocks.axiosGet.mockResolvedValue({
      data: { data: [{ id: "gpt-selected" }] },
    });
    const { providerSettings } =
      await import("../../../src/agent/provider-settings");

    const result = await providerSettings.setProvider("openai", "gpt-selected");

    expect(result).toMatchObject({ provider: "openai", model: "gpt-selected" });
    expect(process.env.AI_PROVIDER).toBe("openai");
    expect(process.env.OPENAI_MODEL).toBe("gpt-selected");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("rejects models that are not available for the selected provider", async () => {
    mocks.axiosGet.mockResolvedValue({
      data: { data: [{ id: "gpt-allowed" }] },
    });
    const { providerSettings } =
      await import("../../../src/agent/provider-settings");

    await expect(
      providerSettings.setProvider("openai", "gpt-missing"),
    ).rejects.toThrow(
      "Model 'gpt-missing' is not available for provider 'openai'",
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("reports the current provider and model from runtime overrides", async () => {
    process.env.AI_PROVIDER = "ollama";
    process.env.OLLAMA_MODEL = "runtime-llama";
    const { providerSettings } =
      await import("../../../src/agent/provider-settings");

    expect(providerSettings.getCurrent()).toEqual({
      provider: "ollama",
      model: "runtime-llama",
      providers: ["opencode", "zai", "ollama", "openai"],
    });
  });
});
