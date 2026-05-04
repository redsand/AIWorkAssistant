import { weeklyPlanner } from "./weekly-planner";
import { jiraService } from "../integrations/jira/jira-service";
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

class DailyPlanner {
  async generatePlan(date: Date, userId: string): Promise<DailyPlan> {
    const dayPlan = await weeklyPlanner.generateDayPlan(date, userId);

    const assignedIssues = await jiraService.getAssignedIssues(userId).catch(() => []);
    const urgentCount = assignedIssues.filter((i: any) => {
      const p = i.fields?.priority?.name?.toLowerCase() || "";
      return p.includes("highest") || p.includes("high");
    }).length;
    const blockedCount = assignedIssues.filter((i: any) => {
      const s = i.fields?.status?.name?.toLowerCase() || "";
      return s.includes("blocked");
    }).length;

    const gitlabActivity = await this.getGitLabActivity(date);

    return {
      date: dayPlan.date,
      summary: dayPlan.summary,
      priorities: dayPlan.priorities,
      schedule: dayPlan.schedule.map((s) => ({
        time: s.time,
        title: s.title,
        type: s.type,
        jiraKey: s.jiraKey,
      })),
      jiraUpdates: {
        assigned: assignedIssues.length,
        urgent: urgentCount,
        blocked: blockedCount,
      },
      gitlabActivity,
      recommendations: dayPlan.recommendations,
    };
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