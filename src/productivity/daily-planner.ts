import { jiraService } from "../integrations/jira/jira-service";
import { fileCalendarService } from "../integrations/file/calendar-service";
import { gitlabClient } from "../integrations/gitlab/gitlab-client";

interface DailyPlan {
  date: string;
  summary: string;
  priorities: string[];
  schedule: Array<{
    time: string;
    title: string;
    type: "meeting" | "focus" | "health" | "break";
    jiraKey?: string;
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

// Exercise schedule config
const EXERCISE_DAYS = [1, 3, 5]; // Mon, Wed, Fri
const MORNING_FOCUS_SLOTS = 2;
const AFTERNOON_FOCUS_SLOTS = 2;

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
        gitlabActivity: await this.getGitLabActivity(d),
        recommendations: ["Enjoy your weekend!"],
      };
    }

    const priorities: string[] = [];
    const schedule: DailyPlan["schedule"] = [];

    // Add existing calendar events to schedule
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

    // Build a task-aware schedule if no events exist
    if (calendarEvents.length === 0) {
      // Exercise on Mon/Wed/Fri at 7am
      if (EXERCISE_DAYS.includes(day)) {
        schedule.push({
          time: "07:00",
          title: "Exercise (1 hour)",
          type: "health",
        });
      }

      // Morning planning
      schedule.push({
        time: "09:00",
        title: "Morning standup / planning",
        type: "meeting",
      });

      // Assign Jira tasks to morning focus blocks (2 tasks)
      const morningTasks = assignedIssues.slice(0, MORNING_FOCUS_SLOTS);
      const morningTimes = ["09:30", "11:00"];
      morningTasks.forEach((issue: any, i: number) => {
        const key = issue.key || "TASK";
        const summary = issue.fields?.summary || issue.summary || key;
        schedule.push({
          time: morningTimes[i],
          title: `Focus: ${key} - ${summary}`,
          type: "focus",
          jiraKey: key,
        });
      });
      // Fill remaining morning slots if not enough tasks
      for (let i = morningTasks.length; i < MORNING_FOCUS_SLOTS; i++) {
        schedule.push({
          time: morningTimes[i],
          title: `Focus block (unassigned) #${i + 1}`,
          type: "focus",
        });
      }

      // Lunch
      schedule.push({ time: "12:00", title: "Lunch break", type: "health" });

      // Afternoon focus blocks (2 tasks)
      const afternoonTasks = assignedIssues.slice(
        MORNING_FOCUS_SLOTS,
        MORNING_FOCUS_SLOTS + AFTERNOON_FOCUS_SLOTS,
      );
      const afternoonTimes = ["13:00", "14:30"];
      afternoonTasks.forEach((issue: any, i: number) => {
        const key = issue.key || "TASK";
        const summary = issue.fields?.summary || issue.summary || key;
        schedule.push({
          time: afternoonTimes[i],
          title: `Focus: ${key} - ${summary}`,
          type: "focus",
          jiraKey: key,
        });
      });
      for (let i = afternoonTasks.length; i < AFTERNOON_FOCUS_SLOTS; i++) {
        schedule.push({
          time: afternoonTimes[i],
          title: `Focus block (unassigned) #${i + 1}`,
          type: "focus",
        });
      }

      // Afternoon mental break
      schedule.push({
        time: "15:30",
        title: "Afternoon walk / mental reset",
        type: "health",
      });

      // Wrap-up
      schedule.push({
        time: "16:00",
        title: "Wrap up / review progress",
        type: "meeting",
      });
    }

    // Build priorities from Jira issues
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

    // Task pace recommendation
    const totalFocusSlots = MORNING_FOCUS_SLOTS + AFTERNOON_FOCUS_SLOTS;
    const taskCount = Math.min(assignedIssues.length, totalFocusSlots);
    if (taskCount > 0) {
      recommendations.push(
        `Targeting ${taskCount} task${taskCount > 1 ? "s" : ""} today — adjust pace as tasks complete organically`,
      );
    }
    if (assignedIssues.length > totalFocusSlots) {
      recommendations.push(
        `${assignedIssues.length - totalFocusSlots} more tasks queued — pick up extras if ahead of pace`,
      );
    }

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

    // Exercise reminder
    if (EXERCISE_DAYS.includes(day)) {
      recommendations.push("Exercise day — 1 hour workout scheduled");
    } else {
      recommendations.push("Rest day from exercise — focus on recovery");
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

  private async getGitLabActivity(date: Date): Promise<{
    commits: number;
    mergeRequests: number;
  }> {
    if (!gitlabClient.isConfigured()) {
      return { commits: 0, mergeRequests: 0 };
    }

    try {
      const dayStart = date.toISOString();
      const dayEndDate = new Date(date);
      dayEndDate.setHours(23, 59, 59, 999);

      const [commits, mergeRequests] = await Promise.all([
        gitlabClient.getCommits(undefined, "main", dayStart).catch(() => []),
        gitlabClient.getMergeRequests(undefined, "all").catch(() => []),
      ]);

      const todayMRs = mergeRequests.filter((mr) => {
        const createdAt = new Date(mr.created_at);
        return createdAt >= date && createdAt <= dayEndDate;
      });

      return {
        commits: commits.length,
        mergeRequests: todayMRs.length,
      };
    } catch (error) {
      console.error("[Daily Planner] Failed to fetch GitLab activity:", error);
      return { commits: 0, mergeRequests: 0 };
    }
  }
}

export const dailyPlanner = new DailyPlanner();
