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
 * Relationship attributes whose edge direction must be reversed.
 * For these, the claim means the *target* acts on the *current entity*,
 * not the other way around.
 *
 * Example: A has claim `blocked_by: B` → B blocks A, so edge is B → A.
 * Without reversal, the edge would incorrectly read "A blocks B."
 */
const REVERSE_DIRECTION_ATTRIBUTES = new Set(["blocked_by"]);

/**
 * Entity types that should NEVER become KG nodes via auto-population.
 *
 * These come from high-volume polling sources (helpdesk tickets, CI pipelines)
 * where every cycle would otherwise mint a fresh KG node — bloating the graph
 * and forcing ClaimKit to re-run LLM extraction over hundreds of low-signal
 * "requirements" on every server restart.
 *
 * Why: jitbit produced 166 `requirement` nodes from alert tickets, which
 * blocked server.listen() for ~90min/start as ClaimKit re-ingested them.
 * How to apply: keep facts in entity-memory (they're cheap there) but don't
 * promote ticket/pipeline entities to the KG layer.
 */
const KG_AUTOPOPULATE_BLOCKED_TYPES = new Set<string>(["ticket", "pipeline"]);

/**
 * Entity sources that should NEVER become KG nodes via auto-population,
 * regardless of entity type. Same rationale as KG_AUTOPOPULATE_BLOCKED_TYPES
 * but keyed on source so future helpdesk integrations are covered without
 * touching mapEntityType.
 */
const KG_AUTOPOPULATE_BLOCKED_SOURCES = new Set<string>(["jitbit"]);

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
  // 0. Drop high-volume / low-signal sources before they hit the KG.
  //    These stay in entity-memory (cheap) but never become KG nodes.
  if (KG_AUTOPOPULATE_BLOCKED_TYPES.has(entity.type)) return;
  if (KG_AUTOPOPULATE_BLOCKED_SOURCES.has(entity.source)) return;

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

    // Determine edge direction. For reverse-direction attributes like
    // "blocked_by", the target entity acts on the current entity, so
    // the edge goes from target → current (e.g., B blocks A).
    const isReverse = REVERSE_DIRECTION_ATTRIBUTES.has(claim.attribute ?? "");
    const edgeSourceId = isReverse ? target.id : nodeId;
    const edgeTargetId = isReverse ? nodeId : target.id;

    // Skip if an identical edge already exists (deduplication).
    const existingEdges = knowledgeGraph.getEdgesForNode(edgeSourceId, "both");
    const duplicate = existingEdges.some(
      (e) =>
        e.type === edgeType &&
        ((e.sourceId === edgeSourceId && e.targetId === edgeTargetId) ||
         (e.sourceId === edgeTargetId && e.targetId === edgeSourceId)),
    );
    if (duplicate) continue;

    knowledgeGraph.addEdge(
      edgeSourceId,
      edgeTargetId,
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
