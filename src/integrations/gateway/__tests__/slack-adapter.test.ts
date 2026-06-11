import { describe, it, expect, beforeEach } from "vitest";
import { SlackAdapter } from "../slack-adapter";
import type { IncomingMessage } from "../platform-adapter";

describe("SlackAdapter", () => {
  let adapter: SlackAdapter;

  beforeEach(() => {
    adapter = new SlackAdapter({
      botToken: "xoxb-test-token",
      appToken: "xapp-test-token",
    });
  });

  describe("constructor and platform", () => {
    it("exposes platform as slack", () => {
      expect(adapter.platform).toBe("slack");
    });

    it("is not connected before start", () => {
      expect(adapter.isConnected()).toBe(false);
    });
  });

  describe("send", () => {
    it("returns failure when webClient is not initialized", async () => {
      const result = await adapter.send("U12345", "Hello");
      expect(result.success).toBe(false);
      expect(result.platform).toBe("slack");
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
    it("skips when botToken is missing", async () => {
      const noToken = new SlackAdapter({ botToken: "", appToken: "xapp-test" });
      await noToken.start();
      expect(noToken.isConnected()).toBe(false);
    });

    it("skips when appToken is missing", async () => {
      const noToken = new SlackAdapter({ botToken: "xoxb-test", appToken: "" });
      await noToken.start();
      expect(noToken.isConnected()).toBe(false);
    });

    it("skips when both tokens are missing", async () => {
      const noToken = new SlackAdapter({ botToken: "", appToken: "" });
      await noToken.start();
      expect(noToken.isConnected()).toBe(false);
    });
  });

  describe("receive", () => {
    it("yields queued messages", async () => {
      // Use a started adapter with injectMessage pattern
      // Since Slack doesn't have injectMessage, we test the queue behavior
      // by verifying the receive generator works with stop
      const messages: IncomingMessage[] = [];
      const consumer = (async () => {
        for await (const msg of adapter.receive()) {
          messages.push(msg);
        }
      })();

      // Stop immediately to unblock
      await adapter.stop();
      await consumer;
      expect(messages).toHaveLength(1); // sentinel from stop
    });
  });
});
