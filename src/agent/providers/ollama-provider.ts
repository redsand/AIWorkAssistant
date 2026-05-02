import axios, { AxiosError } from "axios";
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
    synthesizesToolCallIds: true,
  };

  constructor(config: ProviderConfig) {
    super(config);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    let lastError: Error | null = null;
    const maxAttempts = this.config.maxRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const requestBody = this.buildRequestBody(request);

        console.log("[Ollama API] Sending request:", {
          model: requestBody.model,
          messageCount: (requestBody.messages as any[]).length,
          hasTools: !!request.tools,
          toolCount: request.tools?.length || 0,
          attempt: `${attempt}/${maxAttempts}`,
        });

        const response = await this.client.post(
          "/v1/chat/completions",
          requestBody,
        );

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

        console.log("[Ollama API] Response received:", {
          contentLength: result.content.length,
          thinkingLength: result.thinking?.length || 0,
          toolCallCount: result.toolCalls?.length || 0,
          tokensUsed: result.usage?.totalTokens || 0,
        });

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (axios.isAxiosError(error)) {
          const status = error.response?.status;

          if (status === 400 && request.tools && attempt === 1) {
            console.warn(
              "[Ollama API] Model may not support tools, retrying without tools",
            );
            return this.chat({ ...request, tools: undefined });
          }

          if (status === 500 && request.tools && attempt === 1) {
            console.warn(
              "[Ollama API] Server error with tools, retrying without tools",
            );
            return this.chat({ ...request, tools: undefined });
          }

          if (status === 401 || status === 403) {
            throw new Error(
              `Ollama API authentication failed (${status}). Check your API key.`,
            );
          }

          if (status === 404) {
            throw new Error(
              `Ollama model not found. Make sure '${this.config.model}' is available.`,
            );
          }

          if (status === 429) {
            if (attempt >= maxAttempts) break;
            const delay = this.getRateLimitDelay(error, attempt);
            console.warn(
              `[Ollama API] Rate limited (429), waiting ${Math.round(delay)}ms before attempt ${attempt + 1}/${maxAttempts}`,
            );
            await this.sleep(delay);
            continue;
          }

          if (status && status >= 500) {
            const errorBody = error.response?.data
              ? JSON.stringify(error.response.data).substring(0, 500)
              : undefined;
            console.error(
              `[Ollama API] Server error (${status}):`,
              errorBody || "no response body",
            );
            if (attempt >= maxAttempts) break;
            const delay = this.getRetryDelay(attempt);
            console.warn(
              `[Ollama API] Server error (${status}), waiting ${Math.round(delay)}ms before attempt ${attempt + 1}/${maxAttempts}`,
            );
            await this.sleep(delay);
            continue;
          }
        }

        if (attempt < maxAttempts) {
          const delay = this.getRetryDelay(attempt);
          console.warn(
            `[Ollama API] Network error, waiting ${Math.round(delay)}ms before attempt ${attempt + 1}/${maxAttempts}`,
          );
          await this.sleep(delay);
          continue;
        }
      }
    }

    const errorDetail = lastError?.message || "Unknown error";
    const suggestion = errorDetail.includes("500")
      ? " The Ollama server returned an internal error — check Ollama logs with: ollama logs"
      : "";
    throw new Error(
      `Ollama API request failed after ${this.config.maxRetries} retries: ${errorDetail}.${suggestion}`,
    );
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
    return !!this.config.baseUrl;
  }

  async validateConfig(): Promise<boolean> {
    try {
      const response = await this.client.get("/api/tags", { timeout: 5000 });
      return response.status === 200;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        console.error(
          "[Ollama API] Authentication failed — check your API key",
        );
        return false;
      }

      if (axios.isAxiosError(error) && error.response?.status === 404) {
        console.log(
          "[Ollama API] /api/tags not found (cloud endpoint), assuming valid",
        );
        return true;
      }

      console.error("[Ollama API] Config validation failed:", error);
      return false;
    }
  }

  private getRetryDelay(attempt: number): number {
    const baseDelay = 1000;
    const maxDelay = 30000;
    const exponentialDelay = Math.min(
      baseDelay * Math.pow(2, attempt - 1),
      maxDelay,
    );
    const jitter = Math.random() * 1000;
    return exponentialDelay + jitter;
  }

  private getRateLimitDelay(error: AxiosError, attempt: number): number {
    const retryAfter = error.response?.headers?.["retry-after"];
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (!isNaN(seconds) && seconds > 0) {
        return seconds * 1000 + Math.random() * 500;
      }
    }

    const baseDelay = 4000;
    const maxDelay = 60000;
    const exponentialDelay = Math.min(
      baseDelay * Math.pow(2, attempt - 1),
      maxDelay,
    );
    const jitter = Math.random() * 2000;
    return exponentialDelay + jitter;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
