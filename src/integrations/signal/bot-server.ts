#!/usr/bin/env tsx
/**
 * Signal Bot Server
 * Runs the Signal integration for OpenClaw Agent
 */

import { SignalAgentBot, SignalWebhookHandler } from "./signal-bot";
import { loadEnv } from "../../config/env";
import fastify from "fastify";
import cors from "@fastify/cors";

async function main() {
  console.log("📱 Starting OpenClaw Agent Signal Integration...");

  // Load environment variables
  const env = loadEnv();

  // Validate Signal configuration
  if (!env.SIGNAL_PHONE_NUMBER) {
    console.error("❌ SIGNAL_PHONE_NUMBER environment variable is required");
    console.error("Format: International format (e.g., +1234567890)");
    process.exit(1);
  }

  // Create Signal bot
  const bot = new SignalAgentBot({
    phoneNumber: env.SIGNAL_PHONE_NUMBER,
    dataPath: env.SIGNAL_DATA_PATH || "~/.config/Signal",
  });

  // Verify setup
  console.log("[SignalBot] Verifying Signal CLI setup...");
  const setup = await bot.verifySetup();

  if (!setup.installed) {
    console.error("❌ Signal CLI is not installed");
    console.error("");
    console.error("To install Signal CLI:");
    console.error("  # Install via cargo (Rust package manager)");
    console.error("  cargo install signal-cli");
    console.error("");
    console.error("  # Or download pre-built binary from:");
    console.error("  https://github.com/AsamK/signal-cli/releases");
    process.exit(1);
  }

  if (!setup.configured) {
    console.error("❌ Signal CLI is not configured");
    console.error("");
    console.error("To configure Signal CLI:");
    console.error("  # Link your Signal phone number");
    console.error("  signal-cli link");
    console.error("");
    console.error("  # Follow the QR code instructions on your phone");
    console.error(
      "  # Signal -> Settings -> Linked Devices -> Link Device (Desktop)",
    );
    process.exit(1);
  }

  console.log("✅ Signal CLI verified");

  // Check bot status
  const status = await bot.getStatus();
  console.log(`📱 Phone Number: ${status.phoneNumber}`);
  console.log(`🔗 Status: ${status.connected ? "Connected" : "Disconnected"}`);

  // Create webhook server for receiving messages
  const server = fastify();
  await server.register(cors, {
    origin: true,
  });

  // Webhook endpoint for Signal
  server.post("/webhook/signal", async (request, reply) => {
    try {
      const handler = new SignalWebhookHandler(bot);
      const result = await handler.handleWebhook(request.body);

      if (result.success) {
        reply.code(200).send({ status: "ok" });
      } else {
        reply.code(400).send({ error: result.message });
      }
    } catch (error) {
      console.error("[SignalWebhook] Error:", error);
      reply.code(500).send({ error: "Internal server error" });
    }
  });

  // Health check
  server.get("/health", async (_request, reply) => {
    const status = await bot.getStatus();
    reply.send({
      service: "signal-bot",
      status: status.connected ? "ok" : "error",
      phoneNumber: status.phoneNumber,
      timestamp: new Date().toISOString(),
    });
  });

  // Start webhook server
  const webhookPort = env.SIGNAL_WEBHOOK_PORT || 3001;

  try {
    await server.listen({ port: webhookPort, host: "0.0.0.0" });
    console.log(`✅ Signal webhook server listening on port ${webhookPort}`);
    console.log("");
    console.log("📱 Signal Bot is ready!");
    console.log("");
    console.log("To interact with the bot:");
    console.log("  1. Send a message to your Signal phone number");
    console.log("  2. The bot will respond using AI");
    console.log("");
    console.log("Webhook URL: http://your-server:3001/webhook/signal");
    console.log("");
    console.log("Press Ctrl+C to stop");

    // Set up message polling (as backup/fallback)
    console.log("[SignalBot] Starting message polling...");
    startMessagePolling(bot);
  } catch (error) {
    console.error("❌ Failed to start webhook server:", error);
    process.exit(1);
  }
}

/**
 * Poll for new messages (fallback method)
 */
async function startMessagePolling(_bot: SignalAgentBot) {
  console.log("[SignalBot] Message polling active (fallback method)");

  // Poll every 30 seconds
  setInterval(async () => {
    try {
      // In a real implementation, this would check for new messages
      // using signal-cli or an HTTP bridge service
      console.log("[SignalBot] Polling for new messages...");
    } catch (error) {
      console.error("[SignalBot] Polling error:", error);
    }
  }, 30000);
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down Signal bot...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n🛑 Shutting down Signal bot...");
  process.exit(0);
});

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
