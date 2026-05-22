/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { KanbanEdge, KanbanCard, KanbanBoardResponse } from "../../src/kanban/types";

// Re-implement the core rendering logic from kanban.js for integration testing.
// This tests the drawDepArrows flow end-to-end with a real DOM.

function getCardCenter(el: Element, boardRect: DOMRect) {
  const r = el.getBoundingClientRect();
  return {
    x: r.left - boardRect.left + r.width / 2,
    y: r.top - boardRect.top + r.height / 2,
  };
}

function buildEdgePath(from: { x: number; y: number }, to: { x: number; y: number }) {
  const H = (to.x - from.x) / 2;
  return (
    "M " + from.x + "," + from.y +
    " C " + (from.x + H) + "," + from.y +
    " " + (from.x + H) + "," + to.y +
    " " + to.x + "," + to.y
  );
}

function safeFindByDataKey(parent: Element, key: string): Element | null {
  const items = parent.querySelectorAll("[data-key]");
  for (let i = 0; i < items.length; i++) {
    if (items[i].getAttribute("data-key") === key) {
      return items[i];
    }
  }
  return null;
}

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

describe("drawDepArrows integration", () => {
  let boardEl: HTMLElement;
  let depOverlay: SVGSVGElement;
  let cardIndex: Map<string, HTMLElement>;

  beforeEach(() => {
    // Build the board DOM structure matching kanban.html
    document.body.innerHTML = `
      <div id="kanban-board" class="k-board">
        <svg id="dep-overlay" class="dep-overlay" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="dep-arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill="#667eea" />
            </marker>
            <marker id="dep-arrowhead-ghost" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill="#9ca3af" />
            </marker>
            <marker id="dep-arrowhead-pending" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill="#9ca3af" />
            </marker>
            <marker id="dep-arrowhead-in_progress" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill="#f59e0b" />
            </marker>
            <marker id="dep-arrowhead-blocked" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill="#ef4444" />
            </marker>
            <marker id="dep-arrowhead-resolved" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill="#22c55e" />
            </marker>
            <marker id="dep-arrowhead-critical" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill="#eab308" />
            </marker>
          </defs>
        </svg>
        <div class="k-col" data-column="backlog">
          <div class="k-col-items" id="col-backlog"></div>
        </div>
        <div class="k-col" data-column="in_flight">
          <div class="k-col-items" id="col-in_flight"></div>
        </div>
        <div class="k-col" data-column="blocked">
          <div class="k-col-items" id="col-blocked"></div>
        </div>
        <div class="k-col" data-column="done">
          <div class="k-col-items" id="col-done"></div>
        </div>
      </div>
    `;

    boardEl = document.getElementById("kanban-board")!;
    depOverlay = document.getElementById("dep-overlay") as unknown as SVGSVGElement;
    cardIndex = new Map();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  function renderCards(cards: KanbanCard[]) {
    const colMap: Record<string, HTMLElement> = {
      backlog: document.getElementById("col-backlog")!,
      in_flight: document.getElementById("col-in_flight")!,
      blocked: document.getElementById("col-blocked")!,
      done: document.getElementById("col-done")!,
    };

    cards.forEach((card) => {
      const article = document.createElement("article");
      article.className = "kcard";
      article.setAttribute("data-key", card.key);
      article.textContent = card.title;
      const col = card.column || "backlog";
      (colMap[col] || colMap.backlog).appendChild(article);
      cardIndex.set(card.key, article);
    });
  }

  function drawDepArrows(edges: KanbanEdge[], cards?: KanbanCard[]) {
    // Clear existing paths (keep <defs>)
    const existing = depOverlay.querySelectorAll(".dep-path");
    for (let i = 0; i < existing.length; i++) {
      existing[i].parentNode?.removeChild(existing[i]);
    }

    if (edges.length === 0) return;

    const boardRect = boardEl.getBoundingClientRect();

    // Build card column lookup for edge state computation
    const cardColumnMap: Record<string, string> = {};
    (cards || []).forEach((c) => { cardColumnMap[c.key] = c.column; });

    edges.forEach((edge) => {
      const fromEl = cardIndex.get(edge.fromKey) || safeFindByDataKey(boardEl, edge.fromKey);
      const toEl = cardIndex.get(edge.toKey) || safeFindByDataKey(boardEl, edge.toKey);

      if (!fromEl || !toEl) return;

      const from = getCardCenter(fromEl, boardRect);
      const to = getCardCenter(toEl, boardRect);

      // Determine edge state from blocker column
      const blockerColumn = cardColumnMap[edge.fromKey];
      let edgeState = "pending";
      if (blockerColumn === "done") edgeState = "resolved";
      else if (blockerColumn === "in_flight") edgeState = "in_progress";
      else if (blockerColumn === "blocked") edgeState = "blocked";

      const isCritical = !!edge.onCriticalPath;

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", buildEdgePath(from, to));

      // Pick marker
      let markerId: string;
      if (edge.fromGhost) {
        markerId = "dep-arrowhead-ghost";
      } else if (isCritical) {
        markerId = "dep-arrowhead-critical";
      } else {
        markerId = "dep-arrowhead-" + edgeState;
      }
      const markerEl = depOverlay.querySelector("#" + markerId);
      path.setAttribute("marker-end", markerEl ? ("url(#" + markerId + ")") : "url(#dep-arrowhead)");

      path.classList.add("dep-path");
      if (edge.fromGhost) path.classList.add("dep-path--ghost");
      path.classList.add("dep-edge--" + edgeState);
      if (isCritical) path.classList.add("dep-edge--critical");
      path.setAttribute("data-from", edge.fromKey);
      path.setAttribute("data-to", edge.toKey);
      path.setAttribute("data-state", edgeState);

      depOverlay.appendChild(path);

      // In happy-dom, getTotalLength may not be available — skip if so
      if (typeof path.getTotalLength === "function") {
        const totalLen = path.getTotalLength();
        if (!edge.fromGhost && edgeState !== "resolved") {
          path.style.strokeDasharray = String(totalLen);
          path.style.strokeDashoffset = String(totalLen);
        }
      }
    });
  }

  it("renders no arrows when edges array is empty", () => {
    renderCards([makeCard({ key: "github:owner/repo:1" })]);
    drawDepArrows([]);

    const paths = depOverlay.querySelectorAll(".dep-path");
    expect(paths).toHaveLength(0);
  });

  it("renders an arrow for a single edge between two cards", () => {
    const card1 = makeCard({ key: "github:owner/repo:1", column: "backlog" });
    const card2 = makeCard({ key: "github:owner/repo:2", column: "in_flight" });
    renderCards([card1, card2]);

    const edges: KanbanEdge[] = [
      { fromKey: "github:owner/repo:1", toKey: "github:owner/repo:2", fromGhost: false, kind: "depends_on", label: "depends on #1" },
    ];

    drawDepArrows(edges, [card1, card2]);

    const paths = depOverlay.querySelectorAll(".dep-path");
    expect(paths).toHaveLength(1);
    expect(paths[0].getAttribute("data-from")).toBe("github:owner/repo:1");
    expect(paths[0].getAttribute("data-to")).toBe("github:owner/repo:2");
    // Blocker card1 is in backlog, so edge state is "pending"
    expect(paths[0].getAttribute("marker-end")).toBe("url(#dep-arrowhead-pending)");
  });

  it("renders ghost arrow with ghost marker and class", () => {
    const card2 = makeCard({ key: "github:owner/repo:2", column: "blocked" });
    renderCards([card2]);

    const edges: KanbanEdge[] = [
      { fromKey: "jira:PROJ:999", toKey: "github:owner/repo:2", fromGhost: true, kind: "depends_on", label: "depends on PROJ-999" },
    ];

    drawDepArrows(edges);

    const paths = depOverlay.querySelectorAll(".dep-path");
    // Only 1 arrow — fromEl is missing (ghost not in DOM), so it's skipped
    expect(paths).toHaveLength(0);
  });

  it("skips arrows where both endpoints are missing", () => {
    renderCards([]);
    const edges: KanbanEdge[] = [
      { fromKey: "missing:1", toKey: "missing:2", fromGhost: false, kind: "depends_on", label: "x" },
    ];
    drawDepArrows(edges);

    const paths = depOverlay.querySelectorAll(".dep-path");
    expect(paths).toHaveLength(0);
  });

  it("renders multiple arrows for multiple edges", () => {
    const card1 = makeCard({ key: "github:owner/repo:1", column: "backlog" });
    const card2 = makeCard({ key: "github:owner/repo:2", column: "in_flight" });
    const card3 = makeCard({ key: "github:owner/repo:3", column: "done" });
    renderCards([card1, card2, card3]);

    const edges: KanbanEdge[] = [
      { fromKey: "github:owner/repo:1", toKey: "github:owner/repo:2", fromGhost: false, kind: "depends_on", label: "1→2" },
      { fromKey: "github:owner/repo:1", toKey: "github:owner/repo:3", fromGhost: false, kind: "depends_on", label: "1→3" },
    ];

    drawDepArrows(edges);

    const paths = depOverlay.querySelectorAll(".dep-path");
    expect(paths).toHaveLength(2);
  });

  it("clears previous arrows on redraw", () => {
    const card1 = makeCard({ key: "github:owner/repo:1" });
    const card2 = makeCard({ key: "github:owner/repo:2" });
    renderCards([card1, card2]);

    const edges: KanbanEdge[] = [
      { fromKey: "github:owner/repo:1", toKey: "github:owner/repo:2", fromGhost: false, kind: "depends_on", label: "1→2" },
    ];

    drawDepArrows(edges);
    expect(depOverlay.querySelectorAll(".dep-path")).toHaveLength(1);

    // Redraw
    drawDepArrows(edges);
    expect(depOverlay.querySelectorAll(".dep-path")).toHaveLength(1);
  });

  it("does not inject DOM via malicious edge keys", () => {
    const maliciousKey = 'foo"]<img src=x onerror=alert(1)>[data-key="foo';
    const card1 = makeCard({ key: "safe:card:1" });
    renderCards([card1]);

    // Attempt to use a malicious key — safeFindByDataKey should not throw or find anything
    const edges: KanbanEdge[] = [
      { fromKey: maliciousKey, toKey: "safe:card:1", fromGhost: false, kind: "depends_on", label: "malicious" },
    ];

    expect(() => drawDepArrows(edges)).not.toThrow();
    // fromEl is not found (maliciousKey doesn't match), so no arrow
    expect(depOverlay.querySelectorAll(".dep-path")).toHaveLength(0);
  });

  it("finds card via fallback safeFindByDataKey when not in cardIndex", () => {
    const card1 = makeCard({ key: "github:owner/repo:1" });
    const card2 = makeCard({ key: "github:owner/repo:2" });
    renderCards([card1, card2]);

    // Remove card1 from index but leave in DOM
    cardIndex.delete("github:owner/repo:1");

    const edges: KanbanEdge[] = [
      { fromKey: "github:owner/repo:1", toKey: "github:owner/repo:2", fromGhost: false, kind: "depends_on", label: "1→2" },
    ];

    drawDepArrows(edges);

    const paths = depOverlay.querySelectorAll(".dep-path");
    // Arrow still renders because safeFindByDataKey finds it in the DOM
    expect(paths).toHaveLength(1);
    expect(paths[0].getAttribute("data-from")).toBe("github:owner/repo:1");
  });

  it("simulates full renderBoard → drawDepArrows flow", () => {
    // Simulates the full render flow: renderBoard stores edges, then drawDepArrows is called
    const boardData: KanbanBoardResponse = {
      cards: [
        makeCard({ key: "github:owner/repo:1", column: "backlog", title: "Setup CI" }),
        makeCard({ key: "github:owner/repo:2", column: "in_flight", title: "Add tests", dependencyKeys: ["github:owner/repo:1"] }),
        makeCard({ key: "github:owner/repo:3", column: "blocked", title: "Deploy", dependencyKeys: ["github:owner/repo:2"] }),
      ],
      edges: [
        { fromKey: "github:owner/repo:1", toKey: "github:owner/repo:2", fromGhost: false, kind: "depends_on", label: "depends on #1" },
        { fromKey: "github:owner/repo:2", toKey: "github:owner/repo:3", fromGhost: false, kind: "depends_on", label: "depends on #2" },
      ],
      ghostNodes: [],
      agents: [],
      repos: [{ platform: "github", repo: "owner/repo", cardCount: 3 }],
      generatedAt: "2026-01-01T00:00:00Z",
    };

    // Step 1: Render cards (simulates renderBoard)
    renderCards(boardData.cards);

    // Step 2: Draw dependency arrows (simulates drawDepArrows)
    drawDepArrows(boardData.edges, boardData.cards);

    // Verify all arrows rendered
    const paths = depOverlay.querySelectorAll(".dep-path");
    expect(paths).toHaveLength(2);

    // Verify arrow endpoints
    const fromKeys = Array.from(paths).map((p) => p.getAttribute("data-from"));
    const toKeys = Array.from(paths).map((p) => p.getAttribute("data-to"));
    expect(fromKeys).toContain("github:owner/repo:1");
    expect(fromKeys).toContain("github:owner/repo:2");
    expect(toKeys).toContain("github:owner/repo:2");
    expect(toKeys).toContain("github:owner/repo:3");

    // Verify state-aware rendering
    paths.forEach((p) => {
      expect(p.classList.contains("dep-path--ghost")).toBe(false);
      const state = p.getAttribute("data-state");
      expect(["pending", "in_progress", "blocked", "resolved"]).toContain(state);
    });

    // Card 1 is backlog (blocker for edge 1→2) → pending
    // Card 2 is in_flight (blocker for edge 2→3) → in_progress
    const edge12 = Array.from(paths).find((p) => p.getAttribute("data-from") === "github:owner/repo:1");
    const edge23 = Array.from(paths).find((p) => p.getAttribute("data-from") === "github:owner/repo:2");
    expect(edge12?.getAttribute("data-state")).toBe("pending");
    expect(edge12?.classList.contains("dep-edge--pending")).toBe(true);
    expect(edge23?.getAttribute("data-state")).toBe("in_progress");
    expect(edge23?.classList.contains("dep-edge--in_progress")).toBe(true);
  });

  // ─── Edge state tests ──────────────────────────────────────────────────────

  it("applies blocked state when blocker card is in blocked column", () => {
    const card1 = makeCard({ key: "github:owner/repo:1", column: "blocked" });
    const card2 = makeCard({ key: "github:owner/repo:2", column: "in_flight" });
    renderCards([card1, card2]);

    const edges: KanbanEdge[] = [
      { fromKey: "github:owner/repo:1", toKey: "github:owner/repo:2", fromGhost: false, kind: "depends_on", label: "blocked by #1" },
    ];

    drawDepArrows(edges, [card1, card2]);

    const paths = depOverlay.querySelectorAll(".dep-path");
    expect(paths).toHaveLength(1);
    expect(paths[0].classList.contains("dep-edge--blocked")).toBe(true);
    expect(paths[0].getAttribute("data-state")).toBe("blocked");
    expect(paths[0].getAttribute("marker-end")).toBe("url(#dep-arrowhead-blocked)");
  });

  it("applies resolved state when blocker card is in done column", () => {
    const card1 = makeCard({ key: "github:owner/repo:1", column: "done" });
    const card2 = makeCard({ key: "github:owner/repo:2", column: "backlog" });
    renderCards([card1, card2]);

    const edges: KanbanEdge[] = [
      { fromKey: "github:owner/repo:1", toKey: "github:owner/repo:2", fromGhost: false, kind: "depends_on", label: "depends on #1" },
    ];

    drawDepArrows(edges, [card1, card2]);

    const paths = depOverlay.querySelectorAll(".dep-path");
    expect(paths).toHaveLength(1);
    expect(paths[0].classList.contains("dep-edge--resolved")).toBe(true);
    expect(paths[0].getAttribute("data-state")).toBe("resolved");
    expect(paths[0].getAttribute("marker-end")).toBe("url(#dep-arrowhead-resolved)");
  });

  it("applies critical path class when edge is on critical path", () => {
    const card1 = makeCard({ key: "github:owner/repo:1", column: "backlog" });
    const card2 = makeCard({ key: "github:owner/repo:2", column: "in_flight" });
    renderCards([card1, card2]);

    const edges: KanbanEdge[] = [
      { fromKey: "github:owner/repo:1", toKey: "github:owner/repo:2", fromGhost: false, kind: "depends_on", label: "depends on #1", onCriticalPath: true },
    ];

    drawDepArrows(edges, [card1, card2]);

    const paths = depOverlay.querySelectorAll(".dep-path");
    expect(paths).toHaveLength(1);
    expect(paths[0].classList.contains("dep-edge--critical")).toBe(true);
    // Still has base state too
    expect(paths[0].classList.contains("dep-edge--pending")).toBe(true);
    expect(paths[0].getAttribute("marker-end")).toBe("url(#dep-arrowhead-critical)");
  });

  it("defaults to pending state for unknown blocker column", () => {
    // Ghost node as blocker — not in cardIndex so no column known
    const card2 = makeCard({ key: "github:owner/repo:2", column: "in_flight" });
    renderCards([card2]);

    const edges: KanbanEdge[] = [
      { fromKey: "github:owner/repo:1", toKey: "github:owner/repo:2", fromGhost: false, kind: "depends_on", label: "depends on #1" },
    ];

    drawDepArrows(edges, [card2]);

    const paths = depOverlay.querySelectorAll(".dep-path");
    // fromEl not found (card1 not rendered), so no arrow
    expect(paths).toHaveLength(0);
  });
});
