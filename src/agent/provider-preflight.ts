import type { ChatRequest, ChatResponse } from "./opencode-client";

export type ProviderPreflightScenarioName =
  | "plain_chat"
  | "json_mode"
  | "tools_schema"
  | "tool_history"
  | "long_context";

export interface ProviderPreflightClient {
  chat(request: ChatRequest): Promise<ChatResponse>;
  isConfigured(): boolean;
}

export interface ProviderPreflightResult {
  name: ProviderPreflightScenarioName;
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface ProviderPreflightReport {
  provider: string;
  model: string;
  success: boolean;
  results: ProviderPreflightResult[];
}

const searchTool = {
  type: "function" as const,
  function: {
    name: "repo.search",
    description: "Search a repository for matching text",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
};

export function buildProviderPreflightScenarios(): Array<{
  name: ProviderPreflightScenarioName;
  request: ChatRequest;
}> {
  return [
    {
      name: "plain_chat",
      request: {
        messages: [{ role: "user", content: "Reply with OK." }],
        maxTokens: 32,
      },
    },
    {
      name: "json_mode",
      request: {
        messages: [
          { role: "system", content: "Return only valid JSON." },
          { role: "user", content: "Return {\"ok\":true}." },
        ],
        jsonMode: true,
        maxTokens: 64,
      },
    },
    {
      name: "tools_schema",
      request: {
        messages: [{ role: "user", content: "Confirm tool schema compatibility without calling a tool." }],
        tools: [searchTool],
        maxTokens: 64,
      },
    },
    {
      name: "tool_history",
      request: {
        messages: [
          { role: "user", content: "Search for auth." },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_preflight",
                type: "function",
                function: {
                  name: "repo.search",
                  arguments: "{\"query\":\"auth\"}",
                },
              },
            ],
          },
          {
            role: "tool",
            name: "local.search",
            tool_call_id: "call_preflight",
            content: "{\"matches\":[]}",
          },
          { role: "user", content: "Summarize the tool result in one sentence." },
        ],
        tools: [searchTool],
        maxTokens: 64,
      },
    },
    {
      name: "long_context",
      request: {
        messages: [
          { role: "system", content: "Answer briefly." },
          { role: "user", content: `Context:\n${"x".repeat(12000)}\n\nReply with OK.` },
        ],
        maxTokens: 32,
      },
    },
  ];
}

export async function runProviderPreflight(
  client: ProviderPreflightClient,
  provider: string,
  model: string,
): Promise<ProviderPreflightReport> {
  if (!client.isConfigured()) {
    return {
      provider,
      model,
      success: false,
      results: buildProviderPreflightScenarios().map((scenario) => ({
        name: scenario.name,
        success: false,
        durationMs: 0,
        error: "provider_not_configured",
      })),
    };
  }

  const results: ProviderPreflightResult[] = [];
  for (const scenario of buildProviderPreflightScenarios()) {
    const started = Date.now();
    try {
      await client.chat({
        ...scenario.request,
        model,
      });
      results.push({
        name: scenario.name,
        success: true,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      results.push({
        name: scenario.name,
        success: false,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    provider,
    model,
    success: results.every((result) => result.success),
    results,
  };
}
