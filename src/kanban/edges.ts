import type { KanbanCard, KanbanEdge, KanbanGhostNode } from "./types.js";
import type { DependencyRef } from "../routes/repo-dashboard.js";

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
