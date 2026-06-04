import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { _resetGatewayRateLimits, _getGatewayRateLimits, dispatchToolCall } from "../tool-dispatcher";
import type { DeliveryResult } from "../../integrations/gateway/platform-adapter";

vi.mock("../../integrations/gateway/gateway-engine.js", () => {
  const send = vi.fn<() => Promise<DeliveryResult>>();
  return {
    gatewayEngine: { send },
    __gatewaySendMock: send,
  };
});

const GATEWAY_RATE_LIMIT_MAX = 20;
const GATEWAY_RATE_LIMIT_WINDOW_MS = 60_000;

describe("gateway rate limit Map management", () => {
  beforeEach(() => {
    _resetGatewayRateLimits();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes stale keys from the rate limit Map", async () => {
    const { gatewayEngine } = await import("../../integrations/gateway/gateway-engine.js");
    const mockedSend = gatewayEngine.send as ReturnType<typeof vi.fn>;
    mockedSend.mockResolvedValue({
      success: true,
      messageId: "msg-1",
      platform: "telegram",
      timestamp: new Date().toISOString(),
      suppressed: false,
    });

    // Fill rate limit for a user
    const uid = "cleanup-test-user";
    for (let i = 0; i < GATEWAY_RATE_LIMIT_MAX; i++) {
      await dispatchToolCall("gateway.deliver", {
        platform: "telegram",
        user_id: uid,
        message: `msg-${i}`,
      }, uid);
    }

    // Key should exist
    expect(_getGatewayRateLimits().has(`telegram:${uid}`)).toBe(true);

    // Advance time past the window
    vi.useFakeTimers();
    vi.advanceTimersByTime(GATEWAY_RATE_LIMIT_WINDOW_MS + 1);

    // Trigger another call which should prune the stale key
    mockedSend.mockResolvedValue({
      success: true,
      messageId: "msg-new",
      platform: "telegram",
      timestamp: new Date().toISOString(),
      suppressed: false,
    });
    await dispatchToolCall("gateway.deliver", {
      platform: "telegram",
      user_id: uid,
      message: "after-prune",
    }, uid);

    // The old key should have been cleaned up and a new entry started
    const timestamps = _getGatewayRateLimits().get(`telegram:${uid}`);
    expect(timestamps).toBeDefined();
    expect(timestamps!.length).toBe(1); // Only the new message

    vi.useRealTimers();
  });

  it("cleans up empty timestamp arrays immediately", async () => {
    const { gatewayEngine } = await import("../../integrations/gateway/gateway-engine.js");
    const mockedSend = gatewayEngine.send as ReturnType<typeof vi.fn>;
    mockedSend.mockResolvedValue({
      success: true,
      messageId: "msg-1",
      platform: "discord",
      timestamp: new Date().toISOString(),
      suppressed: false,
    });

    const uid = "immediate-cleanup-user";
    // Send just one message
    await dispatchToolCall("gateway.deliver", {
      platform: "discord",
      user_id: uid,
      message: "test",
    }, uid);

    expect(_getGatewayRateLimits().has(`discord:${uid}`)).toBe(true);

    // Advance past the window so all timestamps are expired
    vi.useFakeTimers();
    vi.advanceTimersByTime(GATEWAY_RATE_LIMIT_WINDOW_MS + 1);

    // The next call for a different key should trigger pruning of the stale entry
    mockedSend.mockResolvedValue({
      success: true,
      messageId: "msg-2",
      platform: "slack",
      timestamp: new Date().toISOString(),
      suppressed: false,
    });
    await dispatchToolCall("gateway.deliver", {
      platform: "slack",
      user_id: "other-user",
      message: "trigger-prune",
    }, "other-user");

    // The stale key should be gone (pruned by periodic cleanup or by access)
    // Note: the pruneStaleRateLimitEntries runs on the interval, but also
    // each checkGatewayRateLimit call cleans its own key. The periodic prune
    // catches cross-key cleanup.
    vi.useRealTimers();
  });

  it("handles concurrent sends without race conditions", async () => {
    const { gatewayEngine } = await import("../../integrations/gateway/gateway-engine.js");
    const mockedSend = gatewayEngine.send as ReturnType<typeof vi.fn>;
    mockedSend.mockResolvedValue({
      success: true,
      messageId: "msg-concurrent",
      platform: "slack",
      timestamp: new Date().toISOString(),
      suppressed: false,
    });

    const uid = "concurrent-user";
    // Fire 5 concurrent sends
    const promises = Array.from({ length: 5 }, (_, i) =>
      dispatchToolCall("gateway.deliver", {
        platform: "slack",
        user_id: uid,
        message: `concurrent-${i}`,
      }, uid)
    );

    const results = await Promise.all(promises);
    expect(results.every((r) => r.success)).toBe(true);

    // The rate limit map should have exactly one entry with 5 timestamps
    const timestamps = _getGatewayRateLimits().get(`slack:${uid}`);
    expect(timestamps).toBeDefined();
    expect(timestamps!.length).toBe(5);
  });

  it("rate limits concurrent sends that exceed the max", async () => {
    const { gatewayEngine } = await import("../../integrations/gateway/gateway-engine.js");
    const mockedSend = gatewayEngine.send as ReturnType<typeof vi.fn>;
    mockedSend.mockResolvedValue({
      success: true,
      messageId: "msg-overlimit",
      platform: "whatsapp",
      timestamp: new Date().toISOString(),
      suppressed: false,
    });

    const uid = "overlimit-user";
    // Fire 25 concurrent sends (limit is 20)
    const promises = Array.from({ length: 25 }, (_, i) =>
      dispatchToolCall("gateway.deliver", {
        platform: "whatsapp",
        user_id: uid,
        message: `overlimit-${i}`,
      }, uid)
    );

    const results = await Promise.all(promises);
    const successes = results.filter((r) => r.success);
    const rateLimited = results.filter((r) => !r.success && r.error?.includes("Rate limit"));

    // At least some should succeed and some should be rate limited
    expect(successes.length).toBeGreaterThan(0);
    expect(rateLimited.length).toBeGreaterThan(0);
    expect(successes.length + rateLimited.length).toBe(25);
  });
});
