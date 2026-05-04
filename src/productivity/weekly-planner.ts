import { jiraService } from "../integrations/jira/jira-service";
import { fileCalendarService } from "../integrations/file/calendar-service";
import type { ScheduleEntry, DayPlan, WeeklyPlan } from "./types";

const EXERCISE_DAYS = [1, 3, 5]; // Mon, Wed, Fri
const MAX_FOCUS_TASKS_PER_DAY = 2;
const BUSINESS_HOUR_START = 9;
const BUSINESS_HOUR_END = 17;

const MORNING_FOCUS = [
  "Start strong — your mind is freshest now",
  "Knock out the big thing first while you're sharp",
  "Morning focus time — make it count",
  "Tackle this now before the day gets away from you",
  "Fresh mind, fresh start — let's go",
];

const AFTERNOON_FOCUS = [
  "You've got momentum — keep the streak going",
  "Deep work time — this is where real progress happens",
  "One more solid push before the day winds down",
  "Stay in the zone — you're making great progress",
  "Afternoon deep work — trust the process",
];

const WALK_MESSAGES = [
  "Step away and recharge — you'll come back sharper",
  "A quick walk to clear your head",
  "Stretch, breathe, reset — you've earned it",
  "Brief reset — your brain needs this",
];

const LUNCH_MESSAGES = [
  "Recharge — food and a mental break",
  "Lunch time — step away from the screen",
  "Fuel up — you've got more to do this afternoon",
];

const WRAP_MESSAGES = [
  "Look at what you accomplished today",
  "Close out strong — tomorrow's plan starts here",
  "Quick review, then call it a day",
];

const CARRY_FORWARD = [
  "Save it for tomorrow — you've done enough today",
  "This can wait — no need to rush everything at once",
  "Tomorrow's version of you will thank you for pacing yourself",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getDayName(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "long" });
}

function toISODate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function getISOWeekNumber(d: Date): number {
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  return Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

interface JiraIssue {
  key: string;
  summary: string;
  priority: string;
  status: string;
  updated: string;
}

function extractJiraIssues(raw: any[]): JiraIssue[] {
  return raw.map((issue: any) => ({
    key: issue.key || "UNKNOWN",
    summary:
      issue.fields?.summary || issue.summary || `Issue ${issue.key || "UNKNOWN"}`,
    priority: issue.fields?.priority?.name?.toLowerCase() || "medium",
    status: issue.fields?.status?.name?.toLowerCase() || "open",
    updated: issue.fields?.updated || new Date().toISOString(),
  }));
}

function sortIssuesByPriority(issues: JiraIssue[]): JiraIssue[] {
  const priorityOrder: Record<string, number> = {
    highest: 0,
    "p0": 0,
    critical: 0,
    high: 1,
    "p1": 1,
    medium: 2,
    "p2": 2,
    low: 3,
    "p3": 3,
    lowest: 4,
    "p4": 4,
  };

  return [...issues].sort((a, b) => {
    const pa = priorityOrder[a.priority] ?? 2;
    const pb = priorityOrder[b.priority] ?? 2;
    if (pa !== pb) return pa - pb;
    return new Date(a.updated).getTime() - new Date(b.updated).getTime();
  });
}

function distributeTasks(
  issues: JiraIssue[],
  weekdays: Date[],
): Map<string, JiraIssue[]> {
  const distribution = new Map<string, JiraIssue[]>();
  for (const day of weekdays) {
    distribution.set(toISODate(day), []);
  }

  let issueIdx = 0;
  let dayIdx = 0;
  while (issueIdx < issues.length && dayIdx < weekdays.length) {
    const dayKey = toISODate(weekdays[dayIdx]);
    const dayTasks = distribution.get(dayKey)!;
    if (dayTasks.length < MAX_FOCUS_TASKS_PER_DAY) {
      dayTasks.push(issues[issueIdx]);
      issueIdx++;
    } else {
      dayIdx++;
    }
  }

  return distribution;
}

class WeeklyPlanner {
  async generateWeeklyPlan(
    startDate: Date,
    weeks: 1 | 2,
    userId: string,
  ): Promise<WeeklyPlan> {
    const monday = this.findMonday(startDate);
    const totalDays = weeks * 7;
    const endDate = new Date(monday);
    endDate.setDate(endDate.getDate() + totalDays - 1);

    const weekdays = this.getWeekdays(monday, totalDays);
    const weekStart = new Date(monday);
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(endDate);
    weekEnd.setHours(23, 59, 59, 999);

    const [assignedIssues, allEvents] = await Promise.all([
      jiraService.getAssignedIssues(userId).catch(() => []),
      Promise.resolve(fileCalendarService.listEvents(weekStart, weekEnd)),
    ]);

    const issues = sortIssuesByPriority(extractJiraIssues(assignedIssues));
    const taskDistribution = distributeTasks(issues, weekdays);
    const eventsByDay = this.groupEventsByDay(allEvents);

    const days: DayPlan[] = [];
    for (const day of weekdays) {
      const dayKey = toISODate(day);
      const dayEvents = eventsByDay.get(dayKey) || [];
      const dayTasks = taskDistribution.get(dayKey) || [];
      days.push(this.buildDayPlan(day, dayEvents, dayTasks));
    }

    const urgentCount = issues.filter(
      (i) =>
        i.priority.includes("highest") ||
        i.priority.includes("high") ||
        i.priority.includes("critical") ||
        i.priority.includes("p0") ||
        i.priority.includes("p1"),
    ).length;
    const blockedCount = issues.filter((i) =>
      i.status.includes("blocked"),
    ).length;

    const tasksPerDay: Record<string, string[]> = {};
    let distributedDays = 0;
    for (const [date, tasks] of taskDistribution) {
      tasksPerDay[date] = tasks.map((t) => t.key);
      if (tasks.length > 0) distributedDays++;
    }

    const totalFocusBlocks = days.reduce(
      (sum, d) => sum + d.schedule.filter((s) => s.type === "focus").length,
      0,
    );
    const totalMeetings = days.reduce(
      (sum, d) => sum + d.schedule.filter((s) => s.type === "meeting").length,
      0,
    );

    const lightestDay = this.findLightestDay(days);
    const heaviestDay = this.findHeaviestDay(days);

    const summary = `Week of ${this.formatShortDate(monday)}–${this.formatShortDate(weekdays[weekdays.length - 1])}: ${totalFocusBlocks} focus blocks across ${distributedDays} day${distributedDays !== 1 ? "s" : ""}, ${totalMeetings} meeting${totalMeetings !== 1 ? "s" : ""}, exercise ${this.exerciseDayNames(weekdays)}. Lightest day: ${lightestDay}. Heaviest: ${heaviestDay}.`;

    const weeklyRecommendations: string[] = [];
    const overflowTasks = issues.length - distributedDays * MAX_FOCUS_TASKS_PER_DAY;
    if (overflowTasks > 0) {
      weeklyRecommendations.push(
        `${overflowTasks} more task${overflowTasks > 1 ? "s" : ""} queued beyond this week — ${pick(CARRY_FORWARD)}`,
      );
    }
    if (urgentCount > 0) {
      weeklyRecommendations.push(
        `${urgentCount} urgent task${urgentCount > 1 ? "s" : ""} — front-load these early in the week`,
      );
    }
    if (blockedCount > 0) {
      weeklyRecommendations.push(
        `${blockedCount} blocked task${blockedCount > 1 ? "s" : ""} — consider unblocking or deprioritizing`,
      );
    }
    if (issues.length === 0) {
      weeklyRecommendations.push(
        "No Jira issues assigned — a great week to get ahead on tech debt or exploratory work",
      );
    }

    return {
      startDate: toISODate(monday),
      endDate: toISODate(weekdays[weekdays.length - 1]),
      weekNumber: getISOWeekNumber(monday),
      summary,
      days,
      taskDistribution: {
        totalTasks: issues.length,
        distributedAcross: distributedDays,
        tasksPerDay,
      },
      weeklyRecommendations,
      jiraUpdates: {
        assigned: issues.length,
        urgent: urgentCount,
        blocked: blockedCount,
      },
    };
  }

  async generateDayPlan(date: Date, userId: string): Promise<DayPlan> {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const dayEnd = new Date(d);
    dayEnd.setHours(23, 59, 59, 999);

    const [assignedIssues, dayEvents] = await Promise.all([
      jiraService.getAssignedIssues(userId).catch(() => []),
      Promise.resolve(fileCalendarService.listEvents(d, dayEnd)),
    ]);

    const issues = sortIssuesByPriority(extractJiraIssues(assignedIssues));
    const dayTasks = issues.slice(0, MAX_FOCUS_TASKS_PER_DAY);

    return this.buildDayPlan(d, dayEvents, dayTasks);
  }

  private buildDayPlan(
    date: Date,
    existingEvents: any[],
    tasks: JiraIssue[],
  ): DayPlan {
    const day = date.getDay();
    const isWeekend = day === 0 || day === 6;

    if (isWeekend) {
      return {
        date: toISODate(date),
        dayOfWeek: getDayName(date),
        isWeekend: true,
        summary: "Weekend — rest and recharge",
        schedule: [
          {
            time: "09:00",
            title: "Sleep in — you've earned it",
            type: "health",
            description: "No schedule today. Rest is productive.",
          },
        ],
        priorities: [],
        recommendations: ["Enjoy your weekend — come back refreshed Monday"],
      };
    }

    const schedule: ScheduleEntry[] = [];
    const priorities: string[] = tasks.map(
      (t) => `${t.key}: ${t.summary} (${t.priority})`,
    );

    // Merge existing calendar events with the template
    if (existingEvents.length > 0) {
      this.mergeWithExistingEvents(schedule, existingEvents, tasks, date);
    } else {
      this.buildFullDayTemplate(schedule, tasks, date);
    }

    schedule.sort((a, b) => a.time.localeCompare(b.time));

    const focusCount = schedule.filter((s) => s.type === "focus").length;
    const meetingCount = schedule.filter((s) => s.type === "meeting").length;
    const freeHours = this.estimateFreeHours(schedule);

    const recommendations: string[] = [];
    if (tasks.length > 0) {
      recommendations.push(
        `${tasks.length} task${tasks.length > 1 ? "s" : ""} queued — adjust pace as you complete things naturally`,
      );
    }
    if (meetingCount > 3) {
      recommendations.push(
        "Heavy meeting day — protect at least one focus block if you can",
      );
    }
    if (focusCount === 0 && tasks.length > 0) {
      recommendations.push(
        "No focus blocks today — consider declining a meeting to make room",
      );
    }
    if (freeHours < 1) {
      recommendations.push(
        "Very little free time — be intentional about what you take on",
      );
    }

    return {
      date: toISODate(date),
      dayOfWeek: getDayName(date),
      isWeekend: false,
      summary: `${focusCount} focus, ${meetingCount} meeting${meetingCount !== 1 ? "s" : ""}, ~${freeHours}h free`,
      schedule,
      priorities,
      recommendations,
    };
  }

  private buildFullDayTemplate(
    schedule: ScheduleEntry[],
    tasks: JiraIssue[],
    date: Date,
  ): void {
    const day = date.getDay();

    // Morning exercise (Mon/Wed/Fri)
    if (EXERCISE_DAYS.includes(day)) {
      schedule.push({
        time: "07:00",
        title: "Morning exercise",
        type: "health",
        description: "1 hour — movement sets up the whole day",
      });
    }

    // Morning routine
    schedule.push({
      time: "08:30",
      title: "Morning routine — coffee, review priorities",
      type: "health",
      description: "Ease in — check messages, set your intention",
    });

    // Standup
    schedule.push({
      time: "09:00",
      title: "Morning standup / planning",
      type: "meeting",
    });

    // Morning focus blocks
    const morningTimes = ["09:30", "11:00"];
    for (let i = 0; i < morningTimes.length; i++) {
      if (tasks[i]) {
        schedule.push({
          time: morningTimes[i],
          title: `Focus: ${tasks[i].key} — ${tasks[i].summary}`,
          type: "focus",
          jiraKey: tasks[i].key,
          description: pick(MORNING_FOCUS),
        });
      } else {
        schedule.push({
          time: morningTimes[i],
          title: "Focus block — pick something meaningful",
          type: "focus",
          description: pick(MORNING_FOCUS),
        });
      }
    }

    // Lunch
    schedule.push({
      time: "12:00",
      title: "Lunch break",
      type: "health",
      description: pick(LUNCH_MESSAGES),
    });

    // Afternoon focus blocks
    const afternoonTimes = ["13:00", "14:30"];
    for (let i = 0; i < afternoonTimes.length; i++) {
      const taskIdx = morningTimes.length + i;
      if (tasks[taskIdx]) {
        schedule.push({
          time: afternoonTimes[i],
          title: `Focus: ${tasks[taskIdx].key} — ${tasks[taskIdx].summary}`,
          type: "focus",
          jiraKey: tasks[taskIdx].key,
          description: pick(AFTERNOON_FOCUS),
        });
      } else {
        schedule.push({
          time: afternoonTimes[i],
          title: "Deep work — explore, refactor, or catch up",
          type: "focus",
          description: pick(AFTERNOON_FOCUS),
        });
      }
    }

    // Afternoon reset
    schedule.push({
      time: "14:15",
      title: "Afternoon reset — stretch, walk, breathe",
      type: "health",
      description: pick(WALK_MESSAGES),
    });

    // Review & prep
    schedule.push({
      time: "15:45",
      title: "Review progress & prep for tomorrow",
      type: "break",
      description: pick(WRAP_MESSAGES),
    });

    // Buffer time
    schedule.push({
      time: "16:15",
      title: "Buffer — async catch-up, quick wins",
      type: "break",
      description: "Wrap up loose ends before signing off",
    });
  }

  private mergeWithExistingEvents(
    schedule: ScheduleEntry[],
    existingEvents: any[],
    tasks: JiraIssue[],
    date: Date,
  ): void {
    const day = date.getDay();

    // Add exercise first if applicable
    if (EXERCISE_DAYS.includes(day)) {
      const exerciseStart = new Date(date);
      exerciseStart.setHours(7, 0, 0, 0);
      const exerciseEnd = new Date(exerciseStart.getTime() + 60 * 60000);
      const conflicts = existingEvents.filter(
        (e: any) =>
          exerciseStart < new Date(e.endTime) && exerciseEnd > new Date(e.startTime),
      );
      if (conflicts.length === 0) {
        schedule.push({
          time: "07:00",
          title: "Morning exercise",
          type: "health",
          description: "1 hour — movement sets up the whole day",
        });
      }
    }

    // Add existing events
    for (const event of existingEvents) {
      const timeStr = new Date(event.startTime).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

      let type: ScheduleEntry["type"] = "meeting";
      if (event.type === "focus") type = "focus";
      else if (["fitness", "meal", "mental_health"].includes(event.type))
        type = "health";
      else if (event.type === "other") type = "break";

      schedule.push({ time: timeStr, title: event.summary, type });
    }

    // Find gaps and fill with focus blocks
    const gaps = this.findGapsInSchedule(schedule, date);
    let taskIdx = 0;
    for (const gap of gaps) {
      if (taskIdx >= tasks.length) break;
      const gapMinutes =
        (gap.end.getTime() - gap.start.getTime()) / 60000;
      if (gapMinutes < 45) continue;

      const timeStr = gap.start.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

      const hour = gap.start.getHours();
      const isAfternoon = hour >= 12;

      schedule.push({
        time: timeStr,
        title: `Focus: ${tasks[taskIdx].key} — ${tasks[taskIdx].summary}`,
        type: "focus",
        jiraKey: tasks[taskIdx].key,
        description: isAfternoon ? pick(AFTERNOON_FOCUS) : pick(MORNING_FOCUS),
      });
      taskIdx++;
    }

    // Add lunch if not present
    const hasLunch = schedule.some(
      (s) => s.type === "health" && s.time.startsWith("12"),
    );
    if (!hasLunch) {
      const lunchSlot = this.findGapAround(schedule, date, 12, 0, 60);
      if (lunchSlot) {
        schedule.push({
          time: "12:00",
          title: "Lunch break",
          type: "health",
          description: pick(LUNCH_MESSAGES),
        });
      }
    }

    // Add afternoon walk if not present
    const hasAfternoonBreak = schedule.some(
      (s) => s.type === "health" && s.time >= "14:00" && s.time < "16:00",
    );
    if (!hasAfternoonBreak) {
      const walkSlot = this.findGapAround(schedule, date, 14, 15, 15);
      if (walkSlot) {
        schedule.push({
          time: "14:15",
          title: "Afternoon reset — stretch, walk, breathe",
          type: "health",
          description: pick(WALK_MESSAGES),
        });
      }
    }
  }

  private findGapsInSchedule(
    schedule: ScheduleEntry[],
    date: Date,
  ): Array<{ start: Date; end: Date }> {
    const dayStart = new Date(date);
    dayStart.setHours(BUSINESS_HOUR_START, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(BUSINESS_HOUR_END, 0, 0, 0);

    const timeSlots = schedule
      .map((s) => {
        const [h, m] = s.time.split(":").map(Number);
        const start = new Date(date);
        start.setHours(h, m, 0, 0);
        return { start, end: new Date(start.getTime() + 90 * 60000), entry: s };
      })
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    const gaps: Array<{ start: Date; end: Date }> = [];
    let cursor = new Date(dayStart);

    for (const slot of timeSlots) {
      if (slot.start > cursor) {
        gaps.push({ start: new Date(cursor), end: new Date(slot.start) });
      }
      if (slot.end > cursor) {
        cursor = new Date(slot.end);
      }
    }

    if (cursor < dayEnd) {
      gaps.push({ start: new Date(cursor), end: new Date(dayEnd) });
    }

    return gaps.filter(
      (g) => (g.end.getTime() - g.start.getTime()) / 60000 >= 30,
    );
  }

  private findGapAround(
    schedule: ScheduleEntry[],
    date: Date,
    hour: number,
    minute: number,
    durationMinutes: number,
  ): boolean {
    const proposed = new Date(date);
    proposed.setHours(hour, minute, 0, 0);
    const proposedEnd = new Date(
      proposed.getTime() + durationMinutes * 60000,
    );

    for (const s of schedule) {
      const [h, m] = s.time.split(":").map(Number);
      const sStart = new Date(date);
      sStart.setHours(h, m, 0, 0);
      const sEnd = new Date(sStart.getTime() + 60 * 60000);
      if (proposed < sEnd && proposedEnd > sStart) return false;
    }
    return true;
  }

  private groupEventsByDay(
    events: any[],
  ): Map<string, any[]> {
    const map = new Map<string, any[]>();
    for (const event of events) {
      const dateKey = toISODate(new Date(event.startTime));
      if (!map.has(dateKey)) map.set(dateKey, []);
      map.get(dateKey)!.push(event);
    }
    return map;
  }

  private findMonday(date: Date): Date {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay();
    // If Sunday (0) go to next day (Monday), if already Monday (1) stay
    // Otherwise go back to Monday
    if (day === 0) {
      d.setDate(d.getDate() + 1);
    } else if (day !== 1) {
      d.setDate(d.getDate() - (day - 1));
    }
    return d;
  }

  private getWeekdays(startMonday: Date, totalDays: number): Date[] {
    const days: Date[] = [];
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(startMonday);
      d.setDate(d.getDate() + i);
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) {
        days.push(d);
      }
    }
    return days;
  }

  private estimateFreeHours(schedule: ScheduleEntry[]): number {
    const businessMinutes = (BUSINESS_HOUR_END - BUSINESS_HOUR_START) * 60;
    const busyMinutes = schedule
      .filter((s) => s.type === "focus" || s.type === "meeting")
      .length * 90; // rough estimate per block
    return Math.max(0, Math.round(((businessMinutes - busyMinutes) / 60) * 10) / 10);
  }

  private findLightestDay(days: DayPlan[]): string {
    let lightest = days[0];
    for (const d of days) {
      if (d.schedule.filter((s) => s.type === "focus" || s.type === "meeting").length <
        lightest.schedule.filter((s) => s.type === "focus" || s.type === "meeting").length) {
        lightest = d;
      }
    }
    return lightest.dayOfWeek;
  }

  private findHeaviestDay(days: DayPlan[]): string {
    let heaviest = days[0];
    for (const d of days) {
      if (d.schedule.filter((s) => s.type === "focus" || s.type === "meeting").length >
        heaviest.schedule.filter((s) => s.type === "focus" || s.type === "meeting").length) {
        heaviest = d;
      }
    }
    return heaviest.dayOfWeek;
  }

  private exerciseDayNames(weekdays: Date[]): string {
    const days = weekdays
      .filter((d) => EXERCISE_DAYS.includes(d.getDay()))
      .map((d) => d.toLocaleDateString("en-US", { weekday: "short" }));
    return days.join("/") || "none";
  }

  private formatShortDate(d: Date): string {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
}

export const weeklyPlanner = new WeeklyPlanner();