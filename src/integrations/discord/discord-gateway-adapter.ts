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

interface DiscordUser {
  id: string;
  bot?: boolean;
  username?: string;
  createDM(): Promise<DiscordDMChannel>;
}

interface DiscordDMChannel {
  send(text: string): Promise<{ id: string }>;
}

interface DiscordChannel {
  isDMBased?(): boolean;
  isTextBased?(): boolean;
  send(text: string): Promise<{ id: string }>;
}

interface DiscordMessage {
  author?: DiscordUser;
  channel?: DiscordChannel;
  channelId: string;
  content?: string;
  createdTimestamp: number;
  mentions?: { has?(user: { id: string }): boolean };
}

interface DiscordClient {
  user?: { id: string };
  users: { fetch(id: string): Promise<DiscordUser | null> };
  channels: { fetch(id: string): Promise<DiscordChannel | null> };
  on(event: "messageCreate", handler: (msg: DiscordMessage) => void): void;
  login(token: string): Promise<string>;
  destroy(): void;
}

export class DiscordGatewayAdapter implements PlatformAdapter {
  readonly platform = "discord";
  private config: DiscordGatewayConfig;
  private client: DiscordClient | null = null;
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
      const discord = await import("discord.js");

      const client = new discord.Client({
        intents: [
          discord.GatewayIntentBits.Guilds,
          discord.GatewayIntentBits.GuildMessages,
          discord.GatewayIntentBits.MessageContent,
          discord.GatewayIntentBits.DirectMessages,
          discord.GatewayIntentBits.DirectMessageReactions,
        ],
        partials: [discord.Partials.Channel, discord.Partials.Message],
      }) as DiscordClient;
      this.client = client;

      client.on("messageCreate", (message: DiscordMessage) => {
        if (message.author?.bot) return;
        if (this.config.allowedUserId && message.author?.id !== this.config.allowedUserId) return;

        const isDM = message.channel?.isDMBased?.();
        const isMentioned = client.user && message.mentions?.has?.(client.user);
        if (!isDM && !isMentioned) return;

        const incoming = this.toIncomingMessage(message);
        if (incoming) this.enqueue(incoming);
      });

      await client.login(this.config.token);
      this.connected = true;
      console.log("[DiscordGateway] Adapter started");
    } catch (error) {
      console.error("[DiscordGateway] Connection failed:", error);
      this.connected = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Resolve any waiting consumers to unblock hanging promises
    while (this.waitingConsumers.length > 0) {
      this.waitingConsumers.shift()!({
        platform: this.platform,
        userId: "",
        channelId: "",
        content: "",
        timestamp: new Date().toISOString(),
      });
    }
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
      if (!channel?.isTextBased?.()) {
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

  private toIncomingMessage(message: DiscordMessage): IncomingMessage | null {
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
