import { loadEnv } from "./env";

export interface ClientConfig {
  apiBaseUrl: string;
  authHeaders: Record<string, string>;
}

export function resolveClientConfig(): ClientConfig {
  const remoteUrl = process.env.AIWORKASSISTANT_URL?.replace(/\/$/, "");
  const remoteKey = process.env.AIWORKASSISTANT_API_KEY;

  if (remoteUrl && remoteKey) {
    return {
      apiBaseUrl: remoteUrl,
      authHeaders: { Authorization: `Bearer ${remoteKey}` },
    };
  }

  const env = loadEnv();
  const providerKeys: Record<string, string> = {
    opencode: env.OPENCODE_API_KEY,
    zai: env.ZAI_API_KEY,
    ollama: env.OLLAMA_API_KEY,
  };
  const token = providerKeys[env.AI_PROVIDER] || "";

  return {
    apiBaseUrl: `http://localhost:${env.PORT}`,
    authHeaders: token ? { Authorization: `Bearer ${token}` } : {},
  };
}
