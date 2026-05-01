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
}

export interface ProviderCapabilities {
  streaming: boolean;
  toolChoice: "required" | "auto" | "none";
  parallelToolCalls: boolean;
  requiresAuth: boolean;
  synthesizesToolCallIds: boolean;
}

export type OpenCodeConfig = ProviderConfig;

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
    const body: Record<string, unknown> = {
      model: request.model || this.config.model,
      messages: request.messages,
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

    return Math.max(1, Math.floor(totalChars / 4));
  }
}
