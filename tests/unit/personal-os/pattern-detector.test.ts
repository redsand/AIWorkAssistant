import { describe, it, expect } from "vitest";
import { patternDetector } from "../../../src/personal-os/pattern-detector";
import type { BriefData } from "../../../src/personal-os/types";

function makeBriefData(overrides: Partial<BriefData> = {}): BriefData {
  return {
    calendar: [],
    jira: [],
    gitlab: { mergeRequests: [], pipelines: [], commits: [] },
    github: { pullRequests: [], workflowRuns: [], commits: [], releases: [] },
    roadmaps: [],
    workItems: [],
    jitbit: { recent: [], followups: [], highPriority: [] },
    memories: [],
    ...overrides,
  };
}

describe("PatternDetector", () => {
  it("detects recurring task type patterns", () => {
    const workItems = Array.from({ length: 5 }, (_, i) => ({
      id: String(i), title: `Task ${i}`, type: "customer_followup", status: "active", priority: "medium", source: "chat",
    }));
    const data = makeBriefData({ workItems: workItems as any[] });
    const patterns = patternDetector.detectRecurringPatterns(data, 7);
    const recurring = patterns.find((p) => p.category === "recurring_task");
    expect(recurring).toBeDefined();
    expect(recurring!.pattern).toContain("5 open customer followup items");
  });

  it("detects meeting overload pattern", () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      startTime: `2025-01-06T${String(9 + i).padStart(2, "0")}:00:00`,
      endTime: `2025-01-06T${String(10 + i).padStart(2, "0")}:00:00`,
      summary: `Meeting ${i}`,
    }));
    const data = makeBriefData({ calendar: events });
    const patterns = patternDetector.detectRecurringPatterns(data, 7);
    const overload = patterns.find((p) => p.category === "meeting_overload");
    expect(overload).toBeDefined();
  });

  it("detects review bottleneck pattern", () => {
    const data = makeBriefData({
      github: {
        pullRequests: Array.from({ length: 4 }, (_, i) => ({ number: i, title: `PR ${i}` })),
        workflowRuns: [], commits: [], releases: [],
      },
      gitlab: {
        mergeRequests: [{ iid: 1, title: "MR 1" }, { iid: 2, title: "MR 2" }],
        pipelines: [], commits: [],
      },
    });
    const patterns = patternDetector.detectRecurringPatterns(data, 7);
    const bottleneck = patterns.find((p) => p.category === "review_bottleneck");
    expect(bottleneck).toBeDefined();
    expect(bottleneck!.pattern).toContain("6 open PRs/MRs");
  });

  it("returns empty array when no patterns are found", () => {
    const data = makeBriefData();
    const patterns = patternDetector.detectRecurringPatterns(data, 30);
    expect(patterns).toHaveLength(0);
  });

  it("detects context switch pattern with many active sources", () => {
    const data = makeBriefData({
      calendar: [{ startTime: "2025-01-06T09:00:00", endTime: "2025-01-06T10:00:00", summary: "Meeting" }],
      jira: [{ key: "JIRA-1", fields: { summary: "Issue" } }],
      workItems: [{ id: "1", title: "Task", type: "task", status: "active", priority: "medium", source: "chat" } as any],
      gitlab: { mergeRequests: [{ iid: 1, title: "MR" }], pipelines: [], commits: [] },
      github: { pullRequests: [{ number: 1, title: "PR" }], workflowRuns: [], commits: [], releases: [] },
      jitbit: { recent: [{ TicketID: 1, Subject: "Ticket" }], followups: [], highPriority: [] },
    });
    const patterns = patternDetector.detectRecurringPatterns(data, 7);
    const ctxSwitch = patterns.find((p) => p.category === "context_switch");
    expect(ctxSwitch).toBeDefined();
  });
});