import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────────

const { mockCleanup, mockEnv, MockHawkIRPoller, MockJitbitPoller, MockEscalationEngine } = vi.hoisted(() => {
  const HawkIRPoller = vi.fn(function (this: any, _opts: any) {
    this.start = vi.fn();
    this.stop = vi.fn();
  });
  const JitbitPoller = vi.fn(function (this: any, _opts: any) {
    this.start = vi.fn();
    this.stop = vi.fn();
  });
  const EscalationEngine = vi.fn(function (this: any) {
    this.start = vi.fn();
    this.stop = vi.fn();
  });
  return {
    mockCleanup: vi.fn().mockResolvedValue(0),
    mockEnv: {} as Record<string, any>,
    MockHawkIRPoller: HawkIRPoller,
    MockJitbitPoller: JitbitPoller,
    MockEscalationEngine: EscalationEngine,
  };
});

vi.mock("../../../src/push/pollers/hawk-ir-poller", () => ({
  HawkIRPoller: MockHawkIRPoller,
}));

vi.mock("../../../src/push/pollers/jitbit-poller", () => ({
  JitbitPoller: MockJitbitPoller,
}));

vi.mock("../../../src/push/escalation/engine", () => ({
  EscalationEngine: MockEscalationEngine,
}));

vi.mock("../../../src/push/notification-store", () => ({
  notificationStore: {
    cleanup: mockCleanup,
  },
}));

vi.mock("../../../src/config/env", () => ({
  get env() {
    return mockEnv;
  },
}));

// Import after mocks are set up
import { startPollingEngine, stopPollingEngine } from "../../../src/push/polling-engine";

describe("Polling Engine", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockEnv.VAPID_PUBLIC_KEY = "test-key";
    mockEnv.PUSH_POLL_INTERVAL_MIN = 5;
    mockEnv.HAWK_IR_ENABLED = false;
    mockEnv.JITBIT_ENABLED = false;
    mockCleanup.mockResolvedValue(0);
    vi.clearAllMocks();
    // Re-set defaults after clear
    mockEnv.VAPID_PUBLIC_KEY = "test-key";
    mockEnv.PUSH_POLL_INTERVAL_MIN = 5;
    mockEnv.HAWK_IR_ENABLED = false;
    mockEnv.JITBIT_ENABLED = false;
    mockCleanup.mockResolvedValue(0);
  });

  afterEach(() => {
    stopPollingEngine();
    vi.restoreAllMocks();
  });

  // ── startPollingEngine ────────────────────────────────────────────────────────

  describe("startPollingEngine", () => {
    it("does nothing when VAPID_PUBLIC_KEY is not set", () => {
      mockEnv.VAPID_PUBLIC_KEY = "";
      startPollingEngine();
      expect(console.log).toHaveBeenCalledWith(
        "[Polling Engine] Push notifications not configured — polling disabled",
      );
    });

    it("does nothing when VAPID_PUBLIC_KEY is undefined", () => {
      mockEnv.VAPID_PUBLIC_KEY = undefined;
      startPollingEngine();
      expect(console.log).toHaveBeenCalledWith(
        "[Polling Engine] Push notifications not configured — polling disabled",
      );
    });

    it("starts HawkIR poller when HAWK_IR_ENABLED is true", () => {
      mockEnv.HAWK_IR_ENABLED = true;
      startPollingEngine();

      expect(MockHawkIRPoller).toHaveBeenCalledWith({
        pollIntervalMinutes: 5,
        minRiskLevel: "high",
      });
      const instance = MockHawkIRPoller.mock.results[0].value;
      expect(instance.start).toHaveBeenCalled();
    });

    it("skips HawkIR poller when HAWK_IR_ENABLED is false", () => {
      mockEnv.HAWK_IR_ENABLED = false;
      startPollingEngine();
      expect(MockHawkIRPoller).not.toHaveBeenCalled();
    });

    it("starts Jitbit poller when JITBIT_ENABLED is true", () => {
      mockEnv.JITBIT_ENABLED = true;
      startPollingEngine();

      expect(MockJitbitPoller).toHaveBeenCalledWith({
        pollIntervalMinutes: 5,
      });
      const instance = MockJitbitPoller.mock.results[0].value;
      expect(instance.start).toHaveBeenCalled();
    });

    it("skips Jitbit poller when JITBIT_ENABLED is false", () => {
      mockEnv.JITBIT_ENABLED = false;
      startPollingEngine();
      expect(MockJitbitPoller).not.toHaveBeenCalled();
    });

    it("always starts the escalation engine", () => {
      startPollingEngine();

      expect(MockEscalationEngine).toHaveBeenCalled();
      const instance = MockEscalationEngine.mock.results[0].value;
      expect(instance.start).toHaveBeenCalled();
    });

    it("logs 'Started' on successful startup", () => {
      startPollingEngine();
      expect(console.log).toHaveBeenCalledWith("[Polling Engine] Started");
    });

    it("sets up a cleanup interval that calls notificationStore.cleanup", async () => {
      vi.useFakeTimers();
      mockCleanup.mockResolvedValue(3);

      startPollingEngine();

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

      expect(mockCleanup).toHaveBeenCalledWith(30);

      vi.useRealTimers();
    });

    it("logs cleanup count when notifications are removed", async () => {
      vi.useFakeTimers();
      mockCleanup.mockResolvedValue(5);

      startPollingEngine();

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

      expect(console.log).toHaveBeenCalledWith(
        "[Polling Engine] Cleaned up 5 old notifications",
      );

      vi.useRealTimers();
    });

    it("does not log cleanup count when no notifications are removed", async () => {
      vi.useFakeTimers();
      mockCleanup.mockResolvedValue(0);

      startPollingEngine();

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

      expect(console.log).not.toHaveBeenCalledWith(
        expect.stringContaining("Cleaned up"),
      );

      vi.useRealTimers();
    });
  });

  // ── stopPollingEngine ─────────────────────────────────────────────────────────

  describe("stopPollingEngine", () => {
    it("logs 'Stopped' when called", () => {
      stopPollingEngine();
      expect(console.log).toHaveBeenCalledWith("[Polling Engine] Stopped");
    });

    it("stops all pollers when they were started", () => {
      mockEnv.HAWK_IR_ENABLED = true;
      mockEnv.JITBIT_ENABLED = true;

      startPollingEngine();

      const hawkInstance = MockHawkIRPoller.mock.results[0].value;
      const jitbitInstance = MockJitbitPoller.mock.results[0].value;
      const escalationInstance = MockEscalationEngine.mock.results[0].value;

      stopPollingEngine();

      expect(hawkInstance.stop).toHaveBeenCalled();
      expect(jitbitInstance.stop).toHaveBeenCalled();
      expect(escalationInstance.stop).toHaveBeenCalled();
    });

    it("does not throw when stop is called without prior start", () => {
      expect(() => stopPollingEngine()).not.toThrow();
    });

    it("clears the cleanup interval on stop", async () => {
      vi.useFakeTimers();
      mockCleanup.mockResolvedValue(0);

      startPollingEngine();
      stopPollingEngine();

      const callCountBefore = mockCleanup.mock.calls.length;
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

      expect(mockCleanup.mock.calls.length).toBe(callCountBefore);

      vi.useRealTimers();
    });
  });
});
