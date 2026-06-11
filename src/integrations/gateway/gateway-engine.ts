/**
 * Gateway engine: manages all platform adapters, routes outbound messages,
 * maintains cross-platform session continuity, and logs deliveries.
 */

import fs from "fs/promises";
import path from "path";
import type { PlatformAdapter, DeliveryOptions, DeliveryResult } from "./platform-adapter";

const SILENT_MARKER = "[SILENT]";

export function sanitizeMessage(message: string, platform: string): string {
  let sanitized = message;

  // Strip Discord-specific mention patterns
  sanitized = sanitized.replace(/@everyone/gi, "@​everyone");
  sanitized = sanitized.replace(/@here/gi, "@​here");
  sanitized = sanitized.replace(/<@&\d+>/g, "[removed-role-mention]");
  sanitized = sanitized.replace(/<#!?\d+>/g, "[removed-channel-mention]");

  // Strip Telegram HTML injection for platforms using HTML parse mode
  if (platform === "telegram") {
    sanitized = sanitized.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    sanitized = sanitized.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, "");
    sanitized = sanitized.replace(/on\w+="[^"]*"/gi, "");
    sanitized = sanitized.replace(/on\w+='[^']*'/gi, "");
    sanitized = sanitized.replace(/javascript:/gi, "");
  }

  return sanitized;
}

const PLATFORM_MESSAGE_LIMITS: Record<string, number> = {
  telegram: 4096,
  discord: 2000,
  slack: 40000,
  whatsapp: 65536,
};

interface SessionMapping {
  userId: string;
  platform: string;
  sessionId: string;
  updatedAt: string;
}

interface DeliveryLogEntry {
  platform: string;
  userId: string;
  messageId?: string;
  suppressed: boolean;
  timestamp: string;
  error?: string;
}

interface DeliveryMetrics {
  totalSent: number;
  totalFailed: number;
  totalSuppressed: number;
  byPlatform: Record<string, { sent: number; failed: number; suppressed: number }>;
}

export class GatewayEngine {
  private adapters: Map<string, PlatformAdapter> = new Map();
  private sessions: Map<string, SessionMapping> = new Map();
  private dataDir: string;
  private running = false;
  private logStream: fs.FileHandle | null = null;
  private saveInProgress = false;
  private savePending = false;
  private metrics: DeliveryMetrics = {
    totalSent: 0,
    totalFailed: 0,
    totalSuppressed: 0,
    byPlatform: {},
  };

  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.join(process.cwd(), "data", "gateway");
  }

  registerAdapter(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.platform, adapter);
  }

  getAdapter(platform: string): PlatformAdapter | undefined {
    return this.adapters.get(platform);
  }

  getRegisteredPlatforms(): string[] {
    return [...this.adapters.keys()];
  }

  getMetrics(): Readonly<DeliveryMetrics> {
    return this.metrics;
  }

  async start(): Promise<void> {
    if (this.running) return;

    await this.loadSessions();

    const startResults = await Promise.allSettled(
      [...this.adapters.values()].map((a) => a.start()),
    );

    for (let i = 0; i < startResults.length; i++) {
      const result = startResults[i];
      const platform = [...this.adapters.keys()][i];
      if (result.status === "rejected") {
        console.error(`[Gateway] Failed to start ${platform} adapter:`, result.reason);
      } else {
        console.log(`[Gateway] Started ${platform} adapter`);
      }
    }

    this.running = true;
    console.log(`[Gateway] Engine started with ${this.adapters.size} adapter(s)`);
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    await Promise.allSettled(
      [...this.adapters.values()].map((a) => a.stop()),
    );

    if (this.logStream) {
      await this.logStream.close();
      this.logStream = null;
    }

    this.running = false;
    console.log("[Gateway] Engine stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  async send(
    platform: string,
    userId: string,
    message: string,
    options?: DeliveryOptions,
  ): Promise<DeliveryResult> {
    const now = new Date().toISOString();

    // [SILENT] suppression
    if (message.includes(SILENT_MARKER) || options?.silent) {
      this.recordMetric(platform, "suppressed");
      const result: DeliveryResult = {
        success: true,
        platform,
        timestamp: now,
        suppressed: true,
      };
      await this.logDelivery({ platform, userId, suppressed: true, timestamp: now });
      return result;
    }

    // Message length validation per platform
    const limit = PLATFORM_MESSAGE_LIMITS[platform];
    if (limit && message.length > limit) {
      this.recordMetric(platform, "failed");
      const result: DeliveryResult = {
        success: false,
        platform,
        timestamp: now,
        suppressed: false,
      };
      await this.logDelivery({
        platform,
        userId,
        suppressed: false,
        timestamp: now,
        error: `Message too long: ${message.length} chars (limit: ${limit} for ${platform})`,
      });
      return result;
    }

    const adapter = this.adapters.get(platform);
    if (!adapter) {
      this.recordMetric(platform, "failed");
      const result: DeliveryResult = {
        success: false,
        platform,
        timestamp: now,
        suppressed: false,
      };
      await this.logDelivery({
        platform,
        userId,
        suppressed: false,
        timestamp: now,
        error: `No adapter registered for platform: ${platform}`,
      });
      return result;
    }

    try {
      const safeMessage = sanitizeMessage(message, platform);
      const result = await adapter.send(userId, safeMessage, options);
      if (result.success) {
        this.recordMetric(platform, "sent");
      } else {
        this.recordMetric(platform, "failed");
      }
      await this.logDelivery({
        platform,
        userId,
        messageId: result.messageId,
        suppressed: false,
        timestamp: result.timestamp,
        error: result.success ? undefined : "Adapter reported failure",
      });
      return result;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.recordMetric(platform, "failed");
      const result: DeliveryResult = {
        success: false,
        platform,
        timestamp: now,
        suppressed: false,
      };
      await this.logDelivery({ platform, userId, suppressed: false, timestamp: now, error: errMsg });
      return result;
    }
  }

  async broadcast(
    message: string,
    userId: string,
    platforms?: string[],
  ): Promise<DeliveryResult[]> {
    const targets = platforms || [...this.adapters.keys()];
    const results = await Promise.all(
      targets.map((p) => this.send(p, userId, message)),
    );
    return results;
  }

  mapSession(userId: string, platform: string, sessionId: string): void {
    const key = `${platform}:${userId}`;
    this.sessions.set(key, {
      userId,
      platform,
      sessionId,
      updatedAt: new Date().toISOString(),
    });
    this.debouncedSaveSessions();
  }

  getSession(userId: string, platform: string): string | undefined {
    return this.sessions.get(`${platform}:${userId}`)?.sessionId;
  }

  findSessionCrossPlatform(userId: string): SessionMapping | undefined {
    for (const [, mapping] of this.sessions) {
      if (mapping.userId === userId) return mapping;
    }
    return undefined;
  }

  private recordMetric(platform: string, type: "sent" | "failed" | "suppressed"): void {
    if (type === "sent") this.metrics.totalSent++;
    else if (type === "failed") this.metrics.totalFailed++;
    else this.metrics.totalSuppressed++;

    if (!this.metrics.byPlatform[platform]) {
      this.metrics.byPlatform[platform] = { sent: 0, failed: 0, suppressed: 0 };
    }
    this.metrics.byPlatform[platform][type]++;
  }

  private debouncedSaveSessions(): void {
    if (this.saveInProgress) {
      this.savePending = true;
      return;
    }
    this.saveInProgress = true;
    this.saveSessions().finally(() => {
      this.saveInProgress = false;
      if (this.savePending) {
        this.savePending = false;
        this.debouncedSaveSessions();
      }
    });
  }

  private async loadSessions(): Promise<void> {
    const filepath = path.join(this.dataDir, "sessions.json");

    try {
      const raw = await fs.readFile(filepath, "utf-8");
      const data = JSON.parse(raw) as SessionMapping[];
      for (const entry of data) {
        this.sessions.set(`${entry.platform}:${entry.userId}`, entry);
      }
    } catch {
      // File missing or corrupt — start fresh
    }
  }

  private async saveSessions(): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      const filepath = path.join(this.dataDir, "sessions.json");
      const tmpPath = filepath + ".tmp";
      const data = [...this.sessions.values()];
      await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      await fs.rename(tmpPath, filepath);
    } catch (error) {
      console.error("[Gateway] Failed to save sessions:", error);
    }
  }

  private async logDelivery(entry: DeliveryLogEntry): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      const filepath = path.join(this.dataDir, "delivery-log.jsonl");
      await fs.appendFile(filepath, JSON.stringify(entry) + "\n", "utf-8");
    } catch (error) {
      console.error("[Gateway] Failed to log delivery:", error);
    }
  }
}

/** Initialize the gateway engine with adapters from environment configuration. */
export async function initializeGateway(
  engine: GatewayEngine,
  config: {
    telegramToken?: string;
    slackBotToken?: string;
    slackAppToken?: string;
  },
): Promise<void> {
  if (config.telegramToken) {
    const { TelegramAdapter } = await import("./telegram-adapter.js");
    engine.registerAdapter(new TelegramAdapter({ token: config.telegramToken }));
  }

  if (config.slackBotToken && config.slackAppToken) {
    const { SlackAdapter } = await import("./slack-adapter.js");
    engine.registerAdapter(new SlackAdapter({
      botToken: config.slackBotToken,
      appToken: config.slackAppToken,
    }));
  }
}

export const gatewayEngine = new GatewayEngine();
