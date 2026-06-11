/**
 * Graph auto-populator: bridges entity-memory observations into the
 * knowledge graph.
 *
 * Entity-memory tracks WHAT (atomic facts about entities like status,
 * assignee, severity). The knowledge graph tracks HOW (relationships
 * between entities). This module auto-bridges them: for every entity
 * observed via tool results, it ensures a KG node exists and creates
 * edges for any relationship-typed claims.
 *
 * Zero LLM cost — reuses claims already extracted by tool-claim-extractor.
 */

import { knowledgeGraph } from "../agent/knowledge-graph";
import type { KGNodeType, KGEdgeType } from "../agent/knowledge-graph";
import { entityMemory } from "./entity-memory";
import type { MemoryEntity } from "./entity-types";

/**
 * Entity-ID extraction patterns (reused from entity-claims-injector.ts).
 * Each pattern extracts a specific type of entity reference from text.
 */
const ENTITY_ID_PATTERNS: RegExp[] = [
  // Jira-style: IR-82, ABC-1234. Two+ uppercase letters - digits.
  /\b[A-Z]{2,10}-\d+\b/g,
  // GitHub PR/issue: owner/repo#123 or repo#123.
  /\b(?:[\w.-]+\/)?[\w.-]+#\d+\b/g,
  // GitLab MR shorthand: !123.
  /(?:^|\s|[(\[])!\d+\b/g,
];

/**
 * Relationship attributes that should create KG edges. Maps claim
 * attribute names to KG edge types.
 */
const RELATIONSHIP_ATTRIBUTES: Record<string, KGEdgeType> = {
  blocks: "blocks",
  blocked_by: "blocks",
  depends_on: "depends_on",
  relates_to: "related_to",
  related_to: "related_to",
  implements: "implements",
  supersedes: "supersedes",
  alternative_to: "alternative_to",
  enables: "enables",
  constrains: "constrains",
  derives_from: "derives_from",
  tested_by: "tested_by",
};

/**
 * Ensure a knowledge graph node exists for the given entity-memory entity.
 * If a matching node already exists (by title or entityName metadata),
 * this is a no-op (deduplication).
 *
 * After creating the node, scans the entity's current claims for
 * relationship-typed attributes and creates edges to target nodes
 * that already exist in the graph.
 */
export function autoPopulateFromEntity(entity: MemoryEntity): void {
  // 1. Check if node already exists (search by entity name in title).
  const existing = knowledgeGraph.queryNodes({ search: entity.name, limit: 5 });
  const match = existing.find(
    (n) =>
      n.title === entity.name ||
      n.metadata?.entityName === entity.name,
  );
  if (match) return; // Already populated.

  // 2. Map entity type to KG node type.
  const nodeType = mapEntityType(entity.type, entity.summary);

  // 3. Create node with autoPopulated metadata.
  const nodeId = knowledgeGraph.addNode({
    type: nodeType,
    title: entity.name,
    content: entity.summary || "",
    status: "accepted",
    tags: [entity.type, "auto-populated"],
    metadata: {
      entityName: entity.name,
      entityType: entity.type,
      sourceUrl: entity.sourceUrl,
      autoPopulated: true,
    },
  });

  // 4. Extract relationships from claims and create edges.
  const claims = entityMemory.getCurrentClaims(entity.id);
  for (const claim of claims) {
    const edgeType = RELATIONSHIP_ATTRIBUTES[claim.attribute ?? ""];
    if (!edgeType) continue; // Not a relationship claim.

    const relatedName = extractRelatedEntity(claim.value ?? "");
    if (!relatedName) continue;

    // Find target node in the graph.
    const targets = knowledgeGraph.queryNodes({ search: relatedName, limit: 5 });
    const target = targets.find(
      (t) =>
        t.title === relatedName ||
        t.metadata?.entityName === relatedName,
    );
    if (!target) continue; // Target not yet in graph — skip.

    knowledgeGraph.addEdge(
      nodeId,
      target.id,
      edgeType,
      `${claim.attribute}: ${claim.value}`,
    );
  }
}

/**
 * Map an entity-memory entity type to a knowledge-graph node type.
 *
 * Mapping rationale:
 * - jira_issue: requirements/tasks → "requirement"
 * - github_pr/gitlab_mr: code patterns/changes → "pattern"
 * - decision → "decision"
 * - component/system → "component"
 * - vulnerability/incident: risks → "risk"
 * - default: general reasoning → "reasoning"
 */
export function mapEntityType(type: string, _summary: string): KGNodeType {
  switch (type) {
    case "jira_issue":
    case "work_item":
    case "ticket":
      return "requirement";
    case "github_pr":
    case "gitlab_mr":
      return "pattern";
    case "decision":
      return "decision";
    case "component":
    case "system":
    case "repo":
      return "component";
    case "api_endpoint":
      return "api_endpoint";
    case "vulnerability":
    case "incident":
      return "risk";
    default:
      return "reasoning";
  }
}

/**
 * Infer a KG edge type from a claim attribute name.
 * Falls back to "related_to" for unrecognized attributes.
 */
export function inferEdgeType(attribute: string): KGEdgeType {
  return RELATIONSHIP_ATTRIBUTES[attribute] ?? "related_to";
}

/**
 * Extract an entity reference from a claim value string.
 * Returns the first entity-ID-shaped token found, or null if none.
 *
 * Examples:
 *   "IR-82" → "IR-82"
 *   "blocked by IR-82 currently" → "IR-82"
 *   "acme/widgets#42" → "acme/widgets#42"
 *   "In Progress" → null
 */
export function extractRelatedEntity(value: string): string | null {
  if (!value) return null;

  for (const pattern of ENTITY_ID_PATTERNS) {
    pattern.lastIndex = 0; // Reset since patterns use /g flag.
    const match = pattern.exec(value);
    if (match) {
      const extracted = match[0].trim().replace(/^[(\[]/, "");
      if (extracted.length >= 3 && extracted.length <= 60) {
        return extracted;
      }
    }
  }

  return null;
}
