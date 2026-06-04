/**
 * Slack platform adapter using Socket Mode for real-time messages.
 */

import type { PlatformAdapter, DeliveryOptions, DeliveryResult, IncomingMessage } from "./platform-adapter";

export interface SlackAdapterConfig {
  botToken: string;
  appToken: string;
}

export class SlackAdapter implements PlatformAdapter {
  readonly platform = "slack";
  private config: SlackAdapterConfig;
  private webClient: any = null;
  private socketMode: any = null;
  private connected = false;
  private messageQueue: IncomingMessage[] = [];
  private waitingConsumers: Array<(msg: IncomingMessage) => void> = [];
  private stopped = false;

  constructor(config: SlackAdapterConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (!this.config.botToken || !this.config.appToken) {
      console.warn("[Slack] Bot token or app token not configured, skipping");
      return;
    }

    try {
      const { WebClient } = await import(/* @vite-ignore */ "@slack/web-api");
      const { SocketModeClient } = await import(/* @vite-ignore */ "@slack/socket-mode");

      this.webClient = new WebClient(this.config.botToken);
      this.socketMode = new SocketModeClient({ appToken: this.config.appToken });

      this.socketMode.on("message", async (event: any) => {
        const incoming = this.toIncomingMessage(event);
        if (incoming) this.enqueue(incoming);
      });

      this.socketMode.on("app_mention", async (event: any) => {
        const incoming = this.toIncomingMessage(event);
        if (incoming) {
          incoming.content = incoming.content.replace(/<@U\w+>/g, "").trim();
          this.enqueue(incoming);
        }
      });

      this.socketMode.on("error", (error: Error) => {
        console.error("[Slack] Socket Mode error:", error.message);
        this.connected = false;
      });

      await this.socketMode.start();
      this.connected = true;
      console.log("[Slack] Adapter started (Socket Mode)");
    } catch (error) {
      console.error("[Slack] Connection failed:", error);
      this.connected = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.socketMode) {
      try {
        await this.socketMode.disconnect();
      } catch {
        // Already disconnected
      }
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(userId: string, message: string, options?: DeliveryOptions): Promise<DeliveryResult> {
    const now = new Date().toISOString();

    if (!this.webClient) {
      return { success: false, platform: this.platform, timestamp: now, suppressed: false };
    }

    try {
      const postOpts: Record<string, unknown> = {
        channel: userId,
        text: message,
        unfurl_links: false,
        unfurl_media: false,
      };

      if (options?.replyToMessageId) {
        postOpts.thread_ts = options.replyToMessageId;
      }

      if (options?.parseMode === "markdown") {
        postOpts.mrkdwn = true;
      }

      const result = await this.webClient.chat.postMessage(postOpts);

      return {
        success: true,
        messageId: result.ts,
        platform: this.platform,
        timestamp: now,
        suppressed: false,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Slack] Send failed to ${userId}:`, errMsg);
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

  private toIncomingMessage(event: any): IncomingMessage | null {
    if (!event || !event.user) return null;

    const isThreadReply = !!event.thread_ts && event.thread_ts !== event.ts;

    return {
      platform: this.platform,
      userId: event.user,
      channelId: event.channel,
      content: event.text || "",
      timestamp: new Date(Number(event.ts.split(".")[0]) * 1000).toISOString(),
      metadata: {
        threadTs: event.thread_ts,
        isThreadReply,
        channelType: event.channel_type,
      },
    };
  }
}
