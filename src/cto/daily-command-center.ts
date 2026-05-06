import { fileCalendarService } from "../integrations/file/calendar-service";
import { jiraClient } from "../integrations/jira/jira-client";
import { gitlabClient } from "../integrations/gitlab/gitlab-client";
import { githubClient } from "../integrations/github/github-client";
import { jitbitService } from "../integrations/jitbit/jitbit-service";
import { hawkIrService } from "../integrations/hawk-ir/hawk-ir-service";
import { roadmapDatabase } from "../roadmap/database";
import { workItemDatabase } from "../work-items/database";
import { conversationManager } from "../memory/conversation-manager";
import type { WorkItem, WorkItemCreateParams } from "../work-items/types";

export interface DailyCommandCenterParams {
  userId: string;
  date?: string;
  includeCalendar?: boolean;
  includeJira?: boolean;
  includeGitLab?: boolean;
  includeGitHub?: boolean;
  includeRoadmap?: boolean;
  includeWorkItems?: boolean;
  includeJitbit?: boolean;
  includeHawkIr?: boolean;
  daysBack?: number;
}

export interface DailyCommandCenterResult {
  date: string;
  markdown: string;
  suggestedWorkItems: WorkItemCreateParams[];
  sources: Record<string, { enabled: boolean; available: boolean; error?: string }>;
}

type SourceStatus = DailyCommandCenterResult["sources"];

interface BriefData {
  calendar: any[];
  jira: any[];
  gitlab: {
    mergeRequests: any[];
    pipelines: any[];
    commits: any[];
  };
  github: {
    pullRequests: any[];
    workflowRuns: any[];
    commits: any[];
    releases: any[];
  };
  roadmaps: Array<any & { milestones?: any[] }>;
  workItems: WorkItem[];
  jitbit: {
    recent: any[];
    followups: any[];
    highPriority: any[];
  };
  hawkIr: {
    riskyOpenCases: any[];
    caseCount: number;
    recentCases: any[];
    activeNodes: any[];
  };
  memories: string[];
}

class CtoDailyCommandCenter {
  async generateDailyCommandCenter(
    params: DailyCommandCenterParams,
  ): Promise<DailyCommandCenterResult> {
    const date = this.normalizeDate(params.date);
    const daysBack = this.clampDays(params.daysBack);
    const include = this.resolveIncludes(params);
    const sources: SourceStatus = {};
    const data: BriefData = {
      calendar: [],
      jira: [],
      gitlab: { mergeRequests: [], pipelines: [], commits: [] },
      github: { pullRequests: [], workflowRuns: [], commits: [], releases: [] },
      roadmaps: [],
      workItems: [],
      jitbit: { recent: [], followups: [], highPriority: [] },
      hawkIr: { riskyOpenCases: [], caseCount: 0, recentCases: [], activeNodes: [] },
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
        params.userId,
        "CTO daily command center decisions blockers customer engineering roadmap",
        5,
      );
    });

    const suggestedWorkItems = this.buildSuggestedWorkItems(date, data);
    const markdown = this.renderMarkdown(date, daysBack, data, sources, suggestedWorkItems);
    return { date, markdown, suggestedWorkItems, sources };
  }

  createSuggestedWorkItems(items: WorkItemCreateParams[]): WorkItem[] {
    return items.map((item) =>
      workItemDatabase.createWorkItem({
        ...item,
        status: item.status ?? "proposed",
        source: item.source ?? "chat",
        tags: Array.from(new Set([...(item.tags ?? []), "cto-daily"])),
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

  private resolveIncludes(params: DailyCommandCenterParams) {
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

  private renderMarkdown(
    date: string,
    daysBack: number,
    data: BriefData,
    sources: SourceStatus,
    suggestedWorkItems: WorkItemCreateParams[],
  ): string {
    const unavailable = Object.entries(sources)
      .filter(([, status]) => status.enabled && !status.available)
      .map(([name, status]) => `${name}: ${status.error || "unavailable"}`);
    const overdue = this.overdueWorkItems(data.workItems, date);
    const blocked = data.workItems.filter((item) => item.status === "blocked");
    const waiting = data.workItems.filter((item) => item.status === "waiting");
    const failedPipelines = data.gitlab.pipelines.filter((pipeline) =>
      String(pipeline.status || "").toLowerCase().includes("fail"),
    );
    const failedRuns = data.github.workflowRuns.filter((run) =>
      String(run.conclusion || run.status || "").toLowerCase().includes("fail"),
    );

    const lines = [
      `# CTO Daily Command Center — ${date}`,
      "",
      "## 1. Executive Snapshot",
      ...this.executiveSnapshot(data, unavailable, overdue, blocked, failedPipelines, failedRuns),
      "",
      "## 2. Needs Tim's Attention",
      ...this.listOrFallback([
        ...blocked.map((item) => `- Blocked work item: ${item.title}`),
        ...overdue.map((item) => `- Overdue work item: ${item.title}`),
        ...data.jitbit.highPriority.map((ticket) => `- High-priority support ticket: ${this.ticketLabel(ticket)}`),
        ...data.hawkSoar.riskyOpenCases.slice(0, 3).map((c: any) => `- High-risk IR case: ${this.irCaseLabel(c)}`),
        ...data.jira.slice(0, 5).map((issue) => `- Jira signal: ${this.jiraLabel(issue)}`),
        ...failedPipelines.map((pipeline) => `- Failed GitLab pipeline: ${pipeline.web_url || pipeline.id || "unknown pipeline"}`),
        ...failedRuns.map((run) => `- Failed GitHub workflow: ${run.html_url || run.name || run.id}`),
        ...data.memories.map((memory) => `- Memory context: ${memory}`),
      ], "- No urgent blockers found in available sources."),
      "",
      "## 3. Customer / Support Signals",
      ...this.customerSignals(data.jitbit),
      "",
      "## 3b. Incident Response / Security Signals",
      ...this.incidentResponseSignals(data.hawkSoar),
      "",
      "## 4. Engineering Signals",
      ...this.engineeringSignals(data),
      "",
      "## 5. Product / Roadmap Signals",
      ...this.roadmapSignals(data.roadmaps),
      "",
      "## 6. Work Items",
      ...this.workItemSignals(data.workItems, date, suggestedWorkItems),
      "",
      "## 7. Suggested Schedule",
      ...this.scheduleSignals(data.calendar),
      "",
      "## 8. Safe Actions The Assistant Can Draft",
      "- Draft Jira/GitHub/GitLab comments for Tim to review.",
      "- Draft customer follow-up notes from Jitbit context.",
      "- Draft PR/MR review checklists and release notes.",
      "- Create internal Work Items from the suggestions below.",
      "- Prepare schedule blocks for review before calendar creation.",
      "",
      "## 9. Questions for Tim",
      ...this.questionsForTim(data, unavailable, waiting),
    ];

    if (unavailable.length > 0) {
      lines.push("", `Data window: last ${daysBack} day(s). Unavailable sources: ${unavailable.join("; ")}.`);
    } else {
      lines.push("", `Data window: last ${daysBack} day(s). All requested sources responded.`);
    }

    return lines.join("\n");
  }

  private executiveSnapshot(
    data: BriefData,
    unavailable: string[],
    overdue: WorkItem[],
    blocked: WorkItem[],
    failedPipelines: any[],
    failedRuns: any[],
  ): string[] {
    const bullets = [
      `- Calendar has ${data.calendar.length} event(s) today.`,
      `- Customer/support: ${data.jitbit.recent.length} recent ticket(s), ${data.jitbit.followups.length} follow-up candidate(s), ${data.jitbit.highPriority.length} high-priority open ticket(s).`,
      `- IR: ${data.hawkSoar.caseCount} total case(s), ${data.hawkSoar.riskyOpenCases.length} high-risk unescalated, ${data.hawkSoar.activeNodes.length} active node(s).`,
      `- Engineering: ${data.github.pullRequests.length} GitHub PR(s), ${data.gitlab.mergeRequests.length} GitLab MR(s), ${failedPipelines.length + failedRuns.length} failed pipeline/workflow signal(s).`,
      `- Product/roadmap: ${data.roadmaps.length} active roadmap(s) in scope.`,
      `- Work items: ${overdue.length} overdue, ${blocked.length} blocked, ${data.workItems.filter((item) => item.status === "waiting").length} waiting.`,
    ];
    if (data.memories.length > 0) bullets.push(`- Memory surfaced ${data.memories.length} relevant prior context item(s).`);
    if (unavailable.length > 0) bullets.push(`- Some integrations were unavailable; the brief still used local and configured sources.`);
    return bullets.slice(0, 7);
  }

  private customerSignals(jitbit: BriefData["jitbit"]): string[] {
    return this.listOrFallback([
      ...jitbit.highPriority.map((ticket) => `- High priority: ${this.ticketLabel(ticket)}`),
      ...jitbit.followups.map((ticket) => `- Needs follow-up: ${this.ticketLabel(ticket)}`),
      ...jitbit.recent.slice(0, 8).map((ticket) => `- Recent: ${this.ticketLabel(ticket)}`),
    ], "- No Jitbit customer/support activity available.");
  }

  private engineeringSignals(data: BriefData): string[] {
    return this.listOrFallback([
      ...data.github.pullRequests.slice(0, 8).map((pr) => `- GitHub PR #${pr.number || "?"}: ${pr.title || "(untitled)"} (${pr.html_url || "no url"})`),
      ...data.gitlab.mergeRequests.slice(0, 8).map((mr) => `- GitLab MR !${mr.iid || "?"}: ${mr.title || "(untitled)"} (${mr.web_url || "no url"})`),
      ...data.github.workflowRuns.slice(0, 5).map((run) => `- GitHub workflow: ${run.name || run.display_title || run.id} - ${run.conclusion || run.status || "unknown"}`),
      ...data.gitlab.pipelines.slice(0, 5).map((pipeline) => `- GitLab pipeline: ${pipeline.id || "unknown"} - ${pipeline.status || "unknown"}`),
      ...data.jira.slice(0, 8).map((issue) => `- Jira: ${this.jiraLabel(issue)}`),
      ...data.github.releases.slice(0, 3).map((release) => `- Recent release: ${release.name || release.tag_name || "unnamed"}`),
    ], "- No engineering signals found in configured sources.");
  }

  private roadmapSignals(roadmaps: BriefData["roadmaps"]): string[] {
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

  private workItemSignals(
    items: WorkItem[],
    date: string,
    suggestedWorkItems: WorkItemCreateParams[],
  ): string[] {
    const dueToday = items.filter((item) => item.dueAt?.slice(0, 10) === date);
    const overdue = this.overdueWorkItems(items, date);
    return this.listOrFallback([
      ...dueToday.map((item) => `- Due today: ${item.title}`),
      ...overdue.map((item) => `- Overdue: ${item.title}`),
      ...items.filter((item) => item.status === "blocked").map((item) => `- Blocked: ${item.title}`),
      ...items.filter((item) => item.status === "waiting").map((item) => `- Waiting: ${item.title}`),
      ...suggestedWorkItems.map((item) => `- Suggested new: ${item.title}`),
    ], "- No due, overdue, blocked, waiting, or suggested work items found.");
  }

  private scheduleSignals(events: any[]): string[] {
    const busy = events.map((event) => `- ${this.timeLabel(event.startTime)}-${this.timeLabel(event.endTime)} ${event.summary}`);
    return [
      ...this.listOrFallback(busy, "- No calendar events found for today."),
      "- Suggested focus block: 90 minutes for the highest-risk blocker or review queue.",
      "- Suggested admin block: 30 minutes for approvals, inbox, and Jira/GitHub triage.",
      "- Suggested customer follow-up block: 30 minutes if Jitbit follow-ups are present.",
      "- Suggested recovery/health block: 20 minutes protected away from screens.",
    ];
  }

  private questionsForTim(
    data: BriefData,
    unavailable: string[],
    waiting: WorkItem[],
  ): string[] {
    const questions = [
      ...waiting.slice(0, 3).map((item) => `- What should unblock or close "${item.title}"?`),
      ...data.jitbit.highPriority.slice(0, 3).map((ticket) => `- Does ${this.ticketLabel(ticket)} need direct CTO/customer follow-up today?`),
      ...data.github.pullRequests.slice(0, 2).map((pr) => `- Should PR #${pr.number || "?"} be reviewed today or deferred?`),
      ...data.gitlab.mergeRequests.slice(0, 2).map((mr) => `- Should MR !${mr.iid || "?"} be reviewed today or deferred?`),
    ];
    if (unavailable.length > 0) {
      questions.push("- Should any unavailable integrations be reconnected before using this as the source of truth?");
    }
    return this.listOrFallback(questions, "- What is the single highest-leverage outcome for today?");
  }

  private buildSuggestedWorkItems(date: string, data: BriefData): WorkItemCreateParams[] {
    const suggestions: WorkItemCreateParams[] = [];
    for (const ticket of data.jitbit.highPriority.slice(0, 5)) {
      suggestions.push({
        type: "customer_followup",
        title: `Follow up on high-priority support ticket: ${this.ticketTitle(ticket)}`,
        description: this.ticketLabel(ticket),
        priority: "high",
        source: "jitbit",
        sourceExternalId: String(ticket.TicketID || ticket.IssueID || ""),
        dueAt: date,
        tags: ["cto-daily", "customer"],
      });
    }
    for (const item of this.overdueWorkItems(data.workItems, date).slice(0, 5)) {
      suggestions.push({
        type: item.type,
        title: `Resolve overdue work item: ${item.title}`,
        description: item.description,
        priority: item.priority === "critical" ? "critical" : "high",
        source: "chat",
        sourceExternalId: item.id,
        dueAt: date,
        tags: ["cto-daily", "overdue"],
      });
    }
    for (const pipeline of data.gitlab.pipelines.filter((p) => String(p.status || "").toLowerCase().includes("fail")).slice(0, 3)) {
      suggestions.push({
        type: "code_review",
        title: `Review failed GitLab pipeline ${pipeline.id || ""}`.trim(),
        description: pipeline.web_url || "Failed GitLab pipeline found in CTO daily scan.",
        priority: "high",
        source: "gitlab",
        sourceUrl: pipeline.web_url,
        sourceExternalId: pipeline.id ? String(pipeline.id) : undefined,
        dueAt: date,
        tags: ["cto-daily", "pipeline"],
      });
    }
    for (const c of data.hawkSoar.riskyOpenCases.slice(0, 5)) {
      const caseRid = c["@rid"] || c.rid || "unknown";
      const caseName = c.name || "(unnamed case)";
      const riskLevel = c.riskLevel || c["risk_level"] || "high";
      suggestions.push({
        type: "customer_followup",
        title: `Investigate high-risk IR case: ${caseName} (${caseRid})`,
        description: `Case ${caseRid} is ${riskLevel}-risk and not yet escalated. Status: ${c.progressStatus || c["progress_status"] || "unknown"}. Consider escalating or creating a Jitbit ticket.`,
        priority: riskLevel === "critical" ? "critical" : "high",
        source: "hawk-ir",
        sourceExternalId: String(caseRid),
        dueAt: date,
        tags: ["cto-daily", "incident-response", "security"],
      });
    }

    return suggestions.slice(0, 12);
  }

  private incidentResponseSignals(hawkSoar: BriefData["hawkSoar"]): string[] {
    const { riskyOpenCases, caseCount, recentCases, activeNodes } = hawkSoar;
    return this.listOrFallback([
      `- Total open cases: ${caseCount}`,
      `- High-risk unescalated: ${riskyOpenCases.length} case(s) needing attention`,
      `- Active nodes: ${activeNodes.length}`,
      ...riskyOpenCases.slice(0, 8).map((c: any) => `- Risky: ${this.irCaseLabel(c)}`),
      ...recentCases.slice(0, 3).map((c: any) => `- Recent: ${this.irCaseLabel(c)}`),
      ...activeNodes.slice(0, 3).map((n: any) => `- Node: ${n.hostname || n.id} (${n.platform || "?"}, last seen ${n.lastSeen || "unknown"})`),
    ], "- No HAWK IR signals available.");
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

  private overdueWorkItems(items: WorkItem[], date: string): WorkItem[] {
    return items.filter(
      (item) =>
        item.dueAt &&
        item.dueAt.slice(0, 10) < date &&
        item.status !== "done" &&
        item.status !== "archived",
    );
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

  private timeLabel(value: unknown): string {
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return "time unknown";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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

export const ctoDailyCommandCenter = new CtoDailyCommandCenter();
