import { fileCalendarService } from "../integrations/file/calendar-service";

class HealthBreaks {
  // Exercise schedule: 3 days per week, 1 hour each
  private readonly EXERCISE_DAYS = [1, 3, 5]; // Mon, Wed, Fri
  private readonly EXERCISE_DURATION = 60; // minutes
  private readonly EXERCISE_PREFERRED_HOUR = 7; // 7am before work

  async recommendBreaks(
    date: Date,
    _userId: string,
  ): Promise<
    Array<{
      startTime: Date;
      duration: number;
      title: string;
      type: "fitness" | "meal" | "mental_health";
    }>
  > {
    console.log(`[Health Breaks] Recommending breaks for ${date}`);

    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay();
    if (day === 0 || day === 6) {
      console.log("[Health Breaks] Skipping weekend");
      return [];
    }

    const dayEnd = new Date(d);
    dayEnd.setHours(23, 59, 59, 999);
    const existing = fileCalendarService.listEvents(d, dayEnd);

    const recommendations: Array<{
      startTime: Date;
      duration: number;
      title: string;
      type: "fitness" | "meal" | "mental_health";
    }> = [];

    // 1-hour exercise on Mon/Wed/Fri
    if (this.EXERCISE_DAYS.includes(day)) {
      const exerciseStart = new Date(d);
      exerciseStart.setHours(this.EXERCISE_PREFERRED_HOUR, 0, 0, 0);
      const exerciseEnd = new Date(
        exerciseStart.getTime() + this.EXERCISE_DURATION * 60000,
      );

      const conflicts = existing.filter(
        (e) => exerciseStart < e.endTime && exerciseEnd > e.startTime,
      );

      if (conflicts.length === 0) {
        recommendations.push({
          startTime: exerciseStart,
          duration: this.EXERCISE_DURATION,
          title: "Exercise (1 hour)",
          type: "fitness",
        });
      } else {
        // Try to find an alternative slot after the conflict
        const afterConflict = new Date(
          Math.max(...conflicts.map((c) => c.endTime.getTime())),
        );
        if (afterConflict.getHours() < 17) {
          recommendations.push({
            startTime: afterConflict,
            duration: this.EXERCISE_DURATION,
            title: "Exercise (1 hour)",
            type: "fitness",
          });
        }
      }
    }

    // Lunch break
    const lunchStart = new Date(d);
    lunchStart.setHours(12, 0, 0, 0);
    const lunchEnd = new Date(lunchStart.getTime() + 60 * 60000);
    const lunchConflicts = existing.filter(
      (e) => lunchStart < e.endTime && lunchEnd > e.startTime,
    );
    if (lunchConflicts.length === 0) {
      recommendations.push({
        startTime: lunchStart,
        duration: 60,
        title: "Lunch break",
        type: "meal",
      });
    }

    // Afternoon mental break
    const pmBreak = new Date(d);
    pmBreak.setHours(15, 0, 0, 0);
    const pmBreakEnd = new Date(pmBreak.getTime() + 15 * 60000);
    const pmConflicts = existing.filter(
      (e) => pmBreak < e.endTime && pmBreakEnd > e.startTime,
    );
    if (pmConflicts.length === 0) {
      recommendations.push({
        startTime: pmBreak,
        duration: 15,
        title: "Afternoon walk / mental reset",
        type: "mental_health",
      });
    }

    if (recommendations.length === 0) {
      console.log("[Health Breaks] No available slots found in schedule");
    }

    return recommendations;
  }

  async createHealthBlock(
    params: {
      title: string;
      startTime: Date;
      duration: number;
      type: "fitness" | "meal" | "mental_health";
    },
    _userId: string,
  ) {
    return fileCalendarService.createHealthBlock({
      ...params,
      autoSchedule: true,
    });
  }
}

export const healthBreaks = new HealthBreaks();
