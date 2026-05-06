import { hawkIrService } from "../../integrations/hawk-ir/hawk-ir-service";
import { notificationStore } from "../notification-store";
import { PushMessage, sendPushNotification } from "../dispatcher";
import { getAllSubscriptions } from "../../routes/push-subscriptions";

export interface HawkIRPollerConfig {
  pollIntervalMinutes: number;
  minRiskLevel: "low" | "medium" | "high" | "critical";
}

const DEFAULT_CONFIG: HawkIRPollerConfig = {
  pollIntervalMinutes: 5,
  minRiskLevel: "high",
};

export class HawkIRPoller {
  private intervalHandle?: NodeJS.Timeout;

  constructor(private config: HawkIRPollerConfig = DEFAULT_CONFIG) {}

  async poll(): Promise<number> {
    if (!hawkIrService.isConfigured()) {
      return 0;
    }

    const cases = await hawkIrService.getRiskyOpenCases({
      minRiskLevel: this.config.minRiskLevel as any,
    });

    let newNotifications = 0;

    for (const c of cases) {
      const caseId = String((c as any)["id"] || (c as any).id || (c as any)["case_id"] || "");
      if (!caseId) continue;

      const alreadyNotified = await notificationStore.hasBeenNotified("hawk-ir", caseId);
      if (alreadyNotified) continue;

      const riskLevel = String(
        (c as any).riskLevel || (c as any)["risk_level"] || "high"
      ).toLowerCase();
      const isCritical = riskLevel === "critical";

      const message: PushMessage = {
        title: `HAWK IR: ${isCritical ? "Critical" : "High-Risk"} Case`,
        body: `Case #${caseId} — ${(c as any).name || (c as any).title || "Action needed"}`,
        url: `/hawk-ir/cases/${caseId}`,
        urgency: isCritical ? "high" : "normal",
        requireInteraction: isCritical,
        tag: `hawk-ir-${caseId}`,
        source: "hawk-ir",
        sourceId: caseId,
        severity: isCritical ? "page" : "urgent",
      };

      const subscriptions = getAllSubscriptions();
      for (const sub of subscriptions) {
        await sendPushNotification(sub, message);
      }

      await notificationStore.markNotified({
        id: `hawk-ir:${caseId}`,
        source: "hawk-ir",
        externalId: caseId,
        riskLevel,
        notifiedAt: new Date().toISOString(),
        escalationLevel: 1,
      });

      newNotifications++;
    }

    return newNotifications;
  }

  start(): void {
    this.poll().catch((err) => console.error("[HAWK IR Poller] Initial poll failed:", err));
    this.intervalHandle = setInterval(
      () => this.poll().catch((err) => console.error("[HAWK IR Poller] Poll failed:", err)),
      this.config.pollIntervalMinutes * 60 * 1000
    );
    console.log(`[HAWK IR Poller] Started (every ${this.config.pollIntervalMinutes}min)`);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
    console.log("[HAWK IR Poller] Stopped");
  }
}
