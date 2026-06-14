import { getProvider, resetProvider } from "./providers/factory";
import type { AIProvider, StreamEvent } from "./providers/types";
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

  get modelName(): string {
    return (this.provider as any).config?.model ?? "";
  }

  /** Re-create the provider from current env vars (for --provider/--model overrides). */
  refresh(): void {
    resetProvider();
    this.provider = getProvider();
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    return this.provider.chat(request);
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<string | StreamEvent, void, unknown> {
    yield* this.provider.chatStream(request);
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

  getMaxTools(): number | undefined {
    return this.provider.capabilities.maxTools;
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
