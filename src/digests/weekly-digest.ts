import { fileCalendarService } from "../integrations/file/calendar-service";
import { jiraClient } from "../integrations/jira/jira-client";
import { gitlabClient } from "../integrations/gitlab/gitlab-client";
import { githubClient } from "../integrations/github/github-client";
import { jitbitService } from "../integrations/jitbit/jitbit-service";
import { hawkIrService } from "../integrations/hawk-ir/hawk-ir-service";
import { roadmapDatabase } from "../roadmap/database";
import { workItemDatabase } from "../work-items/database";
import { conversationManager } from "../memory/conversation-manager";
import { agentRunDatabase } from "../agent-runs/database";
import type { WorkItem, WorkItemCreateParams } from "../work-items/types";
import type { WeeklyDigestParams, WeeklyDigestResult, WeeklyDigestData } from "./types";

type SourceStatus = WeeklyDigestResult["sources"];

class WeeklyDigestGenerator {
  async generateWeeklyDigest(params: WeeklyDigestParams): Promise<WeeklyDigestResult> {
    const { weekStart, weekEnd } = this.resolveWeekRange(params.weekStart);
    const include = this.resolveIncludes(params);
    const sources: SourceStatus = {};
    const data: WeeklyDigestData = {
      calendar: [],
      jira: [],
      gitlab: { mergeRequests: [], pipelines: [], commits: [] },
      github: { pullRequests: [], workflowRuns: [], commits: [], releases: [] },
      roadmaps: [],
      workItems: [],
      jitbit: { recent: [], followups: [], highPriority: [] },
      hawkIr: { riskyOpenCases: [], caseCount: 0, recentCases: [], activeNodes: [] },
      memories: [],
      agentRuns: { total: 0, failed: 0, lastWeek: 0 },
    };

    if (include.calendar) {
      await this.collect("calendar", sources, async () => {
        const start = new Date(`${weekStart}T00:00:00`);
        const end = new Date(`${weekEnd}T23:59:59`);
        data.calendar = fileCalendarService.listEvents(start, end);
      });
    } else {
      sources.calendar = { enabled: false, available: false };
    }

    if (include.jira) {
      await this.collect("jira", sources, async () => {
        if (!jiraClient.isConfigured()) throw new Error("Jira client not configured");
        const jql = `updated >= "${weekStart}" ORDER BY updated DESC`;
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
          gitlabClient.getCommits(defaultProject, "main", weekStart).catch(() => []),
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
          githubClient.listCommits(undefined, undefined, 25).catch(() => []),
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
          limit: 200,
        }).items;
      });
    } else {
      sources.workItems = { enabled: false, available: false };
    }

    if (include.jitbit) {
      await this.collect("jitbit", sources, async () => {
        if (!jitbitService.isConfigured()) throw new Error("Jitbit client not configured");
        const [recent, followups, highPriority] = await Promise.all([
          jitbitService.getRecentCustomerActivity({ days: 7, limit: 30 }).catch(() => []),
          jitbitService.findTicketsNeedingFollowup({ daysSinceUpdate: 7, limit: 20 }).catch(() => []),
          jitbitService.findHighPriorityOpenTickets(20).catch(() => []),
        ]);
        data.jitbit = { recent, followups, highPriority };
      });
    } else {
      sources.jitbit = { enabled: false, available: false };
    }

    if (include.hawkIr) {
      await this.collect("hawkIr", sources, async () => {
        if (!hawkIrService.isConfigured()) throw new Error("HAWK IR client not configured");
        const [riskyOpenCases, caseCount, recentCases, activeNodes] = await Promise.all([
          hawkIrService.getRiskyOpenCases({ minRiskLevel: "high", limit: 15 }).catch(() => []),
          hawkIrService.getCaseCount().catch(() => 0),
          hawkIrService.getRecentCases(10).catch(() => []),
          hawkIrService.getActiveNodes().catch(() => []),
        ]);
        data.hawkIr = { riskyOpenCases, caseCount, recentCases, activeNodes };
      });
    } else {
      sources.hawkIr = { enabled: false, available: false };
    }

    await this.collect("memory", sources, async () => {
      data.memories = conversationManager.getRelevantMemories(
        "tim",
        "weekly digest executive product engineering decisions blockers customer roadmap",
        8,
      );
    });

    await this.collect("agentRuns", sources, async () => {
      const stats = agentRunDatabase.getStats();
      data.agentRuns = {
        total: stats.totalRuns,
        failed: stats.failedRuns,
        lastWeek: stats.runsLast24h,
      };
    });

    const suggestedWorkItems = this.buildSuggestedWorkItems(weekStart, data);
    const markdown = this.renderMarkdown(weekStart, weekEnd, data, sources, suggestedWorkItems);
    return { weekStart, weekEnd, markdown, suggestedWorkItems, sources };
  }

  createSuggestedWorkItems(items: WorkItemCreateParams[]): WorkItem[] {
    return items.map((item) =>
      workItemDatabase.createWorkItem({
        ...item,
        status: item.status ?? "proposed",
        source: item.source ?? "chat",
        tags: Array.from(new Set([...(item.tags ?? []), "weekly-digest"])),
      }),
    );
  }

  private async collect(
    name: string,
    sources: SourceStatus,
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

  private resolveIncludes(params: WeeklyDigestParams) {
    return {
      calendar: params.includeCalendar !== false,
      jira: params.includeJira !== false,
      gitLab: params.includeGitLab !== false,
      gitHub: params.includeGitHub !== false,
      roadmap: params.includeRoadmap !== false,
      workItems: params.includeWorkItems !== false,
      jitbit: params.includeJitbit !== false,
      hawkIr: params.includeHawkIr !== false,
    };
  }

  private resolveWeekRange(weekStart?: string): { weekStart: string; weekEnd: string } {
    let start: Date;
    if (weekStart) {
      start = new Date(`${weekStart}T00:00:00`);
      if (Number.isNaN(start.getTime())) start = this.getMonday(new Date());
    } else {
      start = this.getMonday(new Date());
    }
    // Snap to Monday if the provided date isn't Monday
    const day = start.getDay();
    const offset = day === 0 ? -6 : 1 - day;
    start.setDate(start.getDate() + offset);
    const weekStartStr = start.toISOString().slice(0, 10);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const weekEndStr = end.toISOString().slice(0, 10);
    return { weekStart: weekStartStr, weekEnd: weekEndStr };
  }

  private getMonday(date: Date): Date {
    const d = new Date(date);
    const day = d.getDay();
    const offset = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + offset);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  private renderMarkdown(
    weekStart: string,
    weekEnd: string,
    data: WeeklyDigestData,
    sources: SourceStatus,
    suggestedWorkItems: WorkItemCreateParams[],
  ): string {
    const lines = [
      `# Weekly Digest — Week of ${weekStart}`,
      "",
      "## Executive Summary",
      ...this.executiveSummary(data, sources),
      "",
      "## Customer / Support Signals",
      ...this.customerSignals(data.jitbit),
      "",
      "## Engineering Progress",
      ...this.engineeringProgress(data),
      "",
      "## Product / Roadmap Progress",
      ...this.productRoadmapProgress(data.roadmaps),
      "",
      "## Open Risks",
      ...this.openRisks(data, sources),
      "",
      "## Decisions Needed",
      ...this.decisionsNeeded(data),
      "",
      "## Work Completed",
      ...this.workCompleted(data.workItems, weekStart, weekEnd),
      "",
      "## Work Blocked",
      ...this.workBlocked(data.workItems),
      "",
      "## Follow-ups",
      ...this.followUps(data, weekStart),
      "",
      "## Suggested Next Week Focus",
      ...this.suggestedNextWeek(data, suggestedWorkItems),
      "",
      "## Draft Internal Update",
      ...this.draftInternalUpdate(data, weekStart, weekEnd),
    ];

    const unavailable = Object.entries(sources)
      .filter(([, status]) => status.enabled && !status.available)
      .map(([name, status]) => `${name}: ${status.error || "unavailable"}`);

    if (unavailable.length > 0) {
      lines.push("", `Unavailable sources: ${unavailable.join("; ")}.`);
    }

    return lines.join("\n");
  }

  private executiveSummary(data: WeeklyDigestData, sources: SourceStatus): string[] {
    const bullets = [
      `- Calendar: ${data.calendar.length} event(s) this week.`,
      `- Customer/support: ${data.jitbit.recent.length} recent ticket(s), ${data.jitbit.followups.length} follow-up candidate(s), ${data.jitbit.highPriority.length} high-priority.`,
      `- IR: ${data.hawkIr.caseCount} total case(s), ${data.hawkIr.riskyOpenCases.length} high-risk unescalated, ${data.hawkIr.activeNodes.length} active node(s).`,
      `- Engineering: ${data.github.pullRequests.length} open GitHub PR(s), ${data.gitlab.mergeRequests.length} open GitLab MR(s).`,
      `- Product/roadmap: ${data.roadmaps.length} active roadmap(s).`,
      `- Work items: ${data.workItems.length} total, ${data.workItems.filter((i) => i.status === "blocked").length} blocked, ${data.workItems.filter((i) => i.status === "waiting").length} waiting.`,
      `- Agent runs: ${data.agentRuns.total} total, ${data.agentRuns.failed} failed.`,
    ];
    if (data.memories.length > 0) bullets.push(`- Memory surfaced ${data.memories.length} relevant context item(s).`);
    const unavailable = Object.entries(sources).filter(([, s]) => s.enabled && !s.available);
    if (unavailable.length > 0) bullets.push(`- Some integrations were unavailable; the digest still used local and configured sources.`);
    return bullets.slice(0, 12);
  }

  private customerSignals(jitbit: WeeklyDigestData["jitbit"]): string[] {
    return this.listOrFallback([
      ...jitbit.highPriority.slice(0, 10).map((t) => `- High priority: ${this.ticketLabel(t)}`),
      ...jitbit.followups.slice(0, 10).map((t) => `- Needs follow-up: ${this.ticketLabel(t)}`),
      ...jitbit.recent.slice(0, 10).map((t) => `- Recent: ${this.ticketLabel(t)}`),
    ], "- No Jitbit customer/support activity available.");
  }

  private engineeringProgress(data: WeeklyDigestData): string[] {
    const failedPipelines = data.gitlab.pipelines.filter((p) =>
      String(p.status || "").toLowerCase().includes("fail"),
    );
    const failedRuns = data.github.workflowRuns.filter((r) =>
      String(r.conclusion || r.status || "").toLowerCase().includes("fail"),
    );

    return this.listOrFallback([
      ...data.github.pullRequests.slice(0, 10).map((pr) => `- GitHub PR #${pr.number || "?"}: ${pr.title || "(untitled)"} (${pr.html_url || "no url"})`),
      ...data.gitlab.mergeRequests.slice(0, 10).map((mr) => `- GitLab MR !${mr.iid || "?"}: ${mr.title || "(untitled)"} (${mr.web_url || "no url"})`),
      ...data.github.releases.slice(0, 5).map((r) => `- Release: ${r.name || r.tag_name || "unnamed"}`),
      ...failedPipelines.slice(0, 5).map((p) => `- Failed GitLab pipeline: ${p.web_url || p.id || "unknown"}`),
      ...failedRuns.slice(0, 5).map((r) => `- Failed GitHub workflow: ${r.html_url || r.name || r.id}`),
      ...data.jira.slice(0, 8).map((issue) => `- Jira: ${this.jiraLabel(issue)}`),
    ], "- No engineering signals found in configured sources.");
  }

  private productRoadmapProgress(roadmaps: WeeklyDigestData["roadmaps"]): string[] {
    return this.listOrFallback(
      roadmaps.flatMap((roadmap) => {
        const blockedItems = (roadmap.milestones || []).flatMap((milestone: any) =>
          (milestone.items || []).filter((item: any) => item.status === "blocked"),
        );
        return [
          `- ${roadmap.name}: ${roadmap.status}${roadmap.endDate ? `, target ${roadmap.endDate}` : ""}`,
          ...blockedItems.map((item: any) => `- Roadmap blocker: ${item.title}`),
        ];
      }),
      "- No active roadmaps found.",
    );
  }

  private openRisks(data: WeeklyDigestData, sources: SourceStatus): string[] {
    const risks: string[] = [];
    const blocked = data.workItems.filter((i) => i.status === "blocked");
    for (const item of blocked.slice(0, 5)) {
      risks.push(`- Blocked work item: ${item.title}`);
    }
    for (const c of data.hawkIr.riskyOpenCases.slice(0, 5)) {
      risks.push(`- High-risk IR case: ${this.irCaseLabel(c)}`);
    }
    for (const t of data.jitbit.highPriority.slice(0, 3)) {
      risks.push(`- High-priority support ticket: ${this.ticketLabel(t)}`);
    }
    const failedPipelines = data.gitlab.pipelines.filter((p) =>
      String(p.status || "").toLowerCase().includes("fail"),
    );
    const failedRuns = data.github.workflowRuns.filter((r) =>
      String(r.conclusion || r.status || "").toLowerCase().includes("fail"),
    );
    for (const p of failedPipelines.slice(0, 3)) {
      risks.push(`- Failed pipeline: ${p.web_url || p.id || "unknown"}`);
    }
    for (const r of failedRuns.slice(0, 3)) {
      risks.push(`- Failed workflow: ${r.html_url || r.name || r.id}`);
    }
    const unavailable = Object.entries(sources).filter(([, s]) => s.enabled && !s.available);
    if (unavailable.length > 0) {
      risks.push(`- ${unavailable.length} integration(s) unavailable — data may be incomplete.`);
    }
    return this.listOrFallback(risks, "- No open risks identified from available sources.");
  }

  private decisionsNeeded(data: WeeklyDigestData): string[] {
    const decisions: string[] = [];
    const waiting = data.workItems.filter((i) => i.status === "waiting");
    for (const item of waiting.slice(0, 5)) {
      decisions.push(`- What should unblock or close "${item.title}"?`);
    }
    for (const ticket of data.jitbit.highPriority.slice(0, 3)) {
      decisions.push(`- Does ${this.ticketLabel(ticket)} need direct follow-up this week?`);
    }
    for (const pr of data.github.pullRequests.slice(0, 2)) {
      decisions.push(`- Should PR #${pr.number || "?"} be reviewed this week or deferred?`);
    }
    for (const mr of data.gitlab.mergeRequests.slice(0, 2)) {
      decisions.push(`- Should MR !${mr.iid || "?"} be reviewed this week or deferred?`);
    }
    return this.listOrFallback(decisions, "- No pending decisions identified.");
  }

  private workCompleted(items: WorkItem[], weekStart: string, weekEnd: string): string[] {
    const completed = items.filter((i) => {
      if (i.status !== "done" || !i.completedAt) return false;
      const d = i.completedAt.slice(0, 10);
      return d >= weekStart && d <= weekEnd;
    });
    return this.listOrFallback(
      completed.slice(0, 20).map((i) => `- ${i.title} (${i.type}, ${i.priority} priority)`),
      "- No work items completed this week.",
    );
  }

  private workBlocked(items: WorkItem[]): string[] {
    const blocked = items.filter((i) => i.status === "blocked");
    const overdue = items.filter((i) => i.status !== "done" && i.status !== "archived" && i.dueAt && i.dueAt.slice(0, 10) < new Date().toISOString().slice(0, 10));
    return this.listOrFallback([
      ...blocked.map((i) => `- Blocked: ${i.title}`),
      ...overdue.slice(0, 10).map((i) => `- Overdue: ${i.title}`),
    ], "- No blocked or overdue work items.");
  }

  private followUps(data: WeeklyDigestData, weekStart: string): string[] {
    const items: string[] = [];
    for (const t of data.jitbit.followups.slice(0, 10)) {
      items.push(`- Support follow-up: ${this.ticketLabel(t)}`);
    }
    for (const c of data.hawkIr.riskyOpenCases.slice(0, 5)) {
      items.push(`- IR follow-up: ${this.irCaseLabel(c)}`);
    }
    const overdue = data.workItems.filter(
      (i) => i.dueAt && i.dueAt.slice(0, 10) < weekStart && i.status !== "done" && i.status !== "archived",
    );
    for (const i of overdue.slice(0, 5)) {
      items.push(`- Overdue work item: ${i.title}`);
    }
    return this.listOrFallback(items, "- No follow-ups identified.");
  }

  private suggestedNextWeek(data: WeeklyDigestData, suggestions: WorkItemCreateParams[]): string[] {
    const items: string[] = [];
    for (const s of suggestions.slice(0, 8)) {
      items.push(`- ${s.title}`);
    }
    if (data.workItems.filter((i) => i.status === "blocked").length > 0) {
      items.push("- Prioritize unblocking blocked work items.");
    }
    if (data.jitbit.highPriority.length > 0) {
      items.push("- Address high-priority customer/support tickets.");
    }
    if (data.hawkIr.riskyOpenCases.length > 0) {
      items.push("- Review and escalate high-risk IR cases.");
    }
    return this.listOrFallback(items, "- Continue current priorities.");
  }

  private draftInternalUpdate(data: WeeklyDigestData, weekStart: string, weekEnd: string): string[] {
    const completedCount = data.workItems.filter((i) => {
      if (i.status !== "done" || !i.completedAt) return false;
      const d = i.completedAt.slice(0, 10);
      return d >= weekStart && d <= weekEnd;
    }).length;
    const blockedCount = data.workItems.filter((i) => i.status === "blocked").length;
    const openPRs = data.github.pullRequests.length + data.gitlab.mergeRequests.length;
    const highPriorityTickets = data.jitbit.highPriority.length;
    const riskyCases = data.hawkIr.riskyOpenCases.length;

    const lines = [
      `**Week of ${weekStart} — ${weekEnd}**`,
      "",
      `This week we completed ${completedCount} work item(s), with ${blockedCount} still blocked.`,
      `${openPRs} pull/merge request(s) remain open for review.`,
    ];
    if (highPriorityTickets > 0) {
      lines.push(`${highPriorityTickets} high-priority customer/support ticket(s) need attention.`);
    }
    if (riskyCases > 0) {
      lines.push(`${riskyCases} high-risk IR case(s) require review or escalation.`);
    }
    lines.push("", "No external messages were sent as part of this digest.");
    return lines;
  }

  private buildSuggestedWorkItems(weekStart: string, data: WeeklyDigestData): WorkItemCreateParams[] {
    const suggestions: WorkItemCreateParams[] = [];

    for (const ticket of data.jitbit.highPriority.slice(0, 5)) {
      suggestions.push({
        type: "customer_followup",
        title: `Follow up on high-priority support ticket: ${this.ticketTitle(ticket)}`,
        description: this.ticketLabel(ticket),
        priority: "high",
        source: "jitbit",
        sourceExternalId: String(ticket.TicketID || ticket.IssueID || ""),
        dueAt: weekStart,
        tags: ["weekly-digest", "customer"],
      });
    }

    for (const c of data.hawkIr.riskyOpenCases.slice(0, 5)) {
      const caseRid = c["@rid"] || c.rid || "unknown";
      const caseName = c.name || "(unnamed case)";
      const riskLevel = c.riskLevel || c["risk_level"] || "high";
      suggestions.push({
        type: "customer_followup",
        title: `Investigate high-risk IR case: ${caseName} (${caseRid})`,
        description: `Case ${caseRid} is ${riskLevel}-risk and not yet escalated. Status: ${c.progressStatus || c["progress_status"] || "unknown"}.`,
        priority: riskLevel === "critical" ? "critical" : "high",
        source: "hawk-ir",
        sourceExternalId: String(caseRid),
        dueAt: weekStart,
        tags: ["weekly-digest", "incident-response", "security"],
      });
    }

    for (const pipeline of data.gitlab.pipelines.filter((p) => String(p.status || "").toLowerCase().includes("fail")).slice(0, 3)) {
      suggestions.push({
        type: "code_review",
        title: `Review failed GitLab pipeline ${pipeline.id || ""}`.trim(),
        description: pipeline.web_url || "Failed GitLab pipeline found in weekly digest.",
        priority: "high",
        source: "gitlab",
        sourceUrl: pipeline.web_url,
        sourceExternalId: pipeline.id ? String(pipeline.id) : undefined,
        dueAt: weekStart,
        tags: ["weekly-digest", "pipeline"],
      });
    }

    const blocked = data.workItems.filter((i) => i.status === "blocked");
    for (const item of blocked.slice(0, 5)) {
      suggestions.push({
        type: item.type,
        title: `Unblock work item: ${item.title}`,
        description: item.description,
        priority: item.priority === "critical" ? "critical" : "high",
        source: "chat",
        sourceExternalId: item.id,
        dueAt: weekStart,
        tags: ["weekly-digest", "blocked"],
      });
    }

    return suggestions.slice(0, 15);
  }

  private listOrFallback(items: string[], fallback: string): string[] {
    return items.length > 0 ? items : [fallback];
  }

  private ticketLabel(ticket: any): string {
    const id = ticket.TicketID || ticket.IssueID || ticket.id || "?";
    const subject = this.ticketTitle(ticket);
    const status = ticket.Status || ticket.StatusName || ticket.StatusID || "unknown";
    const customer = ticket.CompanyName || ticket.UserName || ticket.Username || ticket.Email || "unknown customer";
    return `#${id} ${subject} (${status}, ${customer})`;
  }

  private ticketTitle(ticket: any): string {
    return ticket.Subject || ticket.Title || ticket.summary || "(no subject)";
  }

  private jiraLabel(issue: any): string {
    const key = issue.key || issue.id || "?";
    const summary = issue.fields?.summary || issue.summary || "(no summary)";
    const status = issue.fields?.status?.name || issue.status || "unknown";
    return `${key} ${summary} (${status})`;
  }

  private irCaseLabel(c: any): string {
    const rid = c["@rid"] || c.rid || "?";
    const name = c.name || "(unnamed)";
    const risk = c.riskLevel || c["risk_level"] || "unknown";
    const status = c.progressStatus || c["progress_status"] || "unknown";
    const owner = c.ownerName || c["owner_name"] || "unassigned";
    const esc = c.escalated ? " ⚠️ ESCALATED" : "";
    return `#${rid} ${name} (${risk} risk, ${status}, ${owner})${esc}`;
  }
}

export const weeklyDigestGenerator = new WeeklyDigestGenerator();