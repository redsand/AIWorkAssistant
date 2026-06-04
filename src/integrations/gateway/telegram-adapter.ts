/**
 * Telegram platform adapter using node-telegram-bot-api in polling mode.
 */

import type { PlatformAdapter, DeliveryOptions, DeliveryResult, IncomingMessage } from "./platform-adapter";

export interface TelegramAdapterConfig {
  token: string;
  apiBaseUrl?: string;
}

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = "telegram";
  private config: TelegramAdapterConfig;
  private bot: any = null;
  private connected = false;
  private messageQueue: IncomingMessage[] = [];
  private waitingConsumers: Array<(msg: IncomingMessage) => void> = [];
  private backoffMs = 1000;
  private maxBackoffMs = 30000;
  private stopped = false;

  constructor(config: TelegramAdapterConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (!this.config.token) {
      console.warn("[Telegram] No token configured, skipping");
      return;
    }

    await this.connect();
  }

  private async connect(): Promise<void> {
    try {
      // Dynamic import so the dependency is optional
      const TelegramBot = (await import(/* @vite-ignore */ "node-telegram-bot-api")).default;
      this.bot = new TelegramBot(this.config.token, { polling: true });

      this.bot.on("message", (msg: any) => {
        const incoming = this.toIncomingMessage(msg);
        if (incoming) this.enqueue(incoming);
      });

      this.bot.on("polling_error", (error: Error) => {
        console.error("[Telegram] Polling error:", error.message);
        this.connected = false;
      });

      // Handle /start command
      this.bot.onText(/\/start/, (msg: any) => {
        const incoming = this.toIncomingMessage(msg);
        if (incoming) {
          incoming.content = "/start";
          this.enqueue(incoming);
        }
        this.bot.sendMessage(msg.chat.id, "Connected to AI Assistant gateway. Send me a message to get started.");
      });

      this.connected = true;
      this.backoffMs = 1000;
      console.log("[Telegram] Adapter started (polling mode)");
    } catch (error) {
      console.error("[Telegram] Connection failed:", error);
      this.connected = false;
      if (!this.stopped) {
        await this.reconnect();
      }
    }
  }

  private async reconnect(): Promise<void> {
    if (this.stopped) return;
    console.log(`[Telegram] Reconnecting in ${this.backoffMs}ms...`);
    await new Promise((r) => setTimeout(r, this.backoffMs));
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.bot) {
      try {
        await this.bot.stopPolling();
      } catch {
        // Already stopped
      }
      this.bot = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(userId: string, message: string, options?: DeliveryOptions): Promise<DeliveryResult> {
    const now = new Date().toISOString();

    if (!this.bot) {
      return { success: false, platform: this.platform, timestamp: now, suppressed: false };
    }

    try {
      const parseMode = options?.parseMode === "html" ? "HTML" :
        options?.parseMode === "markdown" ? "Markdown" : undefined;

      const sent = await this.bot.sendMessage(userId, message, {
        parse_mode: parseMode,
        disable_notification: options?.silent,
        reply_to_message_id: options?.replyToMessageId
          ? Number(options.replyToMessageId)
          : undefined,
      });

      return {
        success: true,
        messageId: String(sent.message_id),
        platform: this.platform,
        timestamp: now,
        suppressed: false,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Telegram] Send failed to ${userId}:`, errMsg);
      return { success: false, platform: this.platform, timestamp: now, suppressed: false };
    }
  }

  async *receive(): AsyncIterable<IncomingMessage> {
    while (!this.stopped) {
      if (this.messageQueue.length > 0) {
        yield this.messageQueue.shift()!;
        continue;
      }

      const message = await new Promise<IncomingMessage>((resolve) => {
        this.waitingConsumers.push(resolve);
      });
      yield message;
    }
  }

  private enqueue(msg: IncomingMessage): void {
    if (this.waitingConsumers.length > 0) {
      const resolve = this.waitingConsumers.shift()!;
      resolve(msg);
    } else {
      this.messageQueue.push(msg);
    }
  }

  private toIncomingMessage(msg: any): IncomingMessage | null {
    if (!msg || !msg.from) return null;
    return {
      platform: this.platform,
      userId: String(msg.from.id),
      channelId: String(msg.chat.id),
      content: msg.text || "",
      timestamp: new Date(msg.date * 1000).toISOString(),
      metadata: {
        firstName: msg.from.first_name,
        lastName: msg.from.last_name,
        username: msg.from.username,
        chatType: msg.chat.type,
      },
    };
  }
}
