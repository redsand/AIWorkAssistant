import { fileCalendarService } from "../integrations/file/calendar-service";
import { weeklyPlanner } from "../productivity/weekly-planner";
import { env } from "../config/env";

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
}

async function runNightlyPlan(): Promise<void> {
  if (!env.NIGHTLY_PLAN_ENABLED) return;

  const now = new Date();
  const weeks = env.NIGHTLY_PLAN_WEEKS as 1 | 2;
  const userId = env.NIGHTLY_PLAN_USER;

  console.log(`[Scheduler] Generating ${weeks}-week calendar plan...`);

  try {
    const plan = await weeklyPlanner.generateWeeklyPlan(now, weeks, userId);

    let created = 0;
    let skipped = 0;

    for (const day of plan.days) {
      if (day.isWeekend) continue;

      const dayDate = new Date(day.date + "T00:00:00");

      for (const entry of day.schedule) {
        if (entry.type !== "focus" && entry.type !== "health") continue;

        const [hours, minutes] = entry.time.split(":").map(Number);
        const startTime = new Date(dayDate);
        startTime.setHours(hours, minutes, 0, 0);

        const durationMinutes = entry.type === "health" ? 60 : 90;
        const endTime = new Date(
          startTime.getTime() + durationMinutes * 60000,
        );

        if (
          !fileCalendarService.isWithinBusinessHours(startTime, endTime)
        )
          continue;

        const overlaps = fileCalendarService.findOverlaps(startTime, endTime);
        if (overlaps.length > 0) {
          skipped++;
          continue;
        }

        try {
          await fileCalendarService.createEvent({
            summary: entry.title,
            description: entry.description || "",
            startTime,
            endTime,
            type:
              entry.type === "focus"
                ? "focus"
                : entry.type === "health"
                  ? "fitness"
                  : "other",
          });
          created++;
        } catch {
          skipped++;
        }
      }
    }

    console.log(
      `[Scheduler] Nightly plan complete: ${created} events created, ${skipped} skipped (overlap)`,
    );
  } catch (error) {
    console.error("[Scheduler] Nightly plan failed:", error);
  }
}

async function runMidnightTasks() {
  runRollover();
  await runNightlyPlan();
  scheduleNext();
}

function scheduleNext() {
  const delay = msUntilMidnight();
  console.log(
    `[Scheduler] Next midnight run in ${Math.round(delay / 60000)} minutes`,
  );
  timer = setTimeout(runMidnightTasks, delay);
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

export { runNightlyPlan };