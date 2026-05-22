import type { KanbanCard, KanbanEdge, KanbanGhostNode } from "./types.js";
import type { DependencyRef } from "../routes/repo-dashboard.js";

type EdgeState = "resolved" | "in_progress" | "blocked" | "pending" | "critical";

function buildDepKey(dep: DependencyRef, context: { platform: string; repo: string }): string {
  const platform = dep.platform || context.platform;
  const repo = dep.repo || context.repo;
  return `${platform}:${repo}:${dep.id}`;
}

function edgeKindFromLabel(label: string): "depends_on" | "blocks" {
  if (/\bblocked\s+by\b/i.test(label)) return "blocks";
  return "depends_on";
}

export function resolveEdges(
  cards: KanbanCard[],
  depsByCardKey: Map<string, DependencyRef[]>,
): { edges: KanbanEdge[]; ghostNodes: KanbanGhostNode[] } {
  const cardIndex = new Map<string, KanbanCard>();
  for (const card of cards) {
    cardIndex.set(card.key, card);
  }

  const edges: KanbanEdge[] = [];
  const ghostNodeMap = new Map<string, KanbanGhostNode>();
  const seenEdges = new Set<string>();

  for (const card of cards) {
    const deps = depsByCardKey.get(card.key);
    if (!deps || deps.length === 0) continue;

    for (const dep of deps) {
      const blockerKey = buildDepKey(dep, { platform: card.platform, repo: card.repo });
      const edgeKey = `${blockerKey}->${card.key}`;

      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);

      const isGhost = !cardIndex.has(blockerKey);

      edges.push({
        fromKey: blockerKey,
        toKey: card.key,
        fromGhost: isGhost,
        kind: edgeKindFromLabel(dep.label),
        label: dep.label,
      });

      if (isGhost && !ghostNodeMap.has(blockerKey)) {
        ghostNodeMap.set(blockerKey, {
          key: blockerKey,
          platform: dep.platform || card.platform,
          repo: dep.repo || card.repo,
          id: dep.id,
          label: dep.label,
        });
      }
    }
  }

  return {
    edges,
    ghostNodes: Array.from(ghostNodeMap.values()),
  };
}

/**
 * Compute per-edge state based on the blocker card's column.
 */
export function edgeStateFromBlocker(blockerColumn: KanbanCard["column"]): Exclude<EdgeState, "critical"> {
  switch (blockerColumn) {
    case "done": return "resolved";
    case "in_flight": return "in_progress";
    case "blocked": return "blocked";
    case "backlog": return "pending";
  }
}

/**
 * Find the longest dependency chain ending in an in_flight or blocked card.
 * Returns a new edges array with `onCriticalPath` set to true for edges
 * on the critical path(s).
 */
export function computeCriticalPath(
  edges: KanbanEdge[],
  cards: KanbanCard[],
): KanbanEdge[] {
  if (edges.length === 0) return [];

  const cardIndex = new Map<string, KanbanCard>();
  for (const card of cards) {
    cardIndex.set(card.key, card);
  }

  // Build adjacency: for each card, which edges point TO it (incoming)
  // and which edges point FROM it (outgoing).
  // Direction: edge.fromKey is the blocker, edge.toKey is the dependent.
  // For longest path, we traverse from blockers → dependents.
  const outgoing = new Map<string, KanbanEdge[]>();
  for (const edge of edges) {
    if (!outgoing.has(edge.fromKey)) outgoing.set(edge.fromKey, []);
    outgoing.get(edge.fromKey)!.push(edge);
  }

  // Terminal cards: in_flight or blocked
  const isTerminal = (key: string): boolean => {
    const card = cardIndex.get(key);
    if (!card) return false;
    return card.column === "in_flight" || card.column === "blocked";
  };

  // DFS with memoization to find the longest path from each node
  // that ends at a terminal (in_flight/blocked) card.
  // visited set detects cycles.
  const longestFrom = new Map<string, { length: number; edges: KanbanEdge[] }>();
  const inStack = new Set<string>();

  function dfs(key: string): { length: number; edges: KanbanEdge[] } {
    if (longestFrom.has(key)) return longestFrom.get(key)!;
    if (inStack.has(key)) {
      // Cycle detected — ignore back-edge
      return { length: 0, edges: [] };
    }

    inStack.add(key);

    const outEdges = outgoing.get(key) || [];
    let best: { length: number; edges: KanbanEdge[] } | null = null;

    for (const edge of outEdges) {
      const sub = dfs(edge.toKey);
      if (sub.length === 0 && !isTerminal(edge.toKey)) continue;
      const candidateLen = sub.length + 1;
      if (!best || candidateLen > best.length) {
        best = { length: candidateLen, edges: [edge, ...sub.edges] };
      }
    }

    inStack.delete(key);

    if (!best) {
      longestFrom.set(key, { length: 0, edges: [] });
      return { length: 0, edges: [] };
    }

    longestFrom.set(key, best);
    return best;
  }

  // Find the global longest path starting from every card
  let globalBest: KanbanEdge[] = [];
  for (const card of cards) {
    const result = dfs(card.key);
    if (result.edges.length > globalBest.length) {
      globalBest = result.edges;
    }
  }

  // Collect all edges on any path that matches the maximum length
  // (handles ties for disconnected components)
  const maxLen = globalBest.length;
  const criticalEdgeKeys = new Set<string>();

  if (maxLen > 0) {
    for (const card of cards) {
      const result = longestFrom.get(card.key);
      if (result && result.edges.length === maxLen) {
        for (const e of result.edges) {
          criticalEdgeKeys.add(`${e.fromKey}->${e.toKey}`);
        }
      }
    }
  }

  // Return new edges array with onCriticalPath set
  return edges.map((edge) => ({
    ...edge,
    onCriticalPath: criticalEdgeKeys.has(`${edge.fromKey}->${edge.toKey}`) || undefined,
  }));
}
