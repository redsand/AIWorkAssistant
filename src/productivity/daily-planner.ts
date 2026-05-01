import { jiraService } from "../integrations/jira/jira-service";
import { fileCalendarService } from "../integrations/file/calendar-service";

interface DailyPlan {
  date: string;
  summary: string;
  priorities: string[];
  schedule: Array<{
    time: string;
    title: string;
    type: "meeting" | "focus" | "health" | "break";
  }>;
  jiraUpdates: {
    assigned: number;
    urgent: number;
    blocked: number;
  };
  gitlabActivity: {
    commits: number;
    mergeRequests: number;
  };
  recommendations: string[];
}

class DailyPlanner {
  async generatePlan(date: Date, userId: string): Promise<DailyPlan> {
    console.log(`[Daily Planner] Generating plan for ${date}`);

    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const dayEnd = new Date(d);
    dayEnd.setHours(23, 59, 59, 999);

    const assignedIssues = await jiraService.getAssignedIssues(userId);
    const calendarEvents = fileCalendarService.listEvents(d, dayEnd);

    const day = d.getDay();
    const isWeekend = day === 0 || day === 6;

    if (isWeekend) {
      return {
        date: date.toISOString().split("T")[0],
        summary: "Weekend - no work scheduled",
        priorities: [],
        schedule: [],
        jiraUpdates: {
          assigned: assignedIssues.length,
          urgent: 0,
          blocked: 0,
        },
        gitlabActivity: { commits: 0, mergeRequests: 0 },
        recommendations: ["Enjoy your weekend!"],
      };
    }

    const priorities: string[] = [];
    const schedule: DailyPlan["schedule"] = [];

    for (const event of calendarEvents) {
      const timeStr = event.startTime.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

      let type: DailyPlan["schedule"][0]["type"] = "meeting";
      if (event.type === "focus") type = "focus";
      else if (["fitness", "meal", "mental_health"].includes(event.type))
        type = "health";
      else if (event.type === "other") type = "break";

      schedule.push({ time: timeStr, title: event.summary, type });
    }

    const businessStart = new Date(d);
    businessStart.setHours(9, 0, 0, 0);
    const businessEnd = new Date(d);
    businessEnd.setHours(17, 0, 0, 0);

    if (calendarEvents.length === 0) {
      schedule.push(
        { time: "09:00", title: "Morning standup / planning", type: "meeting" },
        { time: "09:30", title: "Focus block: Deep work", type: "focus" },
        { time: "12:00", title: "Lunch break", type: "health" },
        { time: "13:00", title: "Focus block: Implementation", type: "focus" },
        {
          time: "15:00",
          title: "Code review / collaboration",
          type: "meeting",
        },
        { time: "15:30", title: "Focus block: Wrap up tasks", type: "focus" },
      );
    }

    for (const issue of assignedIssues.slice(0, 5)) {
      const summary =
        (issue as any).fields?.summary ||
        (issue as any).summary ||
        `Issue ${(issue as any).key}`;
      priorities.push(`${(issue as any).key}: ${summary}`);
    }

    if (priorities.length === 0) {
      priorities.push("No urgent Jira issues assigned");
    }

    schedule.sort((a, b) => a.time.localeCompare(b.time));

    const freeMinutes = this.calculateFreeMinutes(calendarEvents, d);
    const recommendations: string[] = [];
    if (freeMinutes < 120) {
      recommendations.push(
        "Heavy meeting day - consider declining non-essential meetings",
      );
    }
    if (assignedIssues.length > 5) {
      recommendations.push(
        `${assignedIssues.length} Jira issues assigned - consider triaging`,
      );
    }
    if (freeMinutes >= 240) {
      recommendations.push(
        "Good availability for deep work - schedule focus blocks",
      );
    }

    return {
      date: date.toISOString().split("T")[0],
      summary: `${calendarEvents.length} events, ${assignedIssues.length} Jira issues, ${Math.round((freeMinutes / 60) * 10) / 10}h free`,
      priorities,
      schedule,
      jiraUpdates: {
        assigned: assignedIssues.length,
        urgent: assignedIssues.filter((i: any) => {
          const p = i.fields?.priority?.name?.toLowerCase() || "";
          return p.includes("highest") || p.includes("high");
        }).length,
        blocked: assignedIssues.filter((i: any) => {
          const s = i.fields?.status?.name?.toLowerCase() || "";
          return s.includes("blocked");
        }).length,
      },
      gitlabActivity: { commits: 0, mergeRequests: 0 },
      recommendations,
    };
  }

  private calculateFreeMinutes(
    events: Array<{ startTime: Date; endTime: Date }>,
    date: Date,
  ): number {
    const dayStart = new Date(date);
    dayStart.setHours(9, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(17, 0, 0, 0);

    const sorted = [...events]
      .filter((e) => e.startTime >= dayStart && e.endTime <= dayEnd)
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    let freeMs = dayEnd.getTime() - dayStart.getTime();
    for (const e of sorted) {
      freeMs -=
        Math.min(e.endTime.getTime(), dayEnd.getTime()) -
        Math.max(e.startTime.getTime(), dayStart.getTime());
    }
    return Math.max(0, freeMs / 60000);
  }
}

export const dailyPlanner = new DailyPlanner();
