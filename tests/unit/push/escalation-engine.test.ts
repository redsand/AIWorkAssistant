import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock dependencies (vi.hoisted ensures they exist when vi.mock factories run) ──

const {
  mockGetUnacknowledgedPastThreshold,
  mockMarkEscalated,
  mockSendEmail,
  mockIsEmailConfigured,
  mockGetActiveProviderName,
  mockEnv,
} = vi.hoisted(() => ({
  mockGetUnacknowledgedPastThreshold: vi.fn(),
  mockMarkEscalated: vi.fn(),
  mockSendEmail: vi.fn(),
  mockIsEmailConfigured: vi.fn(),
  mockGetActiveProviderName: vi.fn(),
  mockEnv: {
    PUSH_ESCALATION_L2_MINUTES: 5,
    PUSH_ESCALATION_L3_MINUTES: 15,
    ESCALATION_EMAIL_TO: "oncall@test.example",
    ESCALATION_EMAIL_TO_L3: "backup@test.example",
    HAWK_IR_ENABLED: false,
    TUNNEL_URL: "",
    AIWORKASSISTANT_URL: "http://localhost:3050",
  },
}));

vi.mock("../../../src/push/notification-store", () => ({
  notificationStore: {
    getUnacknowledgedPastThreshold: mockGetUnacknowledgedPastThreshold,
    markEscalated: mockMarkEscalated,
  },
}));

vi.mock("../../../src/config/env", () => ({
  env: mockEnv,
}));

vi.mock("../../../src/push/escalation/email", () => ({
  sendEmail: mockSendEmail,
  isEmailConfigured: mockIsEmailConfigured,
  getActiveProviderName: mockGetActiveProviderName,
}));

// Import after mocks are established
import { EscalationEngine } from "../../../src/push/escalation/engine";

// ── Helpers ──

function makeItem(overrides: Partial<{
  source: "hawk-ir" | "jitbit";
  externalId: string;
  riskLevel: string;
  escalationLevel: number;
  notifiedAt: string;
}> = {}) {
  return {
    id: `${overrides.source ?? "hawk-ir"}:${overrides.externalId ?? "CASE-1"}`,
    source: overrides.source ?? "hawk-ir",
    externalId: overrides.externalId ?? "CASE-1",
    riskLevel: overrides.riskLevel ?? "critical",
    notifiedAt: overrides.notifiedAt ?? new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    escalationLevel: overrides.escalationLevel ?? 1,
  };
}

// ── Tests ──

describe("EscalationEngine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Constructor / default config ──

  describe("constructor", () => {
    it("uses provided config when supplied", () => {
      const config = {
        level2AfterMinutes: 2,
        level3AfterMinutes: 10,
        level2Channels: ["email" as const],
        onCallEmail: "custom@test.example",
        onCallPhone: "",
        backupEmail: "backup-custom@test.example",
        backupPhone: "",
      };
      const engine = new EscalationEngine(config);
      expect(engine).toBeInstanceOf(EscalationEngine);
    });

    it("builds default config from env when no config provided", () => {
      const engine = new EscalationEngine();
      expect(engine).toBeInstanceOf(EscalationEngine);
    });
  });

  // ── checkAndEscalate ──

  describe("checkAndEscalate", () => {
    it("escalates hawk-ir items to L2 when past threshold and email is configured", async () => {
      const item = makeItem({ source: "hawk-ir", escalationLevel: 1 });
      mockGetUnacknowledgedPastThreshold
        .mockResolvedValueOnce([item])  // L2 query
        .mockResolvedValueOnce([]);     // L3 query
      mockIsEmailConfigured.mockReturnValue(true);
      mockSendEmail.mockResolvedValue(true);
      mockGetActiveProviderName.mockReturnValue("smtp");

      const engine = new EscalationEngine({
        level2AfterMinutes: 5,
        level3AfterMinutes: 15,
        level2Channels: ["email"],
        onCallEmail: "oncall@test.example",
        onCallPhone: "",
        backupEmail: "backup@test.example",
        backupPhone: "",
      });

      await engine.checkAndEscalate();

      expect(mockGetUnacknowledgedPastThreshold).toHaveBeenCalledWith(5);
      expect(mockSendEmail).toHaveBeenCalledWith({
        to: "oncall@test.example",
        subject: "[Escalation L2] HAWK IR Case CASE-1 (critical)",
        plainText: expect.stringContaining("HAWK IR CASE-1"),
        html: expect.stringContaining("Acknowledge"),
      });
      expect(mockMarkEscalated).toHaveBeenCalledWith("hawk-ir", "CASE-1", 2);
    });

    it("escalates jitbit items to L2 with correct subject", async () => {
      const item = makeItem({ source: "jitbit", externalId: "T-99", riskLevel: "high", escalationLevel: 1 });
      mockGetUnacknowledgedPastThreshold
        .mockResolvedValueOnce([item])
        .mockResolvedValueOnce([]);
      mockIsEmailConfigured.mockReturnValue(true);
      mockSendEmail.mockResolvedValue(true);
      mockGetActiveProviderName.mockReturnValue("smtp");

      const engine = new EscalationEngine({
        level2AfterMinutes: 5,
        level3AfterMinutes: 15,
        level2Channels: ["email"],
        onCallEmail: "oncall@test.example",
        onCallPhone: "",
        backupEmail: "backup@test.example",
        backupPhone: "",
      });

      await engine.checkAndEscalate();

      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: "[Escalation L2] Jitbit Ticket T-99 (high)",
        })
      );
      expect(mockMarkEscalated).toHaveBeenCalledWith("jitbit", "T-99", 2);
    });

    it("skips L2 email when email is not configured", async () => {
      const item = makeItem({ escalationLevel: 1 });
      mockGetUnacknowledgedPastThreshold
        .mockResolvedValueOnce([item])
        .mockResolvedValueOnce([]);
      mockIsEmailConfigured.mockReturnValue(false);

      const engine = new EscalationEngine({
        level2AfterMinutes: 5,
        level3AfterMinutes: 15,
        level2Channels: ["email"],
        onCallEmail: "oncall@test.example",
        onCallPhone: "",
        backupEmail: "backup@test.example",
        backupPhone: "",
      });

      await engine.checkAndEscalate();

      expect(mockSendEmail).not.toHaveBeenCalled();
      // Still marks escalated
      expect(mockMarkEscalated).toHaveBeenCalledWith("hawk-ir", "CASE-1", 2);
    });

    it("skips L2 email when onCallEmail is empty", async () => {
      const item = makeItem({ escalationLevel: 1 });
      mockGetUnacknowledgedPastThreshold
        .mockResolvedValueOnce([item])
        .mockResolvedValueOnce([]);

      const engine = new EscalationEngine({
        level2AfterMinutes: 5,
        level3AfterMinutes: 15,
        level2Channels: ["email"],
        onCallEmail: "",
        onCallPhone: "",
        backupEmail: "backup@test.example",
        backupPhone: "",
      });

      await engine.checkAndEscalate();

      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(mockMarkEscalated).toHaveBeenCalledWith("hawk-ir", "CASE-1", 2);
    });

    it("skips L2 email when level2Channels does not include email", async () => {
      const item = makeItem({ escalationLevel: 1 });
      mockGetUnacknowledgedPastThreshold
        .mockResolvedValueOnce([item])
        .mockResolvedValueOnce([]);

      const engine = new EscalationEngine({
        level2AfterMinutes: 5,
        level3AfterMinutes: 15,
        level2Channels: ["sms"],
        onCallEmail: "oncall@test.example",
        onCallPhone: "",
        backupEmail: "backup@test.example",
        backupPhone: "",
      });

      await engine.checkAndEscalate();

      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(mockMarkEscalated).toHaveBeenCalledWith("hawk-ir", "CASE-1", 2);
    });

    it("skips items already at L2", async () => {
      const item = makeItem({ escalationLevel: 2 });
      mockGetUnacknowledgedPastThreshold
        .mockResolvedValueOnce([item])
        .mockResolvedValueOnce([]);

      const engine = new EscalationEngine();
      await engine.checkAndEscalate();

      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(mockMarkEscalated).not.toHaveBeenCalled();
    });

    it("handles exceptions during L2 processing and continues", async () => {
      const item1 = makeItem({ source: "hawk-ir", externalId: "CASE-A", escalationLevel: 1 });
      const item2 = makeItem({ source: "jitbit", externalId: "T-B", escalationLevel: 1 });
      mockGetUnacknowledgedPastThreshold
        .mockResolvedValueOnce([item1, item2])
        .mockResolvedValueOnce([]);
      mockIsEmailConfigured.mockReturnValue(true);
      // First item throws during markEscalated (simulating an error mid-processing)
      mockMarkEscalated.mockRejectedValueOnce(new Error("store error"));
      mockGetActiveProviderName.mockReturnValue("smtp");

      const engine = new EscalationEngine({
        level2AfterMinutes: 5,
        level3AfterMinutes: 15,
        level2Channels: ["email"],
        onCallEmail: "oncall@test.example",
        onCallPhone: "",
        backupEmail: "backup@test.example",
        backupPhone: "",
      });

      await engine.checkAndEscalate();

      // Both items should have been attempted for email; first threw on markEscalated
      // Second item should succeed
      expect(mockMarkEscalated).toHaveBeenCalledWith("jitbit", "T-B", 2);
    });

    it("handles non-Error thrown values during L2 processing", async () => {
      const item = makeItem({ escalationLevel: 1 });
      mockGetUnacknowledgedPastThreshold
        .mockResolvedValueOnce([item])
        .mockResolvedValueOnce([]);
      mockIsEmailConfigured.mockReturnValue(true);
      // Throw a string instead of an Error
      mockMarkEscalated.mockRejectedValueOnce("string error");

      const engine = new EscalationEngine({
        level2AfterMinutes: 5,
        level3AfterMinutes: 15,
        level2Channels: ["email"],
        onCallEmail: "oncall@test.example",
        onCallPhone: "",
        backupEmail: "backup@test.example",
        backupPhone: "",
      });

      await engine.checkAndEscalate();

      // Should not throw -- error is caught and logged
      expect(console.error).toHaveBeenCalled();
    });

    it("escalates items to L3 when past L3 threshold", async () => {
      const item = makeItem({ source: "hawk-ir", externalId: "CASE-X", escalationLevel: 2 });
      mockGetUnacknowledgedPastThreshold
        .mockResolvedValueOnce([])     // L2: nothing
        .mockResolvedValueOnce([item]); // L3: one item
      mockIsEmailConfigured.mockReturnValue(true);
      mockSendEmail.mockResolvedValue(true);
      mockGetActiveProviderName.mockReturnValue("acs");

      const engine = new EscalationEngine({
        level2AfterMinutes: 5,
        level3AfterMinutes: 15,
        level2Channels: ["email"],
        onCallEmail: "oncall@test.example",
        onCallPhone: "",
        backupEmail: "backup@test.example",
        backupPhone: "",
      });

      await engine.checkAndEscalate();

      expect(mockGetUnacknowledgedPastThreshold).toHaveBeenCalledWith(15);
      expect(mockSendEmail).toHaveBeenCalledWith({
        to: "backup@test.example",
        subject: "[Escalation L3] UNACKNOWLEDGED: hawk-ir CASE-X (critical)",
        plainText: expect.stringContaining("UNACKNOWLEDGED ESCALATION"),
        html: expect.stringContaining("UNACKNOWLEDGED ESCALATION"),
      });
      expect(mockMarkEscalated).toHaveBeenCalledWith("hawk-ir", "CASE-X", 3);
    });

    it("skips L3 email when backupEmail is empty", async () => {
      const item = makeItem({ escalationLevel: 2 });
      mockGetUnacknowledgedPastThreshold
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([item]);

      const engine = new EscalationEngine({
        level2AfterMinutes: 5,
        level3AfterMinutes: 15,
        level2Channels: ["email"],
        onCallEmail: "oncall@test.example",
        onCallPhone: "",
        backupEmail: "",
        backupPhone: "",
      });

      await engine.checkAndEscalate();

      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(mockMarkEscalated).toHaveBeenCalledWith("hawk-ir", "CASE-1", 3);
    });

    it("skips L3 email when email is not configured", async () => {
      const item = makeItem({ escalationLevel: 2 });
      mockGetUnacknowledgedPastThreshold
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([item]);
      mockIsEmailConfigured.mockReturnValue(false);

      const engine = new EscalationEngine({
        level2AfterMinutes: 5,
        level3AfterMinutes: 15,
        level2Channels: ["email"],
        onCallEmail: "oncall@test.example",
        onCallPhone: "",
        backupEmail: "backup@test.example",
        backupPhone: "",
      });

      await engine.checkAndEscalate();

      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(mockMarkEscalated).toHaveBeenCalledWith("hawk-ir", "CASE-1", 3);
    });

    it("skips L3 items already at level 3", async () => {
      const item = makeItem({ escalationLevel: 3 });
      mockGetUnacknowledgedPastThreshold
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([item]);

      const engine = new EscalationEngine();
      await engine.checkAndEscalate();

      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(mockMarkEscalated).not.toHaveBeenCalled();
    });

    it("handles exceptions during L3 processing", async () => {
      const item = makeItem({ escalationLevel: 2 });
      mockGetUnacknowledgedPastThreshold
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([item]);
      mockIsEmailConfigured.mockReturnValue(true);
      mockMarkEscalated.mockRejectedValue(new Error("store down"));

      const engine = new EscalationEngine({
        level2AfterMinutes: 5,
        level3AfterMinutes: 15,
        level2Channels: ["email"],
        onCallEmail: "oncall@test.example",
        onCallPhone: "",
        backupEmail: "backup@test.example",
        backupPhone: "",
      });

      // Should not throw
      await engine.checkAndEscalate();
      expect(console.error).toHaveBeenCalled();
    });

    it("does nothing when no items are past threshold", async () => {
      mockGetUnacknowledgedPastThreshold
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const engine = new EscalationEngine();
      await engine.checkAndEscalate();

      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(mockMarkEscalated).not.toHaveBeenCalled();
    });

    it("uses TUNNEL_URL for deep link when available", async () => {
      const originalTunnelUrl = mockEnv.TUNNEL_URL;
      mockEnv.TUNNEL_URL = "https://my-tunnel.example.com/";
      const item = makeItem({ source: "jitbit", externalId: "T-42", escalationLevel: 1 });
      mockGetUnacknowledgedPastThreshold
        .mockResolvedValueOnce([item])
        .mockResolvedValueOnce([]);
      mockIsEmailConfigured.mockReturnValue(true);
      mockSendEmail.mockResolvedValue(true);
      mockGetActiveProviderName.mockReturnValue("smtp");

      const engine = new EscalationEngine({
        level2AfterMinutes: 5,
        level3AfterMinutes: 15,
        level2Channels: ["email"],
        onCallEmail: "oncall@test.example",
        onCallPhone: "",
        backupEmail: "backup@test.example",
        backupPhone: "",
      });

      await engine.checkAndEscalate();

      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          plainText: expect.stringContaining("https://my-tunnel.example.com/acknowledge?source=jitbit&id=T-42"),
        })
      );

      mockEnv.TUNNEL_URL = originalTunnelUrl;
    });

    it("logs sent vs failed for L2 email", async () => {
      const item = makeItem({ escalationLevel: 1 });
      mockGetUnacknowledgedPastThreshold
        .mockResolvedValueOnce([item])
        .mockResolvedValueOnce([]);
      mockIsEmailConfigured.mockReturnValue(true);
      mockSendEmail.mockResolvedValue(false);
      mockGetActiveProviderName.mockReturnValue("smtp");

      const engine = new EscalationEngine({
        level2AfterMinutes: 5,
        level3AfterMinutes: 15,
        level2Channels: ["email"],
        onCallEmail: "oncall@test.example",
        onCallPhone: "",
        backupEmail: "backup@test.example",
        backupPhone: "",
      });

      await engine.checkAndEscalate();

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("failed")
      );
    });

    it("logs sent vs failed for L3 email", async () => {
      const item = makeItem({ escalationLevel: 2 });
      mockGetUnacknowledgedPastThreshold
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([item]);
      mockIsEmailConfigured.mockReturnValue(true);
      mockSendEmail.mockResolvedValue(false);
      mockGetActiveProviderName.mockReturnValue("smtp");

      const engine = new EscalationEngine({
        level2AfterMinutes: 5,
        level3AfterMinutes: 15,
        level2Channels: ["email"],
        onCallEmail: "oncall@test.example",
        onCallPhone: "",
        backupEmail: "backup@test.example",
        backupPhone: "",
      });

      await engine.checkAndEscalate();

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("failed")
      );
    });
  });

  // ── start / stop ──

  describe("start", () => {
    it("starts the engine and sets an interval", () => {
      vi.useFakeTimers();
      mockGetUnacknowledgedPastThreshold
        .mockResolvedValue([])
        .mockResolvedValue([]);

      const engine = new EscalationEngine();
      engine.start();

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Started")
      );

      engine.stop();
      vi.useRealTimers();
    });

    it("runs checkAndEscalate on interval tick", async () => {
      vi.useFakeTimers();
      mockGetUnacknowledgedPastThreshold
        .mockResolvedValue([])
        .mockResolvedValue([]);

      const engine = new EscalationEngine();
      engine.start();

      // Advance past the first interval (60s)
      await vi.advanceTimersByTimeAsync(61_000);

      // Initial call + one interval tick
      expect(mockGetUnacknowledgedPastThreshold).toHaveBeenCalled();

      engine.stop();
      vi.useRealTimers();
    });

    it("catches errors from initial checkAndEscalate", async () => {
      vi.useFakeTimers();
      mockGetUnacknowledgedPastThreshold.mockRejectedValue(new Error("store down"));

      const engine = new EscalationEngine();
      engine.start();

      // Let the initial check run and fail
      await vi.advanceTimersByTimeAsync(0);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Initial check failed"),
        expect.any(Error)
      );

      engine.stop();
      vi.useRealTimers();
    });
  });

  describe("stop", () => {
    it("clears the interval and logs stopped", () => {
      vi.useFakeTimers();
      mockGetUnacknowledgedPastThreshold.mockResolvedValue([]);

      const engine = new EscalationEngine();
      engine.start();
      engine.stop();

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Stopped")
      );

      vi.useRealTimers();
    });

    it("is safe to call stop without start", () => {
      const engine = new EscalationEngine();
      engine.stop();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("Stopped")
      );
    });
  });
});
