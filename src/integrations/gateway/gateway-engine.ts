/**
 * Gateway engine: manages all platform adapters, routes outbound messages,
 * maintains cross-platform session continuity, and logs deliveries.
 */

import fs from "fs";
import path from "path";
import type { PlatformAdapter, DeliveryOptions, DeliveryResult } from "./platform-adapter";

const SILENT_MARKER = "[SILENT]";

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

export class GatewayEngine {
  private adapters: Map<string, PlatformAdapter> = new Map();
  private sessions: Map<string, SessionMapping> = new Map();
  private dataDir: string;
  private running = false;

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

  async start(): Promise<void> {
    if (this.running) return;

    this.loadSessions();

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
      const result: DeliveryResult = {
        success: true,
        platform,
        timestamp: now,
        suppressed: true,
      };
      this.logDelivery({ platform, userId, suppressed: true, timestamp: now });
      return result;
    }

    const adapter = this.adapters.get(platform);
    if (!adapter) {
      const result: DeliveryResult = {
        success: false,
        platform,
        timestamp: now,
        suppressed: false,
      };
      this.logDelivery({
        platform,
        userId,
        suppressed: false,
        timestamp: now,
        error: `No adapter registered for platform: ${platform}`,
      });
      return result;
    }

    try {
      const result = await adapter.send(userId, message, options);
      this.logDelivery({
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
      const result: DeliveryResult = {
        success: false,
        platform,
        timestamp: now,
        suppressed: false,
      };
      this.logDelivery({ platform, userId, suppressed: false, timestamp: now, error: errMsg });
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
    this.saveSessions();
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

  private loadSessions(): void {
    const filepath = path.join(this.dataDir, "sessions.json");
    if (!fs.existsSync(filepath)) return;

    try {
      const data = JSON.parse(fs.readFileSync(filepath, "utf-8")) as SessionMapping[];
      for (const entry of data) {
        this.sessions.set(`${entry.platform}:${entry.userId}`, entry);
      }
    } catch {
      // Corrupt file — start fresh
    }
  }

  private saveSessions(): void {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const filepath = path.join(this.dataDir, "sessions.json");
      const tmpPath = filepath + ".tmp";
      const data = [...this.sessions.values()];
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmpPath, filepath);
    } catch (error) {
      console.error("[Gateway] Failed to save sessions:", error);
    }
  }

  private logDelivery(entry: DeliveryLogEntry): void {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const filepath = path.join(this.dataDir, "delivery-log.jsonl");
      fs.appendFileSync(filepath, JSON.stringify(entry) + "\n", "utf-8");
    } catch (error) {
      console.error("[Gateway] Failed to log delivery:", error);
    }
  }
}

export const gatewayEngine = new GatewayEngine();
