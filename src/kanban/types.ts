export type KanbanColumn = "backlog" | "in_flight" | "blocked" | "done";

export interface KanbanCard {
  key: string; // "<platform>:<repo>:<id>"
  platform: "github" | "gitlab" | "jira" | "work_items";
  repo: string;
  id: string;
  externalId: string;
  title: string;
  url: string;
  status: string;
  column: KanbanColumn;
  priority: "critical" | "high" | "medium" | "low" | "unknown";
  assignee: string | null;
  labels: string[];
  sprint?: string;
  createdAt: string;
  updatedAt: string;
  dependencyKeys: string[];
  activeAgentRunId: string | null;
}

export interface KanbanAgent {
  agentRunId: string;
  agent: "claude" | "codex" | "opencode";
  model: string | null;
  status: "running" | "completed" | "failed";
  cardKey: string | null;
  startedAt: string;
  lastActivityAt: string;
  toolLoopCount: number;
  lastTool: string | null;
  checkpoint?: string;
}

export interface KanbanEdge {
  fromKey: string;
  toKey: string;
  fromGhost: boolean;
  kind: "depends_on" | "blocks";
  label: string;
}

export interface KanbanGhostNode {
  key: string;
  platform: string;
  repo: string;
  id: string;
  label: string;
}

export interface KanbanBoardResponse {
  cards: KanbanCard[];
  edges: KanbanEdge[];
  ghostNodes: KanbanGhostNode[];
  agents: KanbanAgent[];
  repos: { platform: string; repo: string; cardCount: number }[];
  generatedAt: string;
}

export type KanbanSSEEvent =
  | { type: "card.updated"; card: KanbanCard }
  | { type: "agent.started"; agent: KanbanAgent }
  | { type: "agent.step"; agentRunId: string; toolName: string; stepOrder: number }
  | { type: "agent.completed"; agentRunId: string; status: "completed" | "failed"; errorMessage?: string }
  | { type: "dependency.unblocked"; blockerKey: string; unblockedKeys: string[] }
  | { type: "worktree.changed"; path: string; status: "active" | "removed" };
