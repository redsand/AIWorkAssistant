import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock functions defined via vi.hoisted so they are available in vi.mock factories ──

const {
  mockSendMail,
  mockCreateTransport,
  mockEnv,
  mockAcsSendEmail,
  mockAcsIsConfigured,
} = vi.hoisted(() => ({
  mockSendMail: vi.fn(),
  mockCreateTransport: vi.fn(),
  mockEnv: {
    ESCALATION_SMTP_HOST: "",
    ESCALATION_SMTP_PORT: 587,
    ESCALATION_SMTP_SECURE: false,
    ESCALATION_SMTP_USER: "",
    ESCALATION_SMTP_PASS: "",
    ESCALATION_EMAIL_FROM: "alerts@ai-work-assistant",
    ESCALATION_EMAIL_TO: "",
    EMAIL_PROVIDER: "auto",
    ACS_CONNECTION_STRING: "",
    ACS_SENDER_ADDRESS: "",
  },
  mockAcsSendEmail: vi.fn(),
  mockAcsIsConfigured: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: mockCreateTransport,
  },
}));

vi.mock("../../../src/config/env", () => ({
  get env() {
    return mockEnv;
  },
}));

vi.mock("../../../src/integrations/microsoft/acs-email-client", () => ({
  acsEmailClient: {
    sendEmail: mockAcsSendEmail,
    isConfigured: mockAcsIsConfigured,
  },
}));

// Import after mocks
import {
  sendEmail,
  sendEscalationEmail,
  isEmailConfigured,
  getActiveProviderName,
} from "../../../src/push/escalation/email";

// ── Helpers ──

/** Reset env to clean defaults. */
function resetEnv() {
  mockEnv.ESCALATION_SMTP_HOST = "";
  mockEnv.ESCALATION_SMTP_PORT = 587;
  mockEnv.ESCALATION_SMTP_SECURE = false;
  mockEnv.ESCALATION_SMTP_USER = "";
  mockEnv.ESCALATION_SMTP_PASS = "";
  mockEnv.ESCALATION_EMAIL_FROM = "alerts@ai-work-assistant";
  mockEnv.ESCALATION_EMAIL_TO = "";
  mockEnv.EMAIL_PROVIDER = "auto";
  mockEnv.ACS_CONNECTION_STRING = "";
  mockEnv.ACS_SENDER_ADDRESS = "";
}

// ── Tests ──

describe("escalation/email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEnv();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── SmtpEmailProvider ──
  // Note: SmtpEmailProvider is a singleton at module level. The transporter is
  // lazily created and then cached. Tests verify behavior through the public
  // sendEmail API with EMAIL_PROVIDER="smtp".

  describe("SmtpEmailProvider", () => {
    beforeEach(() => {
      mockEnv.EMAIL_PROVIDER = "smtp";
    });

    it("returns false when SMTP host is not set (provider not configured)", async () => {
      mockEnv.ESCALATION_SMTP_HOST = "";

      const result = await sendEmail({
        to: "test@example.com",
        subject: "Test",
        plainText: "body",
      });

      expect(result).toBe(false);
    });

    it("sends email via SMTP transporter and returns true on success", async () => {
      mockEnv.ESCALATION_SMTP_HOST = "smtp.example.com";
      mockEnv.ESCALATION_SMTP_PORT = 587;
      mockEnv.ESCALATION_SMTP_SECURE = false;
      mockEnv.ESCALATION_SMTP_USER = "";
      mockEnv.ESCALATION_SMTP_PASS = "";

      mockSendMail.mockResolvedValue({
        messageId: "<msg-123@example.com>",
        response: "250 OK",
      });
      mockCreateTransport.mockReturnValue({ sendMail: mockSendMail });

      const result = await sendEmail({
        to: "user@example.com",
        subject: "Alert",
        plainText: "Something happened",
        html: "<p>Something happened</p>",
      });

      expect(result).toBe(true);
      // On first call, createTransport is invoked by the lazy getter
      expect(mockCreateTransport).toHaveBeenCalled();
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "user@example.com",
          subject: "Alert",
          text: "Something happened",
          html: "<p>Something happened</p>",
          from: expect.any(String),
        })
      );
    });

    it("creates transporter with auth when SMTP_USER is set", async () => {
      mockEnv.ESCALATION_SMTP_HOST = "smtp-auth.example.com";
      mockEnv.ESCALATION_SMTP_PORT = 587;
      mockEnv.ESCALATION_SMTP_SECURE = false;
      mockEnv.ESCALATION_SMTP_USER = "user";
      mockEnv.ESCALATION_SMTP_PASS = "pass";

      mockSendMail.mockResolvedValue({
        messageId: "<msg@example.com>",
        response: "250 OK",
      });
      mockCreateTransport.mockReturnValue({ sendMail: mockSendMail });

      // Force fresh import to get a new SmtpEmailProvider instance
      // by resetting the module cache
      vi.resetModules();

      // Re-import with the same mocks still active
      const { sendEmail: freshSendEmail } = await import("../../../src/push/escalation/email");

      await freshSendEmail({
        to: "user@example.com",
        subject: "Test",
        plainText: "body",
      });

      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: { user: "user", pass: "pass" },
        })
      );
    });

    it("uses default from address when ESCALATION_EMAIL_FROM is not set", async () => {
      mockEnv.ESCALATION_SMTP_HOST = "smtp-from.example.com";
      mockEnv.ESCALATION_EMAIL_FROM = "";

      mockSendMail.mockResolvedValue({
        messageId: "<id@example.com>",
        response: "250 OK",
      });
      mockCreateTransport.mockReturnValue({ sendMail: mockSendMail });

      vi.resetModules();
      const { sendEmail: freshSendEmail } = await import("../../../src/push/escalation/email");

      await freshSendEmail({
        to: "user@example.com",
        subject: "Test",
        plainText: "body",
      });

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "alerts@ai-work-assistant",
        })
      );
    });

    it("returns false on sendMail rejection and logs error", async () => {
      mockEnv.ESCALATION_SMTP_HOST = "smtp-err.example.com";

      mockSendMail.mockRejectedValue(new Error("Connection refused"));
      mockCreateTransport.mockReturnValue({ sendMail: mockSendMail });

      vi.resetModules();
      const { sendEmail: freshSendEmail } = await import("../../../src/push/escalation/email");

      const result = await freshSendEmail({
        to: "user@example.com",
        subject: "Test",
        plainText: "body",
      });

      expect(result).toBe(false);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("FAILED")
      );
    });

    it("logs stack trace when error has one", async () => {
      mockEnv.ESCALATION_SMTP_HOST = "smtp-stack.example.com";

      const err = new Error("Connection refused");
      mockSendMail.mockRejectedValue(err);
      mockCreateTransport.mockReturnValue({ sendMail: mockSendMail });

      vi.resetModules();
      const { sendEmail: freshSendEmail } = await import("../../../src/push/escalation/email");

      await freshSendEmail({
        to: "user@example.com",
        subject: "Test",
        plainText: "body",
      });

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Stack:")
      );
    });

    it("handles non-Error rejection from sendMail", async () => {
      mockEnv.ESCALATION_SMTP_HOST = "smtp-nonerr.example.com";

      mockSendMail.mockRejectedValue("string error");
      mockCreateTransport.mockReturnValue({ sendMail: mockSendMail });

      vi.resetModules();
      const { sendEmail: freshSendEmail } = await import("../../../src/push/escalation/email");

      const result = await freshSendEmail({
        to: "user@example.com",
        subject: "Test",
        plainText: "body",
      });

      expect(result).toBe(false);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("FAILED")
      );
    });

    it("omits html from sendMail when not provided", async () => {
      mockEnv.ESCALATION_SMTP_HOST = "smtp-nohtml.example.com";

      mockSendMail.mockResolvedValue({
        messageId: "<id@example.com>",
        response: "250 OK",
      });
      mockCreateTransport.mockReturnValue({ sendMail: mockSendMail });

      vi.resetModules();
      const { sendEmail: freshSendEmail } = await import("../../../src/push/escalation/email");

      await freshSendEmail({
        to: "user@example.com",
        subject: "Test",
        plainText: "body",
      });

      const callArg = mockSendMail.mock.calls[0][0];
      expect(callArg.html).toBeUndefined();
    });

    it("reports name as smtp", () => {
      mockEnv.EMAIL_PROVIDER = "smtp";
      expect(getActiveProviderName()).toBe("smtp");
    });
  });

  // ── AcsEmailProvider (via sendEmail with EMAIL_PROVIDER=acs) ──

  describe("AcsEmailProvider", () => {
    beforeEach(() => {
      mockEnv.EMAIL_PROVIDER = "acs";
    });

    it("sends email via ACS and returns true on success", async () => {
      // Top-level sendEmail checks provider.isConfigured() first.
      // AcsEmailProvider.isConfigured delegates to acsEmailClient.isConfigured().
      mockAcsIsConfigured.mockReturnValue(true);
      mockAcsSendEmail.mockResolvedValue({ success: true, messageId: "acs-123" });

      vi.resetModules();
      const { sendEmail: freshSendEmail } = await import("../../../src/push/escalation/email");

      const result = await freshSendEmail({
        to: "user@example.com",
        subject: "Test",
        plainText: "body",
        html: "<p>body</p>",
      });

      expect(result).toBe(true);
      expect(mockAcsSendEmail).toHaveBeenCalledWith({
        to: "user@example.com",
        subject: "Test",
        plainText: "body",
        html: "<p>body</p>",
      });
    });

    it("returns false when ACS sendEmail reports failure", async () => {
      mockAcsIsConfigured.mockReturnValue(true);
      mockAcsSendEmail.mockResolvedValue({ success: false, error: "not configured" });

      vi.resetModules();
      const { sendEmail: freshSendEmail } = await import("../../../src/push/escalation/email");

      const result = await freshSendEmail({
        to: "user@example.com",
        subject: "Test",
        plainText: "body",
      });

      expect(result).toBe(false);
    });

    it("returns false when ACS provider is not configured", async () => {
      mockAcsIsConfigured.mockReturnValue(false);

      vi.resetModules();
      const { sendEmail: freshSendEmail } = await import("../../../src/push/escalation/email");

      const result = await freshSendEmail({
        to: "user@example.com",
        subject: "Test",
        plainText: "body",
      });

      expect(result).toBe(false);
    });

    it("reports name as acs", () => {
      mockEnv.EMAIL_PROVIDER = "acs";
      expect(getActiveProviderName()).toBe("acs");
    });
  });

  // ── Provider selection (auto mode) ──

  describe("provider selection (auto mode)", () => {
    beforeEach(() => {
      mockEnv.EMAIL_PROVIDER = "auto";
    });

    it("prefers ACS when ACS is configured", () => {
      mockAcsIsConfigured.mockReturnValue(true);
      expect(getActiveProviderName()).toBe("acs");
    });

    it("falls back to SMTP when ACS is not configured", () => {
      mockAcsIsConfigured.mockReturnValue(false);
      expect(getActiveProviderName()).toBe("smtp");
    });
  });

  // ── isEmailConfigured ──

  describe("isEmailConfigured", () => {
    it("returns true when provider is configured and ESCALATION_EMAIL_TO is set", () => {
      mockEnv.EMAIL_PROVIDER = "smtp";
      mockEnv.ESCALATION_SMTP_HOST = "smtp.example.com";
      mockEnv.ESCALATION_EMAIL_TO = "alerts@example.com";

      expect(isEmailConfigured()).toBe(true);
    });

    it("returns false when provider is not configured", () => {
      mockEnv.EMAIL_PROVIDER = "smtp";
      mockEnv.ESCALATION_SMTP_HOST = "";
      mockEnv.ESCALATION_EMAIL_TO = "alerts@example.com";

      expect(isEmailConfigured()).toBe(false);
    });

    it("returns false when ESCALATION_EMAIL_TO is empty", () => {
      mockEnv.EMAIL_PROVIDER = "smtp";
      mockEnv.ESCALATION_SMTP_HOST = "smtp.example.com";
      mockEnv.ESCALATION_EMAIL_TO = "";

      expect(isEmailConfigured()).toBe(false);
    });
  });

  // ── sendEmail (top-level public function) ──

  describe("sendEmail (public)", () => {
    it("returns false and logs when active provider is not configured", async () => {
      mockEnv.EMAIL_PROVIDER = "smtp";
      mockEnv.ESCALATION_SMTP_HOST = "";

      const result = await sendEmail({
        to: "user@example.com",
        subject: "Test",
        plainText: "body",
      });

      expect(result).toBe(false);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("No provider configured")
      );
    });

    it("delegates to provider when configured", async () => {
      mockEnv.EMAIL_PROVIDER = "smtp";
      mockEnv.ESCALATION_SMTP_HOST = "smtp.example.com";

      mockSendMail.mockResolvedValue({
        messageId: "<id>",
        response: "250 OK",
      });
      mockCreateTransport.mockReturnValue({ sendMail: mockSendMail });

      // resetModules to get fresh provider instance with transporter not yet cached
      vi.resetModules();
      const { sendEmail: freshSendEmail } = await import("../../../src/push/escalation/email");

      const result = await freshSendEmail({
        to: "user@example.com",
        subject: "Test",
        plainText: "body",
        html: "<p>body</p>",
      });

      expect(result).toBe(true);
    });
  });

  // ── sendEscalationEmail ──

  describe("sendEscalationEmail", () => {
    it("delegates to sendEmail with correct params", async () => {
      mockEnv.EMAIL_PROVIDER = "smtp";
      mockEnv.ESCALATION_SMTP_HOST = "smtp.example.com";

      mockSendMail.mockResolvedValue({
        messageId: "<id>",
        response: "250 OK",
      });
      mockCreateTransport.mockReturnValue({ sendMail: mockSendMail });

      vi.resetModules();
      const { sendEscalationEmail: freshFn } = await import("../../../src/push/escalation/email");

      const result = await freshFn(
        "oncall@example.com",
        "[Escalation] Critical",
        "Please respond"
      );

      expect(result).toBe(true);
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "oncall@example.com",
          subject: "[Escalation] Critical",
          text: "Please respond",
        })
      );
    });

    it("returns false when email is not configured", async () => {
      mockEnv.EMAIL_PROVIDER = "smtp";
      mockEnv.ESCALATION_SMTP_HOST = "";

      const result = await sendEscalationEmail(
        "oncall@example.com",
        "Subject",
        "Body"
      );

      expect(result).toBe(false);
    });
  });

  // ── getActiveProviderName ──

  describe("getActiveProviderName", () => {
    it("returns smtp when EMAIL_PROVIDER is smtp", () => {
      mockEnv.EMAIL_PROVIDER = "smtp";
      expect(getActiveProviderName()).toBe("smtp");
    });

    it("returns acs when EMAIL_PROVIDER is acs", () => {
      mockEnv.EMAIL_PROVIDER = "acs";
      expect(getActiveProviderName()).toBe("acs");
    });

    it("returns acs in auto mode when ACS is configured", () => {
      mockEnv.EMAIL_PROVIDER = "auto";
      mockAcsIsConfigured.mockReturnValue(true);
      expect(getActiveProviderName()).toBe("acs");
    });

    it("returns smtp in auto mode when ACS is not configured", () => {
      mockEnv.EMAIL_PROVIDER = "auto";
      mockAcsIsConfigured.mockReturnValue(false);
      expect(getActiveProviderName()).toBe("smtp");
    });
  });
});
