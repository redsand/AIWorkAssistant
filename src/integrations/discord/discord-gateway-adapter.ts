/**
 * Discord gateway adapter — wraps the existing DiscordAgentBot with outbound
 * delivery capability. Reuses the existing discord.js Client for sends.
 */

import type { PlatformAdapter, DeliveryOptions, DeliveryResult, IncomingMessage } from "../gateway/platform-adapter";

export interface DiscordGatewayConfig {
  token: string;
  clientId: string;
  guildId?: string;
  allowedUserId?: string;
}

export class DiscordGatewayAdapter implements PlatformAdapter {
  readonly platform = "discord";
  private config: DiscordGatewayConfig;
  private client: any = null;
  private connected = false;
  private messageQueue: IncomingMessage[] = [];
  private waitingConsumers: Array<(msg: IncomingMessage) => void> = [];
  private stopped = false;

  constructor(config: DiscordGatewayConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (!this.config.token) {
      console.warn("[DiscordGateway] No token configured, skipping");
      return;
    }

    try {
      const { Client, GatewayIntentBits, Partials } = await import("discord.js");

      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.DirectMessageReactions,
        ],
        partials: [Partials.Channel, Partials.Message],
      });

      this.client.on("messageCreate", (message: any) => {
        if (message.author?.bot) return;
        if (this.config.allowedUserId && message.author?.id !== this.config.allowedUserId) return;

        const isDM = message.channel?.isDMBased?.();
        const isMentioned = this.client.user && message.mentions?.has?.(this.client.user);
        if (!isDM && !isMentioned) return;

        const incoming = this.toIncomingMessage(message);
        if (incoming) this.enqueue(incoming);
      });

      await this.client.login(this.config.token);
      this.connected = true;
      console.log("[DiscordGateway] Adapter started");
    } catch (error) {
      console.error("[DiscordGateway] Connection failed:", error);
      this.connected = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(userId: string, message: string, _options?: DeliveryOptions): Promise<DeliveryResult> {
    const now = new Date().toISOString();

    if (!this.client) {
      return { success: false, platform: this.platform, timestamp: now, suppressed: false };
    }

    try {
      const user = await this.client.users.fetch(userId);
      if (!user) {
        return { success: false, platform: this.platform, timestamp: now, suppressed: false };
      }

      const dmChannel = await user.createDM();
      const sent = await dmChannel.send(message);

      return {
        success: true,
        messageId: sent.id,
        platform: this.platform,
        timestamp: now,
        suppressed: false,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[DiscordGateway] Send failed to ${userId}:`, errMsg);
      return { success: false, platform: this.platform, timestamp: now, suppressed: false };
    }
  }

  async sendToChannel(channelId: string, message: string): Promise<DeliveryResult> {
    const now = new Date().toISOString();

    if (!this.client) {
      return { success: false, platform: this.platform, timestamp: now, suppressed: false };
    }

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        return { success: false, platform: this.platform, timestamp: now, suppressed: false };
      }

      const sent = await channel.send(message);
      return {
        success: true,
        messageId: sent.id,
        platform: this.platform,
        timestamp: now,
        suppressed: false,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[DiscordGateway] Send to channel ${channelId} failed:`, errMsg);
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

  private toIncomingMessage(message: any): IncomingMessage | null {
    if (!message.author) return null;

    const content = message.content
      ?.replace(new RegExp(`<@!?${this.client?.user?.id}>`), "")
      .trim();

    if (!content) return null;

    return {
      platform: this.platform,
      userId: message.author.id,
      channelId: message.channelId,
      content,
      timestamp: new Date(message.createdTimestamp).toISOString(),
      metadata: {
        username: message.author.username,
        isDM: message.channel?.isDMBased?.(),
      },
    };
  }
}
