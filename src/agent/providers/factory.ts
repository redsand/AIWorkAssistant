import { env } from "../../config/env";
import { AIProvider } from "./types";
import { OpenCodeProvider } from "./opencode-provider";
import { ZaiProvider } from "./zai-provider";
import { OllamaProvider } from "./ollama-provider";

export function createProvider(): AIProvider {
  const provider = env.AI_PROVIDER;

  switch (provider) {
    case "zai":
      return new ZaiProvider({
        apiKey: env.ZAI_API_KEY,
        baseUrl: env.ZAI_API_URL,
        model: env.ZAI_MODEL,
        temperature: env.ZAI_TEMPERATURE,
        topP: env.ZAI_TOP_P,
        maxRetries: 5,
        timeout: 300000,
      });

    case "ollama":
      return new OllamaProvider({
        apiKey: "",
        baseUrl: env.OLLAMA_API_URL,
        model: env.OLLAMA_MODEL,
        temperature: env.OLLAMA_TEMPERATURE,
        topP: 0.9,
        maxRetries: 2,
        timeout: 300000,
      });

    default:
      return new OpenCodeProvider({
        apiKey: env.OPENCODE_API_KEY,
        baseUrl: env.OPENCODE_API_URL,
        model: "glm-5",
        temperature: 0.7,
        topP: 0.95,
        maxRetries: 3,
        timeout: 120000,
      });
  }
}

let _provider: AIProvider | null = null;

export function getProvider(): AIProvider {
  if (!_provider) {
    _provider = createProvider();
  }
  return _provider;
}
