import { getProvider } from "./providers/factory";
import type { AIProvider } from "./providers/types";
import type {
  ChatMessage,
  ToolCall,
  Tool,
  ChatRequest,
  ChatResponse,
  OpenCodeConfig,
} from "./providers/types";

class OpenCodeClient {
  private provider: AIProvider;

  constructor() {
    this.provider = getProvider();
  }

  get providerName(): string {
    return this.provider.name;
  }

  chat(request: ChatRequest): Promise<ChatResponse> {
    return this.provider.chat(request);
  }

  chatStream(request: ChatRequest): AsyncGenerator<string, void, unknown> {
    return this.provider.chatStream(request);
  }

  isConfigured(): boolean {
    return this.provider.isConfigured();
  }

  async validateConfig(): Promise<boolean> {
    return this.provider.validateConfig();
  }

  estimateTokens(messages: ChatMessage[], tools?: Tool[]): number {
    return this.provider.estimateTokens(messages, tools);
  }

  pruneMessages(messages: ChatMessage[], tools?: Tool[]): ChatMessage[] {
    return this.provider.pruneMessages(messages, tools);
  }

  getMaxContextTokens(): number {
    return this.provider.getMaxContextTokens();
  }
}

export const aiClient = new OpenCodeClient();

export type {
  ChatMessage,
  ToolCall,
  Tool,
  ChatRequest,
  ChatResponse,
  OpenCodeConfig,
};
