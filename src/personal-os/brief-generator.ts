import { fileCalendarService } from "../integrations/file/calendar-service";
import { jiraClient } from "../integrations/jira/jira-client";
import { gitlabClient } from "../integrations/gitlab/gitlab-client";
import { githubClient } from "../integrations/github/github-client";
import { jitbitService } from "../integrations/jitbit/jitbit-service";
import { roadmapDatabase } from "../roadmap/database";
import { workItemDatabase } from "../work-items/database";
import { conversationManager } from "../memory/conversation-manager";
import { openLoopSummarizer } from "./open-loop-summarizer";
import { patternDetector } from "./pattern-detector";
import { delegationSuggester } from "./delegation-suggester";
import { focusBlockSuggester } from "./focus-block-suggester";
import type {
  PersonalBriefParams,
  PersonalBriefResult,
  BriefData,
  TodaysLoadSection,
  StopSuggestion,
} from "./types";
import type { WorkItem, WorkItemCreateParams } from "../work-items/types";

class PersonalOsBriefGenerator {
  async generatePersonalBrief(
    params: PersonalBriefParams,
  ): Promise<PersonalBriefResult> {
    const date = this.normalizeDate(params.date);
    const daysBack = this.clampDays(params.daysBack);
    const include = this.resolveIncludes(params);
    const sources: Record<string, { enabled: boolean; available: boolean; error?: string }> = {};
    const data: BriefData = {
      calendar: [],
      jira: [],
      gitlab: { mergeRequests: [], pipelines: [], commits: [] },
      github: { pullRequests: [], workflowRuns: [], commits: [], releases: [] },
      roadmaps: [],
      workItems: [],
      jitbit: { recent: [], followups: [], highPriority: [] },
      memories: [],
    };

    if (include.calendar) {
      await this.collect("calendar", sources, async () => {
        const start = new Date(`${date}T00:00:00`);
        const end = new Date(`${date}T23:59:59`);
        data.calendar = fileCalendarService.listEvents(start, end);
      });
    } else {
      sources.calendar = { enabled: false, available: false };
    }

    if (include.jira) {
      await this.collect("jira", sources, async () => {
        if (!jiraClient.isConfigured()) throw new Error("Jira client not configured");
        const jql = `updated >= -${daysBack}d ORDER BY updated DESC`;
        data.jira = await jiraClient.searchIssues(jql, 25);
      });
    } else {
      sources.jira = { enabled: false, available: false };
    }

    if (include.gitLab) {
      await this.collect("gitlab", sources, async () => {
        if (!gitlabClient.isConfigured()) throw new Error("GitLab client not configured");
        const defaultProject = gitlabClient.getDefaultProject() || undefined;
        const [mergeRequests, pipelines, commits] = await Promise.all([
          gitlabClient.getMergeRequests(defaultProject, "opened").catch(() => []),
          gitlabClient.listPipelines(defaultProject).catch(() => []),
          gitlabClient.getCommits(defaultProject, "main", this.daysAgoIso(daysBack)).catch(() => []),
        ]);
        data.gitlab = { mergeRequests, pipelines, commits };
      });
    } else {
      sources.gitlab = { enabled: false, available: false };
    }

    if (include.gitHub) {
      await this.collect("github", sources, async () => {
        if (!githubClient.isConfigured()) throw new Error("GitHub client not configured");
        const [pullRequests, workflowRuns, commits, releases] = await Promise.all([
          githubClient.listPullRequests("open").catch(() => []),
          githubClient.listWorkflowRuns().catch(() => []),
          githubClient.listCommits(undefined, undefined, 15).catch(() => []),
          githubClient.listReleases().catch(() => []),
        ]);
        data.github = { pullRequests, workflowRuns, commits, releases };
      });
    } else {
      sources.github = { enabled: false, available: false };
    }

    if (include.roadmap) {
      await this.collect("roadmap", sources, async () => {
        const roadmaps = roadmapDatabase.listRoadmaps({ status: "active" }).slice(0, 10);
        data.roadmaps = roadmaps.map((roadmap) => ({
          ...roadmap,
          milestones: roadmapDatabase.getMilestones(roadmap.id).map((milestone) => ({
            ...milestone,
            items: roadmapDatabase.getItems(milestone.id),
          })),
        }));
      });
    } else {
      sources.roadmap = { enabled: false, available: false };
    }

    if (include.workItems) {
      await this.collect("workItems", sources, async () => {
        data.workItems = workItemDatabase.listWorkItems({
          includeArchived: false,
          limit: 100,
        }).items;
      });
    } else {
      sources.workItems = { enabled: false, available: false };
    }

    if (include.jitbit) {
      await this.collect("jitbit", sources, async () => {
        if (!jitbitService.isConfigured()) throw new Error("Jitbit client not configured");
        const [recent, followups, highPriority] = await Promise.all([
          jitbitService.getRecentCustomerActivity({ days: daysBack, limit: 20 }).catch(() => []),
          jitbitService.findTicketsNeedingFollowup({ daysSinceUpdate: 3, limit: 15 }).catch(() => []),
          jitbitService.findHighPriorityOpenTickets(15).catch(() => []),
        ]);
        data.jitbit = { recent, followups, highPriority };
      });
    } else {
      sources.jitbit = { enabled: false, available: false };
    }

    await this.collect("memory", sources, async () => {
      data.memories = conversationManager.getRelevantMemories(
        params.userId,
        "personal operating system decisions blockers patterns focus delegation",
        5,
      );
    });

    // Run sub-modules on collected data
    const { openLoops, decisionsWaiting } = openLoopSummarizer.summarizeOpenLoops(data);
    const recurringPatterns = patternDetector.detectRecurringPatterns(data, daysBack);
    const suggestedDelegations = delegationSuggester.suggestDelegations(data.workItems);
    const suggestedFocusBlocks = focusBlockSuggester.suggestFocusBlocks(
      data.calendar,
      openLoops,
      date,
      60,
    );
    const energyRisks = [
      ...focusBlockSuggester.detectEnergyRisks(data.calendar, suggestedFocusBlocks),
      ...this.detectContextSwitchRisks(data),
    ];
    const thingsToStop = this.buildStopSuggestions(recurringPatterns, energyRisks);
    const todaysLoad = this.buildTodaysLoad(data, date);
    const workItemsToCreate = this.buildSuggestedWorkItems(date, data, openLoops);
    const markdown = this.renderMarkdown(date, daysBack, todaysLoad, openLoops, decisionsWaiting, recurringPatterns, suggestedDelegations, suggestedFocusBlocks, energyRisks, thingsToStop, workItemsToCreate, sources);

    return {
      date,
      markdown,
      todaysLoad,
      openLoops,
      decisionsWaiting,
      recurringPatterns,
      suggestedDelegations,
      suggestedFocusBlocks,
      energyRisks,
      thingsToStop,
      workItemsToCreate,
      sources,
    };
  }

  createSuggestedWorkItems(items: WorkItemCreateParams[]): WorkItem[] {
    return items.map((item) =>
      workItemDatabase.createWorkItem({
        ...item,
        status: item.status ?? "proposed",
        source: item.source ?? "chat",
        tags: Array.from(new Set([...(item.tags ?? []), "personal-os"])),
      }),
    );
  }

  private detectContextSwitchRisks(data: BriefData): Array<import("./types").EnergyRisk> {
    const risks: Array<import("./types").EnergyRisk> = [];
    const activeSources: string[] = [];
    if (data.calendar.length > 0) activeSources.push("calendar");
    if (data.jira.length > 0) activeSources.push("jira");
    if (data.gitlab.mergeRequests.length > 0 || data.gitlab.commits.length > 0) activeSources.push("gitlab");
    if (data.github.pullRequests.length > 0 || data.github.commits.length > 0) activeSources.push("github");
    if (data.workItems.length > 0) activeSources.push("work items");
    if (data.jitbit.recent.length > 0) activeSources.push("jitbit");

    if (activeSources.length >= 4) {
      risks.push({
        type: "context_switch",
        description: `Active across ${activeSources.length} sources today — expect context-switching overhead`,
        severity: activeSources.length >= 6 ? "high" : "medium",
      });
    }
    return risks;
  }

  private buildStopSuggestions(
    patterns: Array<import("./types").PatternMatch>,
    energyRisks: Array<import("./types").EnergyRisk>,
  ): StopSuggestion[] {
    const suggestions: StopSuggestion[] = [];

    for (const pattern of patterns) {
      if (pattern.category === "meeting_overload") {
        suggestions.push({
          title: "Decline non-essential meetings on heavy days",
          reason: pattern.pattern,
          category: "meeting",
        });
      }
      if (pattern.category === "context_switch") {
        suggestions.push({
          title: "Batch similar tasks together",
          reason: pattern.pattern,
          category: "habit",
        });
      }
      if (pattern.category === "review_bottleneck") {
        suggestions.push({
          title: "Set a daily review block and batch reviews",
          reason: pattern.pattern,
          category: "process",
        });
      }
      if (pattern.category === "support_spike") {
        suggestions.push({
          title: "Delegate routine support to the team",
          reason: pattern.pattern,
          category: "task",
        });
      }
    }

    for (const risk of energyRisks) {
      if (risk.type === "no_breaks") {
        suggestions.push({
          title: "Protect a 15-minute break between meetings",
          reason: risk.description,
          category: "habit",
        });
      }
      if (risk.type === "late_day_deep_work") {
        suggestions.push({
          title: "Move deep work to morning if possible",
          reason: risk.description,
          category: "habit",
        });
      }
    }

    // Deduplicate by title
    const seen = new Set<string>();
    return suggestions.filter((s) => {
      if (seen.has(s.title)) return false;
      seen.add(s.title);
      return true;
    });
  }

  private buildTodaysLoad(data: BriefData, date: string): TodaysLoadSection {
    const overdue = data.workItems.filter(
      (item) => item.dueAt && item.dueAt.slice(0, 10) < date && item.status !== "done" && item.status !== "archived",
    );
    const failedPipelines = data.gitlab.pipelines.filter((p) =>
      String(p.status || "").toLowerCase().includes("fail"),
    );
    const failedRuns = data.github.workflowRuns.filter((run) =>
      String(run.conclusion || run.status || "").toLowerCase().includes("fail"),
    );

    return {
      calendarEventCount: data.calendar.length,
      openWorkItemCount: data.workItems.filter((i) => i.status === "active" || i.status === "planned").length,
      blockedWorkItemCount: data.workItems.filter((i) => i.status === "blocked").length,
      waitingWorkItemCount: data.workItems.filter((i) => i.status === "waiting").length,
      overdueWorkItemCount: overdue.length,
      openPRCount: data.github.pullRequests.length,
      openMRCount: data.gitlab.mergeRequests.length,
      highPriorityTicketCount: data.jitbit.highPriority.length,
      failedPipelineCount: failedPipelines.length + failedRuns.length,
    };
  }

  private buildSuggestedWorkItems(
    date: string,
    data: BriefData,
    openLoops: Array<import("./types").OpenLoop>,
  ): WorkItemCreateParams[] {
    const suggestions: WorkItemCreateParams[] = [];

    // Suggest personal items for critical/high open loops
    for (const loop of openLoops.filter((l) => l.urgency === "critical" || l.urgency === "high").slice(0, 5)) {
      suggestions.push({
        type: "personal",
        title: `Resolve: ${loop.title}`,
        description: `Open loop from ${loop.source}: ${loop.title}`,
        priority: loop.urgency === "critical" ? "high" : "medium",
        source: "chat",
        dueAt: date,
        tags: ["personal-os", loop.source],
      });
    }

    // Suggest follow-up for Jitbit high priority
    for (const ticket of data.jitbit.highPriority.slice(0, 3)) {
      const title = ticket.Subject || ticket.Title || `Ticket #${ticket.TicketID || "?"}`;
      suggestions.push({
        type: "customer_followup",
        title: `Follow up: ${title}`,
        description: `High-priority support ticket`,
        priority: "high",
        source: "jitbit",
        sourceExternalId: String(ticket.TicketID || ticket.IssueID || ""),
        dueAt: date,
        tags: ["personal-os", "customer"],
      });
    }

    // Suggest review items for open PRs/MRs
    for (const pr of data.github.pullRequests.slice(0, 2)) {
      suggestions.push({
        type: "code_review",
        title: `Review PR #${pr.number || "?"}: ${pr.title || "untitled"}`,
        description: pr.html_url || "GitHub pull request",
        priority: "medium",
        source: "github",
        sourceUrl: pr.html_url,
        dueAt: date,
        tags: ["personal-os", "review"],
      });
    }

    return suggestions.slice(0, 10);
  }

  private renderMarkdown(
    date: string,
    daysBack: number,
    todaysLoad: TodaysLoadSection,
    openLoops: Array<import("./types").OpenLoop>,
    decisionsWaiting: Array<import("./types").DecisionItem>,
    recurringPatterns: Array<import("./types").PatternMatch>,
    suggestedDelegations: Array<import("./types").DelegationCandidate>,
    suggestedFocusBlocks: Array<import("./types").FocusBlockSuggestion>,
    energyRisks: Array<import("./types").EnergyRisk>,
    thingsToStop: StopSuggestion[],
    workItemsToCreate: WorkItemCreateParams[],
    sources: Record<string, { enabled: boolean; available: boolean; error?: string }>,
  ): string {
    const unavailable = Object.entries(sources)
      .filter(([, status]) => status.enabled && !status.available)
      .map(([name, status]) => `${name}: ${status.error || "unavailable"}`);

    const lines = [
      `# Personal OS Brief — ${date}`,
      "",
      "## Today's Load",
      ...this.listOrFallback([
        `- ${todaysLoad.calendarEventCount} calendar event(s)`,
        `- ${todaysLoad.openWorkItemCount} open work item(s)`,
        `- ${todaysLoad.blockedWorkItemCount} blocked, ${todaysLoad.waitingWorkItemCount} waiting, ${todaysLoad.overdueWorkItemCount} overdue`,
        `- ${todaysLoad.openPRCount} open GitHub PR(s), ${todaysLoad.openMRCount} GitLab MR(s)`,
        `- ${todaysLoad.highPriorityTicketCount} high-priority support ticket(s)`,
        `- ${todaysLoad.failedPipelineCount} failed pipeline/workflow run(s)`,
      ], "- No load data available."),
      "",
      "## Open Loops",
      ...this.listOrFallback(
        openLoops.slice(0, 10).map((l) => `- [${l.urgency}] ${l.title} (${l.source})`),
        "- No open loops detected.",
      ),
      "",
      "## Decisions Waiting on Tim",
      ...this.listOrFallback(
        decisionsWaiting.slice(0, 8).map((d) => `- ${d.title} — ${d.context}`),
        "- No pending decisions found.",
      ),
      "",
      "## Recurring Patterns",
      ...this.listOrFallback(
        recurringPatterns.map((p) => `- **${p.category.replace(/_/g, " ")}**: ${p.pattern}`),
        "- No recurring patterns detected.",
      ),
      "",
      "## Suggested Delegations",
      ...this.listOrFallback(
        suggestedDelegations.map((d) => `- ${d.title} → ${d.delegatableTo} (${d.priority} priority)`),
        "- No delegations suggested.",
      ),
      "",
      "## Suggested Focus Blocks",
      ...this.listOrFallback(
        suggestedFocusBlocks.map((b) => `- ${this.formatTime(b.startTime)} for ${b.durationMinutes}min: ${b.title} (${b.reason})`),
        "- No focus blocks available today.",
      ),
      "",
      "## Energy / Context Switching Risks",
      ...this.listOrFallback(
        energyRisks.map((r) => `- [${r.severity}] ${r.description}${r.affectedTime ? ` (${r.affectedTime})` : ""}`),
        "- No significant energy risks detected.",
      ),
      "",
      "## Things To Stop Doing",
      ...this.listOrFallback(
        thingsToStop.map((s) => `- **${s.title}** (${s.category}): ${s.reason}`),
        "- No stop suggestions at this time.",
      ),
      "",
      "## Work Items To Create",
      ...this.listOrFallback(
        workItemsToCreate.map((w) => `- [${w.priority}] ${w.title}`),
        "- No work items to suggest.",
      ),
    ];

    if (unavailable.length > 0) {
      lines.push("", `Data window: last ${daysBack} day(s). Unavailable sources: ${unavailable.join("; ")}.`);
    } else {
      lines.push("", `Data window: last ${daysBack} day(s). All requested sources responded.`);
    }

    return lines.join("\n");
  }

  private formatTime(isoString: string): string {
    try {
      const d = new Date(isoString);
      if (Number.isNaN(d.getTime())) return isoString;
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return isoString;
    }
  }

  private listOrFallback(items: string[], fallback: string): string[] {
    return items.length > 0 ? items : [fallback];
  }

  private async collect(
    name: string,
    sources: Record<string, { enabled: boolean; available: boolean; error?: string }>,
    fn: () => Promise<void> | void,
  ): Promise<void> {
    try {
      await fn();
      sources[name] = { enabled: true, available: true };
    } catch (error) {
      sources[name] = {
        enabled: true,
        available: false,
        error: error instanceof Error ? error.message : "Unavailable",
      };
    }
  }

  private resolveIncludes(params: PersonalBriefParams) {
    return {
      calendar: params.includeCalendar !== false,
      jira: params.includeJira !== false,
      gitLab: params.includeGitLab !== false,
      gitHub: params.includeGitHub !== false,
      roadmap: params.includeRoadmap !== false,
      workItems: params.includeWorkItems !== false,
      jitbit: params.includeJitbit !== false,
    };
  }

  private normalizeDate(date?: string): string {
    const parsed = date ? new Date(`${date}T00:00:00`) : new Date();
    if (Number.isNaN(parsed.getTime())) return new Date().toISOString().slice(0, 10);
    return parsed.toISOString().slice(0, 10);
  }

  private clampDays(daysBack?: number): number {
    if (!daysBack || Number.isNaN(daysBack)) return 7;
    return Math.min(Math.max(Math.floor(daysBack), 1), 30);
  }

  private daysAgoIso(days: number): string {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date.toISOString();
  }
}

export const personalOsBriefGenerator = new PersonalOsBriefGenerator();