import { describe, it, expect, vi } from "vitest";
import type { PlatformAdapter, DeliveryOptions, DeliveryResult, IncomingMessage } from "../../../../src/integrations/gateway/platform-adapter";
import { TelegramAdapter } from "../../../../src/integrations/gateway/telegram-adapter";
import { SlackAdapter } from "../../../../src/integrations/gateway/slack-adapter";
import { DiscordGatewayAdapter } from "../../../../src/integrations/discord/discord-gateway-adapter";
import { WhatsAppAdapter } from "../../../../src/integrations/gateway/whatsapp-adapter";

describe("Platform adapter interfaces", () => {
  it("TelegramAdapter has correct platform name", () => {
    const adapter = new TelegramAdapter({ token: "test" });
    expect(adapter.platform).toBe("telegram");
  });

  it("SlackAdapter has correct platform name", () => {
    const adapter = new SlackAdapter({ botToken: "test", appToken: "test" });
    expect(adapter.platform).toBe("slack");
  });

  it("DiscordGatewayAdapter has correct platform name", () => {
    const adapter = new DiscordGatewayAdapter({ token: "test", clientId: "test" });
    expect(adapter.platform).toBe("discord");
  });

  it("WhatsAppAdapter has correct platform name", () => {
    const adapter = new WhatsAppAdapter({ signalPhoneNumber: "test", signalDataPath: "/tmp" });
    expect(adapter.platform).toBe("whatsapp");
  });
});

describe("TelegramAdapter", () => {
  it("reports not connected when not started", () => {
    const adapter = new TelegramAdapter({ token: "test" });
    expect(adapter.isConnected()).toBe(false);
  });

  it("returns failure on send when not connected", async () => {
    const adapter = new TelegramAdapter({ token: "test" });
    const result = await adapter.send("user1", "Hello");
    expect(result.success).toBe(false);
    expect(result.platform).toBe("telegram");
  });

  it("skips start when no token", async () => {
    const adapter = new TelegramAdapter({ token: "" });
    await adapter.start();
    expect(adapter.isConnected()).toBe(false);
  });
});

describe("SlackAdapter", () => {
  it("reports not connected when not started", () => {
    const adapter = new SlackAdapter({ botToken: "test", appToken: "test" });
    expect(adapter.isConnected()).toBe(false);
  });

  it("returns failure on send when not connected", async () => {
    const adapter = new SlackAdapter({ botToken: "test", appToken: "test" });
    const result = await adapter.send("user1", "Hello");
    expect(result.success).toBe(false);
    expect(result.platform).toBe("slack");
  });

  it("skips start when no tokens", async () => {
    const adapter = new SlackAdapter({ botToken: "", appToken: "" });
    await adapter.start();
    expect(adapter.isConnected()).toBe(false);
  });
});

describe("DiscordGatewayAdapter", () => {
  it("reports not connected when not started", () => {
    const adapter = new DiscordGatewayAdapter({ token: "test", clientId: "test" });
    expect(adapter.isConnected()).toBe(false);
  });

  it("returns failure on send when not connected", async () => {
    const adapter = new DiscordGatewayAdapter({ token: "test", clientId: "test" });
    const result = await adapter.send("user1", "Hello");
    expect(result.success).toBe(false);
    expect(result.platform).toBe("discord");
  });

  it("skips start when no token", async () => {
    const adapter = new DiscordGatewayAdapter({ token: "", clientId: "" });
    await adapter.start();
    expect(adapter.isConnected()).toBe(false);
  });
});

describe("WhatsAppAdapter", () => {
  it("reports not connected when not started", () => {
    const adapter = new WhatsAppAdapter({ signalPhoneNumber: "test", signalDataPath: "/tmp" });
    expect(adapter.isConnected()).toBe(false);
  });

  it("skips start when no signal phone number", async () => {
    const adapter = new WhatsAppAdapter({ signalPhoneNumber: "", signalDataPath: "/tmp" });
    await adapter.start();
    expect(adapter.isConnected()).toBe(false);
  });

  it("starts when signal phone number is provided", async () => {
    const adapter = new WhatsAppAdapter({ signalPhoneNumber: "+1234567890", signalDataPath: "/tmp" });
    await adapter.start();
    expect(adapter.isConnected()).toBe(true);
  });

  it("can inject messages from external bridge", () => {
    const adapter = new WhatsAppAdapter({ signalPhoneNumber: "+1234567890", signalDataPath: "/tmp" });
    const messages: IncomingMessage[] = [];

    // Start consuming in background
    const consumer = (async () => {
      for await (const msg of adapter.receive()) {
        messages.push(msg);
        break; // One message is enough for the test
      }
    })();

    adapter.injectMessage({
      platform: "whatsapp",
      userId: "user1",
      channelId: "ch1",
      content: "Hello from bridge",
      timestamp: new Date().toISOString(),
    });

    return consumer.then(() => {
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Hello from bridge");
      expect(messages[0].platform).toBe("whatsapp");
    });
  });
});

describe("DeliveryOptions and DeliveryResult shapes", () => {
  it("DeliveryOptions has expected optional fields", () => {
    const opts: DeliveryOptions = {
      parseMode: "markdown",
      silent: false,
      replyToMessageId: "123",
    };
    expect(opts.parseMode).toBe("markdown");
    expect(opts.silent).toBe(false);
    expect(opts.replyToMessageId).toBe("123");
  });

  it("DeliveryResult has expected fields", () => {
    const result: DeliveryResult = {
      success: true,
      messageId: "msg-123",
      platform: "telegram",
      timestamp: new Date().toISOString(),
      suppressed: false,
    };
    expect(result.success).toBe(true);
    expect(result.suppressed).toBe(false);
  });

  it("IncomingMessage has expected fields", () => {
    const msg: IncomingMessage = {
      platform: "discord",
      userId: "user1",
      channelId: "ch1",
      content: "Hello",
      timestamp: new Date().toISOString(),
      metadata: { username: "testuser" },
    };
    expect(msg.platform).toBe("discord");
    expect(msg.metadata?.username).toBe("testuser");
  });
});
