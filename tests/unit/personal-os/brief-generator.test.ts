import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/integrations/file/calendar-service", () => ({
  fileCalendarService: { listEvents: vi.fn(() => []), isConfigured: vi.fn(() => true) },
}));
vi.mock("../../../src/integrations/jira/jira-client", () => ({
  jiraClient: { isConfigured: vi.fn(() => false) },
}));
vi.mock("../../../src/integrations/gitlab/gitlab-client", () => ({
  gitlabClient: { isConfigured: vi.fn(() => false), getDefaultProject: vi.fn(() => null) },
}));
vi.mock("../../../src/integrations/github/github-client", () => ({
  githubClient: { isConfigured: vi.fn(() => false) },
}));
vi.mock("../../../src/integrations/jitbit/jitbit-service", () => ({
  jitbitService: { isConfigured: vi.fn(() => false) },
}));
vi.mock("../../../src/roadmap/database", () => ({
  roadmapDatabase: { listRoadmaps: vi.fn(() => []), getMilestones: vi.fn(() => []), getItems: vi.fn(() => []) },
}));
vi.mock("../../../src/work-items/database", () => ({
  workItemDatabase: {
    listWorkItems: vi.fn(() => ({ items: [] })),
    createWorkItem: vi.fn((item: any) => ({ id: "new-1", ...item })),
  },
}));
vi.mock("../../../src/memory/conversation-manager", () => ({
  conversationManager: { getRelevantMemories: vi.fn(() => []) },
}));

import { personalOsBriefGenerator } from "../../../src/personal-os/brief-generator";
import { fileCalendarService } from "../../../src/integrations/file/calendar-service";
import { workItemDatabase } from "../../../src/work-items/database";

describe("PersonalOsBriefGenerator", () => {
  it("generates a brief with all sections in markdown", async () => {
    const result = await personalOsBriefGenerator.generatePersonalBrief({ userId: "tim" });
    expect(result.date).toBeTruthy();
    expect(result.markdown).toContain("# Personal OS Brief");
    expect(result.markdown).toContain("## Today's Load");
    expect(result.markdown).toContain("## Open Loops");
    expect(result.markdown).toContain("## Decisions Waiting on Tim");
    expect(result.markdown).toContain("## Recurring Patterns");
    expect(result.markdown).toContain("## Suggested Delegations");
    expect(result.markdown).toContain("## Suggested Focus Blocks");
    expect(result.markdown).toContain("## Energy / Context Switching Risks");
    expect(result.markdown).toContain("## Things To Stop Doing");
    expect(result.markdown).toContain("## Work Items To Create");
  });

  it("returns structured todaysLoad section", async () => {
    const result = await personalOsBriefGenerator.generatePersonalBrief({ userId: "tim" });
    expect(result.todaysLoad).toBeDefined();
    expect(typeof result.todaysLoad.calendarEventCount).toBe("number");
    expect(typeof result.todaysLoad.openWorkItemCount).toBe("number");
    expect(typeof result.todaysLoad.blockedWorkItemCount).toBe("number");
  });

  it("gracefully handles unconfigured integrations", async () => {
    const result = await personalOsBriefGenerator.generatePersonalBrief({ userId: "tim" });
    // Jira/GitLab/GitHub/Jitbit not configured, so sources should reflect that
    expect(result.sources.jira).toBeDefined();
    expect(result.sources.jira.available).toBe(false);
    expect(result.sources.gitlab.available).toBe(false);
    expect(result.sources.github.available).toBe(false);
    expect(result.sources.jitbit.available).toBe(false);
  });

  it("collects calendar data when configured", async () => {
    vi.mocked(fileCalendarService.listEvents).mockReturnValue([
      { id: "1", summary: "Team sync", startTime: new Date(), endTime: new Date(), type: "meeting" },
    ] as any);
    const result = await personalOsBriefGenerator.generatePersonalBrief({ userId: "tim" });
    expect(result.todaysLoad.calendarEventCount).toBe(1);
    expect(result.sources.calendar.available).toBe(true);
  });

  it("creates suggested work items with personal-os tag", () => {
    const items = [
      { type: "personal" as const, title: "Test item", priority: "high" as const, source: "chat" as const },
    ];
    const result = personalOsBriefGenerator.createSuggestedWorkItems(items as any);
    expect(result).toHaveLength(1);
    expect(result[0].tags).toContain("personal-os");
  });

  it("respects date normalization", async () => {
    const result = await personalOsBriefGenerator.generatePersonalBrief({
      userId: "tim",
      date: "2025-06-15",
    });
    expect(result.date).toBe("2025-06-15");
  });
});