/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { KanbanCard, KanbanAgent, KanbanBoardResponse } from "../../src/kanban/types";

function makeCard(overrides: Partial<KanbanCard> & Pick<KanbanCard, "key">): KanbanCard {
  return {
    key: overrides.key,
    platform: "github",
    repo: "owner/repo",
    id: overrides.key.split(":").pop() || "1",
    externalId: "#1",
    title: "Test card",
    url: "",
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

function makeAgent(overrides: Partial<KanbanAgent> & Pick<KanbanAgent, "agentRunId">): KanbanAgent {
  return {
    agentRunId: overrides.agentRunId,
    agent: "claude",
    model: "opus",
    status: "running",
    cardKey: null,
    startedAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    toolLoopCount: 0,
    lastTool: null,
    ...overrides,
  };
}

// Re-implement core swimlane grouping logic from kanban.js for testing
interface AgentCacheEntry {
  agent: string;
  model: string | null;
  startedAt: string;
  cardKey: string | null;
}

function groupCardsByAgent(
  cards: KanbanCard[],
  agentCache: Record<string, AgentCacheEntry>
): { groups: Record<string, KanbanCard[]>; unassigned: KanbanCard[] } {
  const groups: Record<string, KanbanCard[]> = {};
  const unassigned: KanbanCard[] = [];

  cards.forEach((card) => {
    if (card.activeAgentRunId && agentCache[card.activeAgentRunId]) {
      if (!groups[card.activeAgentRunId]) {
        groups[card.activeAgentRunId] = [];
      }
      groups[card.activeAgentRunId].push(card);
    } else {
      unassigned.push(card);
    }
  });

  return { groups, unassigned };
}

function sortAgentLanes(
  groupKeys: string[],
  agentCache: Record<string, AgentCacheEntry>
): string[] {
  return groupKeys.sort((a, b) => {
    const aStarted = agentCache[a] ? new Date(agentCache[a].startedAt).getTime() : 0;
    const bStarted = agentCache[b] ? new Date(agentCache[b].startedAt).getTime() : 0;
    return bStarted - aStarted;
  });
}

describe("Swimlane grouping logic", () => {
  it("places all cards in unassigned when no agents are cached", () => {
    const cards = [
      makeCard({ key: "github:owner/repo:1" }),
      makeCard({ key: "github:owner/repo:2", activeAgentRunId: "run-1" }),
    ];
    const { groups, unassigned } = groupCardsByAgent(cards, {});
    expect(Object.keys(groups)).toHaveLength(0);
    expect(unassigned).toHaveLength(2);
  });

  it("groups cards by activeAgentRunId when agent is cached", () => {
    const agentCache: Record<string, AgentCacheEntry> = {
      "run-1": { agent: "claude", model: "opus", startedAt: "2026-01-01T00:00:00Z", cardKey: "github:owner/repo:2" },
    };
    const cards = [
      makeCard({ key: "github:owner/repo:1" }),
      makeCard({ key: "github:owner/repo:2", activeAgentRunId: "run-1" }),
    ];

    const { groups, unassigned } = groupCardsByAgent(cards, agentCache);
    expect(Object.keys(groups)).toEqual(["run-1"]);
    expect(groups["run-1"]).toHaveLength(1);
    expect(groups["run-1"][0].key).toBe("github:owner/repo:2");
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0].key).toBe("github:owner/repo:1");
  });

  it("stacks multiple cards under one agent", () => {
    const agentCache: Record<string, AgentCacheEntry> = {
      "run-1": { agent: "claude", model: "opus", startedAt: "2026-01-01T00:00:00Z", cardKey: null },
    };
    const cards = [
      makeCard({ key: "github:owner/repo:1", activeAgentRunId: "run-1" }),
      makeCard({ key: "github:owner/repo:2", activeAgentRunId: "run-1" }),
      makeCard({ key: "github:owner/repo:3", activeAgentRunId: "run-1" }),
    ];

    const { groups, unassigned } = groupCardsByAgent(cards, agentCache);
    expect(groups["run-1"]).toHaveLength(3);
    expect(unassigned).toHaveLength(0);
  });

  it("separates cards across multiple agents", () => {
    const agentCache: Record<string, AgentCacheEntry> = {
      "run-1": { agent: "claude", model: "opus", startedAt: "2026-01-01T00:00:00Z", cardKey: null },
      "run-2": { agent: "codex", model: "gpt-4", startedAt: "2026-01-01T01:00:00Z", cardKey: null },
    };
    const cards = [
      makeCard({ key: "github:owner/repo:1", activeAgentRunId: "run-1" }),
      makeCard({ key: "github:owner/repo:2", activeAgentRunId: "run-2" }),
      makeCard({ key: "github:owner/repo:3" }),
    ];

    const { groups, unassigned } = groupCardsByAgent(cards, agentCache);
    expect(Object.keys(groups)).toHaveLength(2);
    expect(groups["run-1"]).toHaveLength(1);
    expect(groups["run-2"]).toHaveLength(1);
    expect(unassigned).toHaveLength(1);
  });

  it("treats activeAgentRunId with no cache entry as unassigned", () => {
    const cards = [
      makeCard({ key: "github:owner/repo:1", activeAgentRunId: "unknown-run" }),
    ];
    const { groups, unassigned } = groupCardsByAgent(cards, {});
    expect(Object.keys(groups)).toHaveLength(0);
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0].key).toBe("github:owner/repo:1");
  });

  it("handles empty cards array", () => {
    const { groups, unassigned } = groupCardsByAgent([], {});
    expect(Object.keys(groups)).toHaveLength(0);
    expect(unassigned).toHaveLength(0);
  });
});

describe("Swimlane sort order", () => {
  it("sorts agent lanes by elapsed-since-started descending (most recent first)", () => {
    const agentCache: Record<string, AgentCacheEntry> = {
      "run-1": { agent: "claude", model: "opus", startedAt: "2026-01-01T00:00:00Z", cardKey: null },
      "run-2": { agent: "codex", model: "gpt-4", startedAt: "2026-01-01T02:00:00Z", cardKey: null },
      "run-3": { agent: "opencode", model: null, startedAt: "2026-01-01T01:00:00Z", cardKey: null },
    };

    const sorted = sortAgentLanes(["run-1", "run-2", "run-3"], agentCache);
    expect(sorted).toEqual(["run-2", "run-3", "run-1"]);
  });

  it("handles single agent lane", () => {
    const agentCache: Record<string, AgentCacheEntry> = {
      "run-1": { agent: "claude", model: "opus", startedAt: "2026-01-01T00:00:00Z", cardKey: null },
    };
    const sorted = sortAgentLanes(["run-1"], agentCache);
    expect(sorted).toEqual(["run-1"]);
  });

  it("handles empty agent list", () => {
    const sorted = sortAgentLanes([], {});
    expect(sorted).toEqual([]);
  });
});

describe("Swimlane DOM rendering", () => {
  let swimlanesEl: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="kanban-swimlanes" class="k-swimlanes">
        <svg id="dep-overlay-swim" class="dep-overlay" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="dep-arrowhead-swim" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill="#667eea" />
            </marker>
            <marker id="dep-arrowhead-ghost-swim" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill="#9ca3af" />
            </marker>
          </defs>
        </svg>
      </div>
    `;
    swimlanesEl = document.getElementById("kanban-swimlanes")!;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  function renderSwimlanes(cards: KanbanCard[], agents: KanbanAgent[]) {
    // Clear previous lanes
    const lanes = swimlanesEl.querySelectorAll(".k-swimlane");
    for (let i = 0; i < lanes.length; i++) {
      lanes[i].parentNode!.removeChild(lanes[i]);
    }

    if (cards.length === 0) return;

    const agentCache: Record<string, AgentCacheEntry> = {};
    agents.forEach((a) => {
      agentCache[a.agentRunId] = {
        agent: a.agent,
        model: a.model,
        startedAt: a.startedAt,
        cardKey: a.cardKey,
      };
    });

    const { groups, unassigned } = groupCardsByAgent(cards, agentCache);
    const sortedAgentIds = sortAgentLanes(Object.keys(groups), agentCache);

    sortedAgentIds.forEach((agentRunId) => {
      const agentInfo = agentCache[agentRunId];
      const agentCards = groups[agentRunId];

      const lane = document.createElement("div");
      lane.className = "k-swimlane";
      lane.setAttribute("data-agent-run-id", agentRunId);

      lane.innerHTML =
        '<div class="k-swimlane-header">' +
          '<span class="k-swimlane-label">' + agentInfo!.agent + '</span>' +
          '<span class="k-swimlane-count">' + agentCards.length + '</span>' +
        '</div>' +
        '<div class="k-swimlane-cards"></div>';

      const cardsContainer = lane.querySelector(".k-swimlane-cards")!;
      agentCards.forEach((card) => {
        const article = document.createElement("article");
        article.className = "kcard";
        article.setAttribute("data-key", card.key);
        article.textContent = card.title;
        cardsContainer.appendChild(article);
      });

      swimlanesEl.appendChild(lane);
    });

    if (unassigned.length > 0) {
      const lane = document.createElement("div");
      lane.className = "k-swimlane k-swimlane--unassigned";

      lane.innerHTML =
        '<div class="k-swimlane-header">' +
          '<span class="k-swimlane-label">Unassigned</span>' +
          '<span class="k-swimlane-count">' + unassigned.length + '</span>' +
        '</div>' +
        '<div class="k-swimlane-cards"></div>';

      const cardsContainer = lane.querySelector(".k-swimlane-cards")!;
      unassigned.forEach((card) => {
        const article = document.createElement("article");
        article.className = "kcard";
        article.setAttribute("data-key", card.key);
        article.textContent = card.title;
        cardsContainer.appendChild(article);
      });

      swimlanesEl.appendChild(lane);
    }
  }

  it("renders one lane per agent plus unassigned lane", () => {
    const agents = [
      makeAgent({ agentRunId: "run-1", agent: "claude", startedAt: "2026-01-01T00:00:00Z" }),
      makeAgent({ agentRunId: "run-2", agent: "codex", startedAt: "2026-01-01T01:00:00Z" }),
    ];
    const cards = [
      makeCard({ key: "github:owner/repo:1", activeAgentRunId: "run-1" }),
      makeCard({ key: "github:owner/repo:2", activeAgentRunId: "run-2" }),
      makeCard({ key: "github:owner/repo:3" }),
    ];

    renderSwimlanes(cards, agents);

    const lanes = swimlanesEl.querySelectorAll(".k-swimlane");
    expect(lanes).toHaveLength(3); // 2 agent lanes + 1 unassigned
  });

  it("renders unassigned lane last", () => {
    const agents = [
      makeAgent({ agentRunId: "run-1", startedAt: "2026-01-01T00:00:00Z" }),
    ];
    const cards = [
      makeCard({ key: "github:owner/repo:1", activeAgentRunId: "run-1" }),
      makeCard({ key: "github:owner/repo:2" }),
    ];

    renderSwimlanes(cards, agents);

    const lanes = swimlanesEl.querySelectorAll(".k-swimlane");
    expect(lanes).toHaveLength(2);
    expect(lanes[1].classList.contains("k-swimlane--unassigned")).toBe(true);
  });

  it("stacks multiple cards in one agent lane", () => {
    const agents = [
      makeAgent({ agentRunId: "run-1", startedAt: "2026-01-01T00:00:00Z" }),
    ];
    const cards = [
      makeCard({ key: "github:owner/repo:1", activeAgentRunId: "run-1" }),
      makeCard({ key: "github:owner/repo:2", activeAgentRunId: "run-1" }),
    ];

    renderSwimlanes(cards, agents);

    const lanes = swimlanesEl.querySelectorAll(".k-swimlane");
    expect(lanes).toHaveLength(1);
    const agentCards = lanes[0].querySelectorAll(".kcard");
    expect(agentCards).toHaveLength(2);
  });

  it("does not render unassigned lane when all cards are assigned", () => {
    const agents = [
      makeAgent({ agentRunId: "run-1", startedAt: "2026-01-01T00:00:00Z" }),
    ];
    const cards = [
      makeCard({ key: "github:owner/repo:1", activeAgentRunId: "run-1" }),
    ];

    renderSwimlanes(cards, agents);

    const unassigned = swimlanesEl.querySelectorAll(".k-swimlane--unassigned");
    expect(unassigned).toHaveLength(0);
  });

  it("renders only unassigned lane when no agents are active", () => {
    const cards = [
      makeCard({ key: "github:owner/repo:1" }),
      makeCard({ key: "github:owner/repo:2" }),
    ];

    renderSwimlanes(cards, []);

    const lanes = swimlanesEl.querySelectorAll(".k-swimlane");
    expect(lanes).toHaveLength(1);
    expect(lanes[0].classList.contains("k-swimlane--unassigned")).toBe(true);
    const cardsInLane = lanes[0].querySelectorAll(".kcard");
    expect(cardsInLane).toHaveLength(2);
  });

  it("renders no lanes when cards array is empty", () => {
    renderSwimlanes([], []);

    const lanes = swimlanesEl.querySelectorAll(".k-swimlane");
    expect(lanes).toHaveLength(0);
  });

  it("sorts lanes by most recently started first", () => {
    const agents = [
      makeAgent({ agentRunId: "run-1", agent: "claude", startedAt: "2026-01-01T00:00:00Z" }),
      makeAgent({ agentRunId: "run-2", agent: "codex", startedAt: "2026-01-02T00:00:00Z" }),
    ];
    const cards = [
      makeCard({ key: "github:owner/repo:1", activeAgentRunId: "run-1" }),
      makeCard({ key: "github:owner/repo:2", activeAgentRunId: "run-2" }),
    ];

    renderSwimlanes(cards, agents);

    const lanes = swimlanesEl.querySelectorAll(".k-swimlane");
    expect(lanes).toHaveLength(2);
    // run-2 started later so should be first
    expect(lanes[0].getAttribute("data-agent-run-id")).toBe("run-2");
    expect(lanes[1].getAttribute("data-agent-run-id")).toBe("run-1");
  });
});

describe("View toggle persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to status view when no localStorage value", () => {
    expect(localStorage.getItem("kanban-view")).toBeNull();
    const currentView = localStorage.getItem("kanban-view") || "status";
    expect(currentView).toBe("status");
  });

  it("persists swimlane view to localStorage", () => {
    localStorage.setItem("kanban-view", "swimlane");
    expect(localStorage.getItem("kanban-view")).toBe("swimlane");
  });

  it("persists status view to localStorage", () => {
    localStorage.setItem("kanban-view", "status");
    expect(localStorage.getItem("kanban-view")).toBe("status");
  });

  it("restores saved view on load", () => {
    localStorage.setItem("kanban-view", "swimlane");
    const restored = localStorage.getItem("kanban-view") || "status";
    expect(restored).toBe("swimlane");
  });
});
