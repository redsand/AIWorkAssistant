export const ENTITY_TYPES = [
  "person",
  "customer",
  "company",
  "project",
  "repo",
  "jira_issue",
  "gitlab_mr",
  "github_pr",
  "roadmap",
  "work_item",
  "decision",
  "preference",
  "system",
  "vendor",
  // Structured-claim entity types added with the tool-claim-extractor.
  // Tenable / HAWK IR sources need these to record per-asset and per-finding
  // claims (severity, status, owner) with auto-supersession on rescan.
  "asset",
  "vulnerability",
  "incident",
  // Second-wave additions (D): support / calendar / CI entities.
  // tickets: jitbit / similar helpdesk; meetings: calendar events;
  // pipelines: gitlab pipelines + github workflow_runs share enough
  // structure to share an entity type.
  "ticket",
  "meeting",
  "pipeline",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export interface MemoryEntity {
  id: string;
  type: EntityType;
  name: string;
  normalizedName: string;
  summary: string;
  confidence: number;
  source: string;
  sourceId: string | null;
  sourceUrl: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  metadata: Record<string, unknown>;
}

export interface EntityFact {
  id: string;
  entityId: string;
  fact: string;
  source: string;
  sourceId: string | null;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  /**
   * Structured-claim fields (Idea 2: tool results as claims).
   * When non-null, this fact represents an atomic (attribute, value) claim
   * extracted deterministically from a tool result rather than an
   * LLM-extracted free-text statement. Enables supersession tracking
   * and direct claim-level queries.
   *
   * Example: entity=IR-82, attribute="status", value="In Progress".
   */
  attribute: string | null;
  value: string | null;
  /**
   * ISO timestamp when a newer claim about the same (entity, attribute)
   * superseded this one. NULL when this is the current claim.
   * Together with `supersededBy`, gives a full audit trail of how a
   * property changed over time.
   */
  supersededAt: string | null;
  supersededBy: string | null;
}

export interface EntityLink {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  relation: string;
  confidence: number;
  source: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface EntityContext {
  entity: MemoryEntity;
  facts: EntityFact[];
  links: Array<{
    relation: string;
    direction: "outbound" | "inbound";
    entity: MemoryEntity;
    confidence: number;
  }>;
}

export interface UpsertEntityInput {
  type: EntityType;
  name: string;
  summary?: string;
  confidence?: number;
  source?: string;
  sourceId?: string;
  sourceUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface FindEntitiesQuery {
  query?: string;
  type?: EntityType;
  source?: string;
  minConfidence?: number;
  limit?: number;
}

export interface ExtractedEntities {
  entities: UpsertEntityInput[];
  facts: Array<{ entityName: string; entityType: EntityType; fact: string; source: string }>;
}
