import { randomUUID } from "crypto";
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

export class ZaiProvider extends AIProvider {
  readonly name = "zai";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolChoice: "auto",
    parallelToolCalls: false,
    requiresAuth: true,
    synthesizesToolCallIds: true,
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
      body.messages = this.normalizeMessagesForZai(body.messages as any[]);
    }
    // Z.ai (GLM) OpenAI-compatible API does not support tool_choice parameter
    delete body.tool_choice;
    (body as any)[kToolNameMap] = toolNameMap;
    return body;
  }

  /**
   * Z.ai/GLM-specific message normalization. GLM is stricter than OpenAI
   * about message format:
   * 1. Assistant messages with tool_calls must have non-empty content.
   * 2. No consecutive messages of the same role (user/user, assistant/assistant).
   */
  private normalizeMessagesForZai(messages: any[]): any[] {
    const normalized: any[] = [];
    for (let msg of messages) {
      // Ensure assistant messages with tool_calls have non-empty content
      if (msg.role === "assistant" && msg.tool_calls?.length > 0 && (!msg.content || msg.content.trim() === "")) {
        msg = { ...msg, content: " " };
      }

      // Skip consecutive messages of the same role (keep the latest)
      if (normalized.length > 0 && normalized[normalized.length - 1].role === msg.role) {
        // Merge content for user/system messages; replace for assistant/tool
        const prev = normalized[normalized.length - 1];
        if (msg.role === "user" || msg.role === "system") {
          prev.content = `${prev.content}\n\n${msg.content}`;
          continue;
        }
        // For assistant/tool, replace the previous with the current
        normalized[normalized.length - 1] = msg;
        continue;
      }

      normalized.push(msg);
    }
    return normalized;
  }


  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!this.isConfigured()) {
      throw new Error(
        "Z.ai API key not configured. Set ZAI_API_KEY environment variable.",
      );
    }
    return this.chatInternal(request, false);
  }

  private async chatInternal(
    request: ChatRequest,
    isContextOverflowRetry: boolean,
  ): Promise<ChatResponse> {
    let lastError: Error | null = null;
    const maxAttempts = this.config.maxRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const requestBody = this.buildRequestBody(request);
        const attemptTimeout = this.getAttemptTimeout(attempt);

        console.log("[Z.ai API] Sending request:", {
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

        console.log("[Z.ai API] Response received:", {
          contentLength: result.content.length,
          thinkingLength: result.thinking?.length || 0,
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
          const status = error.response?.status;

          if (
            status === 400 ||
            status === 401 ||
            status === 403 ||
            status === 404
          ) {
            if (status === 400) {
              const errorBody = error.response?.data
                ? JSON.stringify(error.response.data).substring(0, 500)
                : undefined;

              if (this.isContextOverflowError(errorBody)) {
                console.error(
                  `[Z.ai API] Context length exceeded (400):`,
                  errorBody || "no response body",
                );
                if (!isContextOverflowRetry) {
                  this.calibrateFromOverflowError(errorBody, request.messages, request.tools);
                  const modelMax = this.extractModelMaxContext(errorBody);
                  const targetMax = modelMax || this.getMaxContextTokens();
                  this.resetCalibration();
                  const prunedMessages = this.pruneAggressively(
                    request.messages, request.tools, targetMax,
                  );
                  const repairedMessages = repairToolMessagePairs(prunedMessages as any) as any;
                  console.warn(
                    `[Z.ai API] Retrying with aggressive pruning: ${request.messages.length} → ${repairedMessages.length} messages (target: ${targetMax} tokens)`,
                  );
                  return this.chatInternal(
                    { ...request, messages: repairedMessages },
                    true,
                  );
                }
                throw new Error(
                  `Z.ai API context length exceeded for model '${this.config.model}'. ${errorBody || "Prompt exceeds model maximum context length."}`,
                );
              }
            }
            throw this.mapError(error);
          }

          if (status === 429) {
            if (attempt >= maxAttempts) {
              throw new Error(`Z.ai API rate limited (429) on final attempt`);
            }
            const delay = this.getRateLimitDelay(error, attempt);
            console.warn(
              `[Z.ai API] Rate limited (429), waiting ${Math.round(delay)}ms before attempt ${attempt + 1}/${maxAttempts}`,
            );
            await this.sleep(delay);
            continue;
          }

          if (status && status >= 500) {
            if (attempt >= maxAttempts) {
              throw new Error(`Z.ai API server error (${status}) on final attempt`);
            }
            const delay = this.getRetryDelay(attempt);
            console.warn(
              `[Z.ai API] Server error (${status}), waiting ${Math.round(delay)}ms before attempt ${attempt + 1}/${maxAttempts}`,
            );
            await this.sleep(delay);
            continue;
          }
        }

        if (attempt < maxAttempts) {
          const delay = this.getRetryDelay(attempt);
          console.warn(
            `[Z.ai API] Network error, waiting ${Math.round(delay)}ms before attempt ${attempt + 1}/${maxAttempts}`,
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
  ): AsyncGenerator<string | StreamEvent, void, unknown> {
    yield* this.chatStreamInternal(request, false);
  }

  private async *chatStreamInternal(
    request: ChatRequest,
    isContextOverflowRetry: boolean,
  ): AsyncGenerator<string | StreamEvent, void, unknown> {
    const maxAttempts = this.config.maxRetries + 1;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const requestBody = this.buildRequestBody({ ...request, stream: true });
        const toolNameMap = (requestBody as any)[kToolNameMap] as Map<string, string> | undefined;

        console.log("[Z.ai API] Sending stream request:", {
          model: requestBody.model,
          messageCount: (requestBody.messages as any[]).length,
          hasTools: !!request.tools,
          attempt: `${attempt}/${maxAttempts}`,
        });

        const response = await this.client.post(
          "/chat/completions",
          requestBody,
          { responseType: "stream", validateStatus: () => true },
        );

        if (response.status !== 200) {
          const errorBody = await this.readStreamBody(response.data);

          if (response.status === 400) {
            if (this.isContextOverflowError(errorBody)) {
              console.error("[Z.ai API] Context length exceeded (400):", errorBody);
              if (!isContextOverflowRetry) {
                this.calibrateFromOverflowError(errorBody, request.messages, request.tools);
                const modelMax = this.extractModelMaxContext(errorBody);
                const targetMax = modelMax || this.getMaxContextTokens();
                this.resetCalibration();
                const prunedMessages = this.pruneAggressively(
                  request.messages, request.tools, targetMax,
                );
                const repairedMessages = repairToolMessagePairs(prunedMessages as any) as any;
                console.warn(
                  `[Z.ai API] Retrying stream with aggressive pruning: ${request.messages.length} → ${repairedMessages.length} messages (target: ${targetMax} tokens)`,
                );
                yield* this.chatStreamInternal(
                  { ...request, messages: repairedMessages },
                  true,
                );
                return;
              }
              throw new Error(
                `Z.ai API context length exceeded for model '${this.config.model}'. ${errorBody}`,
              );
            }
            throw new Error(`Z.ai API bad request: ${errorBody}`);
          }

          if (response.status === 401 || response.status === 403) {
            throw this.mapStatusError(response.status, errorBody);
          }

          if (response.status === 429) {
            if (attempt >= maxAttempts) {
              throw new Error(`Z.ai API rate limited (429) on final attempt: ${errorBody}`);
            }
            const delay = this.getRetryDelay(attempt);
            console.warn(`[Z.ai API] Rate limited (429), waiting ${Math.round(delay)}ms before attempt ${attempt + 1}/${maxAttempts}`);
            await this.sleep(delay);
            continue;
          }

          if (response.status >= 500) {
            if (attempt >= maxAttempts) {
              throw new Error(`Z.ai API server error (${response.status}) on final attempt: ${errorBody}`);
            }
            const delay = this.getRetryDelay(attempt);
            console.warn(`[Z.ai API] Server error (${response.status}), waiting ${Math.round(delay)}ms before attempt ${attempt + 1}/${maxAttempts}`);
            await this.sleep(delay);
            continue;
          }

          throw new Error(`Z.ai API error (${response.status}): ${errorBody}`);
        }

        let lineBuffer = "";
        const toolCallAccumulator: ToolCall[] = [];
        for await (const chunk of response.data) {
          lineBuffer += chunk.toString();
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;

            const data = line.slice(6).trim();
            if (data === "[DONE]" || !data) continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices[0]?.delta;
              const finishReason = parsed.choices[0]?.finish_reason;

              if (delta?.reasoning_content || delta?.thinking) {
                yield `<<THINKING>>${delta.reasoning_content || delta.thinking}<<//THINKING>>`;
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
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Context overflow and auth errors should not be retried
        if (
          lastError.message.includes("context length exceeded") ||
          lastError.message.includes("authentication failed") ||
          lastError.message.includes("permission denied")
        ) {
          throw lastError;
        }
        // Rate limit and server errors are retried above; anything else that
        // reaches here (e.g. network error mid-stream) should throw immediately.
        if (attempt < maxAttempts && !axios.isAxiosError(error)) {
          const delay = this.getRetryDelay(attempt);
          console.warn(`[Z.ai API] Stream error, retrying in ${Math.round(delay)}ms: ${lastError.message}`);
          await this.sleep(delay);
          continue;
        }
        throw lastError;
      }
    }

    throw new Error(
      `Z.ai API stream failed after ${this.config.maxRetries} retries: ${lastError?.message || "Unknown error"}`,
    );
  }

  private async readStreamBody(stream: NodeJS.ReadableStream): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    try {
      const text = Buffer.concat(chunks).toString();
      const parsed = JSON.parse(text);
      return JSON.stringify(parsed).substring(0, 500);
    } catch {
      return Buffer.concat(chunks).toString().substring(0, 500);
    }
  }

  private mapStatusError(status: number, body: string): Error {
    if (status === 401) return new Error("Z.ai API authentication failed. Check your API key.");
    if (status === 403) return new Error("Z.ai API permission denied.");
    return new Error(`Z.ai API error (${status}): ${body}`);
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

  protected override parseToolCalls(toolCalls: any[], toolNameMap?: Map<string, string>): ToolCall[] {
    const map = toolNameMap;
    return toolCalls.map((tc, index) => {
      const sanitizedName = tc.function?.name || "";
      const originalName = map?.get(sanitizedName) ?? sanitizedName;
      return {
        id: tc.id || `call_${randomUUID().replace(/-/g, "").substring(0, 24)}_${index}`,
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
