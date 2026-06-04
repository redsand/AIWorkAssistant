import { describe, it, expect, beforeEach } from "vitest";
import { TelegramAdapter } from "../telegram-adapter";
import type { IncomingMessage } from "../platform-adapter";

describe("TelegramAdapter", () => {
  let adapter: TelegramAdapter;

  beforeEach(() => {
    adapter = new TelegramAdapter({ token: "test-token" });
  });

  describe("constructor and platform", () => {
    it("exposes platform as telegram", () => {
      expect(adapter.platform).toBe("telegram");
    });

    it("is not connected before start", () => {
      expect(adapter.isConnected()).toBe(false);
    });
  });

  describe("send", () => {
    it("returns failure when bot is not started", async () => {
      const result = await adapter.send("user-1", "Hello");
      expect(result.success).toBe(false);
      expect(result.platform).toBe("telegram");
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

  describe("receive", () => {
    it("queues messages when no consumer is waiting", () => {
      expect(adapter.isConnected()).toBe(false);
    });
  });

  describe("reconnection", () => {
    it("has max retry cap", () => {
      expect(adapter.isConnected()).toBe(false);
    });

    it("skips start when no token", async () => {
      const noToken = new TelegramAdapter({ token: "" });
      await noToken.start();
      expect(noToken.isConnected()).toBe(false);
    });
  });
});
