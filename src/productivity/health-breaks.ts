import { fileCalendarService } from "../integrations/file/calendar-service";

class HealthBreaks {
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

    const templates = [
      {
        duration: 30,
        title: "Morning stretch / walk",
        type: "fitness" as const,
        preferredHour: 9,
      },
      {
        duration: 60,
        title: "Lunch break",
        type: "meal" as const,
        preferredHour: 12,
      },
      {
        duration: 15,
        title: "Afternoon walk",
        type: "mental_health" as const,
        preferredHour: 15,
      },
    ];

    const recommendations: Array<{
      startTime: Date;
      duration: number;
      title: string;
      type: "fitness" | "meal" | "mental_health";
    }> = [];

    for (const template of templates) {
      if (recommendations.length >= 3) break;

      const preferred = new Date(d);
      preferred.setHours(template.preferredHour, 0, 0, 0);
      const preferredEnd = new Date(
        preferred.getTime() + template.duration * 60000,
      );

      const conflicts = existing.filter(
        (e) => preferred < e.endTime && preferredEnd > e.startTime,
      );

      if (conflicts.length === 0) {
        recommendations.push({
          startTime: preferred,
          duration: template.duration,
          title: template.title,
          type: template.type,
        });
      } else {
        const slot = fileCalendarService.findNextAvailableSlot(
          d,
          template.duration,
          conflicts.sort((a, b) => b.endTime.getTime() - a.endTime.getTime())[0]
            .endTime,
        );
        if (slot) {
          recommendations.push({
            startTime: slot,
            duration: template.duration,
            title: template.title,
            type: template.type,
          });
        }
      }
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
