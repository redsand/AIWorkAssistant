import axios, { AxiosError } from "axios";
import {
  AIProvider,
  ProviderCapabilities,
  ProviderConfig,
  ChatRequest,
  ChatResponse,
  StreamEvent,
  ToolCall,
} from "./types";
import { sanitizeToolName, repairToolMessagePairs } from "./tool-message-repair";

const kToolNameMap = Symbol("toolNameMap");

export class OpenCodeProvider extends AIProvider {
  readonly name = "opencode";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolChoice: "auto",
    parallelToolCalls: true,
    requiresAuth: true,
    synthesizesToolCallIds: false,
    maxTools: 128,
  };

  constructor(config: ProviderConfig) {
    super(config);
  }

  protected override buildRequestBody(request: ChatRequest): Record<string, unknown> {
    const toolNameMap = new Map<string, string>();

    const sanitizedTools = request.tools?.map((tool) => {
      const original = tool.function.name;
      const sanitized = sanitizeToolName(original);
      if (sanitized !== original) toolNameMap.set(sanitized, original);
      return { ...tool, function: { ...tool.function, name: sanitized } };
    });

    // Also sanitize tool_calls.function.name in assistant messages in history
    const sanitizedMessages = request.messages.map((msg) => {
      if (msg.role !== "assistant" || !msg.tool_calls?.length) return msg;
      return {
        ...msg,
        tool_calls: msg.tool_calls.map((tc) => {
          const sanitized = sanitizeToolName(tc.function.name);
          if (sanitized !== tc.function.name) toolNameMap.set(sanitized, tc.function.name);
          return { ...tc, function: { ...tc.function, name: sanitized } };
        }),
      };
    });

    const body = super.buildRequestBody({ ...request, tools: sanitizedTools, messages: sanitizedMessages });
    if (Array.isArray(body.messages)) {
      body.messages = repairToolMessagePairs(body.messages);
    }
    (body as any)[kToolNameMap] = toolNameMap;
    return body;
  }

  protected override parseToolCalls(toolCalls: any[], toolNameMap?: Map<string, string>): ToolCall[] {
    const map = toolNameMap;
    return toolCalls.map((tc) => {
      const sanitizedName = tc.function?.name || "";
      const originalName = map?.get(sanitizedName) ?? sanitizedName;
      return {
        id: tc.id,
        type: tc.type || ("function" as const),
        function: {
          name: originalName,
          arguments: typeof tc.function?.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments || {}),
        },
      };
    });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!this.isConfigured()) {
      throw new Error(
        "OpenCode API key not configured. Set OPENCODE_API_KEY environment variable.",
      );
    }

    let lastError: Error | null = null;
    const maxAttempts = this.config.maxRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const requestBody = this.buildRequestBody(request);
        const attemptTimeout = this.getAttemptTimeout(attempt);

        console.log("[OpenCode API] Sending request:", {
          model: requestBody.model,
          messageCount: (requestBody.messages as any[]).length,
          hasTools: !!request.tools,
          attempt: `${attempt}/${maxAttempts}`,
          timeout: `${Math.round(attemptTimeout / 1000)}s`,
        });

        const response = await this.client.post(
          "/chat/completions",
          requestBody,
          { timeout: attemptTimeout },
        );

        const data = response.data;
        const message = data.choices[0].message;

        const toolNameMap = (requestBody as any)[kToolNameMap] as Map<string, string> | undefined;
        const result: ChatResponse = {
          content: message.content || "",
          thinking: message.reasoning_content || undefined,
          toolCalls: message.tool_calls
            ? this.parseToolCalls(message.tool_calls, toolNameMap)
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

        if (result.usage?.promptTokens) {
          this.calibrateTokenEstimate(
            result.usage.promptTokens,
            request.messages,
            request.tools,
          );
        }

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (axios.isAxiosError(error)) {
          const axiosError = error as AxiosError;
          const status = axiosError.response?.status;
          const data = axiosError.response?.data as any;

          console.error("[OpenCode API] Request failed:", {
            status,
            statusText: axiosError.response?.statusText,
            data: data ? JSON.stringify(data).substring(0, 200) : undefined,
          });

          if (status === 400) {
            const errorBody = data
              ? JSON.stringify(data).substring(0, 500)
              : undefined;

            if (this.isContextOverflowError(errorBody)) {
              console.error(
                `[OpenCode API] Context length exceeded (400):`,
                errorBody || "no response body",
              );
              throw new Error(
                `OpenCode API context length exceeded for model '${this.config.model}'. ${errorBody || "Prompt exceeds model maximum context length."}`,
              );
            }

            throw new Error(
              `OpenCode API bad request (400): ${data?.error?.message || "Unknown error"}`,
            );
          } else if (status === 401) {
            throw new Error(
              "OpenCode API authentication failed. Check your API key.",
            );
          } else if (status === 403 || status === 404) {
            throw new Error(
              `OpenCode API error (${status}): ${data?.error?.message || "Unknown error"}`,
            );
          } else if (status === 429) {
            if (attempt >= maxAttempts) {
              throw new Error(`OpenCode API rate limited (429) on final attempt`);
            }
            const delay = this.getRateLimitDelay(error, attempt);
            console.warn(
              `[OpenCode API] Rate limited (429), waiting ${Math.round(delay)}ms before attempt ${attempt + 1}/${maxAttempts}`,
            );
            await this.sleep(delay);
            continue;
          } else if (status && status >= 500) {
            if (attempt >= maxAttempts) {
              throw new Error(`OpenCode API server error (${status}) on final attempt`);
            }
            const delay = this.getRetryDelay(attempt);
            console.warn(
              `[OpenCode API] Server error (${status}), waiting ${Math.round(delay)}ms before attempt ${attempt + 1}/${maxAttempts}`,
            );
            await this.sleep(delay);
            continue;
          }
        }

        if (attempt < maxAttempts) {
          const delay = this.getRetryDelay(attempt);
          console.warn(
            `[OpenCode API] Network error, waiting ${Math.round(delay)}ms before attempt ${attempt + 1}/${maxAttempts}`,
          );
          await this.sleep(delay);
          continue;
        }
      }
    }

    throw new Error(
      `OpenCode API request failed after ${this.config.maxRetries} retries: ${lastError?.message || "Unknown error"}`,
    );
  }

  async *chatStream(
    request: ChatRequest,
  ): AsyncGenerator<string | StreamEvent, void, unknown> {
    if (!this.isConfigured()) {
      throw new Error(
        "OpenCode API key not configured. Set OPENCODE_API_KEY environment variable.",
      );
    }

    try {
      const requestBody = this.buildRequestBody({ ...request, stream: true });
      const toolNameMap = (requestBody as any)[kToolNameMap] as Map<string, string> | undefined;

      console.log("[OpenCode API] Starting stream request");

      const response = await this.client.post(
        "/chat/completions",
        requestBody,
        {
          responseType: "stream",
        },
      );

      const toolCallAccumulator: ToolCall[] = [];
      let lineBuffer = "";

      for await (const chunk of response.data) {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? ""; // keep incomplete trailing line

        for (const line of lines) {
          if (!line.startsWith("data: ")) {
            continue;
          }

          const data = line.slice(6).trim();

          if (data === "[DONE]" || !data) {
            continue;
          }

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices[0]?.delta;
            const finishReason = parsed.choices[0]?.finish_reason;

            if (delta?.reasoning_content) {
              yield `<<THINKING>>${delta.reasoning_content}<<//THINKING>>`;
            }

            if (delta?.content) {
              yield delta.content;
            }

            if (delta?.tool_calls) {
              for (const tcd of delta.tool_calls) {
                const idx: number = tcd.index ?? 0;
                while (toolCallAccumulator.length <= idx) {
                  toolCallAccumulator.push({
                    id: "",
                    type: "function" as const,
                    function: { name: "", arguments: "" },
                  });
                }
                const existing = toolCallAccumulator[idx];
                if (tcd.id) existing.id = tcd.id;
                if (tcd.type) existing.type = tcd.type;
                if (tcd.function?.name) {
                  existing.function.name = tcd.function.name;
                }
                if (tcd.function?.arguments) {
                  existing.function.arguments += tcd.function.arguments;
                }
              }
            }

            if (finishReason === "tool_calls" && toolCallAccumulator.length > 0) {
              // Reverse-map sanitized tool names back to dot-notation originals
              const mappedCalls = toolCallAccumulator.map((tc) => ({
                ...tc,
                function: {
                  ...tc.function,
                  name: toolNameMap?.get(tc.function.name) ?? tc.function.name,
                },
              }));
              yield { type: "tool_calls", toolCalls: mappedCalls };
              toolCallAccumulator.length = 0;
            }
          } catch {
            continue;
          }
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
    const maxDelay = 60000;
    const retryAfter = error.response?.headers?.["retry-after"];
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (!isNaN(seconds) && seconds > 0) {
        return Math.min(seconds * 1000 + Math.random() * 500, maxDelay);
      }
    }

    const baseDelay = 4000;
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
