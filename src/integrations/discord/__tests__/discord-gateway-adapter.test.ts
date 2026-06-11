import { describe, it, expect, beforeEach } from "vitest";
import { DiscordGatewayAdapter } from "../discord-gateway-adapter";
import type { IncomingMessage } from "../../gateway/platform-adapter";

describe("DiscordGatewayAdapter", () => {
  let adapter: DiscordGatewayAdapter;

  beforeEach(() => {
    adapter = new DiscordGatewayAdapter({ token: "test-token", clientId: "test-client-id" });
  });

  describe("constructor and platform", () => {
    it("exposes platform as discord", () => {
      expect(adapter.platform).toBe("discord");
    });

    it("is not connected before start", () => {
      expect(adapter.isConnected()).toBe(false);
    });
  });

  describe("send", () => {
    it("returns failure when client is not initialized", async () => {
      const result = await adapter.send("user-1", "Hello");
      expect(result.success).toBe(false);
      expect(result.platform).toBe("discord");
    });
  });

  describe("sendToChannel", () => {
    it("returns failure when client is not initialized", async () => {
      const result = await adapter.sendToChannel("channel-1", "Hello");
      expect(result.success).toBe(false);
      expect(result.platform).toBe("discord");
    });
  });

  describe("stop", () => {
    it("stops cleanly without start", async () => {
      await adapter.stop();
      expect(adapter.isConnected()).toBe(false);
    });

    it("resolves waiting consumers on stop", async () => {
      const messages: IncomingMessage[] = [];
      const consumer = (async () => {
        for await (const msg of adapter.receive()) {
          messages.push(msg);
          break;
        }
      })();

      await adapter.stop();
      await consumer;
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("");
    });
  });

  describe("start", () => {
    it("skips start when no token", async () => {
      const noToken = new DiscordGatewayAdapter({ token: "", clientId: "" });
      await noToken.start();
      expect(noToken.isConnected()).toBe(false);
    });

    it("handles connection failure gracefully", async () => {
      // The adapter will try to import discord.js and login with invalid token
      await adapter.start();
      expect(adapter.isConnected()).toBe(false);
    });
  });

  describe("receive", () => {
    it("yields queued messages", async () => {
      const messages: IncomingMessage[] = [];
      const consumer = (async () => {
        for await (const msg of adapter.receive()) {
          messages.push(msg);
        }
      })();

      await adapter.stop();
      await consumer;
      expect(messages).toHaveLength(1);
    });

    it("stops yielding after stop is called", async () => {
      let yieldCount = 0;
      const consumer = (async () => {
        for await (const _msg of adapter.receive()) {
          yieldCount++;
        }
      })();

      await adapter.stop();
      await consumer;
      expect(yieldCount).toBe(1); // Only the sentinel
    });
  });

  describe("with allowedUserId", () => {
    it("accepts allowedUserId in config", () => {
      const restricted = new DiscordGatewayAdapter({
        token: "test",
        clientId: "test",
        allowedUserId: "12345",
      });
      expect(restricted.platform).toBe("discord");
    });
  });
});
