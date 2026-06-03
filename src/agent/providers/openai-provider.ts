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

const DEBUG = process.env.AICODER_DEBUG === "true";

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
    const model = String((body.model as string) || "");
    if (/^o\d/i.test(model)) {
      delete body.temperature;
      delete body.top_p;
      if (body.max_tokens !== undefined) {
        body.max_completion_tokens = body.max_tokens;
        delete body.max_tokens;
      }
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

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!this.isConfigured()) {
      throw new Error("OpenAI API key not configured. Set OPENAI_API_KEY environment variable.");
    }

    let lastError: Error | null = null;
    const maxAttempts = this.config.maxRetries + 1;

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

        const response = await this.client.post("/chat/completions", requestBody, {
          timeout: attemptTimeout,
        });

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
            if (attempt >= maxAttempts) break;
            const delay = this.getRateLimitDelay(error, attempt);
            if (DEBUG) console.warn(`[OpenAI] Rate limited (429), waiting ${Math.round(delay)}ms before attempt ${attempt + 1}/${maxAttempts}`);
            await this.sleep(delay);
            continue;
          }

          if (status && status >= 500) {
            if (attempt >= maxAttempts) break;
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

  async *chatStream(request: ChatRequest): AsyncGenerator<string | StreamEvent, void, unknown> {
    if (!this.isConfigured()) {
      throw new Error("OpenAI API key not configured. Set OPENAI_API_KEY environment variable.");
    }

    try {
      const requestBody = this.buildRequestBody({ ...request, stream: true });
      const toolNameMap = (requestBody as any)[kToolNameMap] as Map<string, string> | undefined;

      if (DEBUG) console.log("[OpenAI] Starting stream request");

      const response = await this.client.post("/chat/completions", requestBody, {
        responseType: "stream",
      });

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

      if (DEBUG) console.log("[OpenAI] Stream completed");
    } catch (error) {
      console.error("[OpenAI] Stream error:", error);
      throw new Error(`OpenAI stream failed: ${error instanceof Error ? error.message : "Unknown error"}`);
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
