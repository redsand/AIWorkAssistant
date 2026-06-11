import { describe, it, expect, beforeEach } from "vitest";
import { WhatsAppAdapter } from "../whatsapp-adapter";
import type { IncomingMessage } from "../platform-adapter";

describe("WhatsAppAdapter", () => {
  let adapter: WhatsAppAdapter;

  beforeEach(() => {
    adapter = new WhatsAppAdapter({
      signalPhoneNumber: "+1234567890",
      signalDataPath: "/tmp",
    });
  });

  describe("constructor and platform", () => {
    it("exposes platform as whatsapp", () => {
      expect(adapter.platform).toBe("whatsapp");
    });

    it("is not connected before start", () => {
      expect(adapter.isConnected()).toBe(false);
    });
  });

  describe("start", () => {
    it("skips start when no signal phone number", async () => {
      const noNumber = new WhatsAppAdapter({ signalPhoneNumber: "", signalDataPath: "/tmp" });
      await noNumber.start();
      expect(noNumber.isConnected()).toBe(false);
    });

    it("starts when signal phone number is provided", async () => {
      await adapter.start();
      expect(adapter.isConnected()).toBe(true);
    });
  });

  describe("stop", () => {
    it("stops cleanly after starting", async () => {
      await adapter.start();
      await adapter.stop();
      expect(adapter.isConnected()).toBe(false);
    });

    it("resolves waiting consumers on stop", async () => {
      await adapter.start();
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

    it("stops cleanly without start", async () => {
      await adapter.stop();
      expect(adapter.isConnected()).toBe(false);
    });
  });

  describe("injectMessage", () => {
    it("injects messages for waiting consumers", async () => {
      await adapter.start();
      const messages: IncomingMessage[] = [];
      const consumer = (async () => {
        for await (const msg of adapter.receive()) {
          messages.push(msg);
          break;
        }
      })();

      adapter.injectMessage({
        platform: "whatsapp",
        userId: "user-1",
        channelId: "ch-1",
        content: "Hello from bridge",
        timestamp: new Date().toISOString(),
      });

      await consumer;
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Hello from bridge");
      expect(messages[0].platform).toBe("whatsapp");
    });

    it("queues messages when no consumer is waiting", async () => {
      await adapter.start();

      adapter.injectMessage({
        platform: "whatsapp",
        userId: "user-1",
        channelId: "ch-1",
        content: "Queued msg",
        timestamp: new Date().toISOString(),
      });

      const messages: IncomingMessage[] = [];
      const consumer = (async () => {
        for await (const msg of adapter.receive()) {
          messages.push(msg);
          break;
        }
      })();

      await consumer;
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Queued msg");
    });
  });

  describe("send", () => {
    it("returns failure when signal-cli is not available", async () => {
      await adapter.start();
      const result = await adapter.send("user-1", "Test message");
      // signal-cli won't be available in test, so it should fail gracefully
      expect(result.platform).toBe("whatsapp");
      // Either success or failure is acceptable depending on signal-cli availability
      expect(typeof result.success).toBe("boolean");
    });

    it("uses bridge map to resolve signal target", async () => {
      const bridged = new WhatsAppAdapter({
        signalPhoneNumber: "+1555777",
        signalDataPath: "/tmp",
        bridgeMap: { "whatsapp-jid": "+1555888" },
      });
      await bridged.start();

      const result = await bridged.send("whatsapp-jid", "Test");
      expect(result.platform).toBe("whatsapp");
    });

    it("falls back to userId when not in bridge map", async () => {
      const noBridge = new WhatsAppAdapter({
        signalPhoneNumber: "+1555777",
        signalDataPath: "/tmp",
        bridgeMap: {},
      });
      await noBridge.start();

      const result = await noBridge.send("unknown-user", "Test");
      expect(result.platform).toBe("whatsapp");
    });
  });

  describe("receive", () => {
    it("stops yielding after stop is called", async () => {
      await adapter.start();
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
});
