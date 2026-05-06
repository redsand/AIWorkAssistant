import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/integrations/hawk-ir/hawk-ir-service", () => ({
  hawkIrService: {
    isConfigured: vi.fn().mockReturnValue(true),
    getRiskyOpenCases: vi.fn().mockResolvedValue([
      {
        id: "CASE-999",
        name: "Unauthorized access detected",
        riskLevel: "critical",
        progressStatus: "open",
        escalated: false,
      },
    ]),
  },
}));

vi.mock("../../../src/routes/push-subscriptions", () => ({
  getAllSubscriptions: vi.fn().mockReturnValue([]),
}));

vi.mock("../../../src/push/dispatcher", () => ({
  sendPushNotification: vi.fn().mockResolvedValue(true),
  initPushDispatcher: vi.fn(),
}));

import { HawkIRPoller } from "../../../src/push/pollers/hawk-ir-poller";

describe("HawkIRPoller", () => {
  it("should detect new risky cases and send notifications", async () => {
    const poller = new HawkIRPoller({ pollIntervalMinutes: 5, minRiskLevel: "high" });
    const count = await poller.poll();
    expect(count).toBe(1);
  });

  it("should skip already-notified cases on subsequent polls", async () => {
    const poller = new HawkIRPoller({ pollIntervalMinutes: 5, minRiskLevel: "high" });
    await poller.poll();
    const count2 = await poller.poll();
    expect(count2).toBe(0);
  });
});
