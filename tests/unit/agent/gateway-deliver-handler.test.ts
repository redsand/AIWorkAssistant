import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DeliveryResult } from "../../../src/integrations/gateway/platform-adapter";

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn<() => Promise<DeliveryResult>>(),
}));

vi.mock("../../../src/config/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/env")>();
  return {
    env: {
      ...actual.env,
      GATEWAY_ENABLED: true,
    },
    resolvePath: actual.resolvePath,
  };
});

vi.mock("../../../src/integrations/gateway/gateway-engine", () => ({
  gatewayEngine: {
    send: mockSend,
  },
}));

import { _resetGatewayRateLimits, dispatchToolCall } from "../../../src/agent/tool-dispatcher";

function successResult(overrides?: Partial<DeliveryResult>): DeliveryResult {
  return {
    success: true,
    messageId: "msg-001",
    platform: "telegram",
    timestamp: new Date().toISOString(),
    suppressed: false,
    ...overrides,
  };
}

describe("gateway.deliver tool handler", () => {
  beforeEach(() => {
    _resetGatewayRateLimits();
    mockSend.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delivers a message successfully", async () => {
    mockSend.mockResolvedValue(successResult());

    const result = await dispatchToolCall("gateway.deliver", {
      platform: "telegram",
      user_id: "user123",
      message: "Hello from the gateway!",
    }, "user123");

    expect(result.success).toBe(true);
    expect(result.message).toContain("Message delivered");
    expect(result.message).toContain("user123");
    expect(mockSend).toHaveBeenCalledWith("telegram", "user123", "Hello from the gateway!", { silent: undefined });
  });

  it("returns suppressed result for [SILENT] messages", async () => {
    mockSend.mockResolvedValue(successResult({ suppressed: true }));

    const result = await dispatchToolCall("gateway.deliver", {
      platform: "telegram",
      user_id: "user123",
      message: "Status [SILENT]",
    }, "user123");

    expect(result.success).toBe(true);
    expect(result.message).toContain("suppressed");
    expect(mockSend).toHaveBeenCalledWith("telegram", "user123", "Status [SILENT]", { silent: undefined });
  });

  it("returns error when platform is missing", async () => {
    const result = await dispatchToolCall("gateway.deliver", {
      user_id: "user123",
      message: "Hello",
    }, "user123");

    expect(result.success).toBe(false);
    expect(result.error).toContain("platform is required");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns error when user_id is missing", async () => {
    const result = await dispatchToolCall("gateway.deliver", {
      platform: "telegram",
      message: "Hello",
    }, "user123");

    expect(result.success).toBe(false);
    expect(result.error).toContain("user_id is required");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns error when message is missing", async () => {
    const result = await dispatchToolCall("gateway.deliver", {
      platform: "telegram",
      user_id: "user123",
    }, "user123");

    expect(result.success).toBe(false);
    expect(result.error).toContain("message is required");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns error for invalid platform", async () => {
    const result = await dispatchToolCall("gateway.deliver", {
      platform: "invalid_platform",
      user_id: "user123",
      message: "Hello",
    }, "user123");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid platform");
    expect(result.error).toContain("invalid_platform");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("accepts all valid platforms", async () => {
    const platforms = ["telegram", "discord", "slack", "whatsapp"];

    for (const platform of platforms) {
      mockSend.mockResolvedValue(successResult({ platform }));

      const result = await dispatchToolCall("gateway.deliver", {
        platform,
        user_id: "user123",
        message: "Test",
      }, "user123");

      expect(result.success).toBe(true);
    }

    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  it("returns error when gateway engine send fails", async () => {
    mockSend.mockResolvedValue(successResult({ success: false }));

    const result = await dispatchToolCall("gateway.deliver", {
      platform: "telegram",
      user_id: "user123",
      message: "Hello",
    }, "user123");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to deliver");
  });

  it("returns error when gateway engine throws exception", async () => {
    mockSend.mockRejectedValue(new Error("Connection refused"));

    const result = await dispatchToolCall("gateway.deliver", {
      platform: "telegram",
      user_id: "user123",
      message: "Hello",
    }, "user123");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Gateway delivery failed");
    expect(result.error).toContain("Connection refused");
  });

  it("passes silent option to gateway engine", async () => {
    mockSend.mockResolvedValue(successResult({ suppressed: true }));

    const result = await dispatchToolCall("gateway.deliver", {
      platform: "telegram",
      user_id: "user123",
      message: "Quiet message",
      silent: true,
    }, "user123");

    expect(mockSend).toHaveBeenCalledWith("telegram", "user123", "Quiet message", { silent: true });
  });

  it("passes silent=undefined when not specified", async () => {
    mockSend.mockResolvedValue(successResult());

    await dispatchToolCall("gateway.deliver", {
      platform: "discord",
      user_id: "user456",
      message: "Normal message",
    }, "user456");

    expect(mockSend).toHaveBeenCalledWith("discord", "user456", "Normal message", { silent: undefined });
  });

  it("returns error when all params are empty strings", async () => {
    const result = await dispatchToolCall("gateway.deliver", {
      platform: "",
      user_id: "",
      message: "",
    }, "user123");

    expect(result.success).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("rejects when caller user_id does not match target user_id", async () => {
    const result = await dispatchToolCall("gateway.deliver", {
      platform: "telegram",
      user_id: "target-user",
      message: "Hello",
    }, "different-caller");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unauthorized");
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("gateway.deliver rate limiting", () => {
  beforeEach(() => {
    _resetGatewayRateLimits();
    mockSend.mockReset();
    mockSend.mockResolvedValue(successResult());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows messages within rate limit", async () => {
    const result = await dispatchToolCall("gateway.deliver", {
      platform: "telegram",
      user_id: "rl-user1",
      message: "Hello",
    }, "rl-user1");

    expect(result.success).toBe(true);
  });

  it("rejects messages when rate limit exceeded for a specific user", async () => {
    // Send 20 messages to hit the limit
    for (let i = 0; i < 20; i++) {
      await dispatchToolCall("gateway.deliver", {
        platform: "slack",
        user_id: "rl-user2",
        message: `Message ${i}`,
      }, "rl-user2");
    }

    // 21st should be rate limited
    const result = await dispatchToolCall("gateway.deliver", {
      platform: "slack",
      user_id: "rl-user2",
      message: "One too many",
    }, "rl-user2");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Rate limit");
  });

  it("rate limits per platform:userId independently", async () => {
    // Fill up telegram:rl-user3 limit
    for (let i = 0; i < 20; i++) {
      await dispatchToolCall("gateway.deliver", {
        platform: "telegram",
        user_id: "rl-user3",
        message: `Msg ${i}`,
      }, "rl-user3");
    }

    // telegram:rl-user3 should be rate limited
    const telegramResult = await dispatchToolCall("gateway.deliver", {
      platform: "telegram",
      user_id: "rl-user3",
      message: "Over limit",
    }, "rl-user3");
    expect(telegramResult.success).toBe(false);
    expect(telegramResult.error).toContain("Rate limit");

    // discord:rl-user3 should still work (different platform:userId key)
    const discordResult = await dispatchToolCall("gateway.deliver", {
      platform: "discord",
      user_id: "rl-user3",
      message: "Still works",
    }, "rl-user3");
    expect(discordResult.success).toBe(true);

    // telegram:rl-user4 should still work (different platform:userId key)
    const otherUserResult = await dispatchToolCall("gateway.deliver", {
      platform: "telegram",
      user_id: "rl-user4",
      message: "Different user works",
    }, "rl-user4");
    expect(otherUserResult.success).toBe(true);
  });
});
