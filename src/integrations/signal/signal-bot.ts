/**
 * Signal Integration for AI Assistant
 * Provides secure, encrypted messaging through Signal
 *
 * Note: Signal doesn't have a traditional bot API, so this uses a webhook-based
 * approach combined with Signal CLI for message sending/receiving
 */

import axios from "axios";
import { spawn } from "child_process";
import { join } from "path";

const API_BASE = process.env.API_BASE_URL || "http://localhost:3000";

interface SignalMessage {
  type: "sent" | "received";
  timestamp: Date;
  phoneNumber: string;
  content: string;
  messageId?: string;
}

interface SignalConfig {
  phoneNumber: string; // Your Signal phone number
  dataPath: string; // Path to Signal CLI data
}

class SignalAgentBot {
  private config: SignalConfig;

  constructor(config: SignalConfig) {
    this.config = config;
  }

  /**
   * Send a message through Signal
   */
  async sendMessage(phoneNumber: string, message: string): Promise<boolean> {
    try {
      console.log(`[SignalBot] Sending message to ${phoneNumber}`);

      // Using signal-cli via command line
      const args = [
        "-u",
        this.config.phoneNumber,
        "send",
        phoneNumber,
        "-m",
        message,
      ];

      const result = await this.executeSignalCli(args);

      if (result.success) {
        // Log the sent message
        this.logMessage({
          type: "sent",
          timestamp: new Date(),
          phoneNumber,
          content: message,
        });

        return true;
      } else {
        console.error("[SignalBot] Failed to send message:", result.error);
        return false;
      }
    } catch (error) {
      console.error("[SignalBot] Error sending message:", error);
      return false;
    }
  }

  /**
   * Process incoming message from Signal
   */
  async processIncomingMessage(
    phoneNumber: string,
    message: string,
  ): Promise<string> {
    try {
      console.log(`[SignalBot] Processing message from ${phoneNumber}`);

      // Send to AI Assistant
      const response = await axios.post(`${API_BASE}/chat`, {
        message,
        mode: "productivity",
        userId: `signal-${phoneNumber}`,
        includeMemory: true,
      });

      const aiResponse =
        response.data.content || "Sorry, I couldn't process that message.";

      // Send response back through Signal
      await this.sendMessage(phoneNumber, aiResponse);

      // Log the conversation
      this.logMessage({
        type: "received",
        timestamp: new Date(),
        phoneNumber,
        content: message,
      });

      this.logMessage({
        type: "sent",
        timestamp: new Date(),
        phoneNumber,
        content: aiResponse,
      });

      return aiResponse;
    } catch (error) {
      console.error("[SignalBot] Error processing message:", error);

      const errorMessage =
        "Sorry, I encountered an error processing your message.";
      await this.sendMessage(phoneNumber, errorMessage);

      return errorMessage;
    }
  }

  /**
   * Execute signal-cli command
   */
  private async executeSignalCli(
    args: string[],
  ): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const signalProcess = spawn("signal-cli", args, {
        stdio: "pipe",
        env: {
          ...process.env,
          SIGNAL_CONFIG_DIR: this.config.dataPath,
        },
      });

      let stdout = "";
      let stderr = "";

      signalProcess.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      signalProcess.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      signalProcess.on("close", (code: number | null) => {
        if (code === 0) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: stderr || `Exit code: ${code}` });
        }
      });

      signalProcess.on("error", (error: Error) => {
        resolve({ success: false, error: error.message });
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        signalProcess.kill();
        resolve({ success: false, error: "Command timed out" });
      }, 30000);
    });
  }

  /**
   * Log message for audit trail
   */
  private async logMessage(message: SignalMessage): Promise<void> {
    try {
      const logPath = join(
        process.cwd(),
        "data",
        "audit",
        "signal-messages.log",
      );
      const logEntry =
        JSON.stringify({
          ...message,
          timestamp: message.timestamp.toISOString(),
        }) + "\n";

      await appendFile(logPath, logEntry);
    } catch (error) {
      console.error("[SignalBot] Failed to log message:", error);
    }
  }

  /**
   * Check if Signal CLI is installed and configured
   */
  async verifySetup(): Promise<{
    installed: boolean;
    configured: boolean;
    error?: string;
  }> {
    try {
      // Check if signal-cli is installed
      const result = await this.executeSignalCli(["--version"]);

      if (!result.success) {
        return {
          installed: false,
          configured: false,
          error: "signal-cli not installed",
        };
      }

      // Check if configured
      const listResult = await this.executeSignalCli(["listIds"]);

      if (!listResult.success) {
        return {
          installed: true,
          configured: false,
          error: "signal-cli not configured",
        };
      }

      return { installed: true, configured: true };
    } catch (error) {
      return {
        installed: false,
        configured: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Get Signal account status
   */
  async getStatus(): Promise<{
    connected: boolean;
    phoneNumber: string;
    messages: number;
  }> {
    try {
      const verifyResult = await this.verifySetup();

      return {
        connected: verifyResult.installed && verifyResult.configured,
        phoneNumber: this.config.phoneNumber,
        messages: 0, // Would need to implement message counting
      };
    } catch (error) {
      return {
        connected: false,
        phoneNumber: this.config.phoneNumber,
        messages: 0,
      };
    }
  }
}

/**
 * Signal Webhook Handler
 * Handles incoming messages from Signal via webhooks
 */
class SignalWebhookHandler {
  private bot: SignalAgentBot;

  constructor(bot: SignalAgentBot) {
    this.bot = bot;
  }

  /**
   * Handle incoming webhook from Signal
   */
  async handleWebhook(
    payload: any,
  ): Promise<{ success: boolean; message?: string }> {
    try {
      console.log("[SignalWebhook] Received webhook:", payload);

      // Extract message data from webhook payload
      const message = payload.envelope?.dataMessage?.message || "";
      const phoneNumber = payload.envelope?.source || "";

      if (!message || !phoneNumber) {
        return {
          success: false,
          message: "Invalid webhook payload",
        };
      }

      // Process the message
      await this.bot.processIncomingMessage(phoneNumber, message);

      return { success: true };
    } catch (error) {
      console.error("[SignalWebhook] Error handling webhook:", error);
      return {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Verify webhook signature
   */
  verifySignature(_signature: string, _payload: string): boolean {
    // TODO: Implement webhook signature verification if Signal provides it
    return true;
  }
}

/**
 * Signal HTTP Bridge
 * Alternative method for Signal integration using HTTP polling
 */
class SignalHTTPBridge {
  private apiBase: string;

  constructor(apiBase: string, _configuredPhoneNumber: string) {
    this.apiBase = apiBase;
  }

  /**
   * Send message via HTTP bridge
   */
  async sendMessage(phoneNumber: string, message: string): Promise<boolean> {
    try {
      // This would connect to a Signal HTTP bridge service
      // Signal doesn't provide an official HTTP API, but there are community solutions

      const response = await axios.post(`${this.apiBase}/v1/send`, {
        number: phoneNumber,
        message: message,
      });

      return response.status === 200;
    } catch (error) {
      console.error("[SignalHTTPBridge] Failed to send message:", error);
      return false;
    }
  }

  /**
   * Poll for new messages
   */
  async pollMessages(): Promise<any[]> {
    try {
      const response = await axios.get(`${this.apiBase}/v1/receive`);

      if (response.status === 200) {
        return response.data.messages || [];
      }

      return [];
    } catch (error) {
      console.error("[SignalHTTPBridge] Failed to poll messages:", error);
      return [];
    }
  }
}

/**
 * Helper function to append to file
 */
async function appendFile(filePath: string, content: string): Promise<void> {
  const fs = await import("fs/promises");
  await fs.appendFile(filePath, content);
}

// Export classes
export { SignalAgentBot, SignalWebhookHandler, SignalHTTPBridge };
