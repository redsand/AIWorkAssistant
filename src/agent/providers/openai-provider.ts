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
import { aiRequestLimiter } from "./ai-request-limiter";
import { env } from "../../config/env";

const DEBUG = process.env.AICODER_DEBUG === "true";
const MAX_RATE_LIMIT_SLEEP_MS = 300_000;

const kToolNameMap = Symbol("toolNameMap");

export class OpenAIProvider extends AIProvider {
  readonly name = "openai";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolChoice: "auto",
    parallelToolCalls: true,
    requiresAuth: true,
    synthesizesToolCallIds: false,
    maxTools: 128,
  };

  private isContextOverflowRetry = false;

  constructor(config: ProviderConfig) {
    super(config);
  }

  protected override buildRequestBody(request: ChatRequest): Record<string, unknown> {
    // Sanitize tool names in the tools schema AND in message history.
    // OpenAI validates ^[a-zA-Z0-9_-]+$ in both places.
    // Also strip caller-supplied temperature/top_p (chat.ts hardcodes 0.7).
    const toolNameMap = new Map<string, string>();

    const sanitizedTools = request.tools?.map((tool) => {
      const original = tool.function.name;
      const sanitized = sanitizeToolName(original);
      if (sanitized !== original) toolNameMap.set(sanitized, original);
      return { ...tool, function: { ...tool.function, name: sanitized } };
    });

    // Sanitize tool_calls.function.name inside assistant messages in history
    const sanitizedMessages = request.messages.map((msg) => {
      if (msg.role !== "assistant" || !msg.tool_calls?.length) return msg;
      return {
        ...msg,
        tool_calls: msg.tool_calls.map((tc) => {
          const sanitized = sanitizeToolName(tc.function.name);
          if (sanitized !== tc.function.name) {
            toolNameMap.set(sanitized, tc.function.name);
          }
          return { ...tc, function: { ...tc.function, name: sanitized } };
        }),
      };
    });

    const sanitizedRequest: ChatRequest = {
      ...request,
      messages: sanitizedMessages,
      tools: sanitizedTools,
      temperature: undefined,
      top_p: undefined,
    };

    const body = super.buildRequestBody(sanitizedRequest);
    (body as any)[kToolNameMap] = toolNameMap;

    // Repair broken tool_calls/tool message pairs introduced by context pruning.
    // OpenAI requires every role:tool message to follow an assistant+tool_calls
    // that contains the matching tool_call_id.
    if (Array.isArray(body.messages)) {
      body.messages = repairToolMessagePairs(body.messages);
    }

    // Reasoning models (o1, o3, o4-*) reject temperature/top_p entirely and
    // require max_completion_tokens instead of max_tokens.
    // GPT-5+ models require temperature=1.0.
    const model = String((body.model as string) || "");
    if (/^o\d/i.test(model)) {
      delete body.temperature;
      delete body.top_p;
      if (body.max_tokens !== undefined) {
        body.max_completion_tokens = body.max_tokens;
        delete body.max_tokens;
      }
    } else if (/^gpt-5/i.test(model)) {
      body.temperature = 1.0;
      delete body.top_p;
    }

    return body;
  }

  isConfigured(): boolean {
    return !!this.config.apiKey && !!this.config.baseUrl;
  }

  async validateConfig(): Promise<boolean> {
    try {
      const response = await this.client.get("/models", { timeout: 5000 });
      return response.status === 200;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        console.error("[OpenAI] Authentication failed — check OPENAI_API_KEY");
        return false;
      }
      console.error("[OpenAI] Config validation failed:", error);
      return false;
    }
  }

  protected async chatImpl(request: ChatRequest): Promise<ChatResponse> {
    if (!this.isConfigured()) {
      throw new Error("OpenAI API key not configured. Set OPENAI_API_KEY environment variable.");
    }

    let lastError: Error | null = null;
    const maxAttempts = this.config.maxRetries + 1;
    let rateLimitedSince: number | null = null;
    const rateLimitBudgetMs = env.AI_RATE_LIMIT_MAX_WAIT_MS;
    let rateLimitAttempt = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const requestBody = this.buildRequestBody(request);
        const attemptTimeout = this.getAttemptTimeout(attempt);

        if (DEBUG) console.log("[OpenAI] Sending request:", {
          model: requestBody.model,
          messageCount: (requestBody.messages as any[]).length,
          hasTools: !!request.tools,
          attempt: `${attempt}/${maxAttempts}`,
          timeout: `${Math.round(attemptTimeout / 1000)}s`,
        });

        const limiterModel = request.model ?? this.config.model ?? null;
        const limiterTag = request.concurrencyTag ?? null;
        const slotId = await aiRequestLimiter.acquire(
          this.name,
          limiterModel,
          limiterTag,
          request.signal,
        );
        let response;
        try {
          response = await this.client.post("/chat/completions", requestBody, {
            timeout: attemptTimeout,
            signal: request.signal,
          });
        } finally {
          aiRequestLimiter.release(this.name, limiterModel, limiterTag, slotId);
        }

        const data = response.data;
        const message = data.choices[0].message;
        const toolNameMap = (requestBody as any)[kToolNameMap] as Map<string, string> | undefined;

        const result: ChatResponse = {
          content: message.content || "",
          toolCalls: message.tool_calls ? this.parseToolCalls(message.tool_calls, toolNameMap) : undefined,
          usage: {
            promptTokens: data.usage?.prompt_tokens || 0,
            completionTokens: data.usage?.completion_tokens || 0,
            totalTokens: data.usage?.total_tokens || 0,
          },
          model: data.model || this.config.model,
          done: true,
        };

        if (result.usage?.promptTokens) {
          this.calibrateTokenEstimate(result.usage.promptTokens, request.messages, request.tools);
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
              this.calibrateFromOverflowError(errorBody, request.messages, request.tools);
              if (!this.isContextOverflowRetry) {
                const modelMax = this.extractModelMaxContext(errorBody);
                const targetMax = modelMax || this.getMaxContextTokens();
                this.resetCalibration();
                const prunedMessages = this.pruneAggressively(request.messages, request.tools, targetMax);
                this.isContextOverflowRetry = true;
                try {
                  return await this.chat({ ...request, messages: prunedMessages });
                } finally {
                  this.isContextOverflowRetry = false;
                }
              }
              throw new Error(`OpenAI context length exceeded for model '${this.config.model}'. ${errorBody || ""}`);
            }

            throw new Error(`OpenAI API returned 400. Error: ${errorBody || "unknown"}`);
          }

          if (status === 401 || status === 403) {
            throw new Error(`OpenAI authentication failed (${status}). Check OPENAI_API_KEY.`);
          }

          if (status === 404) {
            throw new Error(`OpenAI model not found: '${this.config.model}'. Verify the model name.`);
          }

          if (status === 429) {
            // 429 = rate-limit, not failure. Loop until AI_RATE_LIMIT_MAX_WAIT_MS
            // budget is exhausted, then throw.
            rateLimitedSince ??= Date.now();
            rateLimitAttempt++;
            const totalWaited = Date.now() - rateLimitedSince;
            if (totalWaited >= rateLimitBudgetMs) {
              throw new Error(
                `OpenAI API rate limited for ${Math.round(totalWaited / 1000)}s ` +
                `(budget ${Math.round(rateLimitBudgetMs / 1000)}s exhausted)`,
              );
            }
            const delay = Math.min(this.getRateLimitDelay(error, rateLimitAttempt), MAX_RATE_LIMIT_SLEEP_MS);
            if (DEBUG) console.warn(
              `[OpenAI] Rate limited (429), waiting ${Math.round(delay)}ms ` +
              `(throttled for ${Math.round(totalWaited / 1000)}s, budget ${Math.round(rateLimitBudgetMs / 1000)}s)`,
            );
            await this.sleep(delay);
            attempt--; // 429 retries don't consume attempt budget
            continue;
          }

          if (status && status >= 500) {
            if (attempt >= maxAttempts) {
              throw new Error(`OpenAI API server error (${status}) on final attempt`);
            }
            const delay = this.getRetryDelay(attempt);
            await this.sleep(delay);
            continue;
          }
        }

        if (attempt < maxAttempts) {
          const delay = this.getRetryDelay(attempt);
          await this.sleep(delay);
          continue;
        }
      }
    }

    throw new Error(`OpenAI API request failed after ${this.config.maxRetries} retries: ${lastError?.message || "Unknown error"}.`);
  }

  protected async *chatStreamImpl(request: ChatRequest): AsyncGenerator<string | StreamEvent, void, unknown> {
    if (!this.isConfigured()) {
      throw new Error("OpenAI API key not configured. Set OPENAI_API_KEY environment variable.");
    }

    const limiterModel = request.model ?? this.config.model ?? null;
    const limiterTag = request.concurrencyTag ?? null;
    const slotId = await aiRequestLimiter.acquire(
      this.name,
      limiterModel,
      limiterTag,
      request.signal,
    );
    const idleGuard = this.installFirstChunkAbort(request.signal);
    try {
      const requestBody = this.buildRequestBody({ ...request, stream: true });
      (requestBody as any).stream_options = { include_usage: true };
      const toolNameMap = (requestBody as any)[kToolNameMap] as Map<string, string> | undefined;

      if (DEBUG) console.log("[OpenAI] Starting stream request");

      const maxAttempts = this.config.maxRetries + 1;
      let lastError: Error | null = null;
      let response: any;
      let streamRateLimitedSince: number | null = null;
      const streamRateLimitBudgetMs = env.AI_RATE_LIMIT_MAX_WAIT_MS;
      let streamRateLimitAttempt = 0;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          response = await this.client.post("/chat/completions", requestBody, {
            responseType: "stream",
            // installFirstChunkAbort composes the caller's signal with a
            // 30s idle watchdog so a stalled upstream releases the slot
            // promptly instead of waiting on the OS socket timeout.
            signal: idleGuard.signal,
          });
          break;
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
                  `OpenAI API rate limited for ${Math.round(totalWaited / 1000)}s ` +
                  `(budget ${Math.round(streamRateLimitBudgetMs / 1000)}s exhausted)`,
                );
              }
              const delay = Math.min(this.getRateLimitDelay(error, streamRateLimitAttempt), MAX_RATE_LIMIT_SLEEP_MS);
              if (DEBUG) console.warn(`[OpenAI] Rate limited (429), waiting ${Math.round(delay)}ms (throttled for ${Math.round(totalWaited / 1000)}s)`);
              yield { type: "thinking" as const, content: `Rate limited, waiting ${Math.round(delay / 1000)}s before retry…` };
              await this.sleep(delay);
              attempt--;
              continue;
            }
            if (status && status >= 500) {
              if (attempt >= maxAttempts) {
                throw new Error(`OpenAI API server error (${status}) on final attempt`);
              }
              const delay = this.getRetryDelay(attempt);
              if (DEBUG) console.warn(`[OpenAI] Server error (${status}), waiting ${Math.round(delay)}ms before attempt ${attempt + 1}/${maxAttempts}`);
              yield { type: "thinking" as const, content: `OpenAI API server error (${status}), retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxAttempts})...` };
              await this.sleep(delay);
              continue;
            }
            if (status === 400 || status === 401 || status === 403 || status === 404) {
              throw lastError;
            }
          }
          if (attempt < maxAttempts) {
            const delay = this.getRetryDelay(attempt);
            if (DEBUG) console.warn(`[OpenAI] Network error, waiting ${Math.round(delay)}ms before attempt ${attempt + 1}/${maxAttempts}`);
            yield { type: "thinking" as const, content: `Network error connecting to OpenAI API, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxAttempts})...` };
            await this.sleep(delay);
            continue;
          }
          throw lastError;
        }
      }

      let lineBuffer = "";
      const toolCallAccumulator: ToolCall[] = [];
      let streamUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;

      for await (const chunk of response.data) {
        idleGuard.onChunk();
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

            if (parsed.usage?.prompt_tokens) {
              streamUsage = {
                promptTokens: parsed.usage.prompt_tokens,
                completionTokens: parsed.usage.completion_tokens || 0,
                totalTokens: parsed.usage.total_tokens || 0,
              };
            }

            if (delta?.content) {
              yield delta.content;
            }

            if (delta?.tool_calls) {
              for (const tcd of delta.tool_calls) {
                const idx: number = tcd.index ?? 0;
                while (toolCallAccumulator.length <= idx) {
                  toolCallAccumulator.push({ id: "", type: "function", function: { name: "", arguments: "" } });
                }
                const existing = toolCallAccumulator[idx];
                if (tcd.id) existing.id = tcd.id;
                if (tcd.function?.name) existing.function.name = tcd.function.name;
                if (tcd.function?.arguments) existing.function.arguments += tcd.function.arguments;
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

      if (streamUsage) {
        yield { type: "usage" as const, usage: streamUsage };
      }
      if (DEBUG) console.log("[OpenAI] Stream completed");
    } catch (error) {
      const idleReason = idleGuard.abortReason();
      const detail = error instanceof Error ? error.message : "Unknown error";
      const message = idleReason && /abort|cancel|canceled/i.test(detail)
        ? `OpenAI stream aborted: ${idleReason}`
        : `OpenAI stream failed: ${detail}`;
      console.error("[OpenAI] Stream error:", message);
      throw new Error(message);
    } finally {
      idleGuard.dispose();
      aiRequestLimiter.release(this.name, limiterModel, limiterTag, slotId);
    }
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

  private getRetryDelay(attempt: number): number {
    return Math.min(1000 * Math.pow(2, attempt - 1), 30000) + Math.random() * 1000;
  }

  private getRateLimitDelay(error: AxiosError, attempt: number): number {
    const retryAfter = error.response?.headers?.["retry-after"];
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (!isNaN(seconds) && seconds > 0) return seconds * 1000 + Math.random() * 500;
    }
    return Math.min(4000 * Math.pow(2, attempt - 1), 60000) + Math.random() * 2000;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
