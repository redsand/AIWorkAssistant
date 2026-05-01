import axios, { AxiosError } from "axios";
import {
  AIProvider,
  ProviderCapabilities,
  ProviderConfig,
  ChatRequest,
  ChatResponse,
} from "./types";

export class OpenCodeProvider extends AIProvider {
  readonly name = "opencode";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolChoice: "required",
    parallelToolCalls: true,
    requiresAuth: true,
    synthesizesToolCallIds: false,
  };

  constructor(config: ProviderConfig) {
    super(config);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!this.isConfigured()) {
      throw new Error(
        "OpenCode API key not configured. Set OPENCODE_API_KEY environment variable.",
      );
    }

    try {
      const requestBody = this.buildRequestBody(request);

      console.log("[OpenCode API] Sending request:", {
        model: requestBody.model,
        messageCount: (requestBody.messages as any[]).length,
        hasTools: !!request.tools,
      });

      const response = await this.client.post("/chat/completions", requestBody);

      const data = response.data;
      const message = data.choices[0].message;

      const result: ChatResponse = {
        content: message.content || "",
        thinking: message.reasoning_content || undefined,
        toolCalls: message.tool_calls
          ? this.parseToolCalls(message.tool_calls)
          : undefined,
        usage: {
          promptTokens: data.usage?.prompt_tokens || 0,
          completionTokens: data.usage?.completion_tokens || 0,
          totalTokens: data.usage?.total_tokens || 0,
        },
        model: data.model || this.config.model,
        done: true,
      };

      console.log("[OpenCode API] Response received:", {
        contentLength: result.content.length,
        toolCallCount: result.toolCalls?.length || 0,
        tokensUsed: result.usage?.totalTokens || 0,
      });

      return result;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        const status = axiosError.response?.status;
        const data = axiosError.response?.data as any;

        console.error("[OpenCode API] Request failed:", {
          status,
          statusText: axiosError.response?.statusText,
          data: data ? JSON.stringify(data).substring(0, 200) : undefined,
        });

        if (status === 401) {
          throw new Error(
            "OpenCode API authentication failed. Check your API key.",
          );
        } else if (status === 429) {
          throw new Error(
            "OpenCode API rate limit exceeded. Please try again later.",
          );
        } else if (status && status >= 500) {
          throw new Error(`OpenCode API server error: ${status}`);
        } else if (status === 400) {
          throw new Error(
            `OpenCode API bad request: ${data?.error?.message || "Unknown error"}`,
          );
        }
      }

      console.error("[OpenCode API] Unexpected error:", error);
      throw new Error(
        `OpenCode API request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async *chatStream(
    request: ChatRequest,
  ): AsyncGenerator<string, void, unknown> {
    if (!this.isConfigured()) {
      throw new Error(
        "OpenCode API key not configured. Set OPENCODE_API_KEY environment variable.",
      );
    }

    try {
      const requestBody = this.buildRequestBody({ ...request, stream: true });

      console.log("[OpenCode API] Starting stream request");

      const response = await this.client.post(
        "/chat/completions",
        requestBody,
        {
          responseType: "stream",
        },
      );

      for await (const chunk of response.data) {
        const line = chunk.toString();

        if (!line.startsWith("data: ")) {
          continue;
        }

        const data = line.slice(6);

        if (data === "[DONE]") {
          break;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices[0]?.delta;

          if (delta?.content) {
            yield delta.content;
          }
        } catch {
          continue;
        }
      }

      console.log("[OpenCode API] Stream completed");
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        console.error("[OpenCode API] Stream failed:", { status });

        if (status === 401) {
          throw new Error(
            "OpenCode API authentication failed. Check your API key.",
          );
        }
      }

      console.error("[OpenCode API] Stream error:", error);
      throw new Error(
        `OpenCode API stream failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  isConfigured(): boolean {
    return !!this.config.apiKey && this.config.apiKey.length > 0;
  }

  async validateConfig(): Promise<boolean> {
    if (!this.isConfigured()) {
      return false;
    }

    try {
      const response = await this.client.get("/models", { timeout: 10000 });
      return response.status === 200;
    } catch (error) {
      console.error("[OpenCode API] Config validation failed:", error);
      return false;
    }
  }

  async getModels(): Promise<string[]> {
    if (!this.isConfigured()) {
      throw new Error("OpenCode API not configured");
    }

    try {
      const response = await this.client.get("/models");
      const models = response.data.data || [];

      return models
        .filter((m: any) => m.id?.toLowerCase().startsWith("opencode-"))
        .map((m: any) => m.id)
        .sort();
    } catch (error) {
      console.error("[OpenCode API] Failed to get models:", error);
      return [];
    }
  }
}
