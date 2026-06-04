/**
 * Platform adapter interfaces for the multi-platform messaging gateway.
 */

export interface DeliveryOptions {
  parseMode?: "markdown" | "html" | "plain";
  silent?: boolean;
  replyToMessageId?: string;
}

export interface DeliveryResult {
  success: boolean;
  messageId?: string;
  platform: string;
  timestamp: string;
  suppressed: boolean;
}

export interface IncomingMessage {
  platform: string;
  userId: string;
  channelId: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface PlatformAdapter {
  readonly platform: string;
  send(userId: string, message: string, options?: DeliveryOptions): Promise<DeliveryResult>;
  receive(): AsyncIterable<IncomingMessage>;
  start(): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;
}
