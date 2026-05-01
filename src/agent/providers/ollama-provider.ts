import axios from "axios";
import {
  AIProvider,
  ProviderCapabilities,
  ProviderConfig,
  ChatRequest,
  ChatResponse,
} from "./types";

export class OllamaProvider extends AIProvider {
  readonly name = "ollama";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolChoice: "auto",
    parallelToolCalls: false,
    requiresAuth: false,
    synthesizesToolCallIds: false,
  };

  constructor(config: ProviderConfig) {
    super(config);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    try {
      const requestBody = this.buildRequestBody(request);

      console.log("[Ollama API] Sending request:", {
        model: requestBody.model,
        messageCount: (requestBody.messages as any[]).length,
        hasTools: !!request.tools,
      });

      const response = await this.client.post(
        "/v1/chat/completions",
        requestBody,
      );

      const data = response.data;
      const message = data.choices[0].message;

      const result: ChatResponse = {
        content: message.content || "",
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

      console.log("[Ollama API] Response received:", {
        contentLength: result.content.length,
        toolCallCount: result.toolCalls?.length || 0,
        tokensUsed: result.usage?.totalTokens || 0,
      });

      return result;
    } catch (error) {
      if (
        axios.isAxiosError(error) &&
        error.response?.status === 400 &&
        request.tools
      ) {
        console.warn(
          "[Ollama API] Model may not support tools, retrying without tools",
        );
        return this.chat({ ...request, tools: undefined });
      }

      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const data = error.response?.data as any;

        console.error("[Ollama API] Request failed:", {
          status,
          data: data ? JSON.stringify(data).substring(0, 200) : undefined,
        });

        if (status === 404) {
          throw new Error(
            `Ollama model not found. Make sure '${this.config.model}' is pulled.`,
          );
        } else if (status && status >= 500) {
          throw new Error(`Ollama server error: ${status}`);
        }
      }

      console.error("[Ollama API] Unexpected error:", error);
      throw new Error(
        `Ollama API request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async *chatStream(
    request: ChatRequest,
  ): AsyncGenerator<string, void, unknown> {
    try {
      const requestBody = this.buildRequestBody({ ...request, stream: true });

      console.log("[Ollama API] Starting stream request");

      const response = await this.client.post(
        "/v1/chat/completions",
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

        const data = line.slice(6).trim();

        if (data === "[DONE]" || !data) {
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

      console.log("[Ollama API] Stream completed");
    } catch (error) {
      console.error("[Ollama API] Stream error:", error);
      throw new Error(
        `Ollama API stream failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  isConfigured(): boolean {
    return true;
  }

  async validateConfig(): Promise<boolean> {
    try {
      const response = await this.client.get("/api/tags", { timeout: 5000 });
      return response.status === 200;
    } catch (error) {
      console.error("[Ollama API] Config validation failed:", error);
      return false;
    }
  }
}
