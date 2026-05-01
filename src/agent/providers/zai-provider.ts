import { randomUUID } from "crypto";
import axios, { AxiosError } from "axios";
import {
  AIProvider,
  ProviderCapabilities,
  ProviderConfig,
  ChatRequest,
  ChatResponse,
  ToolCall,
} from "./types";

export class ZaiProvider extends AIProvider {
  readonly name = "zai";
  readonly capabilities: ProviderCapabilities = {
    streaming: false,
    toolChoice: "auto",
    parallelToolCalls: false,
    requiresAuth: true,
    synthesizesToolCallIds: true,
  };

  constructor(config: ProviderConfig) {
    super(config);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!this.isConfigured()) {
      throw new Error(
        "Z.ai API key not configured. Set ZAI_API_KEY environment variable.",
      );
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const requestBody = this.buildRequestBody(request);

        console.log("[Z.ai API] Sending request:", {
          model: requestBody.model,
          messageCount: (requestBody.messages as any[]).length,
          hasTools: !!request.tools,
          attempt: attempt + 1,
        });

        console.log(
          "[Z.ai API] Full request body:",
          JSON.stringify(requestBody, null, 2),
        );

        const response = await this.client.post(
          "/chat/completions",
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

        console.log("[Z.ai API] Response received:", {
          contentLength: result.content.length,
          toolCallCount: result.toolCalls?.length || 0,
          tokensUsed: result.usage?.totalTokens || 0,
        });

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (axios.isAxiosError(error)) {
          const status = error.response?.status;

          if (
            status === 400 ||
            status === 401 ||
            status === 403 ||
            status === 404
          ) {
            throw this.mapError(error);
          }

          if (status === 429 || (status && status >= 500)) {
            const delay = this.getRetryDelay(attempt);
            console.warn(
              `[Z.ai API] Retryable error (${status}), waiting ${delay}ms before retry ${attempt + 1}/${this.config.maxRetries}`,
            );
            await this.sleep(delay);
            continue;
          }
        }

        if (attempt < this.config.maxRetries) {
          const delay = this.getRetryDelay(attempt);
          console.warn(
            `[Z.ai API] Network error, waiting ${delay}ms before retry ${attempt + 1}/${this.config.maxRetries}`,
          );
          await this.sleep(delay);
          continue;
        }
      }
    }

    throw new Error(
      `Z.ai API request failed after ${this.config.maxRetries} retries: ${lastError?.message || "Unknown error"}`,
    );
  }

  async *chatStream(
    request: ChatRequest,
  ): AsyncGenerator<string, void, unknown> {
    const response = await this.chat(request);
    if (response.content) {
      yield response.content;
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
      const response = await this.client.get("/models", { timeout: 15000 });
      return response.status === 200;
    } catch (error) {
      console.error("[Z.ai API] Config validation failed:", error);
      return false;
    }
  }

  protected parseToolCalls(toolCalls: any[]): ToolCall[] {
    return toolCalls.map((tc, index) => ({
      id:
        tc.id ||
        `call_${randomUUID().replace(/-/g, "").substring(0, 24)}_${index}`,
      type: tc.type || ("function" as const),
      function: {
        name: tc.function?.name || "",
        arguments:
          typeof tc.function?.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments || {}),
      },
    }));
  }

  private getRetryDelay(attempt: number): number {
    const baseDelay = 2000;
    const maxDelay = 30000;
    const exponentialDelay = Math.min(
      baseDelay * Math.pow(2, attempt),
      maxDelay,
    );
    const jitter = Math.random() * 1000;
    return exponentialDelay + jitter;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private mapError(error: AxiosError): Error {
    const status = error.response?.status;
    const data = error.response?.data as any;

    if (status === 401) {
      return new Error("Z.ai API authentication failed. Check your API key.");
    } else if (status === 400) {
      return new Error(
        `Z.ai API bad request: ${data?.error?.message || "Unknown error"}`,
      );
    } else if (status === 403) {
      return new Error("Z.ai API permission denied.");
    } else if (status === 404) {
      return new Error(
        `Z.ai API endpoint not found: ${data?.error?.message || "Unknown error"}`,
      );
    }

    return new Error(`Z.ai API error (${status}): ${error.message}`);
  }
}
