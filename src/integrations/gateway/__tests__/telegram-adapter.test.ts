import { describe, it, expect, vi, beforeEach } from "vitest";
import { TelegramAdapter } from "../telegram-adapter";

function createMockBot() {
  const handlers: Record<string, Function[]> = {};
  const bot = {
    on: vi.fn((event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    onText: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
    stopPolling: vi.fn().mockResolvedValue(undefined),
    _handlers: handlers,
  };
  return bot;
}

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
  });
});
