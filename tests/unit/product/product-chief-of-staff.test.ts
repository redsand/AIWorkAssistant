import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing
vi.mock("../../../src/agent/opencode-client", () => ({
  aiClient: {
    isConfigured: vi.fn(() => false),
    chat: vi.fn(),
  },
}));

vi.mock("../../../src/integrations/jitbit/jitbit-service", () => ({
  jitbitService: {
    isConfigured: vi.fn(() => false),
    getRecentCustomerActivity: vi.fn(),
    findTicketsNeedingFollowup: vi.fn(),
    findHighPriorityOpenTickets: vi.fn(),
  },
}));

vi.mock("../../../src/roadmap/database", () => ({
  roadmapDatabase: {
    getRoadmap: vi.fn(),
    listRoadmaps: vi.fn(() => []),
    getMilestones: vi.fn(() => []),
    getItems: vi.fn(() => []),
  },
}));

vi.mock("../../../src/work-items/database", () => ({
  workItemDatabase: {
    listWorkItems: vi.fn(() => ({ items: [], total: 0 })),
    createWorkItem: vi.fn(),
  },
}));

import { productChiefOfStaff } from "../../../src/product/product-chief-of-staff";
import { aiClient } from "../../../src/agent/opencode-client";
import { jitbitService } from "../../../src/integrations/jitbit/jitbit-service";
import { roadmapDatabase } from "../../../src/roadmap/database";
import { workItemDatabase } from "../../../src/work-items/database";

describe("ProductChiefOfStaff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Workflow Brief ───────────────────────────────────────────────────

  describe("turnIdeaIntoWorkflowBrief", () => {
    it("returns a fallback brief when AI is not configured", async () => {
      (aiClient.isConfigured as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const result = await productChiefOfStaff.turnIdeaIntoWorkflowBrief({
        idea: "A tool that auto-generates release notes from PRs",
      });

      expect(result.problem).toBe("A tool that auto-generates release notes from PRs");
      expect(result.users).toContain("End user");
      expect(result.mvp).toContain("Core workflow functionality");
      expect(result.actors).toContain("System");
    });

    it("returns AI-generated brief when configured", async () => {
      (aiClient.isConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (aiClient.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
        content: JSON.stringify({
          problem: "Developers waste time manually writing release notes",
          users: ["Release manager", "DevOps engineer"],
          actors: ["CI/CD pipeline", "Git provider"],
          jobToBeDone: "When a release is cut, I want auto-generated notes, so I can skip manual editing",
          trigger: "Git tag push or release branch merge",
          desiredOutcome: "Published release notes within 1 minute of tag push",
          currentWorkflow: ["Manually diff commits", "Write notes in editor", "Copy to GitHub"],
          proposedWorkflow: ["Detect tag push", "Collect PRs since last tag", "Draft notes", "Publish"],
          frictionPoints: ["Manual diffing is error-prone"],
          automationOpportunities: ["PR collection and categorization"],
          humanInTheLoopMoments: ["Review generated notes before publish"],
          mvp: ["Auto-collect PRs", "Draft notes template"],
          nonGoals: ["Slack integration"],
          risks: ["Missing PR descriptions"],
          successCriteria: ["Notes generated within 1 minute"],
        }),
      });

      const result = await productChiefOfStaff.turnIdeaIntoWorkflowBrief({
        idea: "Auto-generate release notes",
        context: "We use GitHub and conventional commits",
      });

      expect(result.problem).toBe("Developers waste time manually writing release notes");
      expect(result.users).toContain("Release manager");
      expect(result.jobToBeDone).toContain("auto-generated notes");
    });

    it("falls back on AI failure", async () => {
      (aiClient.isConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (aiClient.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("API error"));

      const result = await productChiefOfStaff.turnIdeaIntoWorkflowBrief({
        idea: "Something cool",
      });

      expect(result.problem).toBe("Something cool");
      expect(result.mvp).toContain("Core workflow functionality");
    });
  });

  // ── Roadmap Proposal ────────────────────────────────────────────────

  describe("buildRoadmapProposal", () => {
    it("returns a fallback proposal when AI is not configured", async () => {
      (aiClient.isConfigured as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const result = await productChiefOfStaff.buildRoadmapProposal({
        theme: "Self-serve onboarding",
      });

      expect(result.theme).toBe("Self-serve onboarding");
      expect(result.proposedMilestones.length).toBeGreaterThan(0);
      expect(result.workItems.length).toBeGreaterThan(0);
    });

    it("returns AI-generated proposal when configured", async () => {
      (aiClient.isConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (aiClient.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
        content: JSON.stringify({
          theme: "Self-serve onboarding",
          whyNow: "Customer feedback shows 40% drop-off in first week",
          customerEvidence: ["Support tickets mentioning confusion"],
          engineeringImpact: ["New onboarding flow component needed"],
          proposedMilestones: [
            { name: "Onboarding MVP", targetDate: "2026-06-01", items: ["Wizard flow", "Progress tracker"] },
          ],
          workItems: [
            { title: "Build onboarding wizard", description: "Multi-step wizard", type: "feature", priority: "high" },
          ],
          dependencies: ["Design system v2"],
          risks: ["Scope creep"],
          cutLine: "Analytics dashboard can be deferred",
          demoCriteria: ["New user completes wizard end-to-end"],
        }),
      });

      const result = await productChiefOfStaff.buildRoadmapProposal({
        theme: "Self-serve onboarding",
        customerEvidence: "Support tickets",
      });

      expect(result.theme).toBe("Self-serve onboarding");
      expect(result.whyNow).toContain("40%");
      expect(result.proposedMilestones.length).toBeGreaterThan(0);
    });
  });

  // ── Roadmap Drift ────────────────────────────────────────────────────

  describe("analyzeRoadmapDrift", () => {
    it("returns empty array when no active roadmaps", async () => {
      (roadmapDatabase.listRoadmaps as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const result = await productChiefOfStaff.analyzeRoadmapDrift();

      expect(result).toEqual([]);
    });

    it("calculates drift for active roadmaps", async () => {
      const mockRoadmap = {
        id: "r1",
        name: "Q2 Product Roadmap",
        type: "internal",
        status: "active",
        startDate: "2026-04-01",
        endDate: "2026-06-30",
        jiraProjectKey: null,
        jiraProjectId: null,
        description: null,
        createdAt: "2026-04-01",
        updatedAt: "2026-04-01",
        metadata: null,
      };

      const mockMilestone = {
        id: "m1",
        roadmapId: "r1",
        name: "MVP",
        description: null,
        targetDate: "2025-01-01", // Past date = overdue
        status: "pending" as const,
        order: 1,
        jiraEpicKey: null,
        createdAt: "2026-04-01",
        updatedAt: "2026-04-01",
      };

      const mockItems = [
        { id: "i1", milestoneId: "m1", title: "Feature A", description: null, type: "feature" as const, status: "done" as const, priority: "high" as const, estimatedHours: null, actualHours: null, assignee: null, jiraKey: null, order: 1, createdAt: "2026-04-01", updatedAt: "2026-04-01" },
        { id: "i2", milestoneId: "m1", title: "Feature B", description: null, type: "feature" as const, status: "blocked" as const, priority: "critical" as const, estimatedHours: null, actualHours: null, assignee: null, jiraKey: null, order: 2, createdAt: "2026-04-01", updatedAt: "2026-04-01" },
        { id: "i3", milestoneId: "m1", title: "Feature C", description: null, type: "task" as const, status: "todo" as const, priority: "medium" as const, estimatedHours: null, actualHours: null, assignee: null, jiraKey: null, order: 3, createdAt: "2026-04-01", updatedAt: "2026-04-01" },
      ];

      (roadmapDatabase.listRoadmaps as ReturnType<typeof vi.fn>).mockReturnValue([mockRoadmap]);
      (roadmapDatabase.getMilestones as ReturnType<typeof vi.fn>).mockReturnValue([mockMilestone]);
      (roadmapDatabase.getItems as ReturnType<typeof vi.fn>).mockReturnValue(mockItems);

      const result = await productChiefOfStaff.analyzeRoadmapDrift();

      expect(result.length).toBe(1);
      expect(result[0].roadmapName).toBe("Q2 Product Roadmap");
      expect(result[0].totalItems).toBe(3);
      expect(result[0].completedItems).toBe(1);
      expect(result[0].blockedItems).toBe(1);
      expect(result[0].overdueMilestones.length).toBe(1);
      expect(result[0].driftScore).toBeGreaterThan(0);
    });
  });

  // ── Customer Signals ─────────────────────────────────────────────────

  describe("extractCustomerSignalsFromJitbit", () => {
    it("returns empty when Jitbit is not configured", async () => {
      (jitbitService.isConfigured as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const result = await productChiefOfStaff.extractCustomerSignalsFromJitbit();

      expect(result.signals).toEqual([]);
      expect(result.totalTicketsAnalyzed).toBe(0);
      expect(result.summary).toContain("not configured");
    });

    it("detects repeated customer asks", async () => {
      (jitbitService.isConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (jitbitService.getRecentCustomerActivity as ReturnType<typeof vi.fn>).mockResolvedValue([
        { TicketID: 1, Subject: "Password reset broken", Priority: 0, CommentsCount: 2 },
        { TicketID: 2, Subject: "Password reset page missing", Priority: 0, CommentsCount: 1 },
        { TicketID: 3, Subject: "Password reset takes too long", Priority: 0, CommentsCount: 0 },
        { TicketID: 4, Subject: "Feature request: export data", Priority: 0, CommentsCount: 0 },
        { TicketID: 5, Subject: "Export data button not working", Priority: 0, CommentsCount: 0 },
        { TicketID: 6, Subject: "Export data format wrong", Priority: 0, CommentsCount: 0 },
      ]);
      (jitbitService.findTicketsNeedingFollowup as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (jitbitService.findHighPriorityOpenTickets as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await productChiefOfStaff.extractCustomerSignalsFromJitbit({ daysBack: 14 });

      expect(result.totalTicketsAnalyzed).toBeGreaterThan(0);
      const repeatedSignal = result.signals.find((s) => s.type === "repeated_ask");
      expect(repeatedSignal).toBeDefined();
      expect(repeatedSignal!.frequency).toBeGreaterThanOrEqual(3);
    });

    it("detects high-priority items as waiting_on_roadmap signals", async () => {
      (jitbitService.isConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (jitbitService.getRecentCustomerActivity as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (jitbitService.findTicketsNeedingFollowup as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (jitbitService.findHighPriorityOpenTickets as ReturnType<typeof vi.fn>).mockResolvedValue([
        { TicketID: 10, Subject: "Feature X critical", Priority: 1, PriorityName: "High", ResolvedDate: null },
        { TicketID: 11, Subject: "Feature Y critical", Priority: 2, PriorityName: "Critical", ResolvedDate: null },
      ]);

      const result = await productChiefOfStaff.extractCustomerSignalsFromJitbit();

      const waitingSignal = result.signals.find((s) => s.type === "waiting_on_roadmap");
      expect(waitingSignal).toBeDefined();
      expect(waitingSignal!.severity).toBe("high");
    });
  });

  // ── Create Work Items ─────────────────────────────────────────────────

  describe("createRoadmapWorkItems", () => {
    it("creates work items from product proposals", () => {
      (workItemDatabase.createWorkItem as ReturnType<typeof vi.fn>).mockImplementation((item: any) => ({
        id: "wi-1",
        title: item.title,
        status: "proposed",
        ...item,
      }));

      const result = productChiefOfStaff.createRoadmapWorkItems({
        items: [
          { type: "feature", title: "Build onboarding wizard", description: "Multi-step wizard", priority: "high" },
          { type: "research", title: "Investigate analytics requirements", priority: "medium" },
        ],
      });

      expect(result.length).toBe(2);
      expect(result[0].title).toBe("Build onboarding wizard");
      expect(workItemDatabase.createWorkItem).toHaveBeenCalledTimes(2);
    });
  });

  // ── Weekly Update ────────────────────────────────────────────────────

  describe("generateWeeklyProductUpdate", () => {
    it("generates update even with no data", async () => {
      (roadmapDatabase.listRoadmaps as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (workItemDatabase.listWorkItems as ReturnType<typeof vi.fn>).mockReturnValue({ items: [], total: 0 });
      (jitbitService.isConfigured as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const result = await productChiefOfStaff.generateWeeklyProductUpdate();

      expect(result.dateRange).toBeDefined();
      expect(result.shipped).toEqual([]);
      expect(result.inProgress).toEqual([]);
      expect(result.blocked).toEqual([]);
      expect(result.markdown).toContain("Weekly Product Update");
    });

    it("includes shipped and blocked items from work items", async () => {
      (roadmapDatabase.listRoadmaps as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (workItemDatabase.listWorkItems as ReturnType<typeof vi.fn>).mockReturnValue({
        items: [
          { id: "1", title: "Feature A", type: "feature", status: "done", priority: "high" },
          { id: "2", title: "Feature B", type: "task", status: "active", priority: "medium" },
          { id: "3", title: "Feature C", type: "task", status: "blocked", priority: "critical", description: "Waiting on API" },
        ],
        total: 3,
      });
      (jitbitService.isConfigured as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const result = await productChiefOfStaff.generateWeeklyProductUpdate();

      expect(result.shipped.length).toBe(1);
      expect(result.shipped[0].title).toBe("Feature A");
      expect(result.inProgress.length).toBe(1);
      expect(result.blocked.length).toBe(1);
      expect(result.blocked[0].title).toBe("Feature C");
      expect(result.markdown).toContain("Weekly Product Update");
    });
  });
});