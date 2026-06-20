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
import { sanitizeToolName, repairToolMessagePairs } from "./tool-message-repair";
import { aiRequestLimiter } from "./ai-request-limiter";
import { env } from "../../config/env";

const MAX_RATE_LIMIT_SLEEP_MS = 300_000;

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

  protected async chatImpl(request: ChatRequest): Promise<ChatResponse> {
    return this.chatInternal(request, false);
  }

  private async chatInternal(
    request: ChatRequest,
    isContextOverflowRetry: boolean,
  ): Promise<ChatResponse> {
    let lastError: Error | null = null;
    const maxAttempts = this.config.maxRetries + 1;
    let rateLimitedSince: number | null = null;
    const rateLimitBudgetMs = env.AI_RATE_LIMIT_MAX_WAIT_MS;
    let rateLimitAttempt = 0;

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

        await aiRequestLimiter.acquire(this.name);
        let response;
        try {
          response = await this.client.post(
            "/v1/chat/completions",
            requestBody,
            { timeout: attemptTimeout, signal: request.signal },
          );
        } finally {
          aiRequestLimiter.release(this.name);
        }

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

        if (axios.isCancel(error)) throw error;

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
              if (!isContextOverflowRetry) {
                const modelMax = this.extractModelMaxContext(errorBody);
                const targetMax = modelMax || this.getMaxContextTokens();
                this.resetCalibration();
                const prunedMessages = this.pruneAggressively(
                  request.messages,
                  request.tools,
                  targetMax,
                );
                if (DEBUG) console.warn(`[Ollama API] Retrying with aggressive pruning: ${request.messages.length} → ${prunedMessages.length} messages (target: ${targetMax} tokens)`);
                return this.chatInternal(
                  { ...request, messages: prunedMessages },
                  true,
                );
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
            if (attempt >= maxAttempts) {
              throw new Error(`Ollama API server error (500) with tools on final attempt`);
            }
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
            rateLimitedSince ??= Date.now();
            rateLimitAttempt++;
            const totalWaited = Date.now() - rateLimitedSince;
            if (totalWaited >= rateLimitBudgetMs) {
              throw new Error(
                `Ollama API rate limited for ${Math.round(totalWaited / 1000)}s ` +
                `(budget ${Math.round(rateLimitBudgetMs / 1000)}s exhausted)`,
              );
            }
            const delay = Math.min(this.getRateLimitDelay(error, rateLimitAttempt), MAX_RATE_LIMIT_SLEEP_MS);
            if (DEBUG) console.warn(`[Ollama API] Rate limited (429), waiting ${Math.round(delay)}ms (throttled for ${Math.round(totalWaited / 1000)}s)`);
            await this.sleep(delay);
            attempt--;
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
            if (attempt >= maxAttempts) {
              throw new Error(`Ollama API server error (${status}) on final attempt`);
            }
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

  protected async *chatStreamImpl(
    request: ChatRequest,
  ): AsyncGenerator<string | StreamEvent, void, unknown> {
    await aiRequestLimiter.acquire(this.name);
    const idleGuard = this.installFirstChunkAbort(request.signal);
    try {
      const requestBody = this.buildRequestBody({ ...request, stream: true });
      const toolNameMap = (requestBody as any)[kToolNameMap] as Map<string, string> | undefined;

      if (DEBUG) console.log("[Ollama API] Starting stream request");

      // Retry loop for the initial POST — once streaming begins we don't
      // rewind, but 429/500 errors at connection time are retried.
      const maxAttempts = this.config.maxRetries + 1;
      let lastError: Error | null = null;
      let response: any;
      let streamRateLimitedSince: number | null = null;
      const streamRateLimitBudgetMs = env.AI_RATE_LIMIT_MAX_WAIT_MS;
      let streamRateLimitAttempt = 0;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          response = await this.client.post(
            "/v1/chat/completions",
            requestBody,
            {
              responseType: "stream",
              // installFirstChunkAbort composes the caller's cancellation
              // signal with an idle-timeout watchdog (default 30s). Without
              // this, a stalled upstream held the aiRequestLimiter slot for
              // up to 17 minutes per call (observed across 22 consecutive
              // ollama/kimi-k2.7-code:cloud failures on 2026-06-19).
              signal: idleGuard.signal,
            },
          );
          break; // success — exit retry loop
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (axios.isAxiosError(error)) {
            const status = error.response?.status;
            if (status === 429) {
              streamRateLimitedSince ??= Date.now();
              streamRateLimitAttempt++;
              const totalWaited = Date.now() - streamRateLimitedSince;
              if (totalWaited >= streamRateLimitBudgetMs) {
                throw new Error(
                  `Ollama API rate limited for ${Math.round(totalWaited / 1000)}s ` +
                  `(budget ${Math.round(streamRateLimitBudgetMs / 1000)}s exhausted)`,
                );
              }
              const delay = Math.min(this.getRateLimitDelay(error, streamRateLimitAttempt), MAX_RATE_LIMIT_SLEEP_MS);
              if (DEBUG) console.warn(`[Ollama API] Rate limited (429), waiting ${Math.round(delay)}ms (throttled for ${Math.round(totalWaited / 1000)}s)`);
              yield { type: "thinking" as const, content: `Rate limited, waiting ${Math.round(delay / 1000)}s before retry…` };
              await this.sleep(delay);
              attempt--;
              continue;
            }
            if (status && status >= 500) {
              if (attempt >= maxAttempts) {
                throw new Error(`Ollama API server error (${status}) on final attempt`);
              }
              const delay = this.getRetryDelay(attempt);
              if (DEBUG) console.warn(`[Ollama API] Server error (${status}), waiting ${Math.round(delay)}ms before attempt ${attempt + 1}/${maxAttempts}`);
              yield { type: "thinking" as const, content: `Ollama API server error (${status}), retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxAttempts})...` };
              await this.sleep(delay);
              continue;
            }
            if (status === 400 || status === 401 || status === 403 || status === 404) {
              throw lastError;
            }
          }
          if (attempt < maxAttempts) {
            const delay = this.getRetryDelay(attempt);
            if (DEBUG) console.warn(`[Ollama API] Network error, waiting ${Math.round(delay)}ms before attempt ${attempt + 1}/${maxAttempts}`);
            yield { type: "thinking" as const, content: `Network error connecting to Ollama API, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxAttempts})...` };
            await this.sleep(delay);
            continue;
          }
          throw lastError;
        }
      }

      // Buffer incomplete lines — multiple SSE events can arrive in one chunk.
      // Parsing the raw chunk directly drops all but the first event in the batch.
      let lineBuffer = "";
      const toolCallAccumulator: ToolCall[] = [];
      let hasCompleteMessageToolCalls = false;
      let streamUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;
      const emitToolCalls = function* (): Generator<StreamEvent> {
        if (toolCallAccumulator.length === 0) return;
        const mappedCalls = toolCallAccumulator.map((tc, index) => ({
          ...tc,
          id: tc.id || `call_${randomUUID().replace(/-/g, "").substring(0, 24)}_${index}`,
          function: {
            ...tc.function,
            name: toolNameMap?.get(tc.function.name) ?? tc.function.name,
          },
        }));
        yield { type: "tool_calls", toolCalls: mappedCalls };
        toolCallAccumulator.length = 0;
        hasCompleteMessageToolCalls = false;
      };

      for await (const chunk of response.data) {
        // First byte of response body arrived — clear the idle watchdog so
        // a slow but live stream doesn't trip it mid-tokens.
        idleGuard.onChunk();
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? ""; // keep any incomplete trailing line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const data = trimmed.startsWith("data: ")
            ? trimmed.slice(6).trim()
            : trimmed.startsWith("{")
              ? trimmed
              : "";
          if (!data) continue;
          if (data === "[DONE]" || !data) continue;

          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            const delta = choice?.delta ?? {};
            const message = choice?.message ?? parsed.message ?? {};
            const finishReason = choice?.finish_reason ?? parsed.done_reason;
            const done = parsed.done === true || data === "[DONE]";
            const thinking =
              delta?.reasoning_content ||
              delta?.thinking ||
              message?.reasoning_content ||
              message?.thinking ||
              parsed?.reasoning_content ||
              parsed?.thinking;
            const content =
              delta?.content ??
              message?.content ??
              parsed?.content;

            if (thinking) {
              yield `<<THINKING>>${thinking}<<//THINKING>>`;
            }

            if (content) {
              yield content;
            }

            const streamedToolCalls = delta?.tool_calls ?? message?.tool_calls ?? parsed?.tool_calls;
            if (message?.tool_calls || parsed?.tool_calls) {
              hasCompleteMessageToolCalls = true;
            }
            if (streamedToolCalls) {
              this.accumulateToolCallDeltas(streamedToolCalls, toolCallAccumulator);
            }

            if (parsed.usage?.prompt_tokens) {
              streamUsage = {
                promptTokens: parsed.usage.prompt_tokens,
                completionTokens: parsed.usage.completion_tokens || 0,
                totalTokens: parsed.usage.total_tokens || 0,
              };
            }

            if (
              (finishReason === "tool_calls" ||
                done ||
                (finishReason === "stop" && hasCompleteMessageToolCalls)) &&
              toolCallAccumulator.length > 0
            ) {
              yield* emitToolCalls();
            }
          } catch {
            continue;
          }
        }
      }

      if (lineBuffer.trim()) {
        const data = lineBuffer.trim().startsWith("data: ")
          ? lineBuffer.trim().slice(6).trim()
          : lineBuffer.trim().startsWith("{")
            ? lineBuffer.trim()
            : "";
        if (data && data !== "[DONE]") {
          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            const content = choice?.delta?.content ?? choice?.message?.content ?? parsed?.message?.content ?? parsed?.content;
            if (content) yield content;
            const finalToolCalls = choice?.delta?.tool_calls ?? choice?.message?.tool_calls ?? parsed?.message?.tool_calls ?? parsed?.tool_calls;
            if (choice?.message?.tool_calls || parsed?.message?.tool_calls || parsed?.tool_calls) {
              hasCompleteMessageToolCalls = true;
            }
            if (finalToolCalls) {
              this.accumulateToolCallDeltas(finalToolCalls, toolCallAccumulator);
            }
          } catch {}
        }
      }
      if (hasCompleteMessageToolCalls) yield* emitToolCalls();

      if (streamUsage) {
        yield { type: "usage" as const, usage: streamUsage };
      }
      if (DEBUG) console.log("[Ollama API] Stream completed");
    } catch (error) {
      const idleReason = idleGuard.abortReason();
      const detail = error instanceof Error ? error.message : "Unknown error";
      // Prefer the watchdog's reason when it caused the abort — otherwise
      // axios just reports "canceled" with no context.
      const message = idleReason && /abort|cancel|canceled/i.test(detail)
        ? `Ollama API stream aborted: ${idleReason}`
        : `Ollama API stream failed: ${detail}`;
      console.error("[Ollama API] Stream error:", message);
      throw new Error(message);
    } finally {
      idleGuard.dispose();
      aiRequestLimiter.release(this.name);
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

  private accumulateToolCallDeltas(
    deltas: any[],
    accumulator: ToolCall[],
  ): void {
    for (const tcd of deltas) {
      const idx: number = tcd.index ?? 0;
      while (accumulator.length <= idx) {
        accumulator.push({
          id: "",
          type: "function" as const,
          function: { name: "", arguments: "" },
        });
      }
      const existing = accumulator[idx];
      if (tcd.id) existing.id = tcd.id;
      if (tcd.type) existing.type = tcd.type;
      if (tcd.function?.name) existing.function.name = tcd.function.name;
      if (tcd.function?.arguments) {
        existing.function.arguments += typeof tcd.function.arguments === "string"
          ? tcd.function.arguments
          : JSON.stringify(tcd.function.arguments);
      }
    }
  }
}
