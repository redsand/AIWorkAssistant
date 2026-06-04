import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlackAdapter } from "../slack-adapter";

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
  });
});
