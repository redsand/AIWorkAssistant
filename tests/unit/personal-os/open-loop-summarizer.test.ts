import { describe, it, expect, vi } from "vitest";
import { openLoopSummarizer } from "../../../src/personal-os/open-loop-summarizer";
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

describe("OpenLoopSummarizer", () => {
  it("identifies blocked work items as open loops", () => {
    const data = makeBriefData({
      workItems: [
        { id: "1", title: "Blocked task", status: "blocked", priority: "high", type: "task", source: "chat" } as any,
      ],
    });
    const { openLoops } = openLoopSummarizer.summarizeOpenLoops(data);
    expect(openLoops).toHaveLength(1);
    expect(openLoops[0].type).toBe("task");
    expect(openLoops[0].urgency).toBe("high");
  });

  it("identifies waiting work items as approval open loops", () => {
    const data = makeBriefData({
      workItems: [
        { id: "2", title: "Waiting item", status: "waiting", priority: "medium", type: "task", source: "chat" } as any,
      ],
    });
    const { openLoops } = openLoopSummarizer.summarizeOpenLoops(data);
    expect(openLoops).toHaveLength(1);
    expect(openLoops[0].type).toBe("approval");
  });

  it("identifies open PRs as followup loops", () => {
    const data = makeBriefData({
      github: {
        pullRequests: [{ number: 42, title: "Fix bug", html_url: "https://github.com/repo/pull/42" }],
        workflowRuns: [], commits: [], releases: [],
      },
    });
    const { openLoops } = openLoopSummarizer.summarizeOpenLoops(data);
    expect(openLoops).toHaveLength(1);
    expect(openLoops[0].type).toBe("followup");
    expect(openLoops[0].source).toBe("github");
  });

  it("identifies open MRs as followup loops", () => {
    const data = makeBriefData({
      gitlab: {
        mergeRequests: [{ iid: 7, title: "Feature MR", web_url: "https://gitlab.com/repo/mr/7" }],
        pipelines: [], commits: [],
      },
    });
    const { openLoops } = openLoopSummarizer.summarizeOpenLoops(data);
    expect(openLoops).toHaveLength(1);
    expect(openLoops[0].source).toBe("gitlab");
  });

  it("identifies Jitbit followups", () => {
    const data = makeBriefData({
      jitbit: {
        recent: [],
        followups: [{ TicketID: 100, Subject: "Needs reply" }],
        highPriority: [],
      },
    });
    const { openLoops } = openLoopSummarizer.summarizeOpenLoops(data);
    expect(openLoops).toHaveLength(1);
    expect(openLoops[0].source).toBe("jitbit");
  });

  it("identifies decision work items as decisions waiting", () => {
    const data = makeBriefData({
      workItems: [
        { id: "3", title: "Choose tech stack", status: "active", priority: "high", type: "decision", source: "chat", description: "Pick between A and B" } as any,
      ],
    });
    const { decisionsWaiting } = openLoopSummarizer.summarizeOpenLoops(data);
    expect(decisionsWaiting).toHaveLength(1);
    expect(decisionsWaiting[0].title).toBe("Choose tech stack");
  });

  it("does not list done decision items", () => {
    const data = makeBriefData({
      workItems: [
        { id: "4", title: "Resolved decision", status: "done", priority: "low", type: "decision", source: "chat", archived: true } as any,
      ],
    });
    const { decisionsWaiting } = openLoopSummarizer.summarizeOpenLoops(data);
    expect(decisionsWaiting).toHaveLength(0);
  });

  it("handles empty data sources gracefully", () => {
    const data = makeBriefData();
    const result = openLoopSummarizer.summarizeOpenLoops(data);
    expect(result.openLoops).toHaveLength(0);
    expect(result.decisionsWaiting).toHaveLength(0);
  });

  it("detects in-progress Jira issues as open loops", () => {
    const data = makeBriefData({
      jira: [
        { key: "PROJ-123", id: "10001", self: "https://jira.example.com/rest/api/2/issue/10001", fields: { status: { name: "In Progress" }, summary: "Active task", priority: { name: "High" } } } as any,
      ],
    });
    const { openLoops } = openLoopSummarizer.summarizeOpenLoops(data);
    expect(openLoops).toHaveLength(1);
    expect(openLoops[0].title).toBe("Active task");
    expect(openLoops[0].source).toBe("jira");
    expect(openLoops[0].urgency).toBe("high");
  });

  it("maps Jira priority names correctly", () => {
    const makeJira = (priorityName: string) => makeBriefData({
      jira: [{ key: "P-1", id: "1", self: "", fields: { status: { name: "In Progress" }, summary: "Task", priority: { name: priorityName } } } as any],
    });
    expect(openLoopSummarizer.summarizeOpenLoops(makeJira("Highest")).openLoops[0].urgency).toBe("critical");
    expect(openLoopSummarizer.summarizeOpenLoops(makeJira("Critical")).openLoops[0].urgency).toBe("critical");
    expect(openLoopSummarizer.summarizeOpenLoops(makeJira("Low")).openLoops[0].urgency).toBe("low");
    expect(openLoopSummarizer.summarizeOpenLoops(makeJira("Lowest")).openLoops[0].urgency).toBe("low");
    expect(openLoopSummarizer.summarizeOpenLoops(makeJira("Medium")).openLoops[0].urgency).toBe("medium");
  });

  it("maps undefined Jira priority to medium", () => {
    const data = makeBriefData({
      jira: [{ key: "P-1", id: "1", self: "", fields: { status: { name: "In Progress" }, summary: "Task", priority: undefined } } as any],
    });
    const { openLoops } = openLoopSummarizer.summarizeOpenLoops(data);
    expect(openLoops[0].urgency).toBe("medium");
  });

  it("detects blocked roadmap items as decisions waiting", () => {
    const data = makeBriefData({
      roadmaps: [
        {
          name: "Q1 Roadmap",
          milestones: [
            {
              name: "Phase 1",
              items: [
                { title: "Build API", status: "blocked" },
                { title: "Build UI", status: "in_progress" },
              ],
            },
          ],
        } as any,
      ],
    });
    const { decisionsWaiting } = openLoopSummarizer.summarizeOpenLoops(data);
    expect(decisionsWaiting).toHaveLength(1);
    expect(decisionsWaiting[0].title).toBe("Build API");
    expect(decisionsWaiting[0].source).toBe("roadmap");
  });

  it("maps critical blocked work item urgency", () => {
    const data = makeBriefData({
      workItems: [
        { id: "w3", title: "Critical blocked", status: "blocked", priority: "critical" } as any,
      ],
    });
    const { openLoops } = openLoopSummarizer.summarizeOpenLoops(data);
    expect(openLoops[0].urgency).toBe("critical");
  });

  it("maps low/default blocked work item urgency", () => {
    const data = makeBriefData({
      workItems: [
        { id: "w4", title: "Low blocked", status: "blocked", priority: "low" } as any,
      ],
    });
    const { openLoops } = openLoopSummarizer.summarizeOpenLoops(data);
    expect(openLoops[0].urgency).toBe("medium");
  });

  it("maps waiting work item priorities correctly", () => {
    const data = makeBriefData({
      workItems: [
        { id: "w5", title: "Critical waiting", status: "waiting", priority: "critical" } as any,
      ],
    });
    const { openLoops } = openLoopSummarizer.summarizeOpenLoops(data);
    expect(openLoops[0].urgency).toBe("critical");
  });
});