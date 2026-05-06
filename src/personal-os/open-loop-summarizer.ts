import type {
  BriefData,
  OpenLoop,
  DecisionItem,
} from "./types";

class OpenLoopSummarizer {
  summarizeOpenLoops(data: BriefData): {
    openLoops: OpenLoop[];
    decisionsWaiting: DecisionItem[];
  } {
    const openLoops: OpenLoop[] = [];
    const decisionsWaiting: DecisionItem[] = [];

    // Blocked/waiting work items
    for (const item of data.workItems) {
      if (item.status === "blocked") {
        openLoops.push({
          id: `wi-${item.id}`,
          type: "task",
          title: item.title,
          source: "work_items",
          sourceUrl: item.sourceUrl ?? undefined,
          urgency: item.priority === "critical" ? "critical" : item.priority === "high" ? "high" : "medium",
        });
      } else if (item.status === "waiting") {
        openLoops.push({
          id: `wi-${item.id}`,
          type: "approval",
          title: item.title,
          source: "work_items",
          sourceUrl: item.sourceUrl ?? undefined,
          urgency: mapPriority(item.priority),
        });
      }
    }

    // Jira issues in progress for a while
    for (const issue of data.jira) {
      const status = String(issue.fields?.status?.name || "").toLowerCase();
      if (status.includes("progress")) {
        openLoops.push({
          id: `jira-${issue.key || issue.id}`,
          type: "task",
          title: issue.fields?.summary || issue.key || "Jira issue",
          source: "jira",
          sourceUrl: issue.self ? `${issue.self.replace(/\/rest\/.*/, "")}/browse/${issue.key}` : undefined as string | undefined,
          urgency: mapJiraPriority(issue.fields?.priority?.name),
        });
      }
    }

    // Open PRs/MRs awaiting review
    for (const pr of data.github.pullRequests) {
      openLoops.push({
        id: `gh-pr-${pr.number || pr.id}`,
        type: "followup",
        title: pr.title || `PR #${pr.number || "?"}`,
        source: "github",
        sourceUrl: pr.html_url ?? undefined,
        urgency: "medium",
      });
    }
    for (const mr of data.gitlab.mergeRequests) {
      openLoops.push({
        id: `gl-mr-${mr.iid || mr.id}`,
        type: "followup",
        title: mr.title || `MR !${mr.iid || "?"}`,
        source: "gitlab",
        sourceUrl: mr.web_url ?? undefined,
        urgency: "medium",
      });
    }

    // Jitbit follow-ups
    for (const ticket of data.jitbit.followups) {
      openLoops.push({
        id: `jitbit-${ticket.TicketID || ticket.IssueID || ""}`,
        type: "followup",
        title: ticket.Subject || ticket.Title || `Ticket #${ticket.TicketID || "?"}`,
        source: "jitbit",
        urgency: "medium",
      });
    }

    // Decision work items not yet resolved
    for (const item of data.workItems) {
      if (item.type === "decision" && item.status !== "done" && item.status !== "archived") {
        decisionsWaiting.push({
          title: item.title,
          source: "work_items",
          sourceUrl: item.sourceUrl ?? undefined,
          context: item.description || "No context available",
          waitingSince: item.createdAt,
        });
      }
    }

    // Roadmap items that are blocked
    for (const roadmap of data.roadmaps) {
      for (const milestone of roadmap.milestones || []) {
        for (const item of milestone.items || []) {
          if (item.status === "blocked") {
            decisionsWaiting.push({
              title: item.title,
              source: "roadmap",
              context: `Blocked in roadmap "${roadmap.name}", milestone "${milestone.name}"`,
            });
          }
        }
      }
    }

    return { openLoops, decisionsWaiting };
  }
}

function mapPriority(p: string | undefined): OpenLoop["urgency"] {
  if (p === "critical") return "critical";
  if (p === "high") return "high";
  if (p === "medium") return "medium";
  return "low";
}

function mapJiraPriority(name: string | undefined): OpenLoop["urgency"] {
  if (!name) return "medium";
  const n = name.toLowerCase();
  if (n.includes("highest") || n.includes("critical")) return "critical";
  if (n.includes("high")) return "high";
  if (n.includes("low") || n.includes("lowest")) return "low";
  return "medium";
}

export const openLoopSummarizer = new OpenLoopSummarizer();