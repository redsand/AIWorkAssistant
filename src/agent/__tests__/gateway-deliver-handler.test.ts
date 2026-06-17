import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/env", () => ({
  env: new Proxy({}, { get: (_: object, prop: string | symbol) => {
    if (prop === "GATEWAY_ENABLED") return true;
    return "";
  }}),
  resolvePath: (rel: string) => rel,
}));

vi.mock("../../integrations/gateway/gateway-engine", () => {
  const send = vi.fn();
  return {
    gatewayEngine: { send },
    __gatewaySendMock: send,
  };
});

import { dispatchToolCall } from "../tool-dispatcher";
import { gatewayEngine } from "../../integrations/gateway/gateway-engine";

const mockedSend = gatewayEngine.send as ReturnType<typeof vi.fn>;

function makeDeliveryResult(overrides: Partial<{ success: boolean; messageId?: string; suppressed: boolean; platform: string }>) {
  return {
    success: overrides.success ?? true,
    messageId: overrides.messageId ?? "msg-1",
    platform: overrides.platform ?? "telegram",
    timestamp: new Date().toISOString(),
    suppressed: overrides.suppressed ?? false,
  };
}

describe("handleGatewayDeliver via dispatchToolCall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSend.mockResolvedValue(makeDeliveryResult({ success: true }));
  });

  it("requires platform param", async () => {
    const result = await dispatchToolCall("gateway.deliver", {
      user_id: "user-1",
      message: "Hello",
    }, "user-1");
    expect(result.success).toBe(false);
    expect(result.error).toContain("platform is required");
  });

  it("requires user_id param", async () => {
    const result = await dispatchToolCall("gateway.deliver", {
      platform: "telegram",
      message: "Hello",
    }, "user-1");
    expect(result.success).toBe(false);
    expect(result.error).toContain("user_id is required");
  });

  it("requires message param", async () => {
    const result = await dispatchToolCall("gateway.deliver", {
      platform: "telegram",
      user_id: "user-1",
    }, "user-1");
    expect(result.success).toBe(false);
    expect(result.error).toContain("message is required");
  });

  it("rejects invalid platform", async () => {
    const result = await dispatchToolCall("gateway.deliver", {
      platform: "irc",
      user_id: "user-1",
      message: "Hello",
    }, "user-1");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid platform");
  });

  it("rejects when caller is not the target user (authorization)", async () => {
    const result = await dispatchToolCall("gateway.deliver", {
      platform: "telegram",
      user_id: "victim-user",
      message: "Hello",
    }, "attacker-user");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unauthorized");
  });

  it("allows when caller matches target user", async () => {
    const result = await dispatchToolCall("gateway.deliver", {
      platform: "telegram",
      user_id: "valid-caller",
      message: "Hello",
    }, "valid-caller");
    expect(result.success).toBe(true);
    expect(mockedSend).toHaveBeenCalledWith("telegram", "valid-caller", "Hello", { silent: undefined });
  });

  it("returns suppressed message for [SILENT] content", async () => {
    mockedSend.mockResolvedValue(makeDeliveryResult({ success: true, suppressed: true }));

    const result = await dispatchToolCall("gateway.deliver", {
      platform: "telegram",
      user_id: "silent-user",
      message: "Hidden [SILENT]",
    }, "silent-user");
    expect(result.success).toBe(true);
    expect(result.message).toContain("suppressed");
  });

  it("returns failure when adapter fails", async () => {
    mockedSend.mockResolvedValue(makeDeliveryResult({ success: false }));

    const result = await dispatchToolCall("gateway.deliver", {
      platform: "slack",
      user_id: "fail-user",
      message: "Hello",
    }, "fail-user");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to deliver");
  });

  it("handles gateway engine exceptions", async () => {
    mockedSend.mockRejectedValue(new Error("engine crash"));

    const result = await dispatchToolCall("gateway.deliver", {
      platform: "whatsapp",
      user_id: "crash-user",
      message: "Hello",
    }, "crash-user");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Gateway delivery failed");
  });

  // Rate limit tests — use unique users and run last since module state persists
  it("enforces per-user rate limiting", async () => {
    const RATE_LIMIT = 20; // matches GATEWAY_RATE_LIMIT_MAX
    const uid = "ratelimit-test-user";
    for (let i = 0; i < RATE_LIMIT; i++) {
      await dispatchToolCall("gateway.deliver", {
        platform: "telegram",
        user_id: uid,
        message: `msg-${i}`,
      }, uid);
    }

    const result = await dispatchToolCall("gateway.deliver", {
      platform: "telegram",
      user_id: uid,
      message: "one more",
    }, uid);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Rate limit exceeded");
  });

  it("does not rate-limit different users independently", async () => {
    const RATE_LIMIT = 20;
    const uidA = "ratelimit-user-a";
    for (let i = 0; i < RATE_LIMIT; i++) {
      await dispatchToolCall("gateway.deliver", {
        platform: "slack",
        user_id: uidA,
        message: `msg-${i}`,
      }, uidA);
    }

    // user-a is rate-limited
    const resultA = await dispatchToolCall("gateway.deliver", {
      platform: "slack",
      user_id: uidA,
      message: "blocked",
    }, uidA);
    expect(resultA.success).toBe(false);
    expect(resultA.error).toContain("Rate limit exceeded");

    // user-b is NOT rate-limited
    const uidB = "ratelimit-user-b";
    const resultB = await dispatchToolCall("gateway.deliver", {
      platform: "slack",
      user_id: uidB,
      message: "allowed",
    }, uidB);
    expect(resultB.success).toBe(true);
  });

  it("rejects non-string platform param", async () => {
    const result = await dispatchToolCall("gateway.deliver", {
      platform: 123,
      user_id: "user-1",
      message: "Hello",
    }, "user-1");
    expect(result.success).toBe(false);
    expect(result.error).toContain("platform is required");
  });

  it("rejects non-string user_id param", async () => {
    const result = await dispatchToolCall("gateway.deliver", {
      platform: "telegram",
      user_id: 999,
      message: "Hello",
    }, "user-1");
    expect(result.success).toBe(false);
    expect(result.error).toContain("user_id is required");
  });

  it("passes silent param through to engine", async () => {
    const result = await dispatchToolCall("gateway.deliver", {
      platform: "telegram",
      user_id: "silent-param-user",
      message: "Hello",
      silent: true,
    }, "silent-param-user");
    expect(result.success).toBe(true);
    expect(mockedSend).toHaveBeenCalledWith("telegram", "silent-param-user", "Hello", { silent: true });
  });
});
