import axios, { AxiosInstance } from "axios";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface Tool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: Tool[];
  temperature?: number;
  top_p?: number;
  model?: string;
  stream?: boolean;
  /** Per-request output token limit. Overrides the provider default when set. */
  maxTokens?: number;
}

export interface ChatResponse {
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
  done: boolean;
}

export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  topP: number;
  maxRetries: number;
  timeout: number;
  maxContextTokens?: number;
}

export interface ProviderCapabilities {
  streaming: boolean;
  toolChoice: "required" | "auto" | "none";
  parallelToolCalls: boolean;
  requiresAuth: boolean;
  synthesizesToolCallIds: boolean;
}

export type OpenCodeConfig = ProviderConfig;

export const DEFAULT_MAX_CONTEXT_TOKENS = 64000;
export const MAX_TOOL_RESULT_CHARS = 50000;
export const CHARS_PER_TOKEN = 2.5; // Conservative: ensures estimates ≥ actual for GLM (~1.4-2 chars/token)
export const TOOL_SCHEMA_CHARS_PER_TOKEN = 2.5; // Tool schemas also conservative
export const CONTEXT_SAFETY_MARGIN = 0.7; // Use 70% of max context - char-based estimates are inherently imprecise

export abstract class AIProvider {
  abstract readonly name: string;
  abstract readonly capabilities: ProviderCapabilities;

  protected client: AxiosInstance;
  protected config: ProviderConfig;

  // Calibration factor: ratio of actual promptTokens to our estimate.
  // Updated from real API responses so estimates improve over time.
  private tokenCalibrationFactor = 1.0;

  constructor(config: ProviderConfig) {
    this.config = config;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (config.apiKey) {
      headers["Authorization"] = `Bearer ${config.apiKey}`;
    }

    this.client = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeout,
      headers,
    });
  }

  abstract chat(request: ChatRequest): Promise<ChatResponse>;
  abstract chatStream(
    request: ChatRequest,
  ): AsyncGenerator<string, void, unknown>;
  abstract isConfigured(): boolean;

  getMaxContextTokens(): number {
    return this.config.maxContextTokens || DEFAULT_MAX_CONTEXT_TOKENS;
  }
  abstract validateConfig(): Promise<boolean>;

  protected buildRequestBody(request: ChatRequest): Record<string, unknown> {
    const messages = this.pruneToContextWindow(
      request.messages,
      request.tools,
    );

    const body: Record<string, unknown> = {
      model: request.model || this.config.model,
      messages,
      temperature: request.temperature ?? this.config.temperature,
      top_p: request.top_p ?? this.config.topP,
    };

    if (request.tools) {
      body.tools = request.tools;
      body.tool_choice = this.capabilities.toolChoice;
      if (this.capabilities.parallelToolCalls) {
        body.parallel_tool_calls = true;
      }
    }

    if (request.stream) {
      body.stream = true;
    }

    if (request.maxTokens) {
      body.max_tokens = request.maxTokens;
    }

    const msgTokens = this.estimateTokens(messages);
    const toolTokens = request.tools
      ? this.estimateTokens([], request.tools)
      : 0;
    console.log(
      `[${this.name}] Request payload estimate: ${msgTokens + toolTokens} tokens (messages: ${msgTokens}, tools: ${toolTokens}, messages: ${messages.length}, tools: ${request.tools?.length || 0}, calibration: ${this.tokenCalibrationFactor.toFixed(2)})`,
    );

    return body;
  }

  protected pruneToContextWindow(
    messages: ChatMessage[],
    tools?: Tool[],
  ): ChatMessage[] {
    const maxTokens =
      this.config.maxContextTokens || DEFAULT_MAX_CONTEXT_TOKENS;

    // Apply safety margin — our char-based estimate is imprecise, and the actual
    // model tokenizer often produces more tokens than we estimate. Using 85% of
    // the max context leaves headroom for this estimation error.
    const safeLimit = Math.floor(maxTokens * CONTEXT_SAFETY_MARGIN);

    // Reserve budget for tool schemas so they don't push us over the limit
    const toolTokens = tools ? this.estimateTokens([], tools) : 0;
    const messageBudget = safeLimit - toolTokens;

    if (messageBudget < 1000) {
      console.warn(
        `[${this.name}] Tool schemas consume ~${toolTokens} tokens, leaving only ${messageBudget} for messages (out of ${maxTokens}). Consider reducing the number of tools.`,
      );
    }

    let estimated = this.estimateTokens(messages);

    if (estimated <= messageBudget) return messages;

    console.warn(
      `[${this.name}] Prompt ${estimated} tokens exceeds ${messageBudget} limit, pruning...`,
    );

    const pruned = messages.map((m) => {
      if (m.role === "tool" && m.content.length > MAX_TOOL_RESULT_CHARS) {
        return {
          ...m,
          content:
            m.content.substring(0, MAX_TOOL_RESULT_CHARS) + "\n...[truncated]",
        };
      }
      if (m.role === "assistant" && m.content.length > MAX_TOOL_RESULT_CHARS) {
        return {
          ...m,
          content:
            m.content.substring(0, MAX_TOOL_RESULT_CHARS) + "\n...[truncated]",
        };
      }
      return m;
    });

    estimated = this.estimateTokens(pruned);
    if (estimated <= messageBudget) return pruned;

    if (pruned.length <= 4) return pruned;

    const system = pruned[0];
    const userMsg = pruned[pruned.length - 1];
    const recentCount = Math.min(pruned.length - 2, 6);
    const recent = pruned.slice(
      pruned.length - 1 - recentCount,
      pruned.length - 1,
    );

    const kept: ChatMessage[] = [
      system,
      {
        role: "system",
        content: `[Earlier conversation truncated — ${pruned.length - recentCount - 2} messages removed to fit context window of ${messageBudget} tokens]`,
      },
      ...recent,
      userMsg,
    ];

    console.warn(
      `[${this.name}] Pruned ${pruned.length} messages to ${kept.length}`,
    );

    estimated = this.estimateTokens(kept);
    if (estimated <= messageBudget) return kept;

    // Truncate non-system/non-user messages proportionally to fit budget
    const perMsgBudget = Math.floor(messageBudget * 0.4 / kept.length);
    const perMsgChars = Math.max(200, perMsgBudget * CHARS_PER_TOKEN);
    const shrunk = kept.map((m, i) => {
      if (i === 0 || i === kept.length - 1) return m;
      if (m.content.length > perMsgChars) {
        return { ...m, content: m.content.substring(0, perMsgChars) + "\n...[truncated]" };
      }
      return m;
    });

    estimated = this.estimateTokens(shrunk);
    if (estimated <= messageBudget) return shrunk;
    if (kept.length <= 4) return shrunk;

    return shrunk;
  }

  /**
   * Public wrapper so callers (e.g. tool loop in chat.ts) can prune messages
   * without going through buildRequestBody.
   */
  pruneMessages(messages: ChatMessage[], tools?: Tool[]): ChatMessage[] {
    return this.pruneToContextWindow(messages, tools);
  }

  protected pruneAggressively(
    messages: ChatMessage[],
    tools: Tool[] | undefined,
    maxTokens: number,
  ): ChatMessage[] {
    const safeLimit = Math.floor(maxTokens * 0.5);
    const toolTokens = tools ? this.estimateTokens([], tools) : 0;
    const messageBudget = Math.max(1000, safeLimit - toolTokens);

    // Step 1: truncate all tool/assistant messages to 20k chars
    const truncated = messages.map((m) => {
      if ((m.role === "tool" || m.role === "assistant") && m.content.length > 20000) {
        return { ...m, content: m.content.substring(0, 20000) + "\n...[truncated]" };
      }
      return m;
    });

    let estimated = this.estimateTokens(truncated);
    if (estimated <= messageBudget) return truncated;

    // Step 2: keep system + last 6 messages + user
    if (truncated.length > 4) {
      const system = truncated[0];
      const userMsg = truncated[truncated.length - 1];
      const recentCount = Math.min(truncated.length - 2, 6);
      const recent = truncated.slice(truncated.length - 1 - recentCount, truncated.length - 1);
      const kept: ChatMessage[] = [
        system,
        {
          role: "system" as const,
          content: `[Earlier conversation truncated — ${truncated.length - recentCount - 2} messages removed]`,
        },
        ...recent,
        userMsg,
      ];

      estimated = this.estimateTokens(kept);
      if (estimated <= messageBudget) return kept;

      // Step 3: truncate remaining messages proportionally
      const perMsgBudget = Math.floor(messageBudget * 0.4 / kept.length);
      const perMsgChars = Math.max(200, perMsgBudget * CHARS_PER_TOKEN);
      const shrunk = kept.map((m, i) => {
        if (i === 0 || i === kept.length - 1) return m;
        if (m.content.length > perMsgChars) {
          return { ...m, content: m.content.substring(0, perMsgChars) + "\n...[truncated]" };
        }
        return m;
      });

      estimated = this.estimateTokens(shrunk);
      if (estimated <= messageBudget) return shrunk;

      // Step 4: emergency — all non-system/user messages to 1000 chars
      return shrunk.map((m, i) => {
        if (i === 0 || i === kept.length - 1) return m;
        if (m.content.length > 1000) {
          return { ...m, content: m.content.substring(0, 1000) + "\n...[truncated]" };
        }
        return m;
      });
    }

    return truncated;
  }

  protected extractModelMaxContext(errorBody: string | undefined): number | null {
    if (!errorBody) return null;
    const match = errorBody.match(/maximum context length:?\s*(\d+)/i) ||
      errorBody.match(/max context length:?\s*(\d+)/i);
    return match ? parseInt(match[1], 10) : null;
  }

  protected parseToolCalls(toolCalls: any[]): ToolCall[] {
    return toolCalls.map((tc) => ({
      id: tc.id,
      type: tc.type || ("function" as const),
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));
  }

  estimateTokens(messages: ChatMessage[], tools?: Tool[]): number {
    let messageChars = 0;

    for (const message of messages) {
      messageChars += message.content.length;
      messageChars += 16; // message overhead

      if (message.tool_calls) {
        messageChars += JSON.stringify(message.tool_calls).length;
      }
    }

    let toolChars = 0;
    if (tools && tools.length > 0) {
      toolChars += JSON.stringify(tools).length;
      toolChars += tools.length * 8;
    }

    const messageTokens = Math.max(0, Math.floor(messageChars / CHARS_PER_TOKEN));
    const toolTokens = Math.max(0, Math.floor(toolChars / TOOL_SCHEMA_CHARS_PER_TOKEN));

    // Apply calibration factor from real API responses
    const raw = Math.max(1, messageTokens + toolTokens);
    return Math.ceil(raw * this.tokenCalibrationFactor);
  }

  /**
   * Calibrate token estimation using actual promptTokens from an API response.
   * Compares the real count to our estimate and adjusts the calibration factor
   * so future estimates are more accurate.
   */
  protected calibrateTokenEstimate(
    actualPromptTokens: number,
    messages: ChatMessage[],
    tools?: Tool[],
  ) {
    if (actualPromptTokens <= 0) return;

    // Get raw (uncalibrated) estimate
    const savedFactor = this.tokenCalibrationFactor;
    this.tokenCalibrationFactor = 1.0;
    const rawEstimate = this.estimateTokens(messages, tools);
    this.tokenCalibrationFactor = savedFactor;

    const measuredRatio = actualPromptTokens / rawEstimate;
    if (measuredRatio > 0 && isFinite(measuredRatio)) {
      // Exponential moving average, but only increase — never decrease below current.
      // This ensures we never underestimate after calibration.
      const alpha = 0.5;
      const blended = alpha * measuredRatio + (1 - alpha) * this.tokenCalibrationFactor;
      this.tokenCalibrationFactor = Math.max(this.tokenCalibrationFactor, blended);
      console.log(
        `[${this.name}] Token calibration updated: ratio=${measuredRatio.toFixed(2)}, factor=${this.tokenCalibrationFactor.toFixed(2)}, raw=${rawEstimate}, actual=${actualPromptTokens}`,
      );
    }
  }

  protected resetCalibration(): void {
    this.tokenCalibrationFactor = 1.0;
  }

  /**
   * Get the request timeout for a given retry attempt, doubling each time.
   * If the first attempt times out, the next one gets more time to complete.
   */
  protected getAttemptTimeout(attempt: number): number {
    const maxTimeout = this.config.timeout * 4;
    return Math.min(this.config.timeout * Math.pow(2, attempt - 1), maxTimeout);
  }

  /**
   * Check whether an HTTP 400 error body indicates a context-length overflow
   * rather than a generic bad request. Shared across all providers.
   */
  protected isContextOverflowError(errorBody: string | undefined): boolean {
    if (!errorBody) return false;
    const lower = errorBody.toLowerCase();
    return (
      lower.includes("prompt is too long") ||
      lower.includes("context length") ||
      lower.includes("maximum context") ||
      lower.includes("context window") ||
      lower.includes("token limit") ||
      lower.includes("too many tokens") ||
      lower.includes("exceeded max context") ||
      lower.includes("prompt too long")
    );
  }

  /**
   * Extract the actual token count from an overflow error message and
   * use it to calibrate future estimates.
   */
  protected calibrateFromOverflowError(
    errorBody: string | undefined,
    messages: ChatMessage[],
    tools?: Tool[],
  ) {
    if (!errorBody) return;

    // Try to extract the actual token count from error messages like:
    // "The prompt is too long: 221782, model maximum context length: 202752"
    // "prompt too long; exceeded max context length by 15935 tokens"
    const match = errorBody.match(/prompt is too long:?\s*(\d+)/i) ||
      errorBody.match(/exceeded max context length by (\d+) tokens/i);

    if (match) {
      const actualTokens = parseInt(match[1], 10);
      // For "exceeded by X" format, we need to add the max context to get the actual count
      if (errorBody.includes("exceeded max context length by")) {
        const maxMatch = errorBody.match(/max context length:?\s*(\d+)/i);
        if (maxMatch) {
          this.calibrateTokenEstimate(
            actualTokens + parseInt(maxMatch[1], 10),
            messages,
            tools,
          );
          return;
        }
      }
      this.calibrateTokenEstimate(actualTokens, messages, tools);
    }
  }
}
