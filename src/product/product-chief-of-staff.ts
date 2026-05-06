import { aiClient } from "../agent/opencode-client";
import { jitbitService } from "../integrations/jitbit/jitbit-service";
import { roadmapDatabase, type Roadmap } from "../roadmap/database";
import { workItemDatabase } from "../work-items/database";

// ── Output Types ──────────────────────────────────────────────────────────

export interface WorkflowBriefOutput {
  problem: string;
  users: string[];
  actors: string[];
  jobToBeDone: string;
  trigger: string;
  desiredOutcome: string;
  currentWorkflow: string[];
  proposedWorkflow: string[];
  frictionPoints: string[];
  automationOpportunities: string[];
  humanInTheLoopMoments: string[];
  mvp: string[];
  nonGoals: string[];
  risks: string[];
  successCriteria: string[];
}

export interface RoadmapProposalOutput {
  theme: string;
  whyNow: string;
  customerEvidence: string[];
  engineeringImpact: string[];
  proposedMilestones: Array<{
    name: string;
    targetDate: string;
    items: string[];
  }>;
  workItems: Array<{
    title: string;
    description: string;
    type: string;
    priority: string;
  }>;
  dependencies: string[];
  risks: string[];
  cutLine: string;
  demoCriteria: string[];
}

export interface RoadmapDriftOutput {
  roadmapId: string;
  roadmapName: string;
  totalItems: number;
  completedItems: number;
  inProgressItems: number;
  blockedItems: number;
  notStartedItems: number;
  driftScore: number;
  overdueMilestones: Array<{
    name: string;
    targetDate: string;
    status: string;
  }>;
  atRiskItems: Array<{
    title: string;
    status: string;
    priority: string;
  }>;
  summary: string;
}

export interface CustomerSignal {
  type: "repeated_ask" | "high_friction" | "stale_theme" | "waiting_on_roadmap";
  title: string;
  evidence: string[];
  frequency: number;
  severity: "low" | "medium" | "high";
  recommendation: string;
}

export interface CustomerSignalsOutput {
  signals: CustomerSignal[];
  totalTicketsAnalyzed: number;
  summary: string;
}

export interface WeeklyProductUpdateOutput {
  dateRange: { from: string; to: string };
  shipped: Array<{ title: string; type: string }>;
  inProgress: Array<{ title: string; status: string; priority: string }>;
  blocked: Array<{ title: string; reason: string }>;
  customerSignals: CustomerSignal[];
  roadmapChanges: string[];
  decisionsNeeded: string[];
  nextWeek: string[];
  markdown: string;
}

// ── Service Class ─────────────────────────────────────────────────────────

class ProductChiefOfStaff {
  // ── 1. Idea → Workflow Brief ────────────────────────────────────────────

  async turnIdeaIntoWorkflowBrief(input: {
    idea: string;
    context?: string;
  }): Promise<WorkflowBriefOutput> {
    const prompt = input.context
      ? `Idea: ${input.idea}\n\nAdditional context: ${input.context}`
      : input.idea;

    if (aiClient.isConfigured()) {
      try {
        const response = await aiClient.chat({
          messages: [
            {
              role: "system",
              content: `You are a senior product strategist. Given a product idea, produce a workflow-first product brief as a JSON object with these exact fields:

- problem (string): Precise problem statement — who experiences it, how often, what is the cost?
- users (string[]): Every distinct user persona with role, skill level, and motivation
- actors (string[]): Systems and services that participate in the workflow
- jobToBeDone (string): "When [situation], I want to [motivation], so I can [outcome]"
- trigger (string): What event initiates the workflow
- desiredOutcome (string): The measurable end state
- currentWorkflow (string[]): Step-by-step current process, including manual steps and handoffs
- proposedWorkflow (string[]): Step-by-step ideal automated workflow, noting what the system does vs the human
- frictionPoints (string[]): Specific friction points with cause, who is affected, impact
- automationOpportunities (string[]): Things that can and should be automated, with approach and confidence
- humanInTheLoopMoments (string[]): Points where a human MUST be involved, with why and what judgment they provide
- mvp (string[]): Minimum viable product scope — only what is needed to prove value
- nonGoals (string[]): Explicitly out of scope
- risks (string[]): Key risks with mitigation
- successCriteria (string[]): Measurable success criteria

Respond with ONLY the JSON object, no markdown fences. Be SPECIFIC to the idea, not generic.`,
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.7,
        });

        const parsed = this.parseJsonResponse(response.content);
        if (parsed) return this.mergeWithDefaults(parsed, this.workflowBriefFallback(input.idea));
      } catch (error) {
        console.error("[ProductCoS] AI workflow brief failed, using fallback:", (error as Error).message);
      }
    }

    return this.workflowBriefFallback(input.idea);
  }

  // ── 2. Roadmap Proposal ────────────────────────────────────────────────

  async buildRoadmapProposal(input: {
    theme: string;
    customerEvidence?: string;
    engineeringConstraints?: string;
    timeHorizon?: string;
  }): Promise<RoadmapProposalOutput> {
    const context = [
      `Theme: ${input.theme}`,
      input.customerEvidence ? `Customer evidence: ${input.customerEvidence}` : "",
      input.engineeringConstraints ? `Engineering constraints: ${input.engineeringConstraints}` : "",
      input.timeHorizon ? `Time horizon: ${input.timeHorizon}` : "",
    ].filter(Boolean).join("\n");

    if (aiClient.isConfigured()) {
      try {
        const response = await aiClient.chat({
          messages: [
            {
              role: "system",
              content: `You are a senior product leader creating a roadmap proposal. Produce a JSON object with these fields:

- theme (string): The overarching theme/epic name
- whyNow (string): Why this needs attention now — market timing, customer urgency, strategic fit
- customerEvidence (string[]): Specific customer signals, quotes, or data points
- engineeringImpact (string[]): Engineering considerations — tech debt, architecture changes, resourcing
- proposedMilestones (array of {name, targetDate, items}): Ordered milestones with target dates and item lists
- workItems (array of {title, description, type, priority}): Concrete work items for the first milestone
- dependencies (string[]): External dependencies and blockers
- risks (string[]): Key risks with likelihood
- cutLine (string): What to cut if scope needs to be reduced
- demoCriteria (string[]): What a working demo must show to validate the approach

Respond with ONLY the JSON object, no markdown fences.`,
            },
            { role: "user", content: context },
          ],
          temperature: 0.7,
        });

        const parsed = this.parseJsonResponse(response.content);
        if (parsed) return this.mergeWithDefaults(parsed, this.roadmapProposalFallback(input.theme));
      } catch (error) {
        console.error("[ProductCoS] AI roadmap proposal failed, using fallback:", (error as Error).message);
      }
    }

    return this.roadmapProposalFallback(input.theme);
  }

  // ── 3. Roadmap Drift Analysis ──────────────────────────────────────────

  async analyzeRoadmapDrift(input?: {
    roadmapId?: string;
  }): Promise<RoadmapDriftOutput[]> {
    const roadmaps: Roadmap[] = input?.roadmapId
      ? [roadmapDatabase.getRoadmap(input.roadmapId)].filter((r): r is Roadmap => r !== null)
      : roadmapDatabase.listRoadmaps({ status: "active" });

    if (roadmaps.length === 0) return [];

    return roadmaps.map((roadmap) => {
      const milestones = roadmapDatabase.getMilestones(roadmap.id);
      const allItems = milestones.flatMap((m) =>
        roadmapDatabase.getItems(m.id),
      );

      const completedItems = allItems.filter((i) => i.status === "done");
      const inProgressItems = allItems.filter((i) => i.status === "in_progress");
      const blockedItems = allItems.filter((i) => i.status === "blocked");
      const notStartedItems = allItems.filter((i) => i.status === "todo");

      const completionRate = allItems.length > 0 ? completedItems.length / allItems.length : 0;
      const now = new Date();
      const overdueMilestones = milestones
        .filter((m) => new Date(m.targetDate) < now && m.status !== "completed")
        .map((m) => ({
          name: m.name,
          targetDate: m.targetDate,
          status: m.status,
        }));

      const atRiskItems = allItems
        .filter((i) => i.status === "blocked" || i.priority === "critical")
        .map((i) => ({
          title: i.title,
          status: i.status,
          priority: i.priority,
        }));

      // Drift score: 0 = on track, 1 = severely drifted
      const driftFactors = [
        overdueMilestones.length / Math.max(milestones.length, 1),
        blockedItems.length / Math.max(allItems.length, 1),
        1 - completionRate,
      ];
      const driftScore = Math.min(driftFactors.reduce((a, b) => a + b, 0) / driftFactors.length, 1);

      const status = driftScore < 0.3 ? "on track" : driftScore < 0.6 ? "minor drift" : "significant drift";

      return {
        roadmapId: roadmap.id,
        roadmapName: roadmap.name,
        totalItems: allItems.length,
        completedItems: completedItems.length,
        inProgressItems: inProgressItems.length,
        blockedItems: blockedItems.length,
        notStartedItems: notStartedItems.length,
        driftScore: Math.round(driftScore * 100) / 100,
        overdueMilestones,
        atRiskItems,
        summary: `${roadmap.name}: ${status} (${completionRate * 100}% complete, ${overdueMilestones.length} overdue milestones, ${blockedItems.length} blocked items)`,
      };
    });
  }

  // ── 4. Shipped vs Planned Summary ──────────────────────────────────────

  async summarizeShippedVsPlanned(input?: {
    roadmapId?: string;
  }): Promise<{
    roadmapId: string;
    roadmapName: string;
    total: number;
    shipped: number;
    inProgress: number;
    planned: number;
    blocked: number;
    summary: string;
  }> {
    const drifts = await this.analyzeRoadmapDrift(input);
    if (drifts.length === 0) {
      return {
        roadmapId: "",
        roadmapName: "",
        total: 0,
        shipped: 0,
        inProgress: 0,
        planned: 0,
        blocked: 0,
        summary: "No active roadmaps found.",
      };
    }

    // Summarize across all roadmaps (or single if specified)
    const totals = drifts.reduce(
      (acc, d) => ({
        total: acc.total + d.totalItems,
        shipped: acc.shipped + d.completedItems,
        inProgress: acc.inProgress + d.inProgressItems,
        planned: acc.planned + d.notStartedItems,
        blocked: acc.blocked + d.blockedItems,
      }),
      { total: 0, shipped: 0, inProgress: 0, planned: 0, blocked: 0 },
    );

    const pct = (n: number) => totals.total > 0 ? Math.round((n / totals.total) * 100) : 0;
    const summary = [
      `Total: ${totals.total} items`,
      `Shipped: ${totals.shipped} (${pct(totals.shipped)}%)`,
      `In progress: ${totals.inProgress} (${pct(totals.inProgress)}%)`,
      `Planned: ${totals.planned} (${pct(totals.planned)}%)`,
      `Blocked: ${totals.blocked}`,
    ].join(" | ");

    return {
      roadmapId: drifts.length === 1 ? drifts[0].roadmapId : "all",
      roadmapName: drifts.length === 1 ? drifts[0].roadmapName : "All Active Roadmaps",
      ...totals,
      summary,
    };
  }

  // ── 5. Customer Signals from Jitbit ─────────────────────────────────────

  async extractCustomerSignalsFromJitbit(input?: {
    daysBack?: number;
    limit?: number;
  }): Promise<CustomerSignalsOutput> {
    const daysBack = input?.daysBack ?? 14;
    const limit = input?.limit ?? 50;

    if (!jitbitService.isConfigured()) {
      return {
        signals: [],
        totalTicketsAnalyzed: 0,
        summary: "Jitbit is not configured. Enable Jitbit integration to extract customer signals.",
      };
    }

    try {
      const [recentTickets, followups, highPriority] = await Promise.all([
        jitbitService.getRecentCustomerActivity({ days: daysBack, limit }).catch(() => []),
        jitbitService.findTicketsNeedingFollowup({ daysSinceUpdate: 3, limit }).catch(() => []),
        jitbitService.findHighPriorityOpenTickets(limit).catch(() => []),
      ]);

      const allTickets = [...recentTickets, ...followups, ...highPriority];
      const uniqueTickets = this.deduplicateById(allTickets);
      const signals = this.detectSignals(uniqueTickets, daysBack);

      const summary = signals.length === 0
        ? `${uniqueTickets.length} tickets analyzed — no strong customer signals detected.`
        : `${uniqueTickets.length} tickets analyzed — ${signals.length} customer signal(s) detected: ${signals.map((s) => s.title).join("; ")}`;

      return {
        signals,
        totalTicketsAnalyzed: uniqueTickets.length,
        summary,
      };
    } catch (error) {
      console.error("[ProductCoS] Jitbit signal extraction failed:", (error as Error).message);
      return {
        signals: [],
        totalTicketsAnalyzed: 0,
        summary: `Error extracting customer signals: ${(error as Error).message}`,
      };
    }
  }

  // ── 6. Create Roadmap Work Items ────────────────────────────────────────

  createRoadmapWorkItems(input: {
    items: Array<{
      type: string;
      title: string;
      description?: string;
      priority?: string;
      tags?: string[];
    }>;
    source?: string;
  }): Array<{ id: string; title: string; status: string }> {
    return input.items.map((item) => {
      const created = workItemDatabase.createWorkItem({
        type: item.type as WorkItemCreateParams["type"],
        title: item.title,
        description: item.description ?? "",
        priority: (item.priority as WorkItemCreateParams["priority"]) ?? "medium",
        source: (input.source as WorkItemCreateParams["source"]) ?? "roadmap",
        tags: [...(item.tags ?? []), "product"],
      });
      return {
        id: created.id,
        title: created.title,
        status: created.status,
      };
    });
  }

  // ── 7. Weekly Product Update ────────────────────────────────────────────

  async generateWeeklyProductUpdate(input?: {
    weekStart?: string;
    daysBack?: number;
  }): Promise<WeeklyProductUpdateOutput> {
    const daysBack = input?.daysBack ?? 7;
    const weekStart = input?.weekStart ?? new Date().toISOString().slice(0, 10);
    const weekEndDate = new Date(weekStart);
    weekEndDate.setDate(weekEndDate.getDate() + daysBack);
    const weekEnd = weekEndDate.toISOString().slice(0, 10);

    // Gather data from all sources
    const [drifts, shippedVsPlanned, customerSignals] = await Promise.all([
      this.analyzeRoadmapDrift().catch(() => []),
      this.summarizeShippedVsPlanned().catch(() => ({
        roadmapId: "",
        roadmapName: "",
        total: 0,
        shipped: 0,
        inProgress: 0,
        planned: 0,
        blocked: 0,
        summary: "No roadmap data available.",
      })),
      this.extractCustomerSignalsFromJitbit({ daysBack }).catch(() => ({
        signals: [],
        totalTicketsAnalyzed: 0,
        summary: "No customer signal data available.",
      })),
    ]);

    // Gather work items
    const workItems = workItemDatabase.listWorkItems({ includeArchived: false, limit: 200 }).items;
    const shipped = workItems.filter((i) => i.status === "done");
    const inProgress = workItems.filter((i) => i.status === "active" || i.status === "planned");
    const blocked = workItems.filter((i) => i.status === "blocked");

    // Build roadmap changes from drift
    const roadmapChanges = drifts.flatMap((d) => {
      const changes: string[] = [];
      if (d.overdueMilestones.length > 0) {
        changes.push(`${d.roadmapName}: ${d.overdueMilestones.length} overdue milestone(s)`);
      }
      if (d.atRiskItems.length > 0) {
        changes.push(`${d.roadmapName}: ${d.atRiskItems.length} at-risk item(s)`);
      }
      return changes;
    });

    // Build decisions needed
    const decisionsNeeded: string[] = [];
    for (const item of blocked.slice(0, 5)) {
      decisionsNeeded.push(`Unblock: ${item.title}`);
    }
    for (const d of drifts) {
      if (d.driftScore > 0.5) {
        decisionsNeeded.push(`Address drift in ${d.roadmapName} (score: ${d.driftScore})`);
      }
    }

    // Build next week
    const nextWeek = inProgress
      .filter((i) => i.priority === "high" || i.priority === "critical")
      .slice(0, 5)
      .map((i) => i.title);

    const result: WeeklyProductUpdateOutput = {
      dateRange: { from: weekStart, to: weekEnd },
      shipped: shipped.slice(0, 20).map((i) => ({ title: i.title, type: i.type })),
      inProgress: inProgress.slice(0, 20).map((i) => ({
        title: i.title,
        status: i.status,
        priority: i.priority,
      })),
      blocked: blocked.slice(0, 10).map((i) => ({
        title: i.title,
        reason: i.description || "No reason provided",
      })),
      customerSignals: customerSignals.signals,
      roadmapChanges,
      decisionsNeeded,
      nextWeek,
      markdown: "",
    };

    result.markdown = this.renderWeeklyUpdate(result, shippedVsPlanned);
    return result;
  }

  // ── Private Helpers ─────────────────────────────────────────────────────

  private parseJsonResponse(content: string): Record<string, unknown> | null {
    try {
      const trimmed = content.trim();
      const cleaned = trimmed
        .replace(/^```json?\n?/, "")
        .replace(/\n?```$/, "");
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }

  private mergeWithDefaults<T>(parsed: Record<string, unknown>, fallback: T): T {
    const result = { ...fallback } as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== undefined && value !== null && value !== "") {
        result[key] = value;
      }
    }
    return result as T;
  }

  private workflowBriefFallback(idea: string): WorkflowBriefOutput {
    return {
      problem: idea,
      users: ["End user", "Administrator"],
      actors: ["System", "External services"],
      jobToBeDone: `When [situation], I want to [action], so I can [outcome]`,
      trigger: "To be determined",
      desiredOutcome: "To be determined",
      currentWorkflow: ["Manual or non-existent process"],
      proposedWorkflow: ["Automated workflow with appropriate guardrails"],
      frictionPoints: ["To be identified during implementation"],
      automationOpportunities: ["To be identified"],
      humanInTheLoopMoments: ["Approval steps", "Review checkpoints"],
      mvp: ["Core workflow functionality"],
      nonGoals: ["To be defined"],
      risks: ["Scope creep", "Integration complexity"],
      successCriteria: ["Workflow completes successfully", "User satisfaction"],
    };
  }

  private roadmapProposalFallback(theme: string): RoadmapProposalOutput {
    return {
      theme,
      whyNow: "To be determined",
      customerEvidence: ["To be gathered"],
      engineeringImpact: ["To be assessed"],
      proposedMilestones: [
        { name: "MVP", targetDate: "TBD", items: ["Core functionality"] },
        { name: "V1", targetDate: "TBD", items: ["Enhanced features"] },
      ],
      workItems: [
        { title: `${theme} - Initial implementation`, description: "Core implementation", type: "feature", priority: "high" },
      ],
      dependencies: ["To be identified"],
      risks: ["To be assessed"],
      cutLine: "Non-essential features can be deferred to V2",
      demoCriteria: ["Core workflow completes end-to-end"],
    };
  }

  private deduplicateById(tickets: any[]): any[] {
    const seen = new Set<string | number>();
    return tickets.filter((t) => {
      const id = t.TicketID || t.IssueID || t.Id || Math.random();
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  private detectSignals(tickets: any[], daysBack: number): CustomerSignal[] {
    const signals: CustomerSignal[] = [];

    // Group tickets by subject/title keywords to find repeated asks
    const subjectGroups = new Map<string, any[]>();
    for (const ticket of tickets) {
      const subject = (ticket.Subject || ticket.Title || "").toLowerCase().trim();
      if (!subject) continue;

      // Extract first few meaningful words as a group key
      const keywords = subject.split(/\s+/).filter((w: string) => w.length > 3).slice(0, 2).join(" ");
      if (!keywords) continue;

      const group = subjectGroups.get(keywords) || [];
      group.push(ticket);
      subjectGroups.set(keywords, group);
    }

    // Repeated asks: subjects that appear 3+ times
    for (const [keyword, group] of subjectGroups) {
      if (group.length >= 3) {
        signals.push({
          type: "repeated_ask",
          title: `Repeated request: ${keyword}`,
          evidence: group.slice(0, 5).map((t) => `#${t.TicketID || t.IssueID}: ${t.Subject || t.Title}`),
          frequency: group.length,
          severity: group.length >= 5 ? "high" : "medium",
          recommendation: `Consider prioritizing this feature/request — ${group.length} tickets mention it.`,
        });
      }
    }

    // High friction: tickets with many comments or long open duration
    const highFriction = tickets.filter((t) => {
      const comments = t.CommentsCount || t.ReplyCount || 0;
      const age = t.IssueDate ? (Date.now() - new Date(t.IssueDate).getTime()) / (1000 * 60 * 60 * 24) : 0;
      return comments > 5 || age > 14;
    });
    if (highFriction.length > 0) {
      signals.push({
        type: "high_friction",
        title: "High-friction areas detected",
        evidence: highFriction.slice(0, 5).map((t) => `#${t.TicketID || t.IssueID}: ${t.Subject || t.Title} (${t.CommentsCount || t.ReplyCount || "?"} comments)`),
        frequency: highFriction.length,
        severity: highFriction.length >= 5 ? "high" : "medium",
        recommendation: "Investigate these tickets for UX/process improvements.",
      });
    }

    // Stale themes: old tickets still open
    const staleCutoff = new Date();
    staleCutoff.setDate(staleCutoff.getDate() - daysBack);
    const stale = tickets.filter((t) => {
      const created = t.IssueDate ? new Date(t.IssueDate) : null;
      return created && created < staleCutoff && !t.ResolvedDate;
    });
    if (stale.length >= 3) {
      signals.push({
        type: "stale_theme",
        title: "Stale support themes",
        evidence: stale.slice(0, 5).map((t) => `#${t.TicketID || t.IssueID}: ${t.Subject || t.Title} (open since ${t.IssueDate?.slice(0, 10)})`),
        frequency: stale.length,
        severity: stale.length >= 10 ? "high" : "medium",
        recommendation: `${stale.length} tickets have been open beyond the ${daysBack}-day window. Review for patterns.`,
      });
    }

    // Waiting on roadmap: high-priority tickets without resolution
    const waitingHighPri = tickets.filter((t) => {
      const priority = Number(t.Priority) || 0;
      const priorityName = String(t.PriorityName || "").toLowerCase();
      return priority >= 1 || priorityName.includes("high") || priorityName.includes("critical");
    }).filter((t) => !t.ResolvedDate);

    if (waitingHighPri.length >= 2) {
      signals.push({
        type: "waiting_on_roadmap",
        title: "Customers waiting on roadmap promises",
        evidence: waitingHighPri.slice(0, 5).map((t) => `#${t.TicketID || t.IssueID}: ${t.Subject || t.Title}`),
        frequency: waitingHighPri.length,
        severity: "high",
        recommendation: "These high-priority items may need roadmap attention.",
      });
    }

    return signals;
  }

  private renderWeeklyUpdate(
    data: WeeklyProductUpdateOutput,
    shippedVsPlanned: { summary: string },
  ): string {
    const lines = [
      `# Weekly Product Update — ${data.dateRange.from} to ${data.dateRange.to}`,
      "",
      "## Shipped",
      ...this.listOrFallback(
        data.shipped.map((s) => `- ${s.title} (${s.type})`),
        "- Nothing shipped this week.",
      ),
      "",
      "## In Progress",
      ...this.listOrFallback(
        data.inProgress.map((i) => `- [${i.priority}] ${i.title} — ${i.status}`),
        "- No items in progress.",
      ),
      "",
      "## Blocked",
      ...this.listOrFallback(
        data.blocked.map((b) => `- ${b.title}: ${b.reason}`),
        "- No blocked items.",
      ),
      "",
      "## Customer Signals",
      ...this.listOrFallback(
        data.customerSignals.map((s) => `- **[${s.severity}]** ${s.title} (${s.type}, ${s.frequency} occurrences)`),
        "- No customer signals detected.",
      ),
      "",
      "## Roadmap Changes",
      ...this.listOrFallback(
        data.roadmapChanges.map((c) => `- ${c}`),
        "- No roadmap changes this week.",
      ),
      "",
      "## Decisions Needed",
      ...this.listOrFallback(
        data.decisionsNeeded.map((d) => `- ${d}`),
        "- No decisions needed this week.",
      ),
      "",
      "## Next Week",
      ...this.listOrFallback(
        data.nextWeek.map((n) => `- ${n}`),
        "- No items prioritized for next week.",
      ),
      "",
      `## Progress Summary\n${shippedVsPlanned.summary}`,
    ];

    return lines.join("\n");
  }

  private listOrFallback(items: string[], fallback: string): string[] {
    return items.length > 0 ? items : [fallback];
  }
}

export const productChiefOfStaff = new ProductChiefOfStaff();

// Re-export for convenience
type WorkItemCreateParams = import("../work-items/types").WorkItemCreateParams;