import { HawkIRPoller } from "./pollers/hawk-ir-poller";
import { JitbitPoller } from "./pollers/jitbit-poller";
import { EscalationEngine } from "./escalation/engine";
import { notificationStore } from "./notification-store";
import { env } from "../config/env";

let hawkPoller: HawkIRPoller | undefined;
let jitbitPoller: JitbitPoller | undefined;
let escalationEngine: EscalationEngine | undefined;
let cleanupInterval: NodeJS.Timeout | undefined;

export function startPollingEngine(): void {
  if (!env.VAPID_PUBLIC_KEY) {
    console.log("[Polling Engine] Push notifications not configured — polling disabled");
    return;
  }

  const pollInterval = env.PUSH_POLL_INTERVAL_MIN;

  if (env.HAWK_IR_ENABLED) {
    hawkPoller = new HawkIRPoller({ pollIntervalMinutes: pollInterval, minRiskLevel: "high" });
    hawkPoller.start();
  }

  if (env.JITBIT_ENABLED) {
    jitbitPoller = new JitbitPoller({ pollIntervalMinutes: pollInterval });
    jitbitPoller.start();
  }

  escalationEngine = new EscalationEngine();
  escalationEngine.start();

  cleanupInterval = setInterval(
    async () => {
      const removed = await notificationStore.cleanup(30);
      if (removed > 0) {
        console.log(`[Polling Engine] Cleaned up ${removed} old notifications`);
      }
    },
    24 * 60 * 60 * 1000
  );

  console.log("[Polling Engine] Started");
}

export function stopPollingEngine(): void {
  hawkPoller?.stop();
  jitbitPoller?.stop();
  escalationEngine?.stop();
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = undefined;
  }
  console.log("[Polling Engine] Stopped");
}
