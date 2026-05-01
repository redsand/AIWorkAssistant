import { fileCalendarService } from "../integrations/file/calendar-service";

class FocusBlocks {
  async recommendFocusBlocks(
    date: Date,
    _userId: string,
  ): Promise<
    Array<{
      startTime: Date;
      duration: number;
      title: string;
      priority: "high" | "medium" | "low";
    }>
  > {
    console.log(`[Focus Blocks] Recommending focus blocks for ${date}`);

    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay();
    if (day === 0 || day === 6) {
      console.log("[Focus Blocks] Skipping weekend");
      return [];
    }

    const dayEnd = new Date(d);
    dayEnd.setHours(23, 59, 59, 999);
    const existing = fileCalendarService.listEvents(d, dayEnd);

    const gaps = this.findGaps(existing, d);

    const recommendations: Array<{
      startTime: Date;
      duration: number;
      title: string;
      priority: "high" | "medium" | "low";
    }> = [];

    const sizes = [
      { min: 120, label: "Deep work session", priority: "high" as const },
      { min: 90, label: "Focused coding block", priority: "high" as const },
      {
        min: 60,
        label: "Code review / small task",
        priority: "medium" as const,
      },
      { min: 30, label: "Quick focus task", priority: "low" as const },
    ];

    let blockNum = 1;
    for (const gap of gaps) {
      if (recommendations.length >= 3) break;
      const gapMinutes = (gap.end.getTime() - gap.start.getTime()) / 60000;
      for (const size of sizes) {
        if (gapMinutes >= size.min) {
          recommendations.push({
            startTime: new Date(gap.start),
            duration: size.min,
            title: `${size.label} #${blockNum}`,
            priority: size.priority,
          });
          blockNum++;
          break;
        } else if (gapMinutes >= 30) {
          recommendations.push({
            startTime: new Date(gap.start),
            duration: Math.floor(gapMinutes / 15) * 15,
            title: `Quick focus task #${blockNum}`,
            priority: "low" as const,
          });
          blockNum++;
          break;
        }
      }
    }

    if (recommendations.length === 0) {
      console.log("[Focus Blocks] No available gaps found in schedule");
    }

    return recommendations;
  }

  private findGaps(
    events: Array<{ startTime: Date; endTime: Date }>,
    date: Date,
  ): Array<{ start: Date; end: Date }> {
    const dayStart = new Date(date);
    dayStart.setHours(9, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(17, 0, 0, 0);

    const sorted = [...events]
      .filter((e) => e.startTime >= dayStart && e.endTime <= dayEnd)
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    const gaps: Array<{ start: Date; end: Date }> = [];
    let cursor = new Date(dayStart);

    for (const event of sorted) {
      if (event.startTime > cursor) {
        gaps.push({ start: new Date(cursor), end: new Date(event.startTime) });
      }
      if (event.endTime > cursor) {
        cursor = new Date(event.endTime);
      }
    }

    if (cursor < dayEnd) {
      gaps.push({ start: new Date(cursor), end: new Date(dayEnd) });
    }

    return gaps.filter(
      (g) => g.end.getTime() - g.start.getTime() >= 15 * 60000,
    );
  }

  async createFocusBlock(
    params: {
      title: string;
      startTime: Date;
      duration: number;
      description?: string;
    },
    _userId: string,
  ) {
    return fileCalendarService.createFocusBlock({
      ...params,
      autoSchedule: true,
    });
  }
}

export const focusBlocks = new FocusBlocks();
