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

const DEFAULT_MAX_CONTEXT_TOKENS = 64000;
const MAX_TOOL_RESULT_CHARS = 3000;
const CHARS_PER_TOKEN = 4;

export abstract class AIProvider {
  abstract readonly name: string;
  abstract readonly capabilities: ProviderCapabilities;

  protected client: AxiosInstance;
  protected config: ProviderConfig;

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
  abstract validateConfig(): Promise<boolean>;

  protected buildRequestBody(request: ChatRequest): Record<string, unknown> {
    const messages = this.pruneToContextWindow(request.messages);

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

    return body;
  }

  protected pruneToContextWindow(messages: ChatMessage[]): ChatMessage[] {
    const maxTokens =
      this.config.maxContextTokens || DEFAULT_MAX_CONTEXT_TOKENS;
    let estimated = this.estimateTokens(messages);

    if (estimated <= maxTokens) return messages;

    console.warn(
      `[${this.name}] Prompt ${estimated} tokens exceeds ${maxTokens} limit, pruning...`,
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
    if (estimated <= maxTokens) return pruned;

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
        content: `[Earlier conversation truncated — ${pruned.length - recentCount - 2} messages removed to fit context window of ${maxTokens} tokens]`,
      },
      ...recent,
      userMsg,
    ];

    console.warn(
      `[${this.name}] Pruned ${pruned.length} messages to ${kept.length}`,
    );

    return kept;
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

  estimateTokens(messages: ChatMessage[]): number {
    let totalChars = 0;

    for (const message of messages) {
      totalChars += message.content.length;
      totalChars += 16;

      if (message.tool_calls) {
        totalChars += JSON.stringify(message.tool_calls).length;
      }
    }

    return Math.max(1, Math.floor(totalChars / CHARS_PER_TOKEN));
  }
}
