/**
 * WhatsApp adapter — bridges through Signal using signal-cli.
 *
 * Setup: Configure signal-cli with a WhatsApp bridge (e.g., mautrix-whatsapp
 * or a similar Matrix bridge that connects to Signal). Messages flow:
 *
 *   WhatsApp <-> Signal bridge <-> signal-cli <-> this adapter
 *
 * The adapter reuses the existing signal-cli infrastructure from
 * src/integrations/signal/signal-bot.ts for sending.
 */

import { spawn } from "child_process";
import type { PlatformAdapter, DeliveryOptions, DeliveryResult, IncomingMessage } from "./platform-adapter";

export interface WhatsAppAdapterConfig {
  signalPhoneNumber: string;
  signalDataPath: string;
  /** Map of WhatsApp JIDs to Signal phone numbers for bridging */
  bridgeMap?: Record<string, string>;
}

export class WhatsAppAdapter implements PlatformAdapter {
  readonly platform = "whatsapp";
  private config: WhatsAppAdapterConfig;
  private connected = false;
  private messageQueue: IncomingMessage[] = [];
  private waitingConsumers: Array<(msg: IncomingMessage) => void> = [];
  private stopped = false;

  constructor(config: WhatsAppAdapterConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (!this.config.signalPhoneNumber) {
      console.warn("[WhatsApp] No Signal phone number configured, skipping");
      return;
    }
    // WhatsApp connectivity depends on the Signal-WhatsApp bridge being
    // configured externally. We just mark ourselves ready.
    this.connected = true;
    console.log("[WhatsApp] Adapter started (Signal bridge mode)");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async send(userId: string, message: string, _options?: DeliveryOptions): Promise<DeliveryResult> {
    const now = new Date().toISOString();

    // Resolve the Signal number for this WhatsApp user via the bridge map
    const signalTarget = this.config.bridgeMap?.[userId] || userId;

    try {
      const result = await this.executeSignalCli([
        "-u", this.config.signalPhoneNumber,
        "send", signalTarget,
        "-m", message,
      ]);

      if (result.success) {
        return {
          success: true,
          platform: this.platform,
          timestamp: now,
          suppressed: false,
        };
      }

      return {
        success: false,
        platform: this.platform,
        timestamp: now,
        suppressed: false,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[WhatsApp] Send failed to ${userId}:`, errMsg);
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

  /** Inject an incoming message from the Signal webhook handler. */
  injectMessage(msg: IncomingMessage): void {
    const wrapped: IncomingMessage = { ...msg, platform: this.platform };
    if (this.waitingConsumers.length > 0) {
      const resolve = this.waitingConsumers.shift()!;
      resolve(wrapped);
    } else {
      this.messageQueue.push(wrapped);
    }
  }

  private executeSignalCli(args: string[]): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const proc = spawn("signal-cli", args, { stdio: "pipe" });
      let stderr = "";

      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: stderr.trim() || `Exit code ${code}` });
        }
      });

      proc.on("error", (err) => {
        resolve({ success: false, error: err.message });
      });
    });
  }
}
