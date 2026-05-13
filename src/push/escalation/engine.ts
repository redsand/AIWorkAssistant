import { notificationStore } from "../notification-store";
import { env } from "../../config/env";
import { sendEmail, isEmailConfigured, getActiveProviderName } from "./email";

export interface EscalationConfig {
  level2AfterMinutes: number;
  level3AfterMinutes: number;
  level2Channels: ("sms" | "email")[];
  onCallEmail: string;
  onCallPhone: string;
  backupEmail: string;
  backupPhone: string;
}

function buildDefaultConfig(): EscalationConfig {
  return {
    level2AfterMinutes: env.PUSH_ESCALATION_L2_MINUTES,
    level3AfterMinutes: env.PUSH_ESCALATION_L3_MINUTES,
    level2Channels: ["email"],
    onCallEmail: env.ESCALATION_EMAIL_TO || (env.HAWK_IR_ENABLED ? "oncall@ai-work-assistant.example" : ""),
    onCallPhone: "",
    backupEmail: env.ESCALATION_EMAIL_TO_L3 || env.ESCALATION_EMAIL_TO || "backup@ai-work-assistant.example",
    backupPhone: "",
  };
}

function getBaseUrl(): string {
  return (env.TUNNEL_URL || env.AIWORKASSISTANT_URL || "http://localhost:3050").replace(/\/+$/, "");
}

function buildDeepLink(source: string, externalId: string): string {
  const base = getBaseUrl();
  return `${base}/acknowledge?source=${encodeURIComponent(source)}&id=${encodeURIComponent(externalId)}`;
}

export class EscalationEngine {
  private intervalHandle?: NodeJS.Timeout;
  private config: EscalationConfig;

  constructor(config?: EscalationConfig) {
    this.config = config ?? buildDefaultConfig();
  }

  async checkAndEscalate(): Promise<void> {
    const level2Items = await notificationStore.getUnacknowledgedPastThreshold(
      this.config.level2AfterMinutes
    );

    for (const item of level2Items) {
      if (item.escalationLevel >= 2) continue;

      try {
        const deepLink = buildDeepLink(item.source, item.externalId);

        const subject =
          item.source === "hawk-ir"
            ? `[Escalation L2] HAWK IR Case ${item.externalId} (${item.riskLevel})`
            : `[Escalation L2] Jitbit Ticket ${item.externalId} (${item.riskLevel})`;

        const message =
          item.source === "hawk-ir"
            ? `HAWK IR ${item.externalId} — Risk: ${item.riskLevel}. Acknowledge: ${deepLink}`
            : `Jitbit Ticket ${item.externalId} — Risk: ${item.riskLevel}. Acknowledge: ${deepLink}`;

        console.warn(`[Escalation L2] ${message}`);

        if (this.config.level2Channels.includes("email") && this.config.onCallEmail) {
          if (isEmailConfigured()) {
            const sent = await sendEmail({
              to: this.config.onCallEmail,
              subject,
              plainText: `${message}\n\nAcknowledge: ${deepLink}`,
              html: `<p>${message}</p><p><a href="${deepLink}">Acknowledge</a></p>`,
            });
            console.log(`[Escalation L2] Email to ${this.config.onCallEmail}: ${sent ? "sent" : "failed"} (provider: ${getActiveProviderName()})`);
          } else {
            console.log(`[Escalation L2] Email not configured — would email: ${this.config.onCallEmail}`);
          }
        }

        await notificationStore.markEscalated(item.source, item.externalId, 2);
      } catch (err) {
        console.error(`[Escalation L2] Failed to process ${item.source}:${item.externalId}:`, err instanceof Error ? err.message : err);
      }
    }

    const level3Items = await notificationStore.getUnacknowledgedPastThreshold(
      this.config.level3AfterMinutes
    );

    for (const item of level3Items) {
      if (item.escalationLevel >= 3) continue;

      try {
        const deepLink = buildDeepLink(item.source, item.externalId);
        const subject = `[Escalation L3] UNACKNOWLEDGED: ${item.source} ${item.externalId} (${item.riskLevel})`;
        const message = `UNACKNOWLEDGED ESCALATION: ${item.source} ${item.externalId} (${item.riskLevel}) — Primary responder has not responded. Please take over.\n\nAcknowledge: ${deepLink}`;

        console.error(`[Escalation L3] ${message}`);

        if (this.config.backupEmail) {
          if (isEmailConfigured()) {
            const sent = await sendEmail({
              to: this.config.backupEmail,
              subject,
              plainText: message,
              html: `<p>${message.replace(/\n\n/g, "</p><p>")}</p>`,
            });
            console.log(`[Escalation L3] Email to ${this.config.backupEmail}: ${sent ? "sent" : "failed"} (provider: ${getActiveProviderName()})`);
          } else {
            console.log(`[Escalation L3] Email not configured — would email: ${this.config.backupEmail}`);
          }
        }

        await notificationStore.markEscalated(item.source, item.externalId, 3);
      } catch (err) {
        console.error(`[Escalation L3] Failed to process ${item.source}:${item.externalId}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  start(): void {
    this.checkAndEscalate().catch((err) =>
      console.error("[Escalation Engine] Initial check failed:", err)
    );
    this.intervalHandle = setInterval(
      () =>
        this.checkAndEscalate().catch((err) =>
          console.error("[Escalation Engine] Check failed:", err)
        ),
      60 * 1000
    );
    console.log("[Escalation Engine] Started (checking every 1min)");
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
    console.log("[Escalation Engine] Stopped");
  }
}