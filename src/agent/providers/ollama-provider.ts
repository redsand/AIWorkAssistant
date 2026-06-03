import axios, { AxiosError } from "axios";

const DEBUG = process.env.AICODER_DEBUG === "true";
import { randomUUID } from "crypto";
import {
  AIProvider,
  ProviderCapabilities,
  ProviderConfig,
  ChatRequest,
  ChatResponse,
  StreamEvent,
  ToolCall,
} from "./types";

function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function repairToolMessagePairs(messages: any[]): any[] {
  const result: any[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const expectedIds = new Set<string>(msg.tool_calls.map((tc: any) => tc.id).filter(Boolean));
      const toolResponses: any[] = [];
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") {
        toolResponses.push(messages[j]);
        j++;
      }

      const respondedIds = new Set(toolResponses.map((m: any) => m.tool_call_id).filter(Boolean));
      const allPresent = [...expectedIds].every((id) => respondedIds.has(id));

      if (allPresent && toolResponses.length > 0) {
        result.push(msg);
        toolResponses.forEach((m) => result.push(m));
      } else if (toolResponses.length > 0) {
        const filteredCalls = msg.tool_calls.filter((tc: any) => respondedIds.has(tc.id));
        if (filteredCalls.length > 0) {
          result.push({ ...msg, tool_calls: filteredCalls });
          toolResponses
            .filter((m) => filteredCalls.some((tc: any) => tc.id === m.tool_call_id))
            .forEach((m) => result.push(m));
        } else {
          const { tool_calls, ...rest } = msg;
          if (rest.content) result.push(rest);
        }
      } else {
        const { tool_calls, ...rest } = msg;
        if (rest.content) result.push(rest);
      }
      i = j;
    } else if (msg.role === "tool") {
      i++;
    } else {
      result.push(msg);
      i++;
    }
  }

  return result;
}

const kToolNameMap = Symbol("toolNameMap");

export class OllamaProvider extends AIProvider {
  readonly name = "ollama";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolChoice: "auto",
    parallelToolCalls: false,
    requiresAuth: false,
    synthesizesToolCallIds: true,
    maxTools: 128,
  };

  private isContextOverflowRetry = false;

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
    }
    (body as any)[kToolNameMap] = toolNameMap;
    return body;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    let lastError: Error | null = null;
    const maxAttempts = this.config.maxRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const requestBody = this.buildRequestBody(request);
        const attemptTimeout = this.getAttemptTimeout(attempt);

        if (DEBUG) console.log("[Ollama API] Sending request:", {
          model: requestBody.model,
          messageCount: (requestBody.messages as any[]).length,
          hasTools: !!request.tools,
          toolCount: request.tools?.length || 0,
          attempt: `${attempt}/${maxAttempts}`,
          timeout: `${Math.round(attemptTimeout / 1000)}s`,
        });

        const response = await this.client.post(
          "/v1/chat/completions",
          requestBody,
          { timeout: attemptTimeout },
        );

        const data = response.data;
        const message = data.choices[0].message;
        const toolNameMap = (requestBody as any)[kToolNameMap] as Map<string, string> | undefined;

        const result: ChatResponse = {
          content: message.content || "",
          thinking: message.reasoning_content || message.thinking || message.reasoning || undefined,
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

        if (DEBUG) console.log("[Ollama API] Response received:", {
          contentLength: result.content.length,
          thinkingLength: result.thinking?.length || 0,
          toolCallCount: result.toolCalls?.length || 0,
          tokensUsed: result.usage?.totalTokens || 0,
          hasReasoningContent: !!message.reasoning_content,
          hasThinking: !!message.thinking,
          hasReasoning: !!message.reasoning,
          messageKeys: Object.keys(message),
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

          if (status === 400) {
            const errorBody = error.response?.data
              ? JSON.stringify(error.response.data).substring(0, 500)
              : undefined;

            if (this.isContextOverflowError(errorBody)) {
              console.error(
                `[Ollama API] Context length exceeded (400):`,
                errorBody || "no response body",
              );
              // Calibrate from the overflow so the next attempt estimates correctly
              this.calibrateFromOverflowError(
                errorBody,
                request.messages,
                request.tools,
              );

              // Retry once with aggressive pruning if this isn't already a retry
              if (!this.isContextOverflowRetry) {
                const modelMax = this.extractModelMaxContext(errorBody);
                const targetMax = modelMax || this.getMaxContextTokens();
                this.resetCalibration();
                const prunedMessages = this.pruneAggressively(
                  request.messages,
                  request.tools,
                  targetMax,
                );
                if (DEBUG) console.warn(`[Ollama API] Retrying with aggressive pruning: ${request.messages.length} → ${prunedMessages.length} messages (target: ${targetMax} tokens)`);
                this.isContextOverflowRetry = true;
                try {
                  const retryResult = await this.chat({
                    ...request,
                    messages: prunedMessages,
                  });
                  return retryResult;
                } finally {
                  this.isContextOverflowRetry = false;
                }
              }

              throw new Error(
                `Ollama API context length exceeded for model '${this.config.model}'. ${errorBody || "Prompt exceeds model maximum context length."}`,
              );
            }

            if (request.tools) {
              console.error(
                `[Ollama API] Bad request with tools (400):`,
                errorBody || "no response body",
              );
              throw new Error(
                `Ollama API returned 400 with tools. The model '${this.config.model}' may not support function calling. Error: ${errorBody || "unknown"}`,
              );
            }

            throw new Error(
              `Ollama API returned 400. Error: ${errorBody || "unknown"}`,
            );
          }

          if (status === 500 && request.tools && attempt === 1) {
            if (DEBUG) console.warn("[Ollama API] Server error with tools, will retry with tools on next attempt");
            if (attempt >= maxAttempts) break;
            const delay = this.getRetryDelay(attempt);
            await this.sleep(delay);
            continue;
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
            if (DEBUG) console.warn(`[Ollama API] Rate limited (429), waiting ${Math.round(delay)}ms before attempt ${attempt + 1}/${maxAttempts}`);
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
            if (DEBUG) console.warn(`[Ollama API] Server error (${status}), waiting ${Math.round(delay)}ms before attempt ${attempt + 1}/${maxAttempts}`);
            await this.sleep(delay);
            continue;
          }

          // Network-level failure with no HTTP status (ECONNRESET, ETIMEDOUT, etc.)
          if (!status) {
            const errorCode = error.code || "UNKNOWN";
            const errorMessage = error.message || "no message";
            const requestUrl = error.config?.url || "unknown";
            console.error(
              `[Ollama API] Network failure (${errorCode}) on ${requestUrl}: ${errorMessage}`,
            );
          }
        }

        if (attempt < maxAttempts) {
          const delay = this.getRetryDelay(attempt);
          if (DEBUG) console.warn(`[Ollama API] Network error, waiting ${Math.round(delay)}ms before attempt ${attempt + 1}/${maxAttempts}`);
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
  ): AsyncGenerator<string | StreamEvent, void, unknown> {
    try {
      const requestBody = this.buildRequestBody({ ...request, stream: true });
      const toolNameMap = (requestBody as any)[kToolNameMap] as Map<string, string> | undefined;

      if (DEBUG) console.log("[Ollama API] Starting stream request");

      const response = await this.client.post(
        "/v1/chat/completions",
        requestBody,
        {
          responseType: "stream",
        },
      );

      // Buffer incomplete lines — multiple SSE events can arrive in one chunk.
      // Parsing the raw chunk directly drops all but the first event in the batch.
      let lineBuffer = "";
      const toolCallAccumulator: ToolCall[] = [];
      for await (const chunk of response.data) {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? ""; // keep any incomplete trailing line

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

      if (DEBUG) console.log("[Ollama API] Stream completed");
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
        if (DEBUG) console.log("[Ollama API] /api/tags not found (cloud endpoint), assuming valid");
        return true;
      }

      console.error("[Ollama API] Config validation failed:", error);
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
