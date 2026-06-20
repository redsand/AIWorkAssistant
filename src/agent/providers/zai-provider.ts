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
import { zaiRateLimiter } from "./zai-rate-limiter";
import { aiRequestLimiter } from "./ai-request-limiter";
import { env } from "../../config/env";

// 429 is rate-limiting, not failure. Provider-level retry loops loop on 429
// indefinitely (until this wallclock budget) so the user never sees a
// "Sorry, rate limited" error for a transient throttle. Per-attempt sleep
// is capped at MAX_RATE_LIMIT_SLEEP_MS so a wedged retry-after header can't
// stall the request beyond a sane individual wait.
const MAX_RATE_LIMIT_SLEEP_MS = 300_000;

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
   * about message format. The docs show error 1214 example:
   *   {"error":{"code":"1214","message":"Input cannot be empty"}}
   *
   * Rules applied:
   * 1. Every message must have non-empty string content (replace empty/null with " ").
   * 2. Only consecutive user messages are merged; tool responses are left intact.
   */
  private normalizeMessagesForZai(messages: any[]): any[] {
    const normalized: any[] = [];
    for (const msg of messages) {
      // Defensive: ensure no message has empty/null/undefined content.
      let patched = msg;
      if (!patched.content || String(patched.content).trim() === "") {
        patched = { ...patched, content: " " };
      }

      if (normalized.length > 0 && normalized[normalized.length - 1].role === patched.role) {
        const prev = normalized[normalized.length - 1];
        if (patched.role === "user") {
          prev.content = `${prev.content}\n\n${patched.content}`;
          continue;
        }
        if (patched.role === "assistant" && !prev.tool_calls?.length && !patched.tool_calls?.length) {
          // Merge consecutive plain assistant messages — they arise from context
          // compression / session history and are rejected by Z.ai/GLM.
          prev.content = [prev.content, patched.content]
            .filter((s) => s && String(s).trim())
            .join("\n\n") || " ";
          continue;
        }
        // Consecutive system messages shouldn't exist (mergeSystemMessages handles them).
        // Consecutive tool messages ARE valid (multiple tool responses for one assistant call).
        // Consecutive assistant messages that include tool_calls cannot be safely merged
        // here — push and let validation surface the error with context.
      }

      normalized.push(patched);
    }
    return normalized;
  }

  /**
   * Preflight payload validator for Z.ai/GLM. Throws immediately (before any
   * HTTP request) if the message array violates known GLM invariants.
   * This prevents token-wasting retry loops on unrecoverable payload errors.
   */
  private validateZaiPayload(body: Record<string, unknown>): void {
    const messages = body.messages as any[];
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error("[Z.ai PAYLOAD VALIDATION] messages array is empty or missing");
    }

    const allowedRoles = new Set(["system", "user", "assistant", "tool"]);
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg.role || !allowedRoles.has(msg.role)) {
        throw new Error(
          `[Z.ai PAYLOAD VALIDATION] message[${i}] has invalid role '${msg.role}'. Raw: ${JSON.stringify(msg).substring(0, 200)}`,
        );
      }
      if (typeof msg.content !== "string" || msg.content === "") {
        throw new Error(
          `[Z.ai PAYLOAD VALIDATION] message[${i}] (role=${msg.role}) has empty or missing content. Raw: ${JSON.stringify(msg).substring(0, 200)}`,
        );
      }
      if (msg.role === "tool" && (!msg.tool_call_id || typeof msg.tool_call_id !== "string")) {
        throw new Error(
          `[Z.ai PAYLOAD VALIDATION] message[${i}] (role=tool) is missing tool_call_id. Raw: ${JSON.stringify(msg).substring(0, 200)}`,
        );
      }
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (!tc.id || typeof tc.id !== "string") {
            throw new Error(
              `[Z.ai PAYLOAD VALIDATION] message[${i}] (role=assistant) has tool_call missing id. Raw: ${JSON.stringify(msg).substring(0, 200)}`,
            );
          }
        }
      }
    }

    // First non-system message must be 'user' (GLM/Z.ai requires user→assistant turn order)
    const firstNonSystem = messages.find((m: any) => m.role !== "system");
    if (firstNonSystem && firstNonSystem.role !== "user") {
      throw new Error(
        `[Z.ai PAYLOAD VALIDATION] first non-system message must be role=user, got '${firstNonSystem.role}'. ` +
        `GLM requires conversations to begin user→assistant.`,
      );
    }

    // Consecutive same-role check (tool exempt)
    for (let i = 1; i < messages.length; i++) {
      const prev = messages[i - 1];
      const curr = messages[i];
      if (prev.role === curr.role && curr.role !== "tool") {
        throw new Error(
          `[Z.ai PAYLOAD VALIDATION] consecutive ${curr.role} messages at index ${i - 1} and ${i}. ` +
          `This usually means a message was dropped during pruning/repair.`,
        );
      }
    }

    if (messages[0].role === "tool") {
      throw new Error("[Z.ai PAYLOAD VALIDATION] first message cannot be role=tool");
    }
  }


  protected async chatImpl(request: ChatRequest): Promise<ChatResponse> {
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
    // Tracks when the *first* 429 in this request was seen, so the wallclock
    // budget covers the full throttle window even across many 429 cycles.
    let rateLimitedSince: number | null = null;
    const rateLimitBudgetMs = env.AI_RATE_LIMIT_MAX_WAIT_MS;
    let rateLimitAttempt = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const requestBody = this.buildRequestBody(request);
        this.validateZaiPayload(requestBody);
        const attemptTimeout = this.getAttemptTimeout(attempt);

        console.log("[Z.ai API] Sending request:", {
          model: requestBody.model,
          messageCount: (requestBody.messages as any[]).length,
          hasTools: !!request.tools,
          attempt: `${attempt}/${maxAttempts}`,
          timeout: `${Math.round(attemptTimeout / 1000)}s`,
        });

        let response;
        await aiRequestLimiter.acquire(this.name);
        try {
          await zaiRateLimiter.acquire();
          try {
            response = await this.client.post(
              "/chat/completions",
              requestBody,
              { timeout: attemptTimeout, signal: request.signal },
            );
          } finally {
            zaiRateLimiter.release();
          }
        } finally {
          aiRequestLimiter.release(this.name);
        }

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

        if (axios.isCancel(error)) throw error;

        if (lastError.message.includes("[Z.ai PAYLOAD VALIDATION]")) {
          throw lastError; // don't retry unrecoverable payload errors
        }

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
            // 429 is rate-limiting, not failure. Don't count it against
            // maxAttempts — loop until AI_RATE_LIMIT_MAX_WAIT_MS budget
            // is exhausted, then throw.
            rateLimitedSince ??= Date.now();
            rateLimitAttempt++;
            const totalWaited = Date.now() - rateLimitedSince;
            if (totalWaited >= rateLimitBudgetMs) {
              throw new Error(
                `Z.ai API rate limited for ${Math.round(totalWaited / 1000)}s ` +
                `(budget ${Math.round(rateLimitBudgetMs / 1000)}s exhausted)`,
              );
            }
            const delay = this.getRateLimitDelay(error, rateLimitAttempt);
            zaiRateLimiter.reportRateLimit(delay);
            console.warn(
              `[Z.ai API] Rate limited (429), waiting ${Math.round(delay)}ms ` +
              `(throttled for ${Math.round(totalWaited / 1000)}s, budget ${Math.round(rateLimitBudgetMs / 1000)}s)`,
            );
            await this.sleep(delay, request.signal);
            // Cancel the loop's attempt++ so the rate-limit retry is free.
            attempt--;
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
            await this.sleep(delay, request.signal);
            continue;
          }
        }

        if (attempt < maxAttempts) {
          const delay = this.getRetryDelay(attempt);
          console.warn(
            `[Z.ai API] Network error, waiting ${Math.round(delay)}ms before attempt ${attempt + 1}/${maxAttempts}`,
          );
          await this.sleep(delay, request.signal);
          continue;
        }
      }
    }

    throw new Error(
      `Z.ai API request failed after ${this.config.maxRetries} retries: ${lastError?.message || "Unknown error"}`,
    );
  }

  protected async *chatStreamImpl(
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
    let rateLimitedSince: number | null = null;
    const rateLimitBudgetMs = env.AI_RATE_LIMIT_MAX_WAIT_MS;
    let rateLimitAttempt = 0;
    // Captured when an overflow-retry is requested. The recursive
    // chatStreamInternal call MUST happen after the for-loop's inner finally
    // releases the limiter slot — otherwise the recursive acquire() can
    // deadlock (parent holds the only slot, child waits forever).
    let pendingOverflowRetry: ChatRequest | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const requestBody = this.buildRequestBody({ ...request, stream: true });
        this.validateZaiPayload(requestBody);
        const toolNameMap = (requestBody as any)[kToolNameMap] as Map<string, string> | undefined;

        console.log("[Z.ai API] Sending stream request:", {
          model: requestBody.model,
          messageCount: (requestBody.messages as any[]).length,
          hasTools: !!request.tools,
          attempt: `${attempt}/${maxAttempts}`,
        });

        await aiRequestLimiter.acquire(this.name);
        const idleGuard = this.installFirstChunkAbort(request.signal);
        try {
          await zaiRateLimiter.acquire();
          let response;
          try {
            response = await this.client.post(
              "/chat/completions",
              requestBody,
              {
                responseType: "stream",
                validateStatus: () => true,
                // First-chunk idle watchdog (composes with the caller's
                // signal). Without it, a stalled Z.ai response keeps the
                // limiter slot held until the OS socket times out.
                signal: idleGuard.signal,
              },
            );
          } finally {
            zaiRateLimiter.release();
          }

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
                pendingOverflowRetry = { ...request, messages: repairedMessages };
                // break exits the for loop after the inner finally releases
                // the slot; the recursive yield* runs below at function scope.
                break;
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
            // 429 doesn't count toward maxAttempts — loop until the
            // AI_RATE_LIMIT_MAX_WAIT_MS wallclock budget is exhausted.
            rateLimitedSince ??= Date.now();
            rateLimitAttempt++;
            const totalWaited = Date.now() - rateLimitedSince;
            if (totalWaited >= rateLimitBudgetMs) {
              throw new Error(
                `Z.ai API rate limited for ${Math.round(totalWaited / 1000)}s ` +
                `(budget ${Math.round(rateLimitBudgetMs / 1000)}s exhausted)`,
              );
            }
            const delay = this.getStreamRateLimitDelay(response.headers, rateLimitAttempt);
            zaiRateLimiter.reportRateLimit(delay);
            console.warn(
              `[Z.ai API] Rate limited (429), waiting ${Math.round(delay)}ms ` +
              `(throttled for ${Math.round(totalWaited / 1000)}s, budget ${Math.round(rateLimitBudgetMs / 1000)}s)`,
            );
            yield { type: "thinking" as const, content: `Rate limited, waiting ${Math.round(delay / 1000)}s before retry…` };
            await this.sleep(delay, request.signal);
            attempt--; // 429 retries are free
            continue;
          }

          if (response.status >= 500) {
            if (attempt >= maxAttempts) {
              throw new Error(`Z.ai API server error (${response.status}) on final attempt: ${errorBody}`);
            }
            const delay = this.getRetryDelay(attempt);
            console.warn(`[Z.ai API] Server error (${response.status}), waiting ${Math.round(delay)}ms before attempt ${attempt + 1}/${maxAttempts}`);
            yield { type: "thinking" as const, content: `Z.ai API server error (${response.status}), retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxAttempts})...` };
            await this.sleep(delay, request.signal);
            continue;
          }

          throw new Error(`Z.ai API error (${response.status}): ${errorBody}`);
        }

        let lineBuffer = "";
        const toolCallAccumulator: ToolCall[] = [];
        let streamUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;
        for await (const chunk of response.data) {
          // First byte arrived — clear the watchdog.
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
        if (streamUsage) {
          yield { type: "usage" as const, usage: streamUsage };
        }
        return;
      } finally {
        idleGuard.dispose();
        aiRequestLimiter.release(this.name);
      }
    } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Context overflow, auth, and payload validation errors should not be retried
        if (
          lastError.message.includes("[Z.ai PAYLOAD VALIDATION]") ||
          lastError.message.includes("bad request") ||
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
          yield { type: "thinking" as const, content: `Z.ai stream interrupted, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxAttempts})...` };
          await this.sleep(delay, request.signal);
          continue;
        }
        throw lastError;
      }
    }

    // Overflow-retry recursion runs here, AFTER the for-loop's inner finally
    // has released the limiter slot. Recursing inside the try/finally above
    // would deadlock the limiter (parent holds slot, child waits).
    if (pendingOverflowRetry) {
      yield* this.chatStreamInternal(pendingOverflowRetry, true);
      return;
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
    return this.getStreamRateLimitDelay(error.response?.headers, attempt);
  }

  private getStreamRateLimitDelay(headers: Record<string, unknown> | undefined, attempt: number): number {
    // Honor retry-after up to MAX_RATE_LIMIT_SLEEP_MS so the server can ask
    // for long waits (multi-minute throttles are normal on shared tiers).
    // The old 60s cap force-retried into the same limit and burned attempts.
    const retryAfter = headers?.["retry-after"];
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (!isNaN(seconds) && seconds > 0) {
        return Math.min(seconds * 1000 + Math.random() * 500, MAX_RATE_LIMIT_SLEEP_MS);
      }
    }

    const baseDelay = 10000;
    const exponentialDelay = Math.min(
      baseDelay * Math.pow(2, Math.min(attempt - 1, 5)),
      MAX_RATE_LIMIT_SLEEP_MS,
    );
    const jitter = Math.random() * 8000;
    return exponentialDelay + jitter;
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        const err = new Error("Request aborted") as any;
        err.__CANCEL__ = true;
        err.code = "ERR_CANCELED";
        return reject(err);
      }
      const timer = setTimeout(resolve, ms);
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          const err = new Error("Request aborted") as any;
          err.__CANCEL__ = true;
          err.code = "ERR_CANCELED";
          reject(err);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
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
