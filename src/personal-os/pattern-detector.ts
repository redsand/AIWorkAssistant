import type { BriefData, PatternMatch } from "./types";

class PatternDetector {
  detectRecurringPatterns(
    data: BriefData,
    daysBack: number,
  ): PatternMatch[] {
    const patterns: PatternMatch[] = [];

    // Recurring task types from work items
    const typeCounts: Record<string, number> = {};
    for (const item of data.workItems) {
      if (item.status !== "done" && item.status !== "archived") {
        typeCounts[item.type] = (typeCounts[item.type] || 0) + 1;
      }
    }
    for (const [type, count] of Object.entries(typeCounts)) {
      if (count >= 3) {
        patterns.push({
          pattern: `${count} open ${type.replace(/_/g, " ")} items`,
          frequency: `${count} over ${daysBack} days`,
          category: "recurring_task",
          evidence: [`${count} items of type "${type}" are currently open`],
        });
      }
    }

    // Meeting overload from calendar
    const meetingMinutesByDay: Record<string, number> = {};
    for (const event of data.calendar) {
      const day = String(event.startTime || "").slice(0, 10);
      if (!day) continue;
      const start = new Date(event.startTime);
      const end = new Date(event.endTime);
      const durationMin = (end.getTime() - start.getTime()) / 60000;
      if (durationMin > 0 && !Number.isNaN(durationMin)) {
        meetingMinutesByDay[day] = (meetingMinutesByDay[day] || 0) + durationMin;
      }
    }
    for (const [day, minutes] of Object.entries(meetingMinutesByDay)) {
      const hours = minutes / 60;
      if (hours >= 4) {
        patterns.push({
          pattern: `${hours.toFixed(1)} hours of meetings on ${day}`,
          frequency: `${hours.toFixed(1)}h on that day`,
          category: "meeting_overload",
          evidence: [`${Math.round(minutes)} minutes of meetings on ${day}`],
        });
      }
    }

    // Review bottleneck from open PRs/MRs
    const reviewCount =
      data.github.pullRequests.length + data.gitlab.mergeRequests.length;
    if (reviewCount >= 3) {
      patterns.push({
        pattern: `${reviewCount} open PRs/MRs awaiting review`,
        frequency: `${reviewCount} currently open`,
        category: "review_bottleneck",
        evidence: [
          `${data.github.pullRequests.length} GitHub PRs`,
          `${data.gitlab.mergeRequests.length} GitLab MRs`,
        ],
      });
    }

    // Support spike from Jitbit
    if (data.jitbit.recent.length >= 5) {
      patterns.push({
        pattern: `${data.jitbit.recent.length} recent support tickets`,
        frequency: `${data.jitbit.recent.length} in the last ${daysBack} days`,
        category: "support_spike",
        evidence: [
          `${data.jitbit.recent.length} recent tickets`,
          `${data.jitbit.highPriority.length} high priority`,
        ],
      });
    }

    // Context switching from touching many tool sources
    const activeSources: string[] = [];
    if (data.calendar.length > 0) activeSources.push("calendar");
    if (data.jira.length > 0) activeSources.push("jira");
    if (data.gitlab.mergeRequests.length > 0 || data.gitlab.commits.length > 0)
      activeSources.push("gitlab");
    if (data.github.pullRequests.length > 0 || data.github.commits.length > 0)
      activeSources.push("github");
    if (data.workItems.length > 0) activeSources.push("work items");
    if (data.jitbit.recent.length > 0) activeSources.push("jitbit");
    if (activeSources.length >= 4) {
      patterns.push({
        pattern: `Active across ${activeSources.length} sources`,
        frequency: `${activeSources.length} sources active`,
        category: "context_switch",
        evidence: activeSources.map((s) => `Active in ${s}`),
      });
    }

    return patterns;
  }
}

export const patternDetector = new PatternDetector();