import { describe, it, expect } from "vitest";
import type {
  KanbanColumn,
  KanbanCard,
  KanbanAgent,
  KanbanEdge,
  KanbanGhostNode,
  KanbanBoardResponse,
  KanbanSSEEvent,
} from "../types";

function makeCard(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    key: "github:owner/repo:1",
    platform: "github",
    repo: "owner/repo",
    id: "1",
    externalId: "#1",
    title: "Test issue",
    url: "https://github.com/owner/repo/issues/1",
    status: "open",
    column: "backlog",
    priority: "medium",
    assignee: null,
    labels: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    dependencyKeys: [],
    activeAgentRunId: null,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<KanbanAgent> = {}): KanbanAgent {
  return {
    agentRunId: "run-1",
    agent: "claude",
    model: "claude-opus-4-7",
    status: "running",
    cardKey: null,
    startedAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    toolLoopCount: 0,
    lastTool: null,
    ...overrides,
  };
}

describe("KanbanCard", () => {
  it("creates a valid card with all required fields", () => {
    const card = makeCard();
    expect(card.key).toBe("github:owner/repo:1");
    expect(card.platform).toBe("github");
    expect(card.column).toBe("backlog");
    expect(card.priority).toBe("medium");
  });

  it("allows optional sprint field", () => {
    const card = makeCard({ sprint: "sprint-1" });
    expect(card.sprint).toBe("sprint-1");
  });

  it("supports all column values", () => {
    const columns: KanbanColumn[] = ["backlog", "in_flight", "blocked", "done"];
    for (const col of columns) {
      const card = makeCard({ column: col });
      expect(card.column).toBe(col);
    }
  });

  it("supports all platform values", () => {
    const platforms = ["github", "gitlab", "jira", "work_items"] as const;
    for (const platform of platforms) {
      const card = makeCard({
        platform,
        key: `${platform}:repo:1`,
      });
      expect(card.platform).toBe(platform);
    }
  });

  it("supports all priority values", () => {
    const priorities = ["critical", "high", "medium", "low", "unknown"] as const;
    for (const priority of priorities) {
      const card = makeCard({ priority });
      expect(card.priority).toBe(priority);
    }
  });

  it("allows dependency keys", () => {
    const card = makeCard({
      dependencyKeys: ["github:owner/repo:2", "jira:PROJ:123"],
    });
    expect(card.dependencyKeys).toHaveLength(2);
  });

  it("allows null assignee and activeAgentRunId", () => {
    const card = makeCard({ assignee: null, activeAgentRunId: null });
    expect(card.assignee).toBeNull();
    expect(card.activeAgentRunId).toBeNull();
  });

  it("allows non-null assignee and activeAgentRunId", () => {
    const card = makeCard({
      assignee: "user-1",
      activeAgentRunId: "run-42",
    });
    expect(card.assignee).toBe("user-1");
    expect(card.activeAgentRunId).toBe("run-42");
  });
});

describe("KanbanAgent", () => {
  it("creates a valid agent with all required fields", () => {
    const agent = makeAgent();
    expect(agent.agentRunId).toBe("run-1");
    expect(agent.agent).toBe("claude");
    expect(agent.status).toBe("running");
  });

  it("supports all agent types", () => {
    const agents = ["claude", "codex", "opencode"] as const;
    for (const agent of agents) {
      const a = makeAgent({ agent });
      expect(a.agent).toBe(agent);
    }
  });

  it("supports all agent statuses", () => {
    const statuses = ["running", "completed", "failed"] as const;
    for (const status of statuses) {
      const a = makeAgent({ status });
      expect(a.status).toBe(status);
    }
  });

  it("allows optional checkpoint", () => {
    const agent = makeAgent({ checkpoint: "ckpt-abc" });
    expect(agent.checkpoint).toBe("ckpt-abc");
  });

  it("allows null model and lastTool", () => {
    const agent = makeAgent({ model: null, lastTool: null });
    expect(agent.model).toBeNull();
    expect(agent.lastTool).toBeNull();
  });
});

describe("KanbanEdge", () => {
  it("creates a valid edge", () => {
    const edge: KanbanEdge = {
      fromKey: "github:owner/repo:1",
      toKey: "github:owner/repo:2",
      fromGhost: false,
      kind: "depends_on",
      label: "depends on #2",
    };
    expect(edge.fromKey).toBe("github:owner/repo:1");
    expect(edge.kind).toBe("depends_on");
  });

  it("supports blocks kind", () => {
    const edge: KanbanEdge = {
      fromKey: "github:owner/repo:1",
      toKey: "github:owner/repo:2",
      fromGhost: true,
      kind: "blocks",
      label: "blocks #1",
    };
    expect(edge.kind).toBe("blocks");
    expect(edge.fromGhost).toBe(true);
  });
});

describe("KanbanGhostNode", () => {
  it("creates a valid ghost node", () => {
    const ghost: KanbanGhostNode = {
      key: "jira:PROJ:999",
      platform: "jira",
      repo: "PROJ",
      id: "PROJ-999",
      label: "PROJ-999: External task",
    };
    expect(ghost.key).toBe("jira:PROJ:999");
    expect(ghost.label).toContain("External task");
  });
});

describe("KanbanBoardResponse", () => {
  it("creates a valid board response", () => {
    const response: KanbanBoardResponse = {
      cards: [makeCard()],
      edges: [],
      ghostNodes: [],
      agents: [makeAgent()],
      repos: [{ platform: "github", repo: "owner/repo", cardCount: 1 }],
      generatedAt: new Date().toISOString(),
    };
    expect(response.cards).toHaveLength(1);
    expect(response.repos[0].cardCount).toBe(1);
    expect(response.generatedAt).toBeTruthy();
  });

  it("handles empty board", () => {
    const response: KanbanBoardResponse = {
      cards: [],
      edges: [],
      ghostNodes: [],
      agents: [],
      repos: [],
      generatedAt: "2026-01-01T00:00:00Z",
    };
    expect(response.cards).toHaveLength(0);
    expect(response.edges).toHaveLength(0);
  });
});

describe("KanbanSSEEvent", () => {
  it("creates card.updated event", () => {
    const event: KanbanSSEEvent = {
      type: "card.updated",
      card: makeCard(),
    };
    expect(event.type).toBe("card.updated");
    if (event.type === "card.updated") {
      expect(event.card.key).toBe("github:owner/repo:1");
    }
  });

  it("creates agent.started event", () => {
    const event: KanbanSSEEvent = {
      type: "agent.started",
      agent: makeAgent(),
    };
    expect(event.type).toBe("agent.started");
    if (event.type === "agent.started") {
      expect(event.agent.agentRunId).toBe("run-1");
    }
  });

  it("creates agent.step event", () => {
    const event: KanbanSSEEvent = {
      type: "agent.step",
      agentRunId: "run-1",
      toolName: "Edit",
      stepOrder: 3,
    };
    expect(event.type).toBe("agent.step");
    if (event.type === "agent.step") {
      expect(event.stepOrder).toBe(3);
    }
  });

  it("creates agent.completed event without error", () => {
    const event: KanbanSSEEvent = {
      type: "agent.completed",
      agentRunId: "run-1",
      status: "completed",
    };
    expect(event.type).toBe("agent.completed");
    if (event.type === "agent.completed") {
      expect(event.status).toBe("completed");
      expect(event.errorMessage).toBeUndefined();
    }
  });

  it("creates agent.completed event with error", () => {
    const event: KanbanSSEEvent = {
      type: "agent.completed",
      agentRunId: "run-1",
      status: "failed",
      errorMessage: "OOM killed",
    };
    if (event.type === "agent.completed") {
      expect(event.errorMessage).toBe("OOM killed");
    }
  });

  it("creates dependency.unblocked event", () => {
    const event: KanbanSSEEvent = {
      type: "dependency.unblocked",
      blockerKey: "github:owner/repo:5",
      unblockedKeys: ["github:owner/repo:1", "github:owner/repo:3"],
    };
    expect(event.type).toBe("dependency.unblocked");
    if (event.type === "dependency.unblocked") {
      expect(event.unblockedKeys).toHaveLength(2);
    }
  });

  it("creates worktree.changed event", () => {
    const event: KanbanSSEEvent = {
      type: "worktree.changed",
      path: "/repo/.claude/worktrees/feature-x",
      status: "active",
    };
    if (event.type === "worktree.changed") {
      expect(event.status).toBe("active");
    }
  });

  it("creates worktree.changed event with removed status", () => {
    const event: KanbanSSEEvent = {
      type: "worktree.changed",
      path: "/repo/.claude/worktrees/feature-x",
      status: "removed",
    };
    if (event.type === "worktree.changed") {
      expect(event.status).toBe("removed");
    }
  });
});
