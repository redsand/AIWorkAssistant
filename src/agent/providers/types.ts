import axios, { AxiosInstance } from "axios";

const DEBUG = process.env.AICODER_DEBUG === "true";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
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
  /** Force JSON output via response_format (OpenAI-compatible providers: Ollama, ZAI, OpenCode). */
  jsonMode?: boolean;
  /** Cancellation signal. When aborted, the in-flight HTTP request is cancelled and no retry is attempted. */
  signal?: AbortSignal;
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
  /** Maximum number of tools this provider accepts in a single request. Undefined = no known limit. */
  maxTools?: number;
}

export type StreamEvent =
  | { type: "thinking"; content: string }
  | { type: "tool_calls"; toolCalls: ToolCall[] };

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
  ): AsyncGenerator<string | StreamEvent, void, unknown>;
  abstract isConfigured(): boolean;

  getMaxContextTokens(): number {
    return this.config.maxContextTokens || DEFAULT_MAX_CONTEXT_TOKENS;
  }
  abstract validateConfig(): Promise<boolean>;

  protected buildRequestBody(request: ChatRequest): Record<string, unknown> {
    const pruned = this.pruneToContextWindow(
      request.messages,
      request.tools,
    );

    // Many APIs (Z.ai, Qwen, etc.) reject multiple system messages; merge
    // all system-role entries into one so every provider works consistently.
    const messages = this.normalizeMessagesForRequest(
      this.mergeSystemMessages(pruned),
    );

    const body: Record<string, unknown> = {
      model: request.model || this.config.model,
      messages,
      temperature: request.temperature ?? this.config.temperature,
      top_p: request.top_p ?? this.config.topP,
    };

    if (request.tools) {
      const maxTools = this.capabilities.maxTools;
      const tools = maxTools && request.tools.length > maxTools
        ? request.tools.slice(0, maxTools)
        : request.tools;
      if (maxTools && request.tools.length > maxTools) {
        console.warn(
          `[${this.name}] Tool count ${request.tools.length} exceeds provider limit of ${maxTools}. Capped to first ${maxTools} tools.`,
        );
      }
      body.tools = tools;
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

    if (request.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    const msgTokens = this.estimateTokens(messages);
    const toolTokens = request.tools
      ? this.estimateTokens([], request.tools)
      : 0;
    if (DEBUG) console.log(
      `[${this.name}] Request payload estimate: ${msgTokens + toolTokens} tokens (messages: ${msgTokens}, tools: ${toolTokens}, messages: ${messages.length}, tools: ${request.tools?.length || 0}, calibration: ${this.tokenCalibrationFactor.toFixed(2)})`,
    );

    return body;
  }

  private mergeSystemMessages(messages: ChatMessage[]): ChatMessage[] {
    const parts: string[] = [];
    const rest: ChatMessage[] = [];
    for (const msg of messages) {
      if (msg.role === "system") {
        const text = typeof msg.content === "string" ? msg.content.trim() : "";
        if (text) parts.push(text);
      } else {
        rest.push(msg);
      }
    }
    if (parts.length === 0) return messages;
    const originalSystemCount = messages.length - rest.length;
    // No-op only when the array is already clean: exactly one non-empty system message.
    if (parts.length === 1 && originalSystemCount === 1) return messages;
    return [{ role: "system", content: parts.join("\n\n---\n\n") }, ...rest];
  }

  private normalizeMessagesForRequest(messages: ChatMessage[]): ChatMessage[] {
    let changed = false;
    const normalizedMessages = messages.map((message) => {
      if (message.name === undefined) return message;
      changed = true;
      const normalized: ChatMessage = {
        role: message.role,
        content: message.content,
      };
      if (message.tool_calls) normalized.tool_calls = message.tool_calls;
      if (message.tool_call_id) normalized.tool_call_id = message.tool_call_id;
      return normalized;
    });
    return changed ? normalizedMessages : messages;
  }

  /**
   * Extract the last `recentCount` non-system messages from the end of an array,
   * keeping assistant+tool_calls and their consecutive tool responses as atomic
   * groups. This prevents pruning from breaking tool-call pairs, which causes
   * API rejections.
   */
  protected extractRecentMessages(
    messages: ChatMessage[],
    recentCount: number,
  ): ChatMessage[] {
    const recent: ChatMessage[] = [];
    const addedIndices = new Set<number>();
    let idx = messages.length - 1;

    let collected = 0;
    while (idx >= 1 && collected < recentCount) {
      if (addedIndices.has(idx)) {
        idx--;
        continue;
      }
      const msg = messages[idx];
      if (
        msg.role === "assistant" &&
        msg.tool_calls &&
        msg.tool_calls.length > 0
      ) {
        // Include the assistant and all its tool responses
        const group: ChatMessage[] = [msg];
        addedIndices.add(idx);
        let j = idx + 1;
        while (
          j < messages.length &&
          messages[j].role === "tool"
        ) {
          group.push(messages[j]);
          addedIndices.add(j);
          j++;
        }
        recent.unshift(...group);
        collected++;
        idx--;
      } else if (msg.role === "tool") {
        // Skip orphaned tool messages — they will be collected with their head
        idx--;
      } else {
        recent.unshift(msg);
        addedIndices.add(idx);
        collected++;
        idx--;
      }
    }
    return recent;
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
    const userMsg = [...pruned].reverse().find((m) => m.role === "user");
    const recentCount = Math.min(pruned.length - 2, 6);
    const recent = this.extractRecentMessages(pruned, recentCount).filter(
      (m) => m !== userMsg,
    );

    const kept: ChatMessage[] = [
      system,
      {
        role: "system",
        content: `[Earlier conversation truncated — ${pruned.length - recentCount - 2} messages removed to fit context window of ${messageBudget} tokens]`,
      },
      ...(userMsg ? [userMsg] : []),
      ...recent,
    ];

    // Strict APIs (Z.ai/GLM) require the first non-system message to be 'user'.
    // If context pruning left an assistant or tool message at that position,
    // insert a placeholder so the turn structure is valid.
    const firstNonSysIdx = kept.findIndex((m) => m.role !== "system");
    if (firstNonSysIdx !== -1 && kept[firstNonSysIdx].role !== "user") {
      kept.splice(firstNonSysIdx, 0, {
        role: "user",
        content: "[conversation continues]",
      });
    }

    console.warn(
      `[${this.name}] Pruned ${pruned.length} messages to ${kept.length}`,
    );

    estimated = this.estimateTokens(kept);
    if (estimated <= messageBudget) return kept;

    // Truncate non-system/non-user messages proportionally to fit budget
    const perMsgBudget = Math.floor(messageBudget * 0.4 / kept.length);
    const perMsgChars = Math.max(200, perMsgBudget * CHARS_PER_TOKEN);
    const shrunk = kept.map((m, i) => {
      if (i === 0 || m === userMsg) return m;
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
      const userMsg = [...truncated].reverse().find((m) => m.role === "user");
      const recentCount = Math.min(truncated.length - 2, 6);
      const recent = this.extractRecentMessages(truncated, recentCount).filter(
        (m) => m !== userMsg,
      );
      const kept: ChatMessage[] = [
        system,
        {
          role: "system" as const,
          content: `[Earlier conversation truncated — ${truncated.length - recentCount - 2} messages removed]`,
        },
        ...(userMsg ? [userMsg] : []),
        ...recent,
      ];

      estimated = this.estimateTokens(kept);
      if (estimated <= messageBudget) return kept;

      // Step 3: truncate remaining messages proportionally
      const perMsgBudget = Math.floor(messageBudget * 0.4 / kept.length);
      const perMsgChars = Math.max(200, perMsgBudget * CHARS_PER_TOKEN);
      const shrunk = kept.map((m, i) => {
        if (i === 0 || m === userMsg) return m;
        if (m.content.length > perMsgChars) {
          return { ...m, content: m.content.substring(0, perMsgChars) + "\n...[truncated]" };
        }
        return m;
      });

      estimated = this.estimateTokens(shrunk);
      if (estimated <= messageBudget) return shrunk;

      // Step 4: emergency — all non-system/user messages to 1000 chars
      return shrunk.map((m, i) => {
        if (i === 0 || m === userMsg) return m;
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
    const match =
      errorBody.match(/maximum context length:?\s*(\d+)/i) ||
      errorBody.match(/max context length:?\s*(\d+)/i) ||
      // Z.ai / GLM format: "Prompt 50517 tokens exceeds 24760 limit"
      errorBody.match(/exceeds\s+(\d+)\s+limit/i) ||
      errorBody.match(/max tokens.*?\s+(\d+)/i) ||
      errorBody.match(/context length.*?\s+(\d+)/i);
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
      if (DEBUG) console.log(
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
