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
        { id: "4", title: "Resolved decision", status: "done", priority: "low", type: "decision", source: "chat" } as any,
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
});