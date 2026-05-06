import { jitbitService } from "../../integrations/jitbit/jitbit-service";
import { notificationStore } from "../notification-store";
import { PushMessage, sendPushNotification } from "../dispatcher";
import { getAllSubscriptions } from "../../routes/push-subscriptions";

export interface JitbitPollerConfig {
  pollIntervalMinutes: number;
}

const DEFAULT_CONFIG: JitbitPollerConfig = {
  pollIntervalMinutes: 5,
};

export class JitbitPoller {
  private intervalHandle?: NodeJS.Timeout;

  constructor(private config: JitbitPollerConfig = DEFAULT_CONFIG) {}

  async poll(): Promise<number> {
    if (!jitbitService.isConfigured()) {
      return 0;
    }

    const tickets = await jitbitService.findHighPriorityOpenTickets(25);

    let newNotifications = 0;

    for (const ticket of tickets) {
      const ticketId = String(ticket.TicketID || ticket.IssueID || "");
      if (!ticketId) continue;

      const alreadyNotified = await notificationStore.hasBeenNotified("jitbit", ticketId);
      if (alreadyNotified) continue;

      const priority = ticket.Priority ?? 0;
      const priorityName = String(ticket.PriorityName || "").toLowerCase();
      const isCritical = priority >= 5 || priorityName.includes("critical");

      const message: PushMessage = {
        title: `Support: ${isCritical ? "Critical" : "High-Priority"} Ticket`,
        body: `Ticket #${ticketId} — ${ticket.Subject || "Needs attention"}`,
        url: `/support/tickets/${ticketId}`,
        urgency: isCritical ? "high" : "normal",
        requireInteraction: isCritical,
        tag: `jitbit-${ticketId}`,
        source: "jitbit",
        sourceId: ticketId,
        severity: isCritical ? "page" : "urgent",
      };

      const subscriptions = getAllSubscriptions();
      for (const sub of subscriptions) {
        await sendPushNotification(sub, message);
      }

      await notificationStore.markNotified({
        id: `jitbit:${ticketId}`,
        source: "jitbit",
        externalId: ticketId,
        riskLevel: isCritical ? "critical" : "high",
        notifiedAt: new Date().toISOString(),
        escalationLevel: 1,
      });

      newNotifications++;
    }

    return newNotifications;
  }

  start(): void {
    this.poll().catch((err) => console.error("[Jitbit Poller] Initial poll failed:", err));
    this.intervalHandle = setInterval(
      () => this.poll().catch((err) => console.error("[Jitbit Poller] Poll failed:", err)),
      this.config.pollIntervalMinutes * 60 * 1000
    );
    console.log(`[Jitbit Poller] Started (every ${this.config.pollIntervalMinutes}min)`);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
    console.log("[Jitbit Poller] Stopped");
  }
}
