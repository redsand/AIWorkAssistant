import { describe, it, expect } from "vitest";
import { delegationSuggester } from "../../../src/personal-os/delegation-suggester";
import type { WorkItem } from "../../../src/work-items/types";

describe("DelegationSuggester", () => {
  it("suggests delegation for low-priority customer follow-up items", () => {
    const workItems: Partial<WorkItem>[] = [
      { id: "1", title: "Follow up with customer", type: "customer_followup", status: "active", priority: "low" },
    ];
    const result = delegationSuggester.suggestDelegations(workItems as WorkItem[]);
    expect(result).toHaveLength(1);
    expect(result[0].delegatableTo).toBe("support agent");
  });

  it("suggests delegation for support-type items", () => {
    const workItems: Partial<WorkItem>[] = [
      { id: "2", title: "Handle support ticket", type: "support", status: "active", priority: "medium" },
    ];
    const result = delegationSuggester.suggestDelegations(workItems as WorkItem[]);
    expect(result).toHaveLength(1);
    expect(result[0].delegatableTo).toBe("support team");
  });

  it("suggests delegation for old code reviews", () => {
    const workItems: Partial<WorkItem>[] = [
      { id: "3", title: "Review PR #5", type: "code_review", status: "active", priority: "medium", createdAt: new Date(Date.now() - 5 * 86400000).toISOString() },
    ];
    const result = delegationSuggester.suggestDelegations(workItems as WorkItem[]);
    expect(result).toHaveLength(1);
    expect(result[0].delegatableTo).toBe("team lead");
  });

  it("does not suggest delegation for critical items", () => {
    const workItems: Partial<WorkItem>[] = [
      { id: "4", title: "Critical task", type: "task", status: "active", priority: "critical" },
    ];
    const result = delegationSuggester.suggestDelegations(workItems as WorkItem[]);
    expect(result).toHaveLength(0);
  });

  it("does not suggest delegation for blocked items", () => {
    const workItems: Partial<WorkItem>[] = [
      { id: "5", title: "Blocked task", type: "customer_followup", status: "blocked", priority: "low" },
    ];
    const result = delegationSuggester.suggestDelegations(workItems as WorkItem[]);
    expect(result).toHaveLength(0);
  });

  it("suggests delegation for unowned low-priority tasks", () => {
    const workItems: Partial<WorkItem>[] = [
      { id: "6", title: "Minor task", type: "task", status: "active", priority: "low", owner: "" },
    ];
    const result = delegationSuggester.suggestDelegations(workItems as WorkItem[]);
    expect(result).toHaveLength(1);
    expect(result[0].delegatableTo).toBe("team member");
  });

  it("returns empty array for no delegatable items", () => {
    const workItems: Partial<WorkItem>[] = [
      { id: "7", title: "Important task", type: "task", status: "active", priority: "high", owner: "Tim" },
    ];
    const result = delegationSuggester.suggestDelegations(workItems as WorkItem[]);
    expect(result).toHaveLength(0);
  });
});