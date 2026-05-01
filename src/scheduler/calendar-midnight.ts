import { fileCalendarService } from "../integrations/file/calendar-service";

let timer: ReturnType<typeof setTimeout> | null = null;

function msUntilMidnight(): number {
  const now = new Date();
  const midnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    5,
    0,
  );
  return midnight.getTime() - now.getTime();
}

function runRollover() {
  console.log("[Scheduler] Running midnight calendar rollover...");
  try {
    const result = fileCalendarService.rescheduleIncompleteEvents();
    console.log(
      `[Scheduler] Calendar rollover complete: ${result.rescheduled} rescheduled, ${result.deleted} deleted`,
    );
    for (const detail of result.details) {
      console.log(`[Scheduler]   ${detail}`);
    }
  } catch (error) {
    console.error("[Scheduler] Calendar rollover failed:", error);
  }
  scheduleNext();
}

function scheduleNext() {
  const delay = msUntilMidnight();
  console.log(
    `[Scheduler] Next calendar rollover in ${Math.round(delay / 60000)} minutes`,
  );
  timer = setTimeout(runRollover, delay);
}

export function startCalendarScheduler() {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
  console.log("[Scheduler] Starting calendar midnight scheduler");
  scheduleNext();
}

export function stopCalendarScheduler() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
