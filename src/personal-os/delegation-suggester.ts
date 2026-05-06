import type { DelegationCandidate } from "./types";
import type { WorkItem } from "../work-items/types";

class DelegationSuggester {
  suggestDelegations(workItems: WorkItem[]): DelegationCandidate[] {
    const candidates: DelegationCandidate[] = [];

    for (const item of workItems) {
      if (item.status === "done" || item.status === "archived") continue;

      if (item.priority === "critical") continue;
      if (item.status === "blocked") continue;

      const age = item.createdAt
        ? Date.now() - new Date(item.createdAt).getTime()
        : 0;
      const daysOld = age / (1000 * 60 * 60 * 24);

      if (item.type === "customer_followup" && (item.priority === "low" || item.priority === "medium")) {
        candidates.push({
          workItemId: item.id,
          title: item.title,
          reason: `Low-priority customer follow-up — can be handled by support agent`,
          delegatableTo: "support agent",
          priority: item.priority as "low" | "medium" | "high",
        });
      } else if (item.type === "support") {
        candidates.push({
          workItemId: item.id,
          title: item.title,
          reason: `Support task — can be triaged by support team`,
          delegatableTo: "support team",
          priority: mapPriority(item.priority),
        });
      } else if (item.type === "code_review" && daysOld > 3) {
        candidates.push({
          workItemId: item.id,
          title: item.title,
          reason: `Code review waiting ${Math.round(daysOld)} days — can be delegated to team lead`,
          delegatableTo: "team lead",
          priority: mapPriority(item.priority),
        });
      } else if (item.type === "research" && item.priority === "low") {
        candidates.push({
          workItemId: item.id,
          title: item.title,
          reason: `Low-priority research — can be assigned to a team member`,
          delegatableTo: "team member",
          priority: "low",
        });
      } else if (item.type === "task" && !item.owner && (item.priority === "low" || item.priority === "medium")) {
        candidates.push({
          workItemId: item.id,
          title: item.title,
          reason: `Unowned ${item.priority}-priority task — candidate for delegation`,
          delegatableTo: "team member",
          priority: mapPriority(item.priority),
        });
      }
    }

    return candidates;
  }
}

function mapPriority(p: string | undefined): "low" | "medium" | "high" {
  if (p === "critical" || p === "high") return "high";
  if (p === "medium") return "medium";
  return "low";
}

export const delegationSuggester = new DelegationSuggester();