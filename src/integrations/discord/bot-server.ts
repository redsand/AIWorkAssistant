#!/usr/bin/env tsx
/**
 * Discord Bot Server
 * Runs the Discord bot integration
 */

import { DiscordAgentBot } from "./discord-bot";
import { loadEnv } from "../../config/env";
import { getApiKeyForAuth } from "../../middleware/auth";

async function main() {
  console.log("🤖 Starting AI Assistant Discord Bot...");

  // Load environment variables
  const env = loadEnv();

  // Validate Discord configuration
  if (!env.DISCORD_BOT_TOKEN) {
    console.error("❌ DISCORD_BOT_TOKEN environment variable is required");
    console.error(
      "Get your bot token from: https://discord.com/developers/applications",
    );
    process.exit(1);
  }

  if (!env.DISCORD_CLIENT_ID) {
    console.error("❌ DISCORD_CLIENT_ID environment variable is required");
    console.error(
      "Get your client ID from: https://discord.com/developers/applications",
    );
    process.exit(1);
  }

  // Create and start bot
  const bot = new DiscordAgentBot({
    token: env.DISCORD_BOT_TOKEN,
    clientId: env.DISCORD_CLIENT_ID,
    guildId: env.DISCORD_GUILD_ID,
    allowedUserId: env.DISCORD_ALLOWED_USER_ID || undefined,
    apiKey: getApiKeyForAuth() || undefined,
  });

  try {
    await bot.start();
    console.log("✅ Discord bot is running! Press Ctrl+C to stop.");

    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      console.log("\n🛑 Shutting down Discord bot...");
      await bot.stop();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      console.log("\n🛑 Shutting down Discord bot...");
      await bot.stop();
      process.exit(0);
    });
  } catch (error) {
    console.error("❌ Failed to start Discord bot:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
