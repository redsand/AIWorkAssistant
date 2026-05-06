import { notificationStore } from "../notification-store";
import { env } from "../../config/env";

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
    onCallEmail: env.HAWK_IR_ENABLED ? "oncall@ai-work-assistant.example" : "",
    onCallPhone: "",
    backupEmail: "backup@ai-work-assistant.example",
    backupPhone: "",
  };
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

      const deepLink =
        item.source === "hawk-ir"
          ? `https://ai-work-assistant.app/hawk-ir/cases/${item.externalId}`
          : `https://ai-work-assistant.app/support/tickets/${item.externalId}`;

      const message =
        item.source === "hawk-ir"
          ? `HAWK IR ${item.externalId} — Risk: ${item.riskLevel}. Acknowledge: ${deepLink}`
          : `Jitbit Ticket ${item.externalId} — Risk: ${item.riskLevel}. Acknowledge: ${deepLink}`;

      console.warn(`[Escalation L2] ${message}`);

      if (this.config.level2Channels.includes("email") && this.config.onCallEmail) {
        // TODO: Integrate with email service (SendGrid, etc.)
        console.log(`[Escalation L2] Would email: ${this.config.onCallEmail}`);
      }

      await notificationStore.markEscalated(item.source, item.externalId, 2);
    }

    const level3Items = await notificationStore.getUnacknowledgedPastThreshold(
      this.config.level3AfterMinutes
    );

    for (const item of level3Items) {
      if (item.escalationLevel >= 3) continue;

      const message = `UNACKNOWLEDGED ESCALATION: ${item.source} ${item.externalId} (${item.riskLevel}) — Primary responder has not responded. Please take over.`;

      console.error(`[Escalation L3] ${message}`);

      if (this.config.backupEmail) {
        // TODO: Integrate with email service
        console.log(`[Escalation L3] Would email: ${this.config.backupEmail}`);
      }

      await notificationStore.markEscalated(item.source, item.externalId, 3);
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
