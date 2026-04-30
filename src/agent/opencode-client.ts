/**
 * OpenCode API client - Production implementation
 * Based on octorepl Python implementation
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { env } from '../config/env';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface Tool {
  type: 'function';
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

export interface OpenCodeConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  topP: number;
  maxRetries: number;
  timeout: number;
}

class OpenCodeClient {
  private client: AxiosInstance;
  private config: OpenCodeConfig;

  constructor() {
    this.config = {
      apiKey: env.OPENCODE_API_KEY,
      baseUrl: env.OPENCODE_API_URL,
      model: 'glm-5',
      temperature: 0.7,
      topP: 0.95,
      maxRetries: 3,
      timeout: 120000, // 120 seconds
    };

    this.client = axios.create({
      baseURL: this.config.baseUrl,
      timeout: this.config.timeout,
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Send chat request to OpenCode API
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!this.isConfigured()) {
      throw new Error('OpenCode API key not configured. Set OPENCODE_API_KEY environment variable.');
    }

    try {
      const requestBody = {
        model: request.model || this.config.model,
        messages: request.messages,
        temperature: request.temperature ?? this.config.temperature,
        top_p: request.top_p ?? this.config.topP,
        ...(request.tools && {
          tools: request.tools,
          tool_choice: 'required',
          parallel_tool_calls: true,
        }),
      };

      console.log('[OpenCode API] Sending request:', {
        model: requestBody.model,
        messageCount: requestBody.messages.length,
        hasTools: !!request.tools,
      });

      const response = await this.client.post('/chat/completions', requestBody);

      const data = response.data;
      const message = data.choices[0].message;

      const result: ChatResponse = {
        content: message.content || '',
        toolCalls: message.tool_calls ? this.parseToolCalls(message.tool_calls) : undefined,
        usage: {
          promptTokens: data.usage?.prompt_tokens || 0,
          completionTokens: data.usage?.completion_tokens || 0,
          totalTokens: data.usage?.total_tokens || 0,
        },
        model: data.model || this.config.model,
        done: true,
      };

      console.log('[OpenCode API] Response received:', {
        contentLength: result.content.length,
        toolCallCount: result.toolCalls?.length || 0,
        tokensUsed: result.usage.totalTokens,
      });

      return result;

    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        const status = axiosError.response?.status;
        const data = axiosError.response?.data as any;

        console.error('[OpenCode API] Request failed:', {
          status,
          statusText: axiosError.response?.statusText,
          data: data ? JSON.stringify(data).substring(0, 200) : undefined,
        });

        if (status === 401) {
          throw new Error('OpenCode API authentication failed. Check your API key.');
        } else if (status === 429) {
          throw new Error('OpenCode API rate limit exceeded. Please try again later.');
        } else if (status && status >= 500) {
          throw new Error(`OpenCode API server error: ${status}`);
        } else if (status === 400) {
          throw new Error(`OpenCode API bad request: ${data?.error?.message || 'Unknown error'}`);
        }
      }

      console.error('[OpenCode API] Unexpected error:', error);
      throw new Error(`OpenCode API request failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Stream chat response from OpenCode API
   */
  async *chatStream(request: ChatRequest): AsyncGenerator<string, void, unknown> {
    if (!this.isConfigured()) {
      throw new Error('OpenCode API key not configured. Set OPENCODE_API_KEY environment variable.');
    }

    try {
      const requestBody = {
        model: request.model || this.config.model,
        messages: request.messages,
        temperature: request.temperature ?? this.config.temperature,
        top_p: request.top_p ?? this.config.topP,
        stream: true,
        ...(request.tools && {
          tools: request.tools,
          tool_choice: 'required',
          parallel_tool_calls: true,
        }),
      };

      console.log('[OpenCode API] Starting stream request');

      const response = await this.client.post('/chat/completions', requestBody, {
        responseType: 'stream',
      });

      for await (const chunk of response.data) {
        const line = chunk.toString();

        if (!line.startsWith('data: ')) {
          continue;
        }

        const data = line.slice(6);

        if (data === '[DONE]') {
          break;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices[0]?.delta;

          if (delta?.content) {
            yield delta.content;
          }
        } catch (e) {
          // Skip invalid JSON
          continue;
        }
      }

      console.log('[OpenCode API] Stream completed');

    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        console.error('[OpenCode API] Stream failed:', { status });

        if (status === 401) {
          throw new Error('OpenCode API authentication failed. Check your API key.');
        }
      }

      console.error('[OpenCode API] Stream error:', error);
      throw new Error(`OpenCode API stream failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Check if OpenCode API is configured
   */
  isConfigured(): boolean {
    return !!this.config.apiKey && this.config.apiKey.length > 0;
  }

  /**
   * Validate OpenCode API configuration
   */
  async validateConfig(): Promise<boolean> {
    if (!this.isConfigured()) {
      return false;
    }

    try {
      const response = await this.client.get('/models', { timeout: 10000 });
      return response.status === 200;
    } catch (error) {
      console.error('[OpenCode API] Config validation failed:', error);
      return false;
    }
  }

  /**
   * Get list of available models
   */
  async getModels(): Promise<string[]> {
    if (!this.isConfigured()) {
      throw new Error('OpenCode API not configured');
    }

    try {
      const response = await this.client.get('/models');
      const models = response.data.data || [];

      // Filter for chat models
      return models
        .filter((m: any) => m.id?.toLowerCase().startsWith('opencode-'))
        .map((m: any) => m.id)
        .sort();
    } catch (error) {
      console.error('[OpenCode API] Failed to get models:', error);
      return [];
    }
  }

  /**
   * Parse tool calls from API response
   */
  private parseToolCalls(toolCalls: any[]): ToolCall[] {
    return toolCalls.map(tc => ({
      id: tc.id,
      type: tc.type,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));
  }

  /**
   * Estimate token count for messages (rough approximation)
   */
  estimateTokens(messages: ChatMessage[]): number {
    let totalChars = 0;

    for (const message of messages) {
      totalChars += message.content.length;
      totalChars += 16; // Overhead per message

      if (message.tool_calls) {
        totalChars += JSON.stringify(message.tool_calls).length;
      }
    }

    return Math.max(1, Math.floor(totalChars / 4)); // ~4 chars per token
  }
}

export const opencodeClient = new OpenCodeClient();
