import { describe, it, expect, vi } from "vitest";

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("../../../src/config/env", () => ({
  env: {
    VAPID_PUBLIC_KEY: "",
    VAPID_PRIVATE_KEY: "",
    VAPID_ADMIN_EMAIL: "mailto:test@test.com",
    VAPID_SUBJECT: "",
  },
}));

import { sendPushNotification, initPushDispatcher } from "../../../src/push/dispatcher";

const mockSubscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint",
  keys: { p256dh: "test-key", auth: "test-auth" },
};

describe("PushDispatcher", () => {
  it("should return false when dispatcher not initialized", async () => {
    const result = await sendPushNotification(mockSubscription as any, {
      title: "Test",
      body: "Test body",
      url: "/",
    });
    expect(result).toBe(false);
  });

  it("should send notification when initialized", async () => {
    const { env } = await import("../../../src/config/env");
    (env as any).VAPID_PUBLIC_KEY = "test-public-key";
    (env as any).VAPID_PRIVATE_KEY = "test-private-key";

    initPushDispatcher();

    const result = await sendPushNotification(mockSubscription as any, {
      title: "Test Alert",
      body: "Something happened",
      url: "/cases/123",
      severity: "page",
      urgency: "high",
    });

    expect(result).toBe(true);
  });
});
