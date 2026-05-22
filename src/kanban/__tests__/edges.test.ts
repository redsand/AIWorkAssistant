import { describe, it, expect } from "vitest";
import type { KanbanCard } from "../types.js";
import type { DependencyRef } from "../../routes/repo-dashboard.js";
import { resolveEdges, computeCriticalPath } from "../edges.js";

function makeCard(overrides: Partial<KanbanCard> & Pick<KanbanCard, "key" | "platform" | "repo" | "id">): KanbanCard {
  return {
    externalId: overrides.id,
    title: `Card ${overrides.id}`,
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

describe("resolveEdges", () => {
  it("creates a same-repo edge from card to its dependency", () => {
    const blocker = makeCard({ key: "github:owner/repo:10", platform: "github", repo: "owner/repo", id: "10" });
    const dependent = makeCard({ key: "github:owner/repo:42", platform: "github", repo: "owner/repo", id: "42" });

    const depsByCardKey = new Map<string, DependencyRef[]>([
      ["github:owner/repo:42", [{ id: "10", label: "depends on #10", external: false }]],
    ]);

    const { edges, ghostNodes } = resolveEdges([blocker, dependent], depsByCardKey);

    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({
      fromKey: "github:owner/repo:10",
      toKey: "github:owner/repo:42",
      fromGhost: false,
      kind: "depends_on",
      label: "depends on #10",
    });
    expect(ghostNodes).toHaveLength(0);
  });

  it("creates a cross-repo edge when both cards are in portfolio", () => {
    const blocker = makeCard({ key: "github:other/repo:10", platform: "github", repo: "other/repo", id: "10" });
    const dependent = makeCard({ key: "github:owner/repo:42", platform: "github", repo: "owner/repo", id: "42" });

    const depsByCardKey = new Map<string, DependencyRef[]>([
      ["github:owner/repo:42", [{ id: "10", label: "depends on GH:other/repo#10", platform: "github", repo: "other/repo", external: true }]],
    ]);

    const { edges, ghostNodes } = resolveEdges([blocker, dependent], depsByCardKey);

    expect(edges).toHaveLength(1);
    expect(edges[0].fromKey).toBe("github:other/repo:10");
    expect(edges[0].toKey).toBe("github:owner/repo:42");
    expect(edges[0].fromGhost).toBe(false);
    expect(ghostNodes).toHaveLength(0);
  });

  it("creates a ghost node when blocker is not in portfolio", () => {
    const dependent = makeCard({ key: "github:owner/repo:42", platform: "github", repo: "owner/repo", id: "42" });

    const depsByCardKey = new Map<string, DependencyRef[]>([
      ["github:owner/repo:42", [{ id: "99", label: "depends on GH:other/repo#99", platform: "github", repo: "other/repo", external: true }]],
    ]);

    const { edges, ghostNodes } = resolveEdges([dependent], depsByCardKey);

    expect(edges).toHaveLength(1);
    expect(edges[0].fromKey).toBe("github:other/repo:99");
    expect(edges[0].toKey).toBe("github:owner/repo:42");
    expect(edges[0].fromGhost).toBe(true);
    expect(ghostNodes).toHaveLength(1);
    expect(ghostNodes[0]).toEqual({
      key: "github:other/repo:99",
      platform: "github",
      repo: "other/repo",
      id: "99",
      label: "depends on GH:other/repo#99",
    });
  });

  it("deduplicates edges when same dep is listed twice", () => {
    const dependent = makeCard({ key: "github:owner/repo:42", platform: "github", repo: "owner/repo", id: "42" });

    const depsByCardKey = new Map<string, DependencyRef[]>([
      [
        "github:owner/repo:42",
        [
          { id: "10", label: "depends on #10", external: false },
          { id: "10", label: "blocked by #10", external: false },
        ],
      ],
    ]);

    // Both deps resolve to the same key: github:owner/repo:10
    const { edges } = resolveEdges([dependent], depsByCardKey);

    // Only one edge because the second resolves to the same (blockerKey->cardKey) pair
    // Actually, the keys are deduped by "blockerKey->cardKey", but the deps have different labels
    // The dedup should key on (fromKey, toKey) only
    expect(edges).toHaveLength(1);
  });

  it("detects 'blocks' kind from 'blocked by' label", () => {
    const dependent = makeCard({ key: "github:owner/repo:42", platform: "github", repo: "owner/repo", id: "42" });

    const depsByCardKey = new Map<string, DependencyRef[]>([
      ["github:owner/repo:42", [{ id: "10", label: "blocked by #10", external: false }]],
    ]);

    const { edges } = resolveEdges(
      [
        makeCard({ key: "github:owner/repo:10", platform: "github", repo: "owner/repo", id: "10" }),
        dependent,
      ],
      depsByCardKey,
    );

    expect(edges[0].kind).toBe("blocks");
  });

  it("handles JIRA cross-platform reference", () => {
    const dependent = makeCard({ key: "github:owner/repo:42", platform: "github", repo: "owner/repo", id: "42" });

    const depsByCardKey = new Map<string, DependencyRef[]>([
      ["github:owner/repo:42", [{ id: "PROJ-123", label: "depends on JIRA:PROJ-123", platform: "jira", repo: "PROJ", external: true }]],
    ]);

    const { edges, ghostNodes } = resolveEdges([dependent], depsByCardKey);

    expect(edges[0].fromKey).toBe("jira:PROJ:PROJ-123");
    expect(edges[0].fromGhost).toBe(true);
    expect(ghostNodes[0].platform).toBe("jira");
  });

  it("handles GitLab cross-platform reference", () => {
    const dependent = makeCard({ key: "github:owner/repo:42", platform: "github", repo: "owner/repo", id: "42" });

    const depsByCardKey = new Map<string, DependencyRef[]>([
      ["github:owner/repo:42", [{ id: "7", label: "depends on GL:myproject#7", platform: "gitlab", repo: "myproject", external: true }]],
    ]);

    const { edges, ghostNodes } = resolveEdges([dependent], depsByCardKey);

    expect(edges[0].fromKey).toBe("gitlab:myproject:7");
    expect(edges[0].fromGhost).toBe(true);
    expect(ghostNodes[0].platform).toBe("gitlab");
  });

  it("returns empty arrays when no cards have dependencies", () => {
    const card = makeCard({ key: "github:owner/repo:1", platform: "github", repo: "owner/repo", id: "1" });
    const depsByCardKey = new Map<string, DependencyRef[]>();

    const { edges, ghostNodes } = resolveEdges([card], depsByCardKey);

    expect(edges).toHaveLength(0);
    expect(ghostNodes).toHaveLength(0);
  });

  it("qualifies bare #42 dep with parent card's platform and repo", () => {
    const blocker = makeCard({ key: "gitlab:myproject:42", platform: "gitlab", repo: "myproject", id: "42" });
    const dependent = makeCard({ key: "gitlab:myproject:99", platform: "gitlab", repo: "myproject", id: "99" });

    // Bare #42 — no platform/repo on the dep
    const depsByCardKey = new Map<string, DependencyRef[]>([
      ["gitlab:myproject:99", [{ id: "42", label: "depends on #42", external: false }]],
    ]);

    const { edges, ghostNodes } = resolveEdges([blocker, dependent], depsByCardKey);

    expect(edges).toHaveLength(1);
    expect(edges[0].fromKey).toBe("gitlab:myproject:42");
    expect(edges[0].toKey).toBe("gitlab:myproject:99");
    expect(edges[0].fromGhost).toBe(false);
    expect(ghostNodes).toHaveLength(0);
  });
});

describe("computeCriticalPath", () => {
  it("marks edges on the longest chain ending in in_flight/blocked", () => {
    const cards = [
      makeCard({ key: "github:o/r:1", platform: "github", repo: "o/r", id: "1", column: "done" }),
      makeCard({ key: "github:o/r:2", platform: "github", repo: "o/r", id: "2", column: "backlog" }),
      makeCard({ key: "github:o/r:3", platform: "github", repo: "o/r", id: "3", column: "in_flight" }),
    ];

    const depsByCardKey = new Map<string, DependencyRef[]>([
      ["github:o/r:2", [{ id: "1", label: "depends on #1", external: false }]],
      ["github:o/r:3", [{ id: "2", label: "depends on #2", external: false }]],
    ]);

    const { edges } = resolveEdges(cards, depsByCardKey);
    const result = computeCriticalPath(edges, cards);

    const criticalEdges = result.filter((e) => e.onCriticalPath);
    expect(criticalEdges).toHaveLength(2);
    expect(criticalEdges[0].fromKey).toBe("github:o/r:1");
    expect(criticalEdges[0].toKey).toBe("github:o/r:2");
    expect(criticalEdges[1].fromKey).toBe("github:o/r:2");
    expect(criticalEdges[1].toKey).toBe("github:o/r:3");
  });

  it("picks the longest chain when multiple paths exist", () => {
    const cards = [
      makeCard({ key: "github:o/r:1", platform: "github", repo: "o/r", id: "1", column: "done" }),
      makeCard({ key: "github:o/r:2", platform: "github", repo: "o/r", id: "2", column: "done" }),
      makeCard({ key: "github:o/r:3", platform: "github", repo: "o/r", id: "3", column: "in_flight" }),
      makeCard({ key: "github:o/r:4", platform: "github", repo: "o/r", id: "4", column: "done" }),
    ];

    const depsByCardKey = new Map<string, DependencyRef[]>([
      ["github:o/r:3", [{ id: "1", label: "depends on #1", external: false }]],
      ["github:o/r:2", [{ id: "4", label: "depends on #4", external: false }]],
    ]);
    depsByCardKey.get("github:o/r:3")!.push({ id: "2", label: "depends on #2", external: false });

    const { edges } = resolveEdges(cards, depsByCardKey);
    const result = computeCriticalPath(edges, cards);

    const criticalEdges = result.filter((e) => e.onCriticalPath);
    expect(criticalEdges).toHaveLength(2);
    expect(criticalEdges.map((e) => e.fromKey)).toContain("github:o/r:4");
    expect(criticalEdges.map((e) => e.fromKey)).toContain("github:o/r:2");
  });

  it("does not mark edges ending in done/backlog cards", () => {
    const cards = [
      makeCard({ key: "github:o/r:1", platform: "github", repo: "o/r", id: "1", column: "done" }),
      makeCard({ key: "github:o/r:2", platform: "github", repo: "o/r", id: "2", column: "done" }),
    ];

    const depsByCardKey = new Map<string, DependencyRef[]>([
      ["github:o/r:2", [{ id: "1", label: "depends on #1", external: false }]],
    ]);

    const { edges } = resolveEdges(cards, depsByCardKey);
    const result = computeCriticalPath(edges, cards);

    const criticalEdges = result.filter((e) => e.onCriticalPath);
    expect(criticalEdges).toHaveLength(0);
  });

  it("handles cycle without crashing", () => {
    const cards = [
      makeCard({ key: "github:o/r:1", platform: "github", repo: "o/r", id: "1", column: "blocked" }),
      makeCard({ key: "github:o/r:2", platform: "github", repo: "o/r", id: "2", column: "blocked" }),
    ];

    const depsByCardKey = new Map<string, DependencyRef[]>([
      ["github:o/r:1", [{ id: "2", label: "depends on #2", external: false }]],
      ["github:o/r:2", [{ id: "1", label: "depends on #1", external: false }]],
    ]);

    const { edges } = resolveEdges(cards, depsByCardKey);
    expect(() => computeCriticalPath(edges, cards)).not.toThrow();

    const result = computeCriticalPath(edges, cards);
    const criticalEdges = result.filter((e) => e.onCriticalPath);
    expect(criticalEdges.length).toBeGreaterThanOrEqual(0);
  });

  it("handles self-dependency without crashing", () => {
    const cards = [
      makeCard({ key: "github:o/r:1", platform: "github", repo: "o/r", id: "1", column: "blocked" }),
    ];

    const depsByCardKey = new Map<string, DependencyRef[]>([
      ["github:o/r:1", [{ id: "1", label: "depends on #1", external: false }]],
    ]);

    const { edges } = resolveEdges(cards, depsByCardKey);
    expect(() => computeCriticalPath(edges, cards)).not.toThrow();
  });

  it("returns empty array for empty edges", () => {
    const result = computeCriticalPath([], []);
    expect(result).toHaveLength(0);
  });

  it("handles disconnected components", () => {
    const cards = [
      makeCard({ key: "github:o/r:1", platform: "github", repo: "o/r", id: "1", column: "done" }),
      makeCard({ key: "github:o/r:2", platform: "github", repo: "o/r", id: "2", column: "in_flight" }),
      makeCard({ key: "github:o/r:3", platform: "github", repo: "o/r", id: "3", column: "done" }),
      makeCard({ key: "github:o/r:4", platform: "github", repo: "o/r", id: "4", column: "blocked" }),
    ];

    const depsByCardKey = new Map<string, DependencyRef[]>([
      ["github:o/r:2", [{ id: "1", label: "depends on #1", external: false }]],
      ["github:o/r:4", [{ id: "3", label: "depends on #3", external: false }]],
    ]);

    const { edges } = resolveEdges(cards, depsByCardKey);
    const result = computeCriticalPath(edges, cards);

    const criticalEdges = result.filter((e) => e.onCriticalPath);
    expect(criticalEdges).toHaveLength(2);
  });
});
